import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PULL_REQUEST_STATUS_TOOL_NAME, TRACK_BRANCH_TOOL_NAME, UPDATE_FROM_BASE_TOOL_NAME } from "../constants.ts";
import { getGitRoot, requireCurrentBranch } from "../git.ts";
import { findGitHubPullRequest, getGitHubPullRequest, resolveGitHubRepository, resolveGitHubToken } from "../github.ts";
import type { PullRequestStatusDetails } from "../types.ts";
import type { BranchMeToolOptions } from "./branchme-tools.ts";
import { trackBranch, updateFromBase } from "../git-workflow.ts";

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
    name: UPDATE_FROM_BASE_TOOL_NAME,
    label: "Update From Base",
    description: "update_from_base fetches one remote base and merges its captured commit into the clean current feature branch with verified no-op, fast-forward, merge-commit, or automatically aborted conflict results. Never rebases, pushes, stashes, or changes upstream configuration.",
    promptSnippet: "update_from_base: merge a fresh remote base into the current feature without rewriting published history",
    promptGuidelines: [
      "Use update_from_base only when asked to update the current feature branch from an explicit baseBranch; remote defaults to origin.",
      "Run update_from_base by itself. It fetches the base and uses the fixed normal-merge policy; conflicts are automatically aborted with restoration verified.",
      "update_from_base preserves published history and upstream configuration; committing conflict-resolution changes belongs to a separate workflow.",
    ],
    parameters: Type.Object({
      baseBranch: Type.String({ minLength: 1, description: "Exact base branch on the remote, for example main." }),
      remote: Type.Optional(Type.String({ minLength: 1, description: "Configured remote; defaults to origin." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await updateFromBase(pi, ctx, params, signal);
      return { content: [{ type: "text", text: `update_from_base: ${details.status}. ${details.status === "conflict" ? "Merge aborted and restoration verified; inspect conflict paths in details." : "Base integration verified without rewriting published history."}` }], details };
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
