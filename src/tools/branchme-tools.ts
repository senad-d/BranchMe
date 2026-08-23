import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BRANCH_STATUS_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  CREATE_WORKTREE_TOOL_NAME,
  FETCH_BRANCH_TOOL_NAME,
  GIT_INTEGRATION_SUMMARY_LIMIT_CHARS,
  GIT_WORKTREE_SUMMARY_LIMIT_CHARS,
  INTEGRATE_BRANCH_TOOL_NAME,
  LIST_WORKTREES_TOOL_NAME,
  PULL_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
  REBASE_BRANCH_TOOL_NAME,
  REMOVE_WORKTREE_TOOL_NAME,
} from "../constants.ts";
import {
  changeExistingLocalBranch,
  createLocalBranch,
  createWorktree,
  fetchCurrentBranch,
  getGitRoot,
  getLocalBranchCommit,
  getPullRequestCommitSubjects,
  inferPullRequestBaseBranch,
  listWorktrees,
  localBranchExists,
  pullCurrentBranch,
  pushCurrentBranch,
  rebaseCurrentBranch,
  removeWorktree,
  requireCurrentBranch,
  validateBranchName,
  withRepositoryMutationQueue,
} from "../git.ts";
import { collectGitContext, formatGitContext } from "../git-context.ts";
import { integrateBranch } from "../git-integration.ts";
import {
  createGitHubPullRequest,
  ensureGitHubBranchExists,
  redactSecrets,
  repositoryLabel,
  resolveGitHubRepository,
  resolveGitHubToken,
  resolvePullRequestAutofill,
  validatePullRequestBranchRef,
} from "../github.ts";
import type {
  ChangeBranchDetails,
  CreateWorktreeDetails,
  GitContextDetails,
  IntegrateBranchDetails,
  ListWorktreesDetails,
  PullRequestDetails,
  PullRequestInput,
  PullRequestInputField,
  PullRequestToolDetails,
  PullRequestToolInput,
  RemoveWorktreeDetails,
  WorktreeEntry,
} from "../types.ts";

const EmptyParametersSchema = Type.Object({}, { additionalProperties: false });

const BranchStatusParametersSchema = Type.Object(
  {
    ancestry: Type.Optional(
      Type.Object(
        {
          sourceBranch: Type.String({ minLength: 1, description: "Exact existing local source branch to verify." }),
          targetBranch: Type.String({ minLength: 1, description: "Exact existing local target branch to verify." }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const IntegrateBranchParametersSchema = Type.Object(
  {
    sourceBranch: Type.String({ minLength: 1, description: "Exact existing local source branch to integrate." }),
    targetBranch: Type.String({ minLength: 1, description: "Exact existing local target branch already checked out in the clean control worktree." }),
  },
  { additionalProperties: false },
);

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

const CreateWorktreeParametersSchema = Type.Object(
  {
    worktreePath: Type.String({ minLength: 1, description: "Explicit absolute destination path for the linked worktree." }),
    branchName: Type.String({ minLength: 1, description: "New or existing local branch name for the linked worktree." }),
    branchMode: StringEnum(["new", "existing"] as const, {
      description: "Whether create_worktree creates a new local branch from current HEAD or uses an existing local branch.",
    }),
  },
  { additionalProperties: false },
);

const RemoveWorktreeParametersSchema = Type.Object(
  {
    worktreePath: Type.String({ minLength: 1, description: "Explicit absolute path of the linked worktree to remove." }),
  },
  { additionalProperties: false },
);

const PullRequestParametersSchema = Type.Object(
  {
    headBranch: Type.Optional(
      Type.String({ minLength: 1, description: "Existing local branch containing the pull request changes. May be omitted in PR autofill mode." }),
    ),
    baseBranch: Type.Optional(
      Type.String({ minLength: 1, description: "Existing local target branch for the pull request. May be omitted in PR autofill mode." }),
    ),
    title: Type.Optional(Type.String({ minLength: 1, description: "Pull request title. May be omitted in PR autofill mode." })),
    body: Type.Optional(
      Type.String({ description: "Pull request body. Pass an empty string only when intentionally blank; may be omitted in PR autofill mode." }),
    ),
    draft: Type.Optional(Type.Boolean({ description: "Whether to create the pull request as a draft. Defaults to false in PR autofill mode." })),
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

export function formatPullRequest(details: PullRequestDetails, autofilledFields: PullRequestInputField[] = []): string {
  const autofill = autofilledFields.length > 0 ? ` Autofilled fields: ${autofilledFields.join(", ")}.` : "";
  return `Created pull request #${details.number} (${details.state}) for ${repositoryLabel(details.repository)}: ${details.url}.${autofill}`;
}

const WORKTREE_FORMAT_PATH_LIMIT_CHARS = 512;
const WORKTREE_FORMAT_BRANCH_LIMIT_CHARS = 256;

function truncateWorktreeFormatValue(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit - 1;
  const lastCodePoint = value.codePointAt(end - 1);
  if (lastCodePoint !== undefined && lastCodePoint > 0xffff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function escapeWorktreeFormatControlCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? "" : String.raw`\u${codePoint.toString(16).padStart(4, "0")}`;
}

function safeWorktreeFormatValue(value: string, limit: number): string {
  const redacted = redactSecrets(value);
  const escaped = redacted.replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    escapeWorktreeFormatControlCharacter,
  );
  return truncateWorktreeFormatValue(escaped, limit);
}

function worktreeDisplayState(worktree: WorktreeEntry): string {
  if (worktree.bare) return "bare";
  if (worktree.detached) return "detached";
  const branch = worktree.branch ?? "unknown";
  return `branch ${safeWorktreeFormatValue(branch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS)}`;
}

function worktreeDisplayIndicators(worktree: WorktreeEntry): string[] {
  const indicators: string[] = [];
  if (worktree.main) indicators.push("main");
  if (worktree.current) indicators.push("current");
  if (worktree.locked) indicators.push("locked");
  if (worktree.prunable) indicators.push("prunable");
  return indicators;
}

function formatWorktreeEntry(worktree: WorktreeEntry): string {
  const path = safeWorktreeFormatValue(worktree.path, WORKTREE_FORMAT_PATH_LIMIT_CHARS);
  const head = worktree.head === null ? "none" : shortCommit(worktree.head);
  const indicators = worktreeDisplayIndicators(worktree);
  const indicatorText = indicators.length === 0 ? "" : ` | ${indicators.join(",")}`;
  return `- ${path} | ${worktreeDisplayState(worktree)} | HEAD ${head}${indicatorText}`;
}

function worktreeOmissionLine(omitted: number): string {
  return `${omitted} worktree entr${omitted === 1 ? "y" : "ies"} omitted.`;
}

export function formatListWorktrees(details: ListWorktreesDetails): string {
  const repoRoot = safeWorktreeFormatValue(details.repoRoot, WORKTREE_FORMAT_PATH_LIMIT_CHARS);
  const lines = [`Worktrees for ${repoRoot}:`];
  let omitted = details.omitted;

  for (const [index, worktree] of details.worktrees.entries()) {
    const line = formatWorktreeEntry(worktree);
    const remaining = details.worktrees.length - index - 1;
    const candidateOmitted = details.omitted + remaining;
    const candidate = [
      ...lines,
      line,
      ...(candidateOmitted > 0 ? [worktreeOmissionLine(candidateOmitted)] : []),
    ].join("\n");
    if (candidate.length > GIT_WORKTREE_SUMMARY_LIMIT_CHARS) {
      omitted += details.worktrees.length - index;
      break;
    }
    lines.push(line);
  }

  if (omitted > 0) lines.push(worktreeOmissionLine(omitted));
  return lines.join("\n");
}

export function formatCreateWorktree(details: CreateWorktreeDetails): string {
  const cwd = safeWorktreeFormatValue(details.handoff.cwd, WORKTREE_FORMAT_PATH_LIMIT_CHARS);
  const branch = safeWorktreeFormatValue(details.handoff.branch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS);
  const mode = details.request.branchMode === "new" ? "new local branch" : "existing local branch";
  return `Created linked worktree ${cwd} for ${mode} ${branch}. Verified its canonical path, local branch, HEAD ${shortCommit(details.handoff.head)}, clean working tree, and ready handoff.`;
}

export function formatRemoveWorktree(details: RemoveWorktreeDetails): string {
  const path = safeWorktreeFormatValue(
    details.verified.before.worktree.path,
    WORKTREE_FORMAT_PATH_LIMIT_CHARS,
  );
  const branch = safeWorktreeFormatValue(details.handoff.branch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS);
  return `Removed linked worktree directory ${path}. Verified it is no longer registered and retained local branch ${branch} at HEAD ${shortCommit(details.handoff.head)}; the removed cwd is not ready for handoff.`;
}

function integrationConflictOmissionLine(omitted: number): string {
  return `${omitted} conflict path${omitted === 1 ? "" : "s"} omitted.`;
}

function formatIntegrationConflict(details: Extract<IntegrateBranchDetails, { status: "conflict" }>): string {
  const source = safeWorktreeFormatValue(details.request.sourceBranch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS);
  const target = safeWorktreeFormatValue(details.request.targetBranch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS);
  const lines = [
    `integrate_branch found conflicts while integrating ${source} into ${target}; the merge was automatically aborted and exact restoration was verified at target HEAD ${shortCommit(details.verified.heads.after.targetHead)}.`,
    "Conflict paths:",
  ];
  let omitted = details.conflict.omitted;

  for (const [index, entry] of details.conflict.paths.entries()) {
    const path = safeWorktreeFormatValue(entry.path, WORKTREE_FORMAT_PATH_LIMIT_CHARS);
    const line = `- ${path}`;
    const remaining = details.conflict.paths.length - index - 1;
    const candidateOmitted = details.conflict.omitted + remaining;
    const candidate = [
      ...lines,
      line,
      ...(candidateOmitted > 0 ? [integrationConflictOmissionLine(candidateOmitted)] : []),
    ].join("\n");
    if (candidate.length > GIT_INTEGRATION_SUMMARY_LIMIT_CHARS) {
      omitted += details.conflict.paths.length - index;
      break;
    }
    lines.push(line);
  }

  if (omitted > 0) lines.push(integrationConflictOmissionLine(omitted));
  return lines.join("\n");
}

export function formatIntegrateBranch(details: IntegrateBranchDetails): string {
  if (details.status === "conflict") return formatIntegrationConflict(details);

  const source = safeWorktreeFormatValue(details.request.sourceBranch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS);
  const target = safeWorktreeFormatValue(details.request.targetBranch, WORKTREE_FORMAT_BRANCH_LIMIT_CHARS);
  const beforeTarget = shortCommit(details.verified.heads.before.targetHead);
  const afterTarget = shortCommit(details.verified.heads.after.targetHead);
  if (details.status === "already_integrated") {
    return `integrate_branch verified ${source} was already integrated into ${target}; no merge ran and target HEAD remained ${afterTarget}.`;
  }
  if (details.status === "fast_forward") {
    return `integrate_branch fast-forwarded ${target} from ${beforeTarget} to ${afterTarget}, integrating ${source}.`;
  }
  return `integrate_branch created and verified a merge commit ${afterTarget} on ${target} from previous target ${beforeTarget} and source ${source}.`;
}

const PULL_REQUEST_INPUT_FIELDS: PullRequestInputField[] = ["headBranch", "baseBranch", "title", "body", "draft"];

interface ResolvedPullRequestBranches {
  headBranch: string;
  baseBranch: string;
  autofilledFields: PullRequestInputField[];
}

interface ResolvedPullRequestInput {
  input: PullRequestInput;
  autofilledFields: PullRequestInputField[];
}

function missingPullRequestInputFields(params: PullRequestToolInput): PullRequestInputField[] {
  return PULL_REQUEST_INPUT_FIELDS.filter((field) => params[field] === undefined);
}

function generatedPullRequestTitle(
  headBranch: string,
  commitSubjects: string[],
  tokens: readonly string[],
): string {
  if (commitSubjects[0]) return commitSubjects[0];

  const branchSegment = headBranch.split("/").at(-1) ?? headBranch;
  const words = redactSecrets(branchSegment, tokens).replace(/[-_]+/gu, " ").trim();
  if (!words) return "Update project";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function escapePullRequestMarkdownText(value: string): string {
  return value.replace(/[!-/:-@[-`{-~]/gu, String.raw`\$&`);
}

function generatedPullRequestBody(commitSubjects: string[]): string {
  if (commitSubjects.length === 0) return "";
  const bullets = commitSubjects.map((subject) => `- ${escapePullRequestMarkdownText(subject)}`);
  return ["## Summary", "", ...bullets, "", "_Generated by BranchMe from commit subjects._"].join("\n");
}

async function requirePullRequestAutofill(
  missingFields: PullRequestInputField[],
  env: NodeJS.ProcessEnv | undefined,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (missingFields.length === 0) return;
  if (await resolvePullRequestAutofill(env, { cwd: repoRoot, signal })) return;
  throw new Error(
    `Missing pull_request fields: ${missingFields.join(", ")}. Provide them explicitly or set BRANCHME_PR_AUTOFILL=true in the process environment or repository .env file.`,
  );
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

async function resolvePullRequestBranches(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: { cwd: string },
  params: PullRequestToolInput,
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal,
): Promise<ResolvedPullRequestBranches> {
  const autofilledFields = missingPullRequestInputFields(params);
  await requirePullRequestAutofill(autofilledFields, env, ctx.cwd, signal);

  const headBranch = params.headBranch ?? await requireCurrentBranch(pi, ctx, signal);
  const baseBranch = params.baseBranch ?? await inferPullRequestBaseBranch(pi, ctx, headBranch, signal);
  if (headBranch === baseBranch) throw new Error("headBranch and baseBranch must be different branches.");

  await validateLocalPullRequestBranchName(pi, ctx, headBranch, "headBranch", signal);
  await validateLocalPullRequestBranchName(pi, ctx, baseBranch, "baseBranch", signal);
  await requireExistingValidatedLocalPullRequestBranch(pi, ctx, headBranch, "headBranch", signal);
  await requireExistingValidatedLocalPullRequestBranch(pi, ctx, baseBranch, "baseBranch", signal);

  return { headBranch, baseBranch, autofilledFields };
}

async function resolvePullRequestInput(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: { cwd: string },
  params: PullRequestToolInput,
  branches: ResolvedPullRequestBranches,
  tokens: readonly string[],
  signal?: AbortSignal,
): Promise<ResolvedPullRequestInput> {
  const needsCommitSubjects = params.title === undefined || params.body === undefined;
  const commitSubjects = needsCommitSubjects
    ? await getPullRequestCommitSubjects(
      pi,
      ctx,
      branches.headBranch,
      branches.baseBranch,
      signal,
      tokens,
    )
    : [];

  return {
    input: {
      headBranch: branches.headBranch,
      baseBranch: branches.baseBranch,
      title: params.title ?? generatedPullRequestTitle(branches.headBranch, commitSubjects, tokens),
      body: params.body ?? generatedPullRequestBody(commitSubjects),
      draft: params.draft ?? false,
    },
    autofilledFields: branches.autofilledFields,
  };
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
    description: "branch_status explicitly refreshes the current Git repository snapshot and can optionally verify whether one captured local branch commit is an ancestor of another. branch_status is read-only and never mutates files, Git state, or GitHub state.",
    promptSnippet: "branch_status: explicitly refresh current-repository Git state and optionally verify targeted local-branch ancestry without mutation",
    promptGuidelines: [
      "Use the automatic Git context for start-of-run questions; call branch_status only for an explicit refresh or after Git state changes during the current run.",
      "Use branch_status as a read-only refresh; branch_status never mutates files, Git state, or GitHub state.",
      "Use targeted branch_status ancestry verification only after integrate_branch completes; do not issue branch_status in the same parallel tool batch as integrate_branch.",
    ],
    parameters: BranchStatusParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await collectGitContext(pi, ctx, {
        signal,
        ancestry: params.ancestry,
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
    name: FETCH_BRANCH_TOOL_NAME,
    label: "Fetch Branch",
    description: "fetch_branch fetches the current branch's configured upstream branch into its remote-tracking ref with an explicit git fetch --no-tags --no-recurse-submodules refspec. fetch_branch does not change local branches or working-tree files and never prunes, rebases, merges, stashes, stages, commits, or pushes.",
    promptSnippet: "fetch_branch: fetch the current branch's configured upstream into its remote-tracking ref without changing local branches or files",
    promptGuidelines: [
      "Use fetch_branch only when the user explicitly wants to fetch the configured upstream branch for the current branch.",
      "Use fetch_branch only on a current branch with an upstream; fetch_branch has no branchName, remote, tags, prune, force, or refspec parameters.",
      "Call fetch_branch and wait for it to complete before rebase_branch when the user wants the latest upstream state; do not batch fetch_branch with rebase_branch.",
    ],
    parameters: EmptyParametersSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const details = await fetchCurrentBranch(pi, ctx, signal);
      return {
        content: [{ type: "text", text: `Fetched configured upstream remote ${details.remote} for current branch ${details.currentBranch}.` }],
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
    name: REBASE_BRANCH_TOOL_NAME,
    label: "Rebase Branch",
    description: "rebase_branch rebases the clean current branch onto its configured upstream with git rebase --no-autostash --no-update-refs. rebase_branch rewrites local commits, never pushes or force-pushes, and automatically attempts git rebase --abort if the rebase fails.",
    promptSnippet: "rebase_branch: rebase the clean current branch onto its configured upstream with automatic abort on failure",
    promptGuidelines: [
      "Use rebase_branch only when the user explicitly requests rebasing and accepts that rebase_branch rewrites local commit history.",
      "Use rebase_branch only on a clean current branch with an upstream; rebase_branch has no branchName, base, remote, force, autostash, continue, or abort parameters.",
      "Call fetch_branch and wait for it to complete before rebase_branch when the latest upstream state is required; do not batch rebase_branch with fetch_branch, change_branch, pull_branch, create_branch, push_branch, or pull_request.",
      "If rebase_branch fails or conflicts, rebase_branch automatically attempts git rebase --abort and never leaves conflict resolution to another parallel tool call.",
    ],
    parameters: EmptyParametersSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const details = await rebaseCurrentBranch(pi, ctx, signal);
      return {
        content: [{ type: "text", text: `Rebased current branch ${details.currentBranch} onto ${details.upstream}.` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: INTEGRATE_BRANCH_TOOL_NAME,
    label: "Integrate Branch",
    description: "integrate_branch verifies and merges one exact existing local source branch into one exact existing local target branch from the current clean control worktree, returning an already-integrated, fast-forward, merge-commit, or automatically aborted conflict result. integrate_branch never fetches or pushes.",
    promptSnippet: "integrate_branch: merge an exact local source branch into the checked-out clean local target with verified outcomes and automatic conflict abort",
    promptGuidelines: [
      "Use integrate_branch only when the user explicitly wants one exact existing local source branch integrated into one exact existing local target branch.",
      "Before integrate_branch, require the current clean control worktree to already have targetBranch checked out; integrate_branch never switches branches, stashes, or discards changes.",
      "Use integrate_branch only after local refs already contain the commits to integrate; integrate_branch never fetches or pushes.",
      "Call integrate_branch by itself and wait for it to complete; never batch integrate_branch with other Git mutations.",
      "After integrate_branch completes, run any targeted branch_status ancestry proof separately; never place integrate_branch and branch_status in the same parallel tool batch.",
      "A conflict result from integrate_branch means the merge was automatically aborted and restoration was verified; semantic conflict analysis belongs to a separate delegated workflow, not integrate_branch.",
    ],
    parameters: IntegrateBranchParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await integrateBranch(pi, ctx, params, signal);
      return {
        content: [{ type: "text", text: formatIntegrateBranch(details) }],
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
    description: "pull_request creates a GitHub pull request in the resolved current repository. PR fields are optional only when BRANCHME_PR_AUTOFILL=true; pull_request then infers branches, derives title/body from commit subjects, and defaults draft to false. Branches must exist locally and on GitHub, and headBranch must match the GitHub-visible commit. Owner-prefixed refs, owner, and repo are never accepted as inputs.",
    promptSnippet: "pull_request: create a GitHub pull request with explicit fields or optional configured PR field autofill",
    promptGuidelines: [
      "Use pull_request only when the user explicitly asks to create a pull request; pull_request must not create one merely because a branch was pushed.",
      "When automatic Git context reports pull request field autofill disabled, use pull_request only with explicit headBranch, baseBranch, title, body, and draft values.",
      "When automatic Git context reports pull request field autofill enabled, pull_request may omit fields the user did not provide; prefer the user's explicit values whenever present.",
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
        const branches = await resolvePullRequestBranches(pi, rootCtx, params, options.env, signal);
        const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
        const token = (await resolveGitHubToken(options.env, { cwd: repoRoot, signal })).token;

        try {
          const resolved = await resolvePullRequestInput(pi, rootCtx, params, branches, [token], signal);
          const headBranch = await ensureGitHubBranchExists(repository, resolved.input.headBranch, "headBranch", token, {
            fetchImpl: options.fetchImpl,
            signal,
          });
          await requireGitHubHeadMatchesLocalBranch(pi, rootCtx, resolved.input.headBranch, headBranch.commitSha, signal);
          await ensureGitHubBranchExists(repository, resolved.input.baseBranch, "baseBranch", token, {
            fetchImpl: options.fetchImpl,
            signal,
          });
          const details = await createGitHubPullRequest(repository, resolved.input, token, {
            fetchImpl: options.fetchImpl,
            signal,
          });
          const toolDetails: PullRequestToolDetails = resolved.autofilledFields.length > 0
            ? { ...details, autofilledFields: resolved.autofilledFields }
            : details;
          return {
            content: [{ type: "text", text: formatPullRequest(details, resolved.autofilledFields) }],
            details: toolDetails,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(redactSecrets(message, [token]));
        }
      });
    },
  });

  pi.registerTool({
    name: LIST_WORKTREES_TOOL_NAME,
    label: "List Worktrees",
    description: "list_worktrees reads the current repository's bounded linked-worktree inventory without changing Git or filesystem state. list_worktrees accepts no parameters and reports paths, local branches or detached state, HEADs, and safety indicators.",
    promptSnippet: "list_worktrees: explicitly inspect the bounded current-repository worktree inventory without mutation",
    promptGuidelines: [
      "Use list_worktrees when the user or task explicitly needs the current repository's worktree inventory; list_worktrees is read-only.",
      "Use list_worktrees explicitly because automatic Git context remains focused on the active worktree and does not include worktree inventory.",
    ],
    parameters: EmptyParametersSchema,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const details = await listWorktrees(pi, ctx, signal);
      return {
        content: [{ type: "text", text: formatListWorktrees(details) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: CREATE_WORKTREE_TOOL_NAME,
    label: "Create Worktree",
    description: "create_worktree creates and verifies one linked worktree at an explicit absolute worktreePath for either a new local branch from current HEAD or an existing unoccupied local branch. create_worktree returns exact lossless handoff identity fields and never infers paths, remotes, base refs, detached or orphan modes, or force behavior.",
    promptSnippet: "create_worktree: create and verify a linked worktree at an explicit absolute path with a ready handoff cwd",
    promptGuidelines: [
      "Use create_worktree only when the user explicitly requests worktree creation and provides or approves the exact absolute worktreePath; create_worktree must never infer a filesystem path silently.",
      "Use create_worktree with exactly worktreePath, branchName, and branchMode; create_worktree never accepts force, baseRef, remote, detach, orphan, move, prune, repair, lock, or unlock parameters.",
      "Do not batch create_worktree with dependent worktree mutations; wait for create_worktree to complete and verify its ready exact handoff.cwd before passing that cwd to another agent or session.",
    ],
    parameters: CreateWorktreeParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await createWorktree(
        pi,
        ctx,
        params.worktreePath,
        params.branchName,
        params.branchMode,
        signal,
      );
      return {
        content: [{ type: "text", text: formatCreateWorktree(details) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: REMOVE_WORKTREE_TOOL_NAME,
    label: "Remove Worktree",
    description: "remove_worktree force-free removes one verified clean linked worktree at an explicit absolute worktreePath while retaining and returning its exact local branch identity. remove_worktree rejects main, current, dirty, detached, locked, prunable, missing, and foreign worktrees and never deletes branches.",
    promptSnippet: "remove_worktree: force-free removal of an explicitly selected clean linked worktree while retaining its branch",
    promptGuidelines: [
      "Use remove_worktree only when the user explicitly requests worktree removal and provides or approves the exact absolute worktreePath; remove_worktree must never infer a filesystem path silently.",
      "Use remove_worktree with exactly worktreePath; remove_worktree never accepts force, move, prune, repair, lock, unlock, branch deletion, remote, or refspec parameters.",
      "Do not batch remove_worktree with dependent worktree mutations; wait for remove_worktree to complete and verify its non-ready handoff before continuing.",
    ],
    parameters: RemoveWorktreeParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await removeWorktree(pi, ctx, params.worktreePath, signal);
      return {
        content: [{ type: "text", text: formatRemoveWorktree(details) }],
        details,
      };
    },
  });
}
