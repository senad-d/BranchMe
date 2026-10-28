import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { changeIndex } from "../git-index.ts";
import { restorePaths } from "../git-restore.ts";
import { revertChanges } from "../git-revert.ts";
import { addRemote, listRemotes, setUpstream } from "../git-remotes.ts";
import { ADD_REMOTE_TOOL_NAME, LIST_REMOTES_TOOL_NAME, SET_UPSTREAM_TOOL_NAME, STAGE_CHANGES_TOOL_NAME, UNSTAGE_CHANGES_TOOL_NAME, RESTORE_PATHS_TOOL_NAME, REVERT_CHANGES_TOOL_NAME } from "../constants.ts";
import { WorktreeSelector, inspectionResult, inspectionTokens } from "./inspection-tools.ts";
import type { BranchMeToolOptions } from "./branchme-tools.ts";

export const IndexProperties = {
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 25, description: "Exact approved files only, 8 KiB combined; no directories, all-files, globs, or automatic rename expansion." }),
  expectedHead: Type.Union([Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), Type.Null()], { description: "Captured HEAD from git_status, or null before the first commit." }),
  expectedIndex: Type.String({ pattern: "^[a-f0-9]{64}$", description: "Logical index fingerprint from git_status." }),
  worktreePath: WorktreeSelector,
};
export function registerMutationTools(pi: Pick<ExtensionAPI, "exec" | "registerTool">, options: BranchMeToolOptions): void {
  pi.registerTool({
    name: RESTORE_PATHS_TOOL_NAME, label: "Restore Selected Files", description: "Preview or explicitly discard selected tracked working-file edits while preserving index/HEAD. Never cleans untracked files.", promptSnippet: "Restore explicitly approved tracked paths",
    promptGuidelines: ["Use restore_paths preview first, then apply only with explicit discardChanges authorization and its expectedFiles. Pin sourceRef to preview sourceCommit; stale file/index expectations refuse restoration."],
    parameters: Type.Object({ ...IndexProperties, sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), preview: Type.Optional(Type.Boolean()), discardChanges: Type.Optional(Type.Boolean()), expectedFiles: Type.Optional(Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }), { minItems: 1, maxItems: 25 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await restorePaths(pi, ctx, params, signal, inspectionTokens(options))); },
  });
  pi.registerTool({
    name: REVERT_CHANGES_TOOL_NAME, label: "Prepare Revert", description: "Stage the inverse of one non-merge commit without creating a commit. Conflicts attempt verified abort/restoration.", promptSnippet: "Prepare a no-commit revert",
    promptGuidelines: ["Use revert_changes only for an explicitly requested inverse with a clean idle checkout and fresh expectations. Never commit automatically; uncertain recovery requires inspection and a person's decision."],
    parameters: Type.Object({ commit: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), expectedIndex: IndexProperties.expectedIndex, worktreePath: WorktreeSelector }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await revertChanges(pi, ctx, params, signal, inspectionTokens(options))); },
  });
  for (const name of [STAGE_CHANGES_TOOL_NAME, UNSTAGE_CHANGES_TOOL_NAME]) {
    pi.registerTool({
      name, label: name === STAGE_CHANGES_TOOL_NAME ? "Stage Changes" : "Unstage Changes",
      description: name === STAGE_CHANGES_TOOL_NAME ? "Stage exact approved files after HEAD/index checks. Preserves working files; never commits." : "Unstage exact files to captured HEAD, preserving working files. Never commits or discards edits.",
      promptSnippet: name === STAGE_CHANGES_TOOL_NAME ? "Stage selected files" : "Unstage selected files",
      promptGuidelines: [`Use ${name} only for requested exact paths with fresh git_status expectations. Both rename sides require approval; active operations and unsupported indexes are refused.`],
      parameters: Type.Object(IndexProperties, { additionalProperties: false }),
      async execute(_id, params, signal, _update, ctx) { return inspectionResult(await changeIndex(pi, ctx, params, name as "stage_changes" | "unstage_changes", signal, inspectionTokens(options))); },
    });
  }
  pi.registerTool({
    name: LIST_REMOTES_TOOL_NAME, label: "List Remotes", description: "Read configured and effective remote destinations with a configuration fingerprint. No network access.", promptSnippet: "Inspect remotes and configuration",
    promptGuidelines: [],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) { return inspectionResult(await listRemotes(pi, ctx, signal, inspectionTokens(options))); },
  });
  pi.registerTool({
    name: ADD_REMOTE_TOOL_NAME, label: "Add Remote", description: "Add an unused remote with a credential-free HTTPS or SSH destination. Does not fetch or overwrite remotes.", promptSnippet: "Configure a new remote",
    promptGuidelines: ["Use add_remote only for explicitly requested setup, with expectedConfig from list_remotes. Fetch separately; URL rewriting and existing names are refused."],
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), url: Type.String({ minLength: 1, maxLength: 2048 }), expectedConfig: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await addRemote(pi, ctx, params, signal, inspectionTokens(options))); },
  });
  pi.registerTool({
    name: SET_UPSTREAM_TOOL_NAME, label: "Set Upstream", description: "Set or unset one local branch's tracking configuration without switching, fetching, or pushing.", promptSnippet: "Configure branch tracking",
    promptGuidelines: ["Use set_upstream with expectedConfig from list_remotes and an existing remote-tracking branch, or unset: true. Never change tracking merely to select a rebase base."],
    parameters: Type.Object({ branchName: Type.String({ minLength: 1, maxLength: 512 }), upstream: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), unset: Type.Optional(Type.Boolean()), expectedConfig: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) { return inspectionResult(await setUpstream(pi, ctx, params, signal, inspectionTokens(options))); },
  });
}
