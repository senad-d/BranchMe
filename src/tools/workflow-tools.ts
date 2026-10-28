import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CONCLUDE_MERGE_TOOL_NAME, GIT_CONTEXT_VALUE_LIMIT_CHARS, PULL_REQUEST_FEEDBACK_TOOL_NAME, PULL_REQUEST_REPLY_BODY_LIMIT_CHARS,
  LABEL_PULL_REQUEST_TOOL_NAME, PULL_REQUEST_FILES_TOOL_NAME, PULL_REQUEST_LABEL_LIMIT, PULL_REQUEST_STATUS_TOOL_NAME,
  REPLY_PULL_REQUEST_FEEDBACK_TOOL_NAME, TRACK_BRANCH_TOOL_NAME, UPDATE_FROM_BASE_TOOL_NAME,
} from "../constants.ts";
import { getGitRoot, requireCurrentBranch, resolveRepositoryWorktreeCwd, safeWorktreeValue } from "../git.ts";
import { concludeMerge, formatConflictPathList } from "../git-integration.ts";
import { findGitHubPullRequest, getGitHubPullRequest, resolveGitHubRepository, resolveGitHubToken } from "../github.ts";
import {
  formatPullRequestFeedback, formatPullRequestFiles, formatPullRequestLabel, formatPullRequestReply, getPullRequestFeedback,
  getPullRequestFiles, labelPullRequest, replyPullRequestFeedback,
} from "../github-feedback.ts";
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
    return `conclude_merge: aborted. git merge --abort restored ${branch} to HEAD ${shortCommit(details.head)}; MERGE_HEAD ${shortCommit(details.mergeHead)} is cleared, no Git operation is in progress, and tracked files are clean.`;
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
    description: "Read a GitHub PR's open, closed, or merged state and commit identities. Does not certify CI success or review approval.",
    promptSnippet: "Check PR lifecycle state",
    promptGuidelines: [
      "Branch lookup in pull_request_status selects the latest updated PR, not only open PRs; prefer its exact number afterward.",
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
    description: "Read unresolved PR reviews, conversation comments, and failing CI checks with annotations and log tails. Read-only.",
    promptSnippet: "Read PR feedback and CI failures",
    promptGuidelines: [
      "Branch lookup in pull_request_feedback selects the latest updated PR; prefer its exact number afterward. Unreadable job logs are reported per check.",
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
    name: REPLY_PULL_REQUEST_FEEDBACK_TOOL_NAME,
    label: "Reply To Pull Request Feedback",
    description: "Post a PR comment or review-thread reply, optionally resolving the thread.",
    promptSnippet: "Comment on a PR or reply to review",
    promptGuidelines: [
      "Use reply_pull_request_feedback once per thread, describing the fix or why it was not made.",
      "Resolve with reply_pull_request_feedback only when the request is addressed; leave threads needing a person's decision open.",
    ],
    parameters: Type.Object({
      number: Type.Integer({ minimum: 1, description: "PR number." }),
      body: Type.String({ minLength: 1, maxLength: PULL_REQUEST_REPLY_BODY_LIMIT_CHARS, description: "Markdown text to publish as a new PR comment or thread reply, not an edit to an existing comment." }),
      threadId: Type.Optional(Type.String({ minLength: 1, description: "Review thread id from pull_request_feedback; omit for a conversation comment." })),
      resolve: Type.Optional(Type.Boolean({ description: "Resolve the thread after replying; requires threadId." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const rootCtx = { cwd: await getGitRoot(pi, ctx, signal) };
      const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
      const token = (await resolveGitHubToken(options.env, { cwd: rootCtx.cwd, signal })).token;
      const details = await replyPullRequestFeedback(repository, params, token, { fetchImpl: options.fetchImpl, signal });
      return { content: [{ type: "text", text: formatPullRequestReply(details) }], details };
    },
  });
  pi.registerTool({
    name: PULL_REQUEST_FILES_TOOL_NAME,
    label: "Pull Request Files",
    description: "List a PR's changed file paths, line counts, and current labels. Does not return patches or file contents.",
    promptSnippet: "List files changed by a PR",
    promptGuidelines: [],
    parameters: Type.Object({
      number: Type.Integer({ minimum: 1, description: "PR number." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const rootCtx = { cwd: await getGitRoot(pi, ctx, signal) };
      const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
      const token = (await resolveGitHubToken(options.env, { cwd: rootCtx.cwd, signal })).token;
      const details = await getPullRequestFiles(repository, params.number, token, { fetchImpl: options.fetchImpl, signal });
      return { content: [{ type: "text", text: formatPullRequestFiles(details) }], details };
    },
  });
  pi.registerTool({
    name: LABEL_PULL_REQUEST_TOOL_NAME,
    label: "Label Pull Request",
    description: "Add existing repository labels to a PR, preserving its current labels. Refuses unknown labels.",
    promptSnippet: "Add labels to a PR",
    promptGuidelines: [
      "Use label_pull_request only with exact existing label names from the assignment or repository.",
    ],
    parameters: Type.Object({
      number: Type.Integer({ minimum: 1, description: "PR number." }),
      labels: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: PULL_REQUEST_LABEL_LIMIT, description: "Exact names of existing labels." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const rootCtx = { cwd: await getGitRoot(pi, ctx, signal) };
      const repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env);
      const token = (await resolveGitHubToken(options.env, { cwd: rootCtx.cwd, signal })).token;
      const details = await labelPullRequest(repository, params.number, params.labels, token, { fetchImpl: options.fetchImpl, signal });
      return { content: [{ type: "text", text: formatPullRequestLabel(details) }], details };
    },
  });
  pi.registerTool({
    name: UPDATE_FROM_BASE_TOOL_NAME,
    label: "Update From Base",
    description: "Fetch and merge a remote base into the current branch without rewriting history. Conflicts abort unless explicitly kept.",
    promptSnippet: "Merge a fresh remote base",
    promptGuidelines: [
      "Use update_from_base only for a requested remote-base update; run it alone.",
      "Keep update_from_base conflicts only with a planned editing step; for conflict_kept, use conclude_merge to commit or abort before another Git mutation.",
    ],
    parameters: Type.Object({
      baseBranch: Type.String({ minLength: 1, description: "Branch name on remote to fetch and merge, for example main, not origin/main. The current branch is the merge destination." }),
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
    description: "Commit or abort an existing merge. Concluding stages resolved conflicts and commits the entire index; it does not resolve conflicts.",
    promptSnippet: "Commit or abort an existing merge",
    promptGuidelines: [
      "Before conclude_merge, resolve conflicts and remove all marker lines, including diff3/custom-sized markers; both working-tree and index content are checked. This editing requirement does not apply to abort.",
      "Run conclude_merge alone. Concluding commits the entire index, including previously staged entries; do not stage unrelated edits.",
    ],
    parameters: Type.Object({
      action: StringEnum(["conclude", "abort"] as const, {
        description: "conclude: after conflicts are resolved, stage currently unmerged paths and commit the entire index as a merge. abort: abandon the merge and verify restoration. Neither action resolves conflict contents.",
      }),
      worktreePath: Type.Optional(Type.String({ minLength: 1, description: "Absolute root path of another worktree of the same repository to act on; omit for the current one." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const target = params.worktreePath === undefined ? ctx : { cwd: await resolveRepositoryWorktreeCwd(pi, ctx, params.worktreePath, signal) };
      const details = await concludeMerge(pi, target, params, signal);
      return { content: [{ type: "text", text: formatConcludeMerge(details) }], details };
    },
  });
  pi.registerTool({
    name: TRACK_BRANCH_TOOL_NAME,
    label: "Track Branch",
    description: "Fetch an existing remote branch, create a new local tracking branch, and switch to it.",
    promptSnippet: "Check out a remote branch locally",
    promptGuidelines: [
      "Use track_branch only for requested remote-branch checkout; run it alone. Existing local branches require change_branch.",
    ],
    parameters: Type.Object({
      branchName: Type.String({ minLength: 1, description: "Unused local branch name to create and switch to; existing local branches require change_branch." }),
      remote: Type.Optional(Type.String({ minLength: 1, description: "Configured remote; defaults to origin." })),
      remoteBranch: Type.Optional(Type.String({ minLength: 1, description: "Existing branch name on remote, for example topic, not origin/topic; defaults to branchName." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await trackBranch(pi, ctx, params, signal);
      return { content: [{ type: "text", text: `Checked out ${details.branchName} tracking ${details.upstream} at ${details.head}.` }], details };
    },
  });
}
