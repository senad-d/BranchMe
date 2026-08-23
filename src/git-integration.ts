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
  isCommitAncestor,
  isLosslessGitMetadata,
  parseWorkingTreeStatus,
  requireExistingLocalBranch,
  requireLosslessWorktreeIdentity,
  runGit,
  validateBranchName,
  validateBranchNameInput,
  withRepositoryMutationQueue,
  type GitCommandContext,
} from "./git.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  GitExecResult,
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

function parseConflictPaths(output: string): CapturedConflictPaths {
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

  const returnedPaths = rawPaths.slice(0, GIT_INTEGRATION_CONFLICT_ENTRY_LIMIT);
  return {
    paths: returnedPaths.map((path) => ({ path })),
    omitted: rawPaths.length - returnedPaths.length,
  };
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
  const sourceHead = await getLocalBranchCommit(pi, rootCtx, prepared.sourceBranch, signal);
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
  if (!snapshot.clean) problems.push("the control worktree is not clean");
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
  const args = mergeArgs(prepared.sourceBranch);
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
): Promise<CapturedConflictPaths> {
  const result = await runGit(pi, { cwd: prepared.worktreeRoot }, CONFLICT_PATH_ARGS, {
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  return parseConflictPaths(result.stdout);
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
    throw new Error(
      boundedIntegrationText(
        `The failed merge was restored, but conflict paths could not be classified safely: ${conflictCaptureError.message}`,
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

async function integrateBranchWithinQueue(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: IntegrateBranchToolInput,
  queuedWorktreeRoot: string,
  signal?: AbortSignal,
): Promise<IntegrateBranchDetails> {
  const prepared = await prepareBranchIntegration(pi, ctx, request, signal);
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
  return recoverFailedMerge(pi, prepared, mergeFailure);
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
  await requireExistingLocalBranch(pi, rootCtx, request.sourceBranch, "Source", signal);
  await requireExistingLocalBranch(pi, rootCtx, request.targetBranch, "Target", signal);
  const sourceHead = await getLocalBranchCommit(pi, rootCtx, request.sourceBranch, signal);
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
