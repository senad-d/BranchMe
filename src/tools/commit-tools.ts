import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { COMMIT_CHANGES_TOOL_NAME } from "../constants.ts";
import { CommitError, assertNoUnsafeCommitFiles, createCommit, scopeChangedFilesToPaths, validateCommitMessage } from "../git-commit.ts";
import { gatherGitContext } from "../git-commit-context.ts";
import type { DraftCommitMessageDependency } from "../commit-draft.ts";
import { buildBoundedCommitPrompt } from "../commit-prompt.ts";
import type { CommitChangesDetails, CommitResult, GitContext } from "../types.ts";
import { collectGitContextTruncation, createCommitDetails, createUnsafeCommitFileApproval, draftAndCreateCommit } from "../commit-workflow.ts";

const COMMIT_CHANGES_ACTIONS = ["gather", "commit"] as const;

export const CommitChangesParameters = Type.Object({
  action: Type.Optional(
    StringEnum(COMMIT_CHANGES_ACTIONS, {
      description: "Use gather to collect commit context. Use commit to create a local commit with either an explicit message or a drafted message when message is omitted.",
      default: "gather",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description:
        "When present with action=commit, use this final one-line Lightweight Conventional Commit subject. When omitted with action=commit, the subject is drafted with the active model. Empty or whitespace-only values are invalid explicit messages.",
    }),
  ),
  steeringPrompt: Type.Optional(
    Type.String({
      description:
        "Optional user guidance to include in gather prompts and message-less commit drafting prompts. Guides message wording only; it never limits which paths are staged or committed. Use paths for that.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "With action=commit, an allowlist of exact repo-relative paths to stage and commit. Only listed paths enter the commit; the commit is refused when a listed path has no changes or when staged changes outside the list would be committed. When omitted, all changed paths are committed.",
    }),
  ),
  confirm: Type.Optional(Type.Boolean({ description: "Ask before creating the local commit when UI is available." })),
}, { additionalProperties: false });

export type CommitChangesInput = Static<typeof CommitChangesParameters>;

export interface CreateCommitChangesToolOptions {
  draftCommitMessage?: DraftCommitMessageDependency;
}

type CommitChangesResult = AgentToolResult<CommitChangesDetails>;

type DraftedCommitResult = Awaited<ReturnType<typeof draftAndCreateCommit>>;

interface CommitChangesRuntime {
  pi: Pick<ExtensionAPI, "exec">;
  options: CreateCommitChangesToolOptions;
  params: CommitChangesInput;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
  cwd: string;
}

function requireValidCommitMessage(message: string | undefined): string {
  if (!message || message.trim().length === 0) {
    throw new Error("commit_changes action=commit requires a final one-line Lightweight Conventional Commit subject.");
  }

  const validation = validateCommitMessage(message);
  if (!validation.ok) {
    throw new Error(`commit_changes action=commit received an invalid Lightweight Conventional Commit subject: ${validation.error}`);
  }
  return validation.subject;
}

function requireConfirmationUi(ctx: ExtensionContext, confirm: boolean | undefined): void {
  if (confirm && !ctx.hasUI) {
    throw new Error("commit_changes confirm=true requires a UI-capable Pi mode.");
  }
}

async function confirmCommit(ctx: ExtensionContext, message: string, confirm: boolean | undefined): Promise<boolean> {
  requireConfirmationUi(ctx, confirm);
  if (!confirm) return true;
  return ctx.ui.confirm("BranchMe: create commit?", `Commit with this message?\n\n${message}`);
}

function cancelledCommitResult(context: GitContext): CommitChangesResult {
  return {
    content: [{ type: "text", text: "Commit cancelled; no git mutation was performed." }],
    details: createCommitDetails("commit", context),
  };
}

function committedResult(context: GitContext, committed: CommitResult): CommitChangesResult {
  return {
    content: [{ type: "text", text: `Committed ${committed.commitHash}: ${committed.subject}` }],
    details: createCommitDetails("commit", context, { committed }),
  };
}

function blockedCommitResult(context: GitContext): CommitChangesResult {
  return {
    content: [{ type: "text", text: "Commit blocked because potentially unsafe files were not approved." }],
    details: createCommitDetails("commit", context),
  };
}

function draftedCommitResult(result: DraftedCommitResult): CommitChangesResult {
  if (result.status === "no-changes") {
    return {
      content: [{ type: "text", text: "No staged or unstaged git changes found; no commit was created." }],
      details: result.details,
    };
  }

  if (result.status === "cancelled") {
    return {
      content: [{ type: "text", text: "Commit cancelled; no git mutation was performed." }],
      details: result.details,
    };
  }

  if (result.status === "blocked") {
    return {
      content: [{ type: "text", text: "Commit blocked because potentially unsafe files were not approved." }],
      details: result.details,
    };
  }

  return {
    content: [{ type: "text", text: `Committed ${result.committed.commitHash}: ${result.committed.subject}` }],
    details: result.details,
  };
}

async function executeExplicitCommit(runtime: CommitChangesRuntime): Promise<CommitChangesResult> {
  const message = requireValidCommitMessage(runtime.params.message);
  requireConfirmationUi(runtime.ctx, runtime.params.confirm);

  const context = await gatherGitContext(runtime.pi, { cwd: runtime.cwd, signal: runtime.signal });
  const scopedFiles = runtime.params.paths ? scopeChangedFilesToPaths(context.changedFiles, runtime.params.paths) : context.changedFiles;
  const approveUnsafeCommitFiles = createUnsafeCommitFileApproval(runtime.ctx);
  if (!approveUnsafeCommitFiles) assertNoUnsafeCommitFiles(scopedFiles);

  if (!(await confirmCommit(runtime.ctx, message, runtime.params.confirm))) {
    return cancelledCommitResult(context);
  }

  try {
    const committed = await createCommit(runtime.pi, {
      cwd: runtime.cwd,
      signal: runtime.signal,
      message,
      paths: runtime.params.paths,
      expectedStatusPorcelain: context.statusPorcelain,
      approveUnsafeCommitFiles,
    });
    return committedResult(context, committed);
  } catch (error) {
    if (error instanceof CommitError && error.code === "unsafe-sensitive-files-blocked") {
      return blockedCommitResult(context);
    }
    throw error;
  }
}

async function executeDraftedCommit(runtime: CommitChangesRuntime): Promise<CommitChangesResult> {
  requireConfirmationUi(runtime.ctx, runtime.params.confirm);

  const approveUnsafeCommitFiles = createUnsafeCommitFileApproval(runtime.ctx);
  const result = await draftAndCreateCommit(runtime.pi, {
    cwd: runtime.cwd,
    signal: runtime.signal,
    steeringPrompt: runtime.params.steeringPrompt,
    paths: runtime.params.paths,
    draftContext: { model: runtime.ctx.model, modelRegistry: runtime.ctx.modelRegistry, signal: runtime.signal },
    ...(runtime.options.draftCommitMessage ? { draftCommitMessage: runtime.options.draftCommitMessage } : {}),
    ...(approveUnsafeCommitFiles ? { approveUnsafeCommitFiles } : {}),
    ...(runtime.params.confirm
      ? { confirmCommit: (subject: string) => runtime.ctx.ui.confirm("BranchMe: create commit?", `Commit with this message?\n\n${subject}`) }
      : {}),
  });

  return draftedCommitResult(result);
}

async function executeCommit(runtime: CommitChangesRuntime): Promise<CommitChangesResult> {
  if (runtime.params.message !== undefined) return executeExplicitCommit(runtime);
  return executeDraftedCommit(runtime);
}

async function executeGather(runtime: CommitChangesRuntime): Promise<CommitChangesResult> {
  const context = await gatherGitContext(runtime.pi, { cwd: runtime.cwd, signal: runtime.signal });
  const prompt = buildBoundedCommitPrompt(context, {
    steeringPrompt: runtime.params.steeringPrompt,
    modelContextWindow: runtime.ctx.model?.contextWindow,
    modelMaxTokens: runtime.ctx.model?.maxTokens,
  });
  const details = createCommitDetails("gather", context, {
    ...(runtime.params.steeringPrompt ? { steeringPrompt: runtime.params.steeringPrompt } : {}),
    truncation: [...collectGitContextTruncation(context), ...prompt.truncation],
    prompt: prompt.diagnostics,
  });
  const content = [
    "commit_changes gathered local git context. Use the instructions below to produce exactly one Lightweight Conventional Commit subject line as your next assistant response. Do not summarize this prompt.",
    "",
    prompt.text,
  ].join("\n");

  return {
    content: [{ type: "text", text: content }],
    details,
  };
}

export function createCommitChangesTool(pi: Pick<ExtensionAPI, "exec">, options: CreateCommitChangesToolOptions = {}) {
  return defineTool({
    name: COMMIT_CHANGES_TOOL_NAME,
    label: "Commit Changes",
    description: "Gather commit context or create a local Conventional Commit from current changes. Never pushes.",
    promptSnippet: "Draft or create a local commit",
    promptGuidelines: [
      "Use commit_changes action=gather when a commit message is requested without a commit; then reply with exactly one Lightweight Conventional Commit subject.",
      "Use commit_changes action=commit only when a local commit is explicitly requested; omit message to draft one, or pass an already chosen final subject.",
      "Pass commit_changes paths to commit only exact approved repo-relative files; steeringPrompt guides wording only. Set confirm only when the user wants to review first.",
    ],
    parameters: CommitChangesParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = { pi, options, params, signal, ctx, cwd: ctx.cwd };
      const action = params.action ?? "gather";
      if (action === "commit") return executeCommit(runtime);
      return executeGather(runtime);
    },
  });
}

export function registerCommitTools(pi: Pick<ExtensionAPI, "exec" | "registerTool">): void {
  pi.registerTool(createCommitChangesTool(pi));
}
