import { isAbsolute, posix, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GIT_INTEGRATION_CONFLICT_ENTRY_LIMIT,
  GIT_INTEGRATION_CONFLICT_PATH_LIMIT_CHARS,
  GIT_INTEGRATION_CONFLICT_RAW_OUTPUT_LIMIT_BYTES,
  GIT_INTEGRATION_SUMMARY_LIMIT_CHARS,
  GIT_INTEGRATION_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
  GIT_WORKTREE_PATH_LIMIT_CHARS,
} from "./constants.ts";
import {
  formatGitFailure,
  getCanonicalCommonGitDirectory,
  getCanonicalGitWorktreeRoot,
  getCurrentBranch,
  getGitOperationState,
  getLocalBranchCommit,
  getMergeHeadCommit,
  getRemoteTrackingRefCommit,
  inspectDirectRemoteTrackingRef,
  isCommitAncestor,
  isLosslessGitMetadata,
  parseWorkingTreeStatus,
  requireExistingLocalBranch,
  requireLosslessWorktreeIdentity,
  runGit,
  safeWorktreeValue,
  validateBranchName,
  validateBranchNameInput,
  withRepositoryMutationQueue,
  type GitCommandContext,
} from "./git.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  ConcludeMergeAbortedDetails,
  ConcludeMergeConcludedDetails,
  ConcludeMergeDetails,
  ConcludeMergeToolInput,
  GitExecResult,
  IntegrateBranchConflictKeptDetails,
  IntegrateBranchConflictPathEntry,
  IntegrateBranchDetails,
  IntegrateBranchToolInput,
  IntegrateBranchVerification,
} from "./types.ts";

export interface PreparedBranchIntegration {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
  sourceBranch: string;
  targetBranch: string;
  sourceHead: string;
  targetHead: string;
  sourceAlreadyIntegrated: boolean;
  remoteSource?: true;
  /** conclude_merge: the source is MERGE_HEAD, which disappears on abort or commit; trust the captured sourceHead. */
  sourceHeadFixed?: true;
}

interface IntegrationStateSnapshot {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
  currentBranch: string | null;
  detached: boolean;
  sourceHead: string;
  targetHead: string;
  activeOperations: string[];
  clean: boolean;
  sourceIsAncestorOfTarget: boolean;
  previousTargetIsAncestorOfTarget: boolean;
}

interface CapturedConflictPaths {
  paths: IntegrateBranchConflictPathEntry[];
  omitted: number;
}

const INTEGRATION_MERGE_POLICY_ARGS = [
  "-c",
  "rerere.enabled=false",
  "merge",
  "--ff",
  "--no-edit",
  "--no-autostash",
  "--no-rerere-autoupdate",
  "--no-overwrite-ignore",
] as const;

const INTEGRATION_STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];
const CONFLICT_PATH_ARGS = ["diff", "--name-only", "--diff-filter=U", "-z", "--"];
// Also inspect the index: manually staging a conflicted file must not bypass the marker check.
const STAGED_MERGE_PATH_ARGS = ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMRT", "-z"];
const CONFLICT_MARKER_SIZE_LIMIT = 4_096;
const CONFLICT_DISPLAY_PATH_LIMIT_CHARS = 512;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/iu;

function sameCommit(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function integrationTokens(prepared: PreparedBranchIntegration): string[] {
  return [
    prepared.worktreeRoot,
    prepared.canonicalCommonGitDirectory,
    prepared.sourceBranch,
    prepared.targetBranch,
  ];
}

function boundedIntegrationText(value: string, tokens: readonly string[]): string {
  const redacted = redactSecrets(value, tokens).replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    (character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined ? "" : String.raw`\u${codePoint.toString(16).padStart(4, "0")}`;
    },
  );
  if (redacted.length <= GIT_INTEGRATION_SUMMARY_LIMIT_CHARS) return redacted;
  return `${redacted.slice(0, GIT_INTEGRATION_SUMMARY_LIMIT_CHARS - 14)}… [truncated]`;
}

function boundedMergeExecutionError(
  error: unknown,
  prepared: PreparedBranchIntegration,
): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = boundedIntegrationText(rawMessage, integrationTokens(prepared));
  return new Error(message || "git merge failed without a diagnostic.");
}

function uncertainIntegrationError(
  prepared: PreparedBranchIntegration,
  reason: unknown,
  observedTargetHead?: string,
): Error {
  const rawReason = reason instanceof Error ? reason.message : String(reason);
  const reasonText = boundedIntegrationText(rawReason, integrationTokens(prepared));
  const observed = observedTargetHead && COMMIT_PATTERN.test(observedTargetHead)
    ? ` Observed target HEAD: ${observedTargetHead}.`
    : "";
  const message =
    `Branch integration postconditions are uncertain: ${reasonText || "verification was inconclusive"}. ` +
    `Before source HEAD: ${prepared.sourceHead}; before target HEAD: ${prepared.targetHead}.${observed} ` +
    "Integration may have completed; inspect the repository before retrying.";
  return new Error(boundedIntegrationText(message, integrationTokens(prepared)));
}

function requireLosslessIntegrationMetadata(prepared: PreparedBranchIntegration): void {
  requireLosslessWorktreeIdentity(prepared.worktreeRoot, "cwd");
  requireLosslessWorktreeIdentity(prepared.sourceBranch, "branch");
  requireLosslessWorktreeIdentity(prepared.targetBranch, "branch");
  if (
    !isLosslessGitMetadata(
      prepared.canonicalCommonGitDirectory,
      GIT_WORKTREE_PATH_LIMIT_CHARS,
    )
  ) {
    throw new Error(
      "The canonical common Git directory cannot be returned safely and losslessly. " +
      "Use a repository path without credential-like token text or control/format characters.",
    );
  }
}

function conflictPathIsRepositoryRelative(path: string): boolean {
  if (!path || path === "." || isAbsolute(path) || win32.isAbsolute(path)) return false;
  if (posix.normalize(path) !== path) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function requireLosslessConflictPath(path: string): void {
  if (
    !conflictPathIsRepositoryRelative(path) ||
    !isLosslessGitMetadata(path, GIT_INTEGRATION_CONFLICT_PATH_LIMIT_CHARS)
  ) {
    throw new Error(
      "A conflict path cannot be returned safely and losslessly as a bounded repository-relative identity.",
    );
  }
}

function parseConflictPaths(output: string, entryLimit = GIT_INTEGRATION_CONFLICT_ENTRY_LIMIT): CapturedConflictPaths {
  if (Buffer.byteLength(output, "utf8") > GIT_INTEGRATION_CONFLICT_RAW_OUTPUT_LIMIT_BYTES) {
    throw new Error("Conflict-path output exceeded the bounded safety limit.");
  }
  if (output.length === 0) return { paths: [], omitted: 0 };
  if (!output.endsWith("\0")) throw new Error("Conflict-path output was malformed.");

  const rawPaths = output.slice(0, -1).split("\0");
  const seen = new Set<string>();
  for (const path of rawPaths) {
    requireLosslessConflictPath(path);
    if (seen.has(path)) throw new Error("Conflict-path output contained duplicate identities.");
    seen.add(path);
  }

  const returnedPaths = rawPaths.slice(0, entryLimit);
  return {
    paths: returnedPaths.map((path) => ({ path })),
    omitted: rawPaths.length - returnedPaths.length,
  };
}

async function integrationSourceHead(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  sourceBranch: string,
  signal?: AbortSignal,
  remoteSource = false,
): Promise<string> {
  if (!remoteSource) return getLocalBranchCommit(pi, ctx, sourceBranch, signal);
  const ref = await inspectDirectRemoteTrackingRef(pi, ctx, sourceBranch, signal);
  const head = await getRemoteTrackingRefCommit(pi, ctx, sourceBranch, signal);
  if (ref.status !== "present" || ref.objectId !== head) throw new Error("Integration source must be a direct remote-tracking commit ref.");
  return head;
}

async function inspectIntegrationState(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  signal?: AbortSignal,
): Promise<IntegrationStateSnapshot> {
  const rootCtx = { cwd: prepared.worktreeRoot };
  const worktreeRoot = await getCanonicalGitWorktreeRoot(pi, rootCtx, signal);
  const canonicalCommonGitDirectory = await getCanonicalCommonGitDirectory(pi, rootCtx, signal);
  const current = await getCurrentBranch(pi, rootCtx, signal);
  const sourceHead = prepared.sourceHeadFixed
    ? prepared.sourceHead
    : await integrationSourceHead(pi, rootCtx, prepared.sourceBranch, signal, prepared.remoteSource);
  const targetHead = await getLocalBranchCommit(pi, rootCtx, prepared.targetBranch, signal);
  const operationState = await getGitOperationState(pi, rootCtx, signal);
  const statusResult = await runGit(pi, rootCtx, INTEGRATION_STATUS_ARGS, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const clean = parseWorkingTreeStatus(statusResult.stdout).workingTree.state === "clean";
  const sourceIsAncestorOfTarget = await isCommitAncestor(
    pi,
    rootCtx,
    prepared.sourceHead,
    targetHead,
    signal,
  );
  const previousTargetIsAncestorOfTarget = await isCommitAncestor(
    pi,
    rootCtx,
    prepared.targetHead,
    targetHead,
    signal,
  );

  return {
    worktreeRoot,
    canonicalCommonGitDirectory,
    currentBranch: current.currentBranch,
    detached: current.detached,
    sourceHead,
    targetHead,
    activeOperations: operationState.active,
    clean,
    sourceIsAncestorOfTarget,
    previousTargetIsAncestorOfTarget,
  };
}

function integrationStateProblems(
  prepared: PreparedBranchIntegration,
  snapshot: IntegrationStateSnapshot,
  expectedTargetHead: string | null,
  requireIntegratedAncestry: boolean,
  requireClean = true,
): string[] {
  const problems: string[] = [];
  if (snapshot.worktreeRoot !== prepared.worktreeRoot) problems.push("the control worktree root changed");
  if (snapshot.canonicalCommonGitDirectory !== prepared.canonicalCommonGitDirectory) {
    problems.push("the canonical common Git directory changed");
  }
  if (snapshot.detached || snapshot.currentBranch !== prepared.targetBranch) {
    problems.push("the current target branch changed");
  }
  if (!sameCommit(snapshot.sourceHead, prepared.sourceHead)) problems.push("the source ref moved");
  if (expectedTargetHead !== null && !sameCommit(snapshot.targetHead, expectedTargetHead)) {
    problems.push("the target ref did not have the required commit");
  }
  if (snapshot.activeOperations.length > 0) problems.push("a Git operation remains in progress");
  if (requireClean && !snapshot.clean) problems.push("the control worktree is not clean");
  if (requireIntegratedAncestry && !snapshot.sourceIsAncestorOfTarget) {
    problems.push("the captured source is not an ancestor of the resulting target");
  }
  if (!snapshot.previousTargetIsAncestorOfTarget) {
    problems.push("the captured previous target is not an ancestor of the resulting target");
  }
  return problems;
}

function integrationVerification(
  prepared: PreparedBranchIntegration,
  snapshot: IntegrationStateSnapshot,
): IntegrateBranchVerification {
  return {
    repository: {
      worktreeRoot: prepared.worktreeRoot,
      canonicalCommonGitDirectory: prepared.canonicalCommonGitDirectory,
      identityPreserved: true,
    },
    controlWorktree: {
      targetBranch: prepared.targetBranch,
      currentBranchPreserved: true,
      cleanBefore: true,
      cleanAfter: true,
      operationStateAbsentBefore: true,
      operationStateAbsentAfter: true,
    },
    heads: {
      before: {
        sourceHead: prepared.sourceHead,
        targetHead: prepared.targetHead,
      },
      after: {
        sourceHead: snapshot.sourceHead,
        targetHead: snapshot.targetHead,
      },
    },
    finalAncestry: {
      sourceHead: prepared.sourceHead,
      previousTargetHead: prepared.targetHead,
      targetHead: snapshot.targetHead,
      sourceIsAncestorOfTarget: snapshot.sourceIsAncestorOfTarget,
      previousTargetIsAncestorOfTarget: snapshot.previousTargetIsAncestorOfTarget,
    },
  };
}

async function getCommitParents(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  commit: string,
): Promise<string[]> {
  const args = ["rev-list", "--parents", "-n", "1", commit];
  const result = await runGit(pi, ctx, args, { timeout: GIT_STATUS_TIMEOUT_MS });
  if (Buffer.byteLength(result.stdout, "utf8") > 1_024) {
    throw new Error("Git returned oversized commit-parent output.");
  }
  const fields = result.stdout.trim().split(/\s+/u);
  if (
    fields.length < 1 ||
    !fields.every((field) => COMMIT_PATTERN.test(field)) ||
    !sameCommit(fields[0], commit)
  ) {
    throw new Error("Git returned malformed commit-parent identities.");
  }
  return fields.slice(1);
}

function mergeArgs(sourceBranch: string): string[] {
  return [...INTEGRATION_MERGE_POLICY_ARGS, `refs/heads/${sourceBranch}`];
}

async function requireDefaultTargetMergeOptions(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  signal?: AbortSignal,
): Promise<void> {
  const args = ["config", "--get-all", `branch.${prepared.targetBranch}.mergeOptions`];
  const result = await runGit(pi, { cwd: prepared.worktreeRoot }, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
    tokens: integrationTokens(prepared),
  });
  if (result.code === 1) return;
  if (result.code !== 0) {
    throw new Error(
      boundedIntegrationText(
        formatGitFailure(args, result, integrationTokens(prepared)),
        integrationTokens(prepared),
      ),
    );
  }
  if (result.stdout.trim().length === 0) return;
  throw new Error(
    "The target branch has branch-specific merge options configured. " +
    "Clear its branch.<name>.mergeOptions setting before integration so the fixed merge policy cannot be changed.",
  );
}

async function runMerge(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  signal?: AbortSignal,
): Promise<Error | null> {
  const args = prepared.remoteSource ? [...INTEGRATION_MERGE_POLICY_ARGS, prepared.sourceHead] : mergeArgs(prepared.sourceBranch);
  let result: GitExecResult;
  try {
    result = await runGit(pi, { cwd: prepared.worktreeRoot }, args, {
      signal,
      timeout: GIT_INTEGRATION_TIMEOUT_MS,
      allowFailure: true,
      tokens: integrationTokens(prepared),
    });
  } catch (error) {
    return boundedMergeExecutionError(error, prepared);
  }
  if (result.code === 0) return null;
  return new Error(
    boundedIntegrationText(
      formatGitFailure(args, result, integrationTokens(prepared)),
      integrationTokens(prepared),
    ),
  );
}

async function verifySuccessfulMerge(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
): Promise<IntegrateBranchDetails> {
  let snapshot: IntegrationStateSnapshot;
  try {
    snapshot = await inspectIntegrationState(pi, prepared);
  } catch (error) {
    throw uncertainIntegrationError(prepared, error);
  }

  const problems = integrationStateProblems(prepared, snapshot, null, true);
  if (problems.length > 0) {
    throw uncertainIntegrationError(prepared, problems.join("; "), snapshot.targetHead);
  }

  const verified = integrationVerification(prepared, snapshot);
  if (sameCommit(snapshot.targetHead, prepared.sourceHead)) {
    return {
      action: "integrate_branch",
      status: "fast_forward",
      mergeExecuted: true,
      request: { sourceBranch: prepared.sourceBranch, targetBranch: prepared.targetBranch },
      verified,
    };
  }

  let parents: string[];
  try {
    parents = await getCommitParents(pi, { cwd: prepared.worktreeRoot }, snapshot.targetHead);
  } catch (error) {
    throw uncertainIntegrationError(prepared, error, snapshot.targetHead);
  }
  if (
    parents.length !== 2 ||
    !sameCommit(parents[0], prepared.targetHead) ||
    !sameCommit(parents[1], prepared.sourceHead)
  ) {
    throw uncertainIntegrationError(
      prepared,
      "the resulting target was not an exact two-parent merge of the captured target and source",
      snapshot.targetHead,
    );
  }

  return {
    action: "integrate_branch",
    status: "merge_commit",
    mergeExecuted: true,
    request: { sourceBranch: prepared.sourceBranch, targetBranch: prepared.targetBranch },
    verified,
  };
}

async function captureConflictPaths(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  entryLimit?: number,
  signal?: AbortSignal,
): Promise<CapturedConflictPaths> {
  const result = await runGit(pi, { cwd: prepared.worktreeRoot }, CONFLICT_PATH_ARGS, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  return parseConflictPaths(result.stdout, entryLimit);
}

async function abortMerge(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
): Promise<Error | null> {
  try {
    await runGit(pi, { cwd: prepared.worktreeRoot }, ["merge", "--abort"], {
      timeout: GIT_INTEGRATION_TIMEOUT_MS,
      tokens: integrationTokens(prepared),
    });
    return null;
  } catch (error) {
    return boundedMergeExecutionError(error, prepared);
  }
}

async function recoverFailedMerge(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  mergeFailure: Error,
  keepConflicts = false,
): Promise<IntegrateBranchDetails> {
  let mergeStatePresent = false;
  let operationInspectionError: Error | null = null;
  try {
    const operationState = await getGitOperationState(pi, { cwd: prepared.worktreeRoot });
    mergeStatePresent = operationState.mergeHeadPresent;
  } catch (error) {
    operationInspectionError = boundedMergeExecutionError(error, prepared);
  }

  let conflictPaths: CapturedConflictPaths = { paths: [], omitted: 0 };
  let conflictCaptureError: Error | null = null;
  try {
    conflictPaths = await captureConflictPaths(pi, prepared);
  } catch (error) {
    conflictCaptureError = boundedMergeExecutionError(error, prepared);
  }

  if (
    keepConflicts &&
    mergeStatePresent &&
    conflictCaptureError === null &&
    conflictPaths.paths.length + conflictPaths.omitted > 0
  ) {
    return verifyKeptConflict(pi, prepared, conflictPaths);
  }

  const abortAttempted = mergeStatePresent;
  const abortError = mergeStatePresent ? await abortMerge(pi, prepared) : null;

  let snapshot: IntegrationStateSnapshot;
  try {
    snapshot = await inspectIntegrationState(pi, prepared);
  } catch (error) {
    const reason = abortError ?? operationInspectionError ?? conflictCaptureError ?? error;
    throw uncertainIntegrationError(prepared, reason);
  }

  const restorationProblems = integrationStateProblems(
    prepared,
    snapshot,
    prepared.targetHead,
    false,
  );
  if (operationInspectionError) restorationProblems.push("the failed merge state could not be inspected");
  if (abortError) restorationProblems.push("git merge --abort did not succeed");
  if (restorationProblems.length > 0) {
    throw uncertainIntegrationError(prepared, restorationProblems.join("; "), snapshot.targetHead);
  }
  if (conflictCaptureError) {
    const keepNote = keepConflicts ? "keepConflicts could not be honored. " : "";
    throw new Error(
      boundedIntegrationText(
        `${keepNote}The failed merge was restored, but conflict paths could not be classified safely: ${conflictCaptureError.message}`,
        integrationTokens(prepared),
      ),
    );
  }

  if (conflictPaths.paths.length + conflictPaths.omitted > 0) {
    if (!abortAttempted) {
      throw uncertainIntegrationError(
        prepared,
        "unmerged paths were present without a verified merge abort",
        snapshot.targetHead,
      );
    }
    return {
      action: "integrate_branch",
      status: "conflict",
      mergeExecuted: true,
      request: { sourceBranch: prepared.sourceBranch, targetBranch: prepared.targetBranch },
      verified: integrationVerification(prepared, snapshot),
      conflict: {
        paths: conflictPaths.paths,
        omitted: conflictPaths.omitted,
        abort: { attempted: true, succeeded: true },
        restoration: {
          verified: true,
          repositoryIdentityPreserved: true,
          controlWorktreeBranchPreserved: true,
          sourceHeadPreserved: true,
          targetHeadRestored: true,
          operationStateCleared: true,
          cleanControlWorktree: true,
        },
      },
    };
  }

  throw mergeFailure;
}

function uncertainKeptConflictError(prepared: PreparedBranchIntegration, reason: unknown): Error {
  const rawReason = reason instanceof Error ? reason.message : String(reason);
  const message =
    `The conflicted merge was kept, but its state could not be verified: ${boundedIntegrationText(rawReason, integrationTokens(prepared)) || "verification was inconclusive"}. ` +
    `Captured MERGE_HEAD: ${prepared.sourceHead}; captured HEAD: ${prepared.targetHead}. ` +
    "The merge may still be in progress; inspect the repository, then use conclude_merge with action abort or conclude.";
  return new Error(boundedIntegrationText(message, integrationTokens(prepared)));
}

async function verifyKeptConflict(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  conflictPaths: CapturedConflictPaths,
): Promise<IntegrateBranchConflictKeptDetails> {
  const rootCtx = { cwd: prepared.worktreeRoot };
  const problems: string[] = [];
  try {
    const [worktreeRoot, commonGitDirectory, current, targetHead, mergeHead, operationState] = await Promise.all([
      getCanonicalGitWorktreeRoot(pi, rootCtx),
      getCanonicalCommonGitDirectory(pi, rootCtx),
      getCurrentBranch(pi, rootCtx),
      getLocalBranchCommit(pi, rootCtx, prepared.targetBranch),
      getMergeHeadCommit(pi, rootCtx),
      getGitOperationState(pi, rootCtx),
    ]);
    if (worktreeRoot !== prepared.worktreeRoot) problems.push("the control worktree root changed");
    if (commonGitDirectory !== prepared.canonicalCommonGitDirectory) problems.push("the canonical common Git directory changed");
    if (current.detached || current.currentBranch !== prepared.targetBranch) problems.push("the current target branch changed");
    if (!sameCommit(targetHead, prepared.targetHead)) problems.push("the target ref moved");
    if (!sameCommit(mergeHead, prepared.sourceHead)) problems.push("MERGE_HEAD is not the captured source commit");
    if (!operationState.mergeHeadPresent || operationState.active.some((operation) => operation !== "merge")) {
      problems.push("the operation state is not a single in-progress merge");
    }
  } catch (error) {
    throw uncertainKeptConflictError(prepared, error);
  }
  if (problems.length > 0) throw uncertainKeptConflictError(prepared, problems.join("; "));

  return {
    action: "integrate_branch",
    status: "conflict_kept",
    mergeExecuted: true,
    request: { sourceBranch: prepared.sourceBranch, targetBranch: prepared.targetBranch },
    heads: { sourceHead: prepared.sourceHead, targetHead: prepared.targetHead },
    conflict: {
      paths: conflictPaths.paths,
      omitted: conflictPaths.omitted,
      kept: true,
      mergeInProgress: true,
    },
  };
}

function conflictOmissionLine(noun: string, omitted: number): string {
  return `${omitted} ${noun}${omitted === 1 ? "" : "s"} omitted.`;
}

/** Bounded, sanitized "header + one path per line" text shared by every conflict-path report. */
export function formatConflictPathList(
  header: string,
  conflict: { paths: IntegrateBranchConflictPathEntry[]; omitted: number },
  label = "Conflict paths:",
  noun = "conflict path",
): string {
  const lines = [header, label];
  let omitted = conflict.omitted;

  for (const [index, entry] of conflict.paths.entries()) {
    const line = `- ${safeWorktreeValue(entry.path, CONFLICT_DISPLAY_PATH_LIMIT_CHARS)}`;
    const candidateOmitted = conflict.omitted + conflict.paths.length - index - 1;
    const candidate = [
      ...lines,
      line,
      ...(candidateOmitted > 0 ? [conflictOmissionLine(noun, candidateOmitted)] : []),
    ].join("\n");
    if (candidate.length > GIT_INTEGRATION_SUMMARY_LIMIT_CHARS) {
      omitted += conflict.paths.length - index;
      break;
    }
    lines.push(line);
  }

  if (omitted > 0) lines.push(conflictOmissionLine(noun, omitted));
  return lines.join("\n");
}

// Caller holds the mutation queue. Remote sources are internal to update_from_base only.
export async function integrateBranchWithinQueue(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: IntegrateBranchToolInput,
  queuedWorktreeRoot: string,
  signal?: AbortSignal,
  remoteSource = false,
  keepConflicts = false,
): Promise<IntegrateBranchDetails> {
  const prepared = await prepareBranchIntegration(pi, ctx, request, signal, remoteSource);
  if (prepared.worktreeRoot !== queuedWorktreeRoot) {
    throw new Error("The control worktree changed while preparing branch integration.");
  }
  requireLosslessIntegrationMetadata(prepared);

  if (prepared.sourceAlreadyIntegrated) {
    const snapshot = await inspectIntegrationState(pi, prepared, signal);
    const problems = integrationStateProblems(prepared, snapshot, prepared.targetHead, true);
    if (problems.length > 0) {
      throw new Error(`Branch integration no-op verification failed: ${problems.join("; ")}.`);
    }
    return {
      action: "integrate_branch",
      status: "already_integrated",
      mergeExecuted: false,
      request: { sourceBranch: prepared.sourceBranch, targetBranch: prepared.targetBranch },
      verified: integrationVerification(prepared, snapshot),
    };
  }

  await requireDefaultTargetMergeOptions(pi, prepared, signal);
  const mergeFailure = await runMerge(pi, prepared, signal);
  if (mergeFailure === null) return verifySuccessfulMerge(pi, prepared);
  return recoverFailedMerge(pi, prepared, mergeFailure, keepConflicts);
}

export async function resolveIntegrationWorktreeRoot(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  return getCanonicalGitWorktreeRoot(pi, ctx, signal);
}

export async function prepareBranchIntegration(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: IntegrateBranchToolInput,
  signal?: AbortSignal,
  remoteSource = false,
): Promise<PreparedBranchIntegration> {
  validateBranchNameInput(request.sourceBranch, "Source branch");
  validateBranchNameInput(request.targetBranch, "Target branch");
  if (request.sourceBranch === request.targetBranch) {
    throw new Error("Source branch and target branch must be distinct local branches.");
  }

  const worktreeRoot = await resolveIntegrationWorktreeRoot(pi, ctx, signal);
  const rootCtx = { cwd: worktreeRoot };
  const canonicalCommonGitDirectory = await getCanonicalCommonGitDirectory(pi, rootCtx, signal);

  await validateBranchName(pi, rootCtx, request.sourceBranch, signal);
  await validateBranchName(pi, rootCtx, request.targetBranch, signal);
  if (!remoteSource) await requireExistingLocalBranch(pi, rootCtx, request.sourceBranch, "Source", signal);
  await requireExistingLocalBranch(pi, rootCtx, request.targetBranch, "Target", signal);
  const sourceHead = await integrationSourceHead(pi, rootCtx, request.sourceBranch, signal, remoteSource);
  const targetHead = await getLocalBranchCommit(pi, rootCtx, request.targetBranch, signal);

  const current = await getCurrentBranch(pi, rootCtx, signal);
  if (current.detached || current.currentBranch === null) {
    throw new Error("The control worktree must have the target branch checked out; HEAD is detached.");
  }
  if (current.currentBranch !== request.targetBranch) {
    throw new Error("The control worktree must already have the requested target branch checked out.");
  }

  const operationState = await getGitOperationState(pi, rootCtx, signal);
  if (operationState.active.length > 0) {
    throw new Error(
      `The control worktree has an existing ${operationState.active.join(", ")} operation in progress. ` +
      "Finish or abort it before integrating a branch.",
    );
  }

  const statusResult = await runGit(pi, rootCtx, INTEGRATION_STATUS_ARGS, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const workingTree = parseWorkingTreeStatus(statusResult.stdout).workingTree;
  if (workingTree.state !== "clean") {
    throw new Error(
      "The control worktree must be clean, with no staged, unstaged, untracked, or unmerged changes, before integration.",
    );
  }

  const sourceAlreadyIntegrated = await isCommitAncestor(
    pi,
    rootCtx,
    sourceHead,
    targetHead,
    signal,
  );
  return {
    worktreeRoot,
    canonicalCommonGitDirectory,
    sourceBranch: request.sourceBranch,
    targetBranch: request.targetBranch,
    sourceHead,
    targetHead,
    sourceAlreadyIntegrated,
    ...(remoteSource ? { remoteSource: true as const } : {}),
  };
}

export async function integrateBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: IntegrateBranchToolInput,
  signal?: AbortSignal,
): Promise<IntegrateBranchDetails> {
  const worktreeRoot = await resolveIntegrationWorktreeRoot(pi, ctx, signal);
  const operation = integrateBranchWithinQueue.bind(
    undefined,
    pi,
    ctx,
    request,
    worktreeRoot,
    signal,
  );
  return withRepositoryMutationQueue(worktreeRoot, operation);
}

function uncertainMergeConclusionError(
  prepared: PreparedBranchIntegration,
  reason: unknown,
  observedHead?: string,
): Error {
  const rawReason = reason instanceof Error ? reason.message : String(reason);
  const observed = observedHead && COMMIT_PATTERN.test(observedHead) ? ` Observed HEAD: ${observedHead}.` : "";
  const message =
    "conclude_merge postconditions are uncertain. " +
    `Before the attempt HEAD was ${prepared.targetHead} and MERGE_HEAD was ${prepared.sourceHead}.${observed} ` +
    "The merge may still be in progress or may have been committed; inspect the repository before retrying. " +
    `Diagnostic: ${boundedIntegrationText(rawReason, integrationTokens(prepared)) || "verification was inconclusive"}.`;
  return new Error(boundedIntegrationText(message, integrationTokens(prepared)));
}

async function prepareMergeInProgress(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<PreparedBranchIntegration> {
  const worktreeRoot = await getCanonicalGitWorktreeRoot(pi, ctx, signal);
  const rootCtx = { cwd: worktreeRoot };
  const operationState = await getGitOperationState(pi, rootCtx, signal);
  if (!operationState.mergeHeadPresent) {
    throw new Error("conclude_merge: no merge is in progress (MERGE_HEAD is absent); nothing to conclude or abort.");
  }
  if (operationState.active.some((operation) => operation !== "merge")) {
    throw new Error(
      `conclude_merge: a ${operationState.active.join(", ")} operation is in progress alongside the merge; finish or abort it outside BranchMe first.`,
    );
  }
  const current = await getCurrentBranch(pi, rootCtx, signal);
  if (current.detached || current.currentBranch === null) {
    throw new Error("conclude_merge requires a current local branch; HEAD is detached.");
  }
  await requireExistingLocalBranch(pi, rootCtx, current.currentBranch, "Target", signal);
  const prepared: PreparedBranchIntegration = {
    worktreeRoot,
    canonicalCommonGitDirectory: await getCanonicalCommonGitDirectory(pi, rootCtx, signal),
    sourceBranch: "MERGE_HEAD",
    targetBranch: current.currentBranch,
    sourceHead: await getMergeHeadCommit(pi, rootCtx, signal),
    targetHead: await getLocalBranchCommit(pi, rootCtx, current.currentBranch, signal),
    sourceAlreadyIntegrated: false,
    sourceHeadFixed: true,
  };
  requireLosslessIntegrationMetadata(prepared);
  return prepared;
}

async function abortMergeInProgress(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  request: ConcludeMergeToolInput,
): Promise<ConcludeMergeAbortedDetails> {
  const abortError = await abortMerge(pi, prepared);
  let snapshot: IntegrationStateSnapshot;
  try {
    snapshot = await inspectIntegrationState(pi, prepared);
  } catch (error) {
    throw uncertainMergeConclusionError(prepared, abortError ?? error);
  }
  const problems = integrationStateProblems(prepared, snapshot, prepared.targetHead, false);
  if (abortError) problems.push("git merge --abort did not succeed");
  if (problems.length > 0) throw uncertainMergeConclusionError(prepared, problems.join("; "), snapshot.targetHead);

  return {
    action: "conclude_merge",
    status: "aborted",
    request,
    repoRoot: prepared.worktreeRoot,
    branch: prepared.targetBranch,
    head: snapshot.targetHead,
    mergeHead: prepared.sourceHead,
    restoration: {
      verified: true,
      headRestored: true,
      branchPreserved: true,
      operationStateCleared: true,
      cleanWorktree: true,
    },
  };
}

function parseMarkerSizeGroups(output: string, paths: readonly string[]): Map<number, string[]> {
  if (Buffer.byteLength(output, "utf8") > GIT_INTEGRATION_CONFLICT_RAW_OUTPUT_LIMIT_BYTES || !output.endsWith("\0")) {
    throw new Error("conclude_merge: conflict-marker-size attributes exceeded the safety limit or were malformed.");
  }
  const fields = output.slice(0, -1).split("\0");
  if (fields.length !== paths.length * 3) throw new Error("conclude_merge: malformed conflict-marker-size attributes.");
  const groups = new Map<number, string[]>();
  for (const [index, path] of paths.entries()) {
    const [reportedPath, attribute, value] = fields.slice(index * 3, index * 3 + 3);
    if (reportedPath !== path || attribute !== "conflict-marker-size") {
      throw new Error("conclude_merge: conflict-marker-size attribute identities did not match.");
    }
    const configured = /^\d+$/u.test(value) ? Number(value) : 7;
    if (!Number.isSafeInteger(configured) || configured > CONFLICT_MARKER_SIZE_LIMIT) {
      throw new Error("conclude_merge: conflict-marker-size exceeds the bounded safety limit.");
    }
    // Git falls back to seven for zero/invalid values. Keep recognizing default markers
    // even if attributes changed after the conflict, plus longer/custom-sized markers.
    const size = configured > 0 ? Math.min(7, configured) : 7;
    const group = groups.get(size) ?? [];
    group.push(path);
    groups.set(size, group);
  }
  return groups;
}

function markerGrepArgs(size: number, paths: readonly string[], cached: boolean): string[] {
  return [
    "--literal-pathspecs", "grep", "--no-color", "--no-ext-grep", "--no-textconv", "-a", "-l", "-z", "-E",
    ...(cached ? ["--cached"] : []),
    "-e", `^[<]{${size},}([[:space:]]|$)`, "-e", `^[=]{${size},}[[:space:]]*$`,
    "-e", `^[>]{${size},}([[:space:]]|$)`, "-e", `^[|]{${size},}([[:space:]]|$)`,
    "--", ...paths,
  ];
}

async function inspectMarkerGroup(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  cached: boolean,
  signal: AbortSignal | undefined,
  entry: [number, string[]],
): Promise<string> {
  const [size, paths] = entry;
  const tokens = integrationTokens(prepared);
  const args = markerGrepArgs(size, paths, cached);
  const result = await runGit(pi, { cwd: prepared.worktreeRoot }, args, {
    signal, timeout: GIT_INTEGRATION_TIMEOUT_MS, tokens, allowFailure: true,
  });
  if (result.code === 1) return "";
  if (result.code !== 0) throw new Error(boundedIntegrationText(formatGitFailure(args, result, tokens), tokens));
  return result.stdout;
}

async function requireNoConflictMarkers(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  paths: readonly string[],
  cached = false,
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return;
  const tokens = integrationTokens(prepared);
  const options = { signal, timeout: GIT_INTEGRATION_TIMEOUT_MS, tokens };
  const attributes = await runGit(pi, { cwd: prepared.worktreeRoot }, [
    "--literal-pathspecs", "check-attr", ...(cached ? ["--cached"] : []), "-z", "conflict-marker-size", "--", ...paths,
  ], options);
  const groups = parseMarkerSizeGroups(attributes.stdout, paths);
  // There are at most seven size groups; these bounded, read-only checks are independent.
  const outputs = await Promise.all([...groups].map(inspectMarkerGroup.bind(undefined, pi, prepared, cached, signal)));
  const flaggedOutput = outputs.join("");
  if (!flaggedOutput) return;
  const flagged = parseConflictPaths(flaggedOutput);
  const count = flagged.paths.length + flagged.omitted;
  throw new Error(formatConflictPathList(
    `conclude_merge: refused. Conflict markers remain in ${count} path${count === 1 ? "" : "s"}${cached ? " in the index" : ""}; remove every <<<<<<<, |||||||, =======, and >>>>>>> marker line, then retry conclude_merge or abort it.`,
    flagged,
    "Paths with markers:",
    "flagged path",
  ));
}

async function requireMarkerFreeIndex(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit(pi, { cwd: prepared.worktreeRoot }, [
    ...STAGED_MERGE_PATH_ARGS, prepared.targetHead, "--",
  ], { signal, timeout: GIT_STATUS_TIMEOUT_MS });
  const staged = parseConflictPaths(result.stdout, Number.POSITIVE_INFINITY);
  await requireNoConflictMarkers(pi, prepared, staged.paths.map((entry) => entry.path), true, signal);
}

async function commitResolvedMerge(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchIntegration,
  request: ConcludeMergeToolInput,
  signal?: AbortSignal,
): Promise<ConcludeMergeConcludedDetails> {
  const rootCtx = { cwd: prepared.worktreeRoot };
  const tokens = integrationTokens(prepared);
  const unmerged = await captureConflictPaths(pi, prepared, Number.POSITIVE_INFINITY, signal);
  const paths = unmerged.paths.map((entry) => entry.path);
  await requireNoConflictMarkers(pi, prepared, paths, false, signal);
  await requireMarkerFreeIndex(pi, prepared, signal);
  signal?.throwIfAborted();
  if (paths.length > 0) {
    try {
      await runGit(pi, rootCtx, ["--literal-pathspecs", "add", "--", ...paths], { timeout: GIT_INTEGRATION_TIMEOUT_MS, tokens });
    } catch (error) {
      throw uncertainMergeConclusionError(prepared, error);
    }
  }
  // Filters can change staged content; verify the exact candidate index after staging too.
  await requireMarkerFreeIndex(pi, prepared);
  try {
    await runGit(pi, rootCtx, ["commit", "--no-edit"], { timeout: GIT_INTEGRATION_TIMEOUT_MS, tokens });
  } catch (error) {
    throw uncertainMergeConclusionError(prepared, error);
  }

  let snapshot: IntegrationStateSnapshot;
  let parents: string[];
  try {
    snapshot = await inspectIntegrationState(pi, prepared);
    parents = await getCommitParents(pi, rootCtx, snapshot.targetHead);
  } catch (error) {
    throw uncertainMergeConclusionError(prepared, error);
  }
  const problems = integrationStateProblems(prepared, snapshot, null, true, false);
  if (sameCommit(snapshot.targetHead, prepared.targetHead)) problems.push("HEAD did not move");
  if (parents.length !== 2 || !sameCommit(parents[0], prepared.targetHead) || !sameCommit(parents[1], prepared.sourceHead)) {
    problems.push("the resulting HEAD was not an exact two-parent merge of the previous HEAD and MERGE_HEAD");
  }
  if (problems.length > 0) throw uncertainMergeConclusionError(prepared, problems.join("; "), snapshot.targetHead);

  return {
    action: "conclude_merge",
    status: "concluded",
    request,
    repoRoot: prepared.worktreeRoot,
    branch: prepared.targetBranch,
    heads: { before: prepared.targetHead, after: snapshot.targetHead },
    parents: { first: parents[0], second: parents[1] },
    mergeHead: prepared.sourceHead,
    resolvedPaths: unmerged.paths,
  };
}

async function concludeMergeWithinQueue(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: ConcludeMergeToolInput,
  queuedWorktreeRoot: string,
  signal?: AbortSignal,
): Promise<ConcludeMergeDetails> {
  const prepared = await prepareMergeInProgress(pi, ctx, signal);
  if (prepared.worktreeRoot !== queuedWorktreeRoot) {
    throw new Error("The control worktree changed while preparing merge conclusion.");
  }
  signal?.throwIfAborted();
  return request.action === "abort"
    ? abortMergeInProgress(pi, prepared, request)
    : commitResolvedMerge(pi, prepared, request, signal);
}

export async function concludeMerge(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: ConcludeMergeToolInput,
  signal?: AbortSignal,
): Promise<ConcludeMergeDetails> {
  if (request.action !== "conclude" && request.action !== "abort") {
    throw new Error("conclude_merge action must be \"conclude\" or \"abort\".");
  }
  const worktreeRoot = await resolveIntegrationWorktreeRoot(pi, ctx, signal);
  const operation = concludeMergeWithinQueue.bind(undefined, pi, ctx, request, worktreeRoot, signal);
  return withRepositoryMutationQueue(worktreeRoot, operation);
}
