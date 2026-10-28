import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { editPullRequest, mergePullRequest } from "../github-lifecycle.ts";
import { PULL_REQUEST_CHECKS_TOOL_NAME, EDIT_PULL_REQUEST_TOOL_NAME, MERGE_PULL_REQUEST_TOOL_NAME } from "../constants.ts";
import { openGitHubClient } from "../github-api.ts";
import { getPullRequestChecks } from "../github-checks.ts";
import { inspectionResult } from "./inspection-tools.ts";
import type { BranchMeToolOptions } from "./branchme-tools.ts";
export function registerGitHubLifecycleTools(pi: Pick<ExtensionAPI, "exec" | "registerTool">, options: BranchMeToolOptions): void {
  pi.registerTool({
    name: EDIT_PULL_REQUEST_TOOL_NAME, label: "Edit Pull Request", description: "Update explicit title/body/draft fields of one open PR, preserving omitted fields. Does not retarget or merge.", promptSnippet: "Edit explicit PR metadata",
    promptGuidelines: ["Use edit_pull_request for requested metadata changes only; omitted fields are preserved. Inspect partial/uncertain outcomes before retrying; no automatic rollback occurs."],
    parameters: Type.Object({ number: Type.Integer({ minimum: 1 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), body: Type.Optional(Type.String({ maxLength: 60000 })), draft: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await editPullRequest(await openGitHubClient(pi, ctx, options, signal), params)); },
  });
  pi.registerTool({
    name: MERGE_PULL_REQUEST_TOOL_NAME, label: "Merge Pull Request", description: "Merge an explicitly authorized ready PR on GitHub with an expected-head lease. Never bypasses policy or cleans branches/worktrees.", promptSnippet: "Perform a guarded host PR merge",
    promptGuidelines: ["Use merge_pull_request only with explicit merge authorization, an exact expectedHead and mergeMethod. Unknown/blocked readiness refuses merging. Reconcile uncertain outcomes with pull_request_status before any retry; land_branch remains separate."],
    parameters: Type.Object({ number: Type.Integer({ minimum: 1 }), expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), mergeMethod: StringEnum(["merge", "squash", "rebase"] as const) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await mergePullRequest(await openGitHubClient(pi, ctx, options, signal), params)); },
  });
  pi.registerTool({
    name: PULL_REQUEST_CHECKS_TOOL_NAME, label: "Pull Request Checks", description: "Read all PR check states, legacy statuses, and available host readiness for an exact head. No reruns or mutations.", promptSnippet: "Inspect complete PR checks",
    promptGuidelines: ["Use pull_request_checks for pending/successful as well as failing checks. Follow next with the same number; changed heads, missing permissions or incomplete pages never certify readiness."],
    parameters: Type.Object({ number: Type.Integer({ minimum: 1 }), after: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await getPullRequestChecks(await openGitHubClient(pi, ctx, options, signal), params)); },
  });
}
