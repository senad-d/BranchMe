import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CONCLUDE_MERGE_TOOL_NAME, GIT_CONTEXT_VALUE_LIMIT_CHARS, PULL_REQUEST_FEEDBACK_TOOL_NAME, PULL_REQUEST_STATUS_TOOL_NAME,
  TRACK_BRANCH_TOOL_NAME, UPDATE_FROM_BASE_TOOL_NAME,
} from "../constants.ts";
import { getGitRoot, requireCurrentBranch, safeWorktreeValue } from "../git.ts";
import { concludeMerge, formatConflictPathList } from "../git-integration.ts";
import { findGitHubPullRequest, getGitHubPullRequest, resolveGitHubRepository, resolveGitHubToken } from "../github.ts";
import { formatPullRequestFeedback, getPullRequestFeedback } from "../github-feedback.ts";
import type { ConcludeMergeDetails, PullRequestStatusDetails } from "../types.ts";
import type { BranchMeToolOptions } from "./branchme-tools.ts";
import { trackBranch, updateFromBase, type UpdateFromBaseDetails } from "../git-workflow.ts";

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function branchLabel(branch: string): string {
  return safeWorktreeValue(branch, GIT_CONTEXT_VALUE_LIMIT_CHARS);
}

export function formatUpdateFromBase(details: UpdateFromBaseDetails): string {
  const { integration } = details;
  const source = branchLabel(integration.request.sourceBranch);
  const target = branchLabel(integration.request.targetBranch);
  if (integration.status === "conflict") {
    return formatConflictPathList(
      `update_from_base: conflict. Merging ${source} into ${target} conflicted; the merge was automatically aborted and restoration was verified at HEAD ${shortCommit(integration.verified.heads.after.targetHead)}. Rerun with keepConflicts: true to keep the conflicted merge in progress for resolution.`,
      integration.conflict,
    );
  }
  if (integration.status === "conflict_kept") {
    return formatConflictPathList(
      `update_from_base: conflict_kept. Merging ${source} (${shortCommit(integration.heads.sourceHead)}) into ${target} conflicted; the merge is in progress with MERGE_HEAD set and HEAD unchanged at ${shortCommit(integration.heads.targetHead)}. Remove the conflict markers in the listed paths, then run conclude_merge with action "conclude" to commit the merge or action "abort" to restore the branch.`,
      integration.conflict,
    );
  }
  return `update_from_base: ${integration.status}. Base integration verified without rewriting published history.`;
}

export function formatConcludeMerge(details: ConcludeMergeDetails): string {
  const branch = branchLabel(details.branch);
  if (details.status === "aborted") {
    return `conclude_merge: aborted. git merge --abort restored ${branch} to HEAD ${shortCommit(details.head)}; MERGE_HEAD ${shortCommit(details.mergeHead)} is cleared, no Git operation is in progress, and the working tree is clean.`;
  }
  const count = details.resolvedPaths.length;
  return formatConflictPathList(
    `conclude_merge: concluded. Committed merge ${shortCommit(details.heads.after)} on ${branch} with parents ${shortCommit(details.parents.first)} (previous HEAD) and ${shortCommit(details.parents.second)} (MERGE_HEAD); MERGE_HEAD is cleared and both parents were verified. Only the ${count} resolved path${count === 1 ? "" : "s"} listed below ${count === 1 ? "was" : "were"} staged during this call; other working-tree changes remain unstaged. The commit includes all previously staged entries.`,
    { paths: details.resolvedPaths, omitted: 0 },
    "Resolved paths:",
    "resolved path",
  );
}

function formatPullRequestStatus(pullRequest: PullRequestStatusDetails | null): string {
  if (!pullRequest) return "No matching pull request found.";
  const state = pullRequest.merged ? "merged" : pullRequest.state;
  const draft = pullRequest.draft ? " (draft)" : "";
  return `PR #${pullRequest.number}: ${state}${draft}; ${pullRequest.head} -> ${pullRequest.base}. ${pullRequest.url}`;
}

export function registerWorkflowTools(pi: Pick<ExtensionAPI, "registerTool" | "exec">, options: BranchMeToolOptions = {}): void {
  pi.registerTool({
    name: PULL_REQUEST_STATUS_TOOL_NAME,
    label: "Pull Request Status",
    description: "pull_request_status reads one same-repository GitHub PR by number, or the most recently updated PR for a head branch (current branch by default). Reports open/closed/merged state and exact head/base/merge identities. No mutations; not a CI-check or review-approval verdict.",
    promptSnippet: "pull_request_status: inspect open, closed, or merged PR state and immutable commit identities",
    promptGuidelines: [
      "Use pull_request_status with number for exact lifecycle verification; number and headBranch are mutually exclusive.",
      "Without number, pull_request_status returns the most recently updated PR for headBranch or the current branch. Prefer its exact number for subsequent checks.",
      "pull_request_status never merges, edits, closes, or deletes a PR and does not claim CI checks or review requirements passed.",
    ],
    parameters: Type.Object({
      number: Type.Optional(Type.Integer({ minimum: 1, description: "Exact PR number; mutually exclusive with headBranch." })),
      headBranch: Type.Optional(Type.String({ minLength: 1, description: "Head branch to look up; defaults to current branch when number is omitted." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.number !== undefined && params.headBranch !== undefined) throw new Error("Supply number or headBranch, not both.");
      const rootCtx = { cwd: await getGitRoot(pi, ctx, signal) };
      const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
      const token = (await resolveGitHubToken(options.env, { cwd: rootCtx.cwd, signal })).token;
      const requestOptions = { fetchImpl: options.fetchImpl, signal };
      const pullRequest = params.number === undefined
        ? await findGitHubPullRequest(repository, params.headBranch ?? await requireCurrentBranch(pi, rootCtx, signal), token, requestOptions)
        : await getGitHubPullRequest(repository, params.number, token, requestOptions);
      return {
        content: [{ type: "text", text: formatPullRequestStatus(pullRequest) }],
        details: { action: "pull_request_status", pullRequest },
      };
    },
  });
  pi.registerTool({
    name: PULL_REQUEST_FEEDBACK_TOOL_NAME,
    label: "Pull Request Feedback",
    description: "pull_request_feedback reads what a same-repository GitHub PR asks to be fixed: unresolved review threads with their comments, review summaries, conversation comments, and the head commit's failing checks with the log tail of up to three failing GitHub Actions jobs. Resolved and outdated threads are counted, not listed. No mutations.",
    promptSnippet: "pull_request_feedback: read a PR's unresolved review comments and failing checks with their log tails",
    promptGuidelines: [
      "Use pull_request_feedback with number to collect the review comments and failing checks a follow-up must address; number and headBranch are mutually exclusive.",
      "Without number, pull_request_feedback reads the most recently updated PR for headBranch or the current branch.",
      "pull_request_feedback never comments, resolves threads, reruns checks, or edits the PR; a job log that cannot be read is reported per check, not as a failure of the call.",
    ],
    parameters: Type.Object({
      number: Type.Optional(Type.Integer({ minimum: 1, description: "Exact PR number; mutually exclusive with headBranch." })),
      headBranch: Type.Optional(Type.String({ minLength: 1, description: "Head branch to look up; defaults to current branch when number is omitted." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.number !== undefined && params.headBranch !== undefined) throw new Error("Supply number or headBranch, not both.");
      const rootCtx = { cwd: await getGitRoot(pi, ctx, signal) };
      const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
      const token = (await resolveGitHubToken(options.env, { cwd: rootCtx.cwd, signal })).token;
      const requestOptions = { fetchImpl: options.fetchImpl, signal };
      let number = params.number;
      if (number === undefined) {
        const found = await findGitHubPullRequest(repository, params.headBranch ?? await requireCurrentBranch(pi, rootCtx, signal), token, requestOptions);
        if (!found) return { content: [{ type: "text", text: "No matching pull request found." }], details: { action: "pull_request_feedback", feedback: null } };
        number = found.number;
      }
      const feedback = await getPullRequestFeedback(repository, number, token, requestOptions);
      return { content: [{ type: "text", text: formatPullRequestFeedback(feedback) }], details: { action: "pull_request_feedback", feedback } };
    },
  });
  pi.registerTool({
    name: UPDATE_FROM_BASE_TOOL_NAME,
    label: "Update From Base",
    description: "update_from_base fetches one remote base and merges its captured commit into the clean current feature branch with verified no-op, fast-forward, merge-commit, or conflict results. A conflict is automatically aborted with restoration verified unless keepConflicts is true, which leaves the conflicted merge in progress for conclude_merge. Never rebases, pushes, stashes, or changes upstream configuration.",
    promptSnippet: "update_from_base: merge a fresh remote base into the current feature without rewriting published history; keepConflicts keeps a conflicted merge in progress",
    promptGuidelines: [
      "Use update_from_base only when asked to update the current feature branch from an explicit baseBranch; remote defaults to origin.",
      "Run update_from_base by itself. It fetches the base and uses the fixed normal-merge policy; by default conflicts are automatically aborted with restoration verified and the conflict paths are listed.",
      "Pass keepConflicts: true to update_from_base only when a file-editing step will resolve the listed paths; the result conflict_kept leaves MERGE_HEAD set, and conclude_merge must then conclude or abort it before any other Git mutation.",
      "update_from_base preserves published history and upstream configuration; it never resolves conflict content itself.",
    ],
    parameters: Type.Object({
      baseBranch: Type.String({ minLength: 1, description: "Exact base branch on the remote, for example main." }),
      remote: Type.Optional(Type.String({ minLength: 1, description: "Configured remote; defaults to origin." })),
      keepConflicts: Type.Optional(Type.Boolean({ description: "When true, a conflicted merge is left in progress (MERGE_HEAD set, conflicted paths unmerged) for conclude_merge instead of being aborted; defaults to false." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await updateFromBase(pi, ctx, params, signal);
      return { content: [{ type: "text", text: formatUpdateFromBase(details) }], details };
    },
  });
  pi.registerTool({
    name: CONCLUDE_MERGE_TOOL_NAME,
    label: "Conclude Merge",
    description: "conclude_merge finishes or abandons the in-progress merge on the current checkout, normally one kept by update_from_base with keepConflicts: true. action \"conclude\" checks unmerged working-tree paths and staged blobs for default/custom-sized conflict marker lines, stages exactly the unmerged paths, checks the candidate index again, and commits the full index with Git's prepared merge message, then verifies the two-parent result; action \"abort\" runs git merge --abort and verifies restoration. conclude_merge never stages other changes, accepts no commit message, and never pushes.",
    promptSnippet: "conclude_merge: commit or abort the kept in-progress merge after conflict markers are removed",
    promptGuidelines: [
      "Use conclude_merge only after update_from_base reported conflict_kept, or when a single-head merge is otherwise in progress on the current checkout; run conclude_merge by itself. Multi-head merges are refused before mutation.",
      "Before conclude_merge with action conclude, a file-editing step must remove every <<<<<<<, |||||||, =======, and >>>>>>> marker line from the listed paths; conclude_merge refuses and names the paths that still contain markers.",
      "conclude_merge with action conclude stages only the currently unmerged paths and uses Git's prepared merge message; unrelated unstaged edits stay unstaged and are not part of the merge commit. Git commits the entire index, including previously staged entries: do not stage unrelated edits during the merge.",
      "conclude_merge with action abort restores the branch with git merge --abort and verifies a clean idle checkout; conclude_merge refuses when no merge is in progress.",
    ],
    parameters: Type.Object({
      action: StringEnum(["conclude", "abort"] as const, {
        description: "conclude stages the resolved formerly unmerged paths and commits the merge; abort runs git merge --abort and verifies restoration.",
      }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await concludeMerge(pi, ctx, params, signal);
      return { content: [{ type: "text", text: formatConcludeMerge(details) }], details };
    },
  });
  pi.registerTool({
    name: TRACK_BRANCH_TOOL_NAME,
    label: "Track Branch",
    description: "track_branch fetches one exact remote branch, creates and checks out a new local tracking branch, and verifies HEAD/upstream. Requires a clean idle checkout. Never forces, stashes, commits, or pushes.",
    promptSnippet: "track_branch: join an existing remote branch with a verified local tracking checkout",
    promptGuidelines: [
      "Use track_branch only when explicitly asked to create and check out a local branch tracking an existing remote branch.",
      "Run track_branch by itself; it fetches before checkout. Supply branchName and optionally remote (default origin) and remoteBranch (default branchName).",
      "track_branch rejects existing local branches and dirty or in-progress worktrees; it never stashes or discards changes.",
    ],
    parameters: Type.Object({
      branchName: Type.String({ minLength: 1, description: "New local branch name." }),
      remote: Type.Optional(Type.String({ minLength: 1, description: "Configured remote; defaults to origin." })),
      remoteBranch: Type.Optional(Type.String({ minLength: 1, description: "Existing branch on that remote; defaults to branchName." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await trackBranch(pi, ctx, params, signal);
      return { content: [{ type: "text", text: `Checked out ${details.branchName} tracking ${details.upstream} at ${details.head}.` }], details };
    },
  });
}
