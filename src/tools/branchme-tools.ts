import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BRANCH_STATUS_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  PULL_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
} from "../constants.ts";
import {
  changeExistingLocalBranch,
  createLocalBranch,
  getGitRoot,
  getLocalBranchCommit,
  localBranchExists,
  pullCurrentBranch,
  pushCurrentBranch,
  validateBranchName,
  withRepositoryMutationQueue,
} from "../git.ts";
import { collectGitContext, formatGitContext } from "../git-context.ts";
import {
  createGitHubPullRequest,
  ensureGitHubBranchExists,
  redactSecrets,
  repositoryLabel,
  resolveGitHubRepository,
  resolveGitHubToken,
  validatePullRequestBranchRef,
} from "../github.ts";
import type { ChangeBranchDetails, GitContextDetails, PullRequestDetails } from "../types.ts";

const EmptyParametersSchema = Type.Object({}, { additionalProperties: false });

const CreateBranchParametersSchema = Type.Object(
  {
    branchName: Type.String({ minLength: 1, description: "Name of the new branch to create from current HEAD." }),
  },
  { additionalProperties: false },
);

const ChangeBranchParametersSchema = Type.Object(
  {
    branchName: Type.String({ minLength: 1, description: "Name of the existing local branch to switch to." }),
  },
  { additionalProperties: false },
);

const PullRequestParametersSchema = Type.Object(
  {
    headBranch: Type.String({ minLength: 1, description: "Existing local branch containing the pull request changes." }),
    baseBranch: Type.String({ minLength: 1, description: "Existing local target branch for the pull request." }),
    title: Type.String({ minLength: 1, description: "Pull request title." }),
    body: Type.String({ description: "Pull request body. Pass an empty string only when intentionally blank." }),
    draft: Type.Boolean({ description: "Whether to create the pull request as a draft." }),
  },
  { additionalProperties: false },
);

// Exported so tests and advanced embedders can inject environment/fetch behavior without mutating globals.
export interface BranchMeToolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function formatBranchStatus(details: GitContextDetails): string {
  return formatGitContext(details, "refresh");
}

export function formatChangeBranch(details: ChangeBranchDetails): string {
  const previous = details.previousDetached ? "detached HEAD" : details.previousBranch ?? "unknown branch";
  return `Changed branch from ${previous} to ${details.currentBranch}.`;
}

export function formatPullRequest(details: PullRequestDetails): string {
  return `Created pull request #${details.number} (${details.state}) for ${repositoryLabel(details.repository)}: ${details.url}`;
}

async function validateLocalPullRequestBranchName(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: { cwd: string },
  branchName: string,
  field: "headBranch" | "baseBranch",
  signal?: AbortSignal,
): Promise<void> {
  // Keep PR-specific safety rules and local branch semantics on one path before existence checks.
  validatePullRequestBranchRef(branchName, field);
  try {
    await validateBranchName(pi, ctx, branchName, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${field} is not a valid local branch name: ${redactSecrets(message)}.`);
  }
}

async function requireExistingValidatedLocalPullRequestBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: { cwd: string },
  branchName: string,
  field: "headBranch" | "baseBranch",
  signal?: AbortSignal,
): Promise<void> {
  if (await localBranchExists(pi, ctx, branchName, signal)) return;
  throw new Error(`${field} local branch '${redactSecrets(branchName)}' does not exist.`);
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

async function requireGitHubHeadMatchesLocalBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: { cwd: string },
  branchName: string,
  githubCommitSha: string,
  signal?: AbortSignal,
): Promise<void> {
  const localCommit = await getLocalBranchCommit(pi, ctx, branchName, signal);
  if (localCommit.toLowerCase() === githubCommitSha.toLowerCase()) return;
  throw new Error(
    `headBranch local branch '${redactSecrets(branchName)}' points to ${shortCommit(localCommit)}, but GitHub has ${shortCommit(githubCommitSha)}. Run push_branch and wait for it to complete before calling pull_request, then retry.`,
  );
}

export function registerBranchMeTools(pi: Pick<ExtensionAPI, "registerTool" | "exec">, options: BranchMeToolOptions = {}): void {
  pi.registerTool({
    name: BRANCH_STATUS_TOOL_NAME,
    label: "Branch Status",
    description: "branch_status explicitly refreshes the current Git repository snapshot, including branch, working tree, unstaged changes, related pull request, and recent commits. branch_status is read-only and never mutates files, Git state, or GitHub state.",
    promptSnippet: "branch_status: explicitly refresh current-repository branch, working tree, changes, related PR, and recent commits without mutation",
    promptGuidelines: [
      "Use the automatic Git context for start-of-run questions; call branch_status only for an explicit refresh or after Git state changes during the current run.",
      "Use branch_status as a read-only refresh; branch_status never mutates files, Git state, or GitHub state.",
    ],
    parameters: EmptyParametersSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const details = await collectGitContext(pi, ctx, {
        signal,
        env: options.env,
        fetchImpl: options.fetchImpl,
      });

      try {
        details.githubRepository ??= await resolveGitHubRepository(pi, ctx, signal, options.env);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Repository resolution is optional compatibility metadata; context collection is authoritative.
      }

      return {
        content: [{ type: "text", text: formatBranchStatus(details) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: CREATE_BRANCH_TOOL_NAME,
    label: "Create Branch",
    description: "create_branch creates and checks out a new local branch from the current HEAD only. create_branch does not accept a base ref and never stages, commits, pushes, or edits files.",
    promptSnippet: "create_branch: create and checkout a new branch from current HEAD using an explicit branchName",
    promptGuidelines: [
      "Use create_branch only when the user explicitly wants a new branch from current HEAD.",
      "Use create_branch with only branchName; create_branch never accepts or infers baseRef, commits, stages, pushes, or edits files.",
    ],
    parameters: CreateBranchParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await createLocalBranch(pi, ctx, params.branchName, signal);
      return {
        content: [
          {
            type: "text",
            text: `Created and checked out branch ${details.newBranch} from ${details.previousBranch}.`,
          },
        ],
        details,
      };
    },
  });

  pi.registerTool({
    name: CHANGE_BRANCH_TOOL_NAME,
    label: "Change Branch",
    description: "change_branch switches to an existing local branch in the current repository only. change_branch rejects dirty worktrees and never creates branches, forces checkout, stashes, stages, commits, pushes, or edits files directly.",
    promptSnippet: "change_branch: switch to an existing local branch with branchName after a clean-worktree preflight",
    promptGuidelines: [
      "Use change_branch only when the user explicitly wants to switch to an existing local branch in the current repository.",
      "Use change_branch with only branchName; change_branch never accepts baseRef, force, stash, discard, create, owner, repo, or path inputs.",
      "Use change_branch only on a clean working tree; change_branch rejects dirty worktrees and never stages, commits, pushes, stashes, or force-switches.",
    ],
    parameters: ChangeBranchParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await changeExistingLocalBranch(pi, ctx, params.branchName, signal);
      return {
        content: [{ type: "text", text: formatChangeBranch(details) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: PULL_BRANCH_TOOL_NAME,
    label: "Pull Branch",
    description: "pull_branch updates the current branch from its configured upstream with git pull --ff-only --no-rebase --no-autostash. pull_branch requires a clean working tree and never rebases, creates merge commits, force-updates, stashes, stages, or commits.",
    promptSnippet: "pull_branch: fast-forward the clean current branch from its configured upstream without rebasing",
    promptGuidelines: [
      "Use pull_branch only when the user explicitly wants to update the current branch from its configured upstream.",
      "Use pull_branch only on a clean working tree with an upstream; pull_branch has no branchName, remote, force, or rebase parameters.",
      "Do not call pull_branch in the same tool batch as change_branch or create_branch; call pull_branch after change_branch completes, then call create_branch after pull_branch completes.",
    ],
    parameters: EmptyParametersSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const details = await pullCurrentBranch(pi, ctx, signal);
      return {
        content: [{ type: "text", text: `Pulled current branch ${details.currentBranch} with fast-forward-only semantics.` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: PUSH_BRANCH_TOOL_NAME,
    label: "Push Branch",
    description: "push_branch pushes the current branch to its configured upstream remote with an explicit refspec. If the current branch has no upstream, push_branch publishes it to origin with --set-upstream. push_branch never commits, stages, or edits files.",
    promptSnippet: "push_branch: push or publish the current branch only with an explicit target, without committing or staging",
    promptGuidelines: [
      "Use push_branch only after commits already exist; push_branch never commits, stages, or edits files.",
      "Use push_branch to push only the current branch; push_branch does not accept a branchName parameter.",
      "Use push_branch by itself before pull_request; wait for push_branch to complete before creating a pull_request.",
    ],
    parameters: EmptyParametersSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const details = await pushCurrentBranch(pi, ctx, signal);
      const action = details.mode === "publish" ? "Published" : "Pushed";
      return {
        content: [{ type: "text", text: `${action} current branch ${details.currentBranch}.` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: PULL_REQUEST_TOOL_NAME,
    label: "Pull Request",
    description: "pull_request creates a GitHub pull request in the resolved current repository. pull_request requires headBranch and baseBranch to exist as safe local branch names, requires headBranch to match the GitHub-visible branch commit, and requires baseBranch to be visible on GitHub. Owner-prefixed refs, owner, and repo are never accepted as inputs.",
    promptSnippet: "pull_request: create a GitHub pull request in the current repository with all PR fields explicit",
    promptGuidelines: [
      "Use pull_request only when the user provides explicit headBranch, baseBranch, title, body, and draft values.",
      "Use pull_request only with existing local branches for headBranch and baseBranch; headBranch must match the GitHub-visible branch commit.",
      "Do not call push_branch and pull_request in the same tool batch; call pull_request only after push_branch has completed.",
      "Use pull_request only for the resolved current repository; pull_request never accepts owner, repo, or owner-prefixed branch refs.",
      "Use pull_request with GITHUB_TOKEN or GH_TOKEN from the process environment or local .env fallback; pull_request must not expose token values.",
    ],
    parameters: PullRequestParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repoRoot = await getGitRoot(pi, ctx, signal);
      const rootCtx = { cwd: repoRoot };

      return withRepositoryMutationQueue(repoRoot, async () => {
        await validateLocalPullRequestBranchName(pi, rootCtx, params.headBranch, "headBranch", signal);
        await validateLocalPullRequestBranchName(pi, rootCtx, params.baseBranch, "baseBranch", signal);
        await requireExistingValidatedLocalPullRequestBranch(pi, rootCtx, params.headBranch, "headBranch", signal);
        await requireExistingValidatedLocalPullRequestBranch(pi, rootCtx, params.baseBranch, "baseBranch", signal);
        const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
        const token = (await resolveGitHubToken(options.env, { cwd: repoRoot, signal })).token;

        try {
          const headBranch = await ensureGitHubBranchExists(repository, params.headBranch, "headBranch", token, {
            fetchImpl: options.fetchImpl,
            signal,
          });
          await requireGitHubHeadMatchesLocalBranch(pi, rootCtx, params.headBranch, headBranch.commitSha, signal);
          await ensureGitHubBranchExists(repository, params.baseBranch, "baseBranch", token, {
            fetchImpl: options.fetchImpl,
            signal,
          });
          const details = await createGitHubPullRequest(repository, params, token, {
            fetchImpl: options.fetchImpl,
            signal,
          });
          return {
            content: [{ type: "text", text: formatPullRequest(details) }],
            details,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(redactSecrets(message, [token]));
        }
      });
    },
  });
}
