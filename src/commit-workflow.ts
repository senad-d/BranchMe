import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  draftCommitMessageWithActiveModelDiagnostics,
  type DraftCommitMessageContext,
  type DraftCommitMessageDependency,
  type DraftCommitMessageResult,
} from "./commit-draft.ts";
import { buildBoundedCommitPrompt } from "./commit-prompt.ts";
import {
  CommitError,
  assertNoUnsafeCommitFiles,
  createCommit,
  describeUnsafeCommitFileReason,
  scopeChangedFilesToPaths,
  validateCommitMessage,
} from "./git-commit.ts";
import { gatherGitContext } from "./git-commit-context.ts";
import { collectTruncationMetadata, formatDisplayPath } from "./truncation.ts";
import type {
  ChangedFile,
  CommitChangesDetails,
  CommitPromptPayload,
  CommitResult,
  GitContext,
  TruncationMetadata,
  UnsafeCommitFileApproval,
} from "./types.ts";

export function collectGitContextTruncation(context: GitContext): TruncationMetadata[] {
  return collectTruncationMetadata([
    context.staged,
    context.unstaged,
    ...context.project.metadata,
    ...context.project.changedFileSnippets,
  ]);
}

type CommitDetailsExtra = Omit<Partial<CommitChangesDetails>, "action">;

export function createCommitDetails(
  action: CommitChangesDetails["action"],
  context: GitContext,
  extra: CommitDetailsExtra = {},
): CommitChangesDetails {
  const { truncation = collectGitContextTruncation(context), ...rest } = extra;

  return {
    action,
    repositoryRoot: context.repositoryRoot,
    branch: context.branch,
    statusPorcelain: context.statusPorcelain,
    hasChanges: context.hasChanges,
    changedFiles: context.changedFiles,
    truncation,
    warnings: context.warnings,
    ...rest,
  };
}

const UNSAFE_COMMIT_FILE_DISPLAY_LIMIT = 10;
const UNSAFE_COMMIT_PROMPT_TITLE = "BranchMe: commit potentially unsafe files?";

interface CommitConfirmationContext {
  hasUI?: boolean;
  ui?: {
    confirm(title: string, message: string): boolean | Promise<boolean>;
  };
}

function formatUnsafeCommitFilePromptLine(file: ChangedFile): string {
  return `- ${formatDisplayPath(file.path)} (${describeUnsafeCommitFileReason(file)})`;
}

export function buildUnsafeCommitFileApprovalMessage(files: ChangedFile[]): string {
  const displayedFiles = files.slice(0, UNSAFE_COMMIT_FILE_DISPLAY_LIMIT).map(formatUnsafeCommitFilePromptLine);
  const omittedCount = files.length - UNSAFE_COMMIT_FILE_DISPLAY_LIMIT;
  const omittedLine = omittedCount > 0 ? [`- ...and ${omittedCount} more`] : [];
  return [
    "commit_changes found changed files that look unsafe to stage:",
    "",
    ...displayedFiles,
    ...omittedLine,
    "",
    "Only continue if you reviewed these files and they contain safe fixtures/placeholders, not real secrets.",
    "Block the commit if you are unsure.",
    "",
    "Commit these flagged files?",
  ].join("\n");
}

export function createUnsafeCommitFileApproval(ctx: CommitConfirmationContext): UnsafeCommitFileApproval | undefined {
  if (!ctx.hasUI || !ctx.ui?.confirm) return undefined;
  return async ({ files }) => ctx.ui?.confirm(UNSAFE_COMMIT_PROMPT_TITLE, buildUnsafeCommitFileApprovalMessage(files)) ?? false;
}

export interface DraftAndCreateCommitOptions {
  cwd: string;
  signal?: AbortSignal;
  steeringPrompt?: string;
  paths?: string[];
  draftContext: DraftCommitMessageContext;
  draftCommitMessage?: DraftCommitMessageDependency;
  confirmCommit?: (subject: string) => Promise<boolean>;
  approveUnsafeCommitFiles?: UnsafeCommitFileApproval;
}

export type CommitFlowResult =
  | {
      status: "committed";
      context: GitContext;
      prompt: CommitPromptPayload;
      subject: string;
      committed: CommitResult;
      details: CommitChangesDetails;
    }
  | {
      status: "cancelled";
      context: GitContext;
      prompt: CommitPromptPayload;
      subject: string;
      details: CommitChangesDetails;
    }
  | {
      status: "blocked";
      context: GitContext;
      prompt: CommitPromptPayload;
      subject: string;
      details: CommitChangesDetails;
    }
  | { status: "no-changes"; context: GitContext; details: CommitChangesDetails };

function isDraftCommitMessageResult(value: string | DraftCommitMessageResult): value is DraftCommitMessageResult {
  return Boolean(value) && typeof value === "object" && "message" in value && typeof value.message === "string" && "attempts" in value && Array.isArray(value.attempts);
}

async function draftWithDiagnostics(
  prompt: CommitPromptPayload,
  context: DraftCommitMessageContext,
  draftCommitMessage: DraftCommitMessageDependency,
): Promise<DraftCommitMessageResult> {
  const result = await draftCommitMessage(prompt.text, context, prompt);
  if (isDraftCommitMessageResult(result)) return result;
  return { message: result, attempts: [] };
}

function createDraftCommitDetails(
  context: GitContext,
  prompt: CommitPromptPayload,
  draft: DraftCommitMessageResult,
  options: Pick<DraftAndCreateCommitOptions, "steeringPrompt"> & { committed?: CommitResult } = {},
): CommitChangesDetails {
  return createCommitDetails("commit", context, {
    ...(options.steeringPrompt ? { steeringPrompt: options.steeringPrompt } : {}),
    truncation: [...collectGitContextTruncation(context), ...prompt.truncation],
    prompt: prompt.diagnostics,
    draft: draft.attempts,
    ...(options.committed ? { committed: options.committed } : {}),
  });
}

export async function draftAndCreateCommit(
  executor: Pick<ExtensionAPI, "exec">,
  options: DraftAndCreateCommitOptions,
): Promise<CommitFlowResult> {
  const context = await gatherGitContext(executor, { cwd: options.cwd, signal: options.signal });
  if (!context.hasChanges) {
    return {
      status: "no-changes",
      context,
      details: createCommitDetails("commit", context, {
        ...(options.steeringPrompt ? { steeringPrompt: options.steeringPrompt } : {}),
      }),
    };
  }

  const scopedFiles = options.paths ? scopeChangedFilesToPaths(context.changedFiles, options.paths) : context.changedFiles;
  if (!options.approveUnsafeCommitFiles) assertNoUnsafeCommitFiles(scopedFiles);

  const prompt = buildBoundedCommitPrompt(context, {
    steeringPrompt: options.steeringPrompt,
    modelContextWindow: options.draftContext.model?.contextWindow,
    modelMaxTokens: options.draftContext.model?.maxTokens,
  });
  const draftCommitMessage = options.draftCommitMessage ?? draftCommitMessageWithActiveModelDiagnostics;
  const draft = await draftWithDiagnostics(prompt, options.draftContext, draftCommitMessage);
  const validation = validateCommitMessage(draft.message);
  if (!validation.ok) {
    throw new Error(`commit_changes received an invalid commit message draft: ${validation.error} Nothing was staged or committed.`);
  }

  const details = createDraftCommitDetails(context, prompt, draft, { steeringPrompt: options.steeringPrompt });
  const confirmed = options.confirmCommit ? await options.confirmCommit(validation.subject) : true;
  if (!confirmed) {
    return {
      status: "cancelled",
      context,
      prompt,
      subject: validation.subject,
      details,
    };
  }

  try {
    const committed = await createCommit(executor, {
      cwd: options.cwd,
      signal: options.signal,
      message: validation.subject,
      paths: options.paths,
      expectedStatusPorcelain: context.statusPorcelain,
      approveUnsafeCommitFiles: options.approveUnsafeCommitFiles,
    });

    return {
      status: "committed",
      context,
      prompt,
      subject: validation.subject,
      committed,
      details: createDraftCommitDetails(context, prompt, draft, { steeringPrompt: options.steeringPrompt, committed }),
    };
  } catch (error) {
    if (error instanceof CommitError && error.code === "unsafe-sensitive-files-blocked") {
      return {
        status: "blocked",
        context,
        prompt,
        subject: validation.subject,
        details,
      };
    }
    throw error;
  }
}
