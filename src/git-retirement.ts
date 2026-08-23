import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GIT_CONTEXT_VALUE_LIMIT_CHARS,
  GIT_RETIREMENT_MUTATION_TIMEOUT_MS,
  GIT_RETIREMENT_SUMMARY_LIMIT_CHARS,
  GIT_WORKTREE_PATH_LIMIT_CHARS,
} from "./constants.ts";
import {
  formatGitFailure,
  getCanonicalCommonGitDirectory,
  getCanonicalGitWorktreeRoot,
  getLocalBranchCommit,
  inspectDirectLocalBranchRef,
  inspectLocalBranchWorktreeOccupancy,
  isCommitAncestor,
  isLosslessGitMetadata,
  requireLosslessWorktreeIdentity,
  runGit,
  validateBranchName,
  validateBranchNameInput,
  withRepositoryMutationQueue,
  type DirectLocalBranchRefInspection,
  type GitCommandContext,
  type LocalBranchWorktreeOccupancy,
  type PresentDirectLocalBranchRef,
} from "./git.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  RetireBranchDetails,
  RetireBranchMode,
  RetireBranchRefIdentity,
  RetireBranchToolInput,
  RetireBranchWorktreeOccupancyProof,
} from "./types.ts";

const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const RETIREMENT_REQUEST_FIELDS = new Set(["branchName", "expectedHead", "targetBranch", "force"]);

export interface PreparedBranchRetirement {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
  request: RetireBranchToolInput;
  retiring: RetireBranchRefIdentity;
  target: RetireBranchRefIdentity;
  worktreeOccupancy: RetireBranchWorktreeOccupancyProof;
  retiringIsAncestorOfTarget: boolean;
  mode: RetireBranchMode;
}

function validateRetirementBranchName(value: unknown, label: string): asserts value is string {
  validateBranchNameInput(value, label);
  if (value.startsWith("refs/")) {
    throw new Error(`${label} must be a local branch name, not a full ref name.`);
  }
}

function normalizeExpectedHead(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected HEAD must be a string.");
  if (!FULL_OBJECT_ID_PATTERN.test(value)) {
    throw new Error("Expected HEAD must be exactly 40 or 64 hexadecimal characters.");
  }
  return value.toLowerCase();
}

function validateRetirementRequest(request: unknown): RetireBranchToolInput {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TypeError("Branch retirement request must be an object.");
  }

  const values = request as Record<string, unknown>;
  const fields = Object.keys(values);
  if (
    fields.length !== RETIREMENT_REQUEST_FIELDS.size ||
    fields.some((field) => !RETIREMENT_REQUEST_FIELDS.has(field))
  ) {
    throw new Error("Branch retirement request must contain exactly branchName, expectedHead, targetBranch, and force.");
  }

  validateRetirementBranchName(values.branchName, "Retiring branch");
  validateRetirementBranchName(values.targetBranch, "Target branch");
  if (values.branchName === values.targetBranch) {
    throw new Error("Retiring branch and target branch must be distinct local branches.");
  }
  const expectedHead = normalizeExpectedHead(values.expectedHead);
  if (typeof values.force !== "boolean") throw new TypeError("force must be a boolean.");

  return {
    branchName: values.branchName,
    expectedHead,
    targetBranch: values.targetBranch,
    force: values.force,
  };
}

function sameObjectIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requirePresentDirectRef(
  inspection: DirectLocalBranchRefInspection,
  label: "Retiring" | "Target",
): PresentDirectLocalBranchRef {
  if (inspection.status === "present") return inspection;
  throw new Error(`${label} local branch '${inspection.branchName}' does not exist.`);
}

function requireDirectRefCommitIdentity(
  directRef: PresentDirectLocalBranchRef,
  commit: string,
  label: "Retiring" | "Target",
): void {
  if (sameObjectIdentity(directRef.objectId, commit)) return;
  throw new Error(
    `${label} local branch '${directRef.branchName}' is not a direct ref to its resolved commit identity.`,
  );
}

function requireUnoccupiedRetiringBranch(
  occupancy: LocalBranchWorktreeOccupancy,
): RetireBranchWorktreeOccupancyProof {
  if (occupancy.occupied || occupancy.matchingWorktreeCount !== 0) {
    throw new Error(
      `Retiring local branch '${occupancy.branchName}' is occupied by ` +
      `${occupancy.matchingWorktreeCount} registered worktree record(s).`,
    );
  }
  return {
    branchName: occupancy.branchName,
    completeInventoryInspected: true,
    occupied: false,
    matchingWorktreeCount: 0,
  };
}

function requireLosslessRetirementMetadata(
  worktreeRoot: string,
  canonicalCommonGitDirectory: string,
  request: RetireBranchToolInput,
  retiringRef: PresentDirectLocalBranchRef,
  targetRef: PresentDirectLocalBranchRef,
): void {
  requireLosslessWorktreeIdentity(worktreeRoot, "cwd");
  requireLosslessWorktreeIdentity(request.branchName, "branch");
  requireLosslessWorktreeIdentity(request.targetBranch, "branch");
  if (
    !isLosslessGitMetadata(canonicalCommonGitDirectory, GIT_WORKTREE_PATH_LIMIT_CHARS) ||
    !isLosslessGitMetadata(retiringRef.fullRef, GIT_CONTEXT_VALUE_LIMIT_CHARS) ||
    !isLosslessGitMetadata(targetRef.fullRef, GIT_CONTEXT_VALUE_LIMIT_CHARS)
  ) {
    throw new Error(
      "Branch retirement identities cannot be returned safely and losslessly within bounded details.",
    );
  }
}

function retirementRefIdentity(
  directRef: PresentDirectLocalBranchRef,
  commit: string,
): RetireBranchRefIdentity {
  return {
    branchName: directRef.branchName,
    fullRef: directRef.fullRef,
    head: commit.toLowerCase(),
  };
}

export async function prepareBranchRetirement(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  requestValue: unknown,
  signal?: AbortSignal,
): Promise<PreparedBranchRetirement> {
  const request = validateRetirementRequest(requestValue);
  const worktreeRoot = await getCanonicalGitWorktreeRoot(pi, ctx, signal);
  const rootCtx = { cwd: worktreeRoot };
  const canonicalCommonGitDirectory = await getCanonicalCommonGitDirectory(pi, rootCtx, signal);

  await validateBranchName(pi, rootCtx, request.branchName, signal);
  await validateBranchName(pi, rootCtx, request.targetBranch, signal);
  const retiringRef = requirePresentDirectRef(
    await inspectDirectLocalBranchRef(pi, rootCtx, request.branchName, signal),
    "Retiring",
  );
  const targetRef = requirePresentDirectRef(
    await inspectDirectLocalBranchRef(pi, rootCtx, request.targetBranch, signal),
    "Target",
  );
  const retiringHead = await getLocalBranchCommit(pi, rootCtx, request.branchName, signal);
  const targetHead = await getLocalBranchCommit(pi, rootCtx, request.targetBranch, signal);
  requireDirectRefCommitIdentity(retiringRef, retiringHead, "Retiring");
  requireDirectRefCommitIdentity(targetRef, targetHead, "Target");
  if (!sameObjectIdentity(retiringHead, request.expectedHead)) {
    throw new Error(
      `Retiring local branch '${request.branchName}' does not match the required expected HEAD.`,
    );
  }

  const worktreeOccupancy = requireUnoccupiedRetiringBranch(
    await inspectLocalBranchWorktreeOccupancy(pi, rootCtx, request.branchName, signal),
  );
  const retiringIsAncestorOfTarget = await isCommitAncestor(
    pi,
    rootCtx,
    retiringHead,
    targetHead,
    signal,
  );
  if (!retiringIsAncestorOfTarget && request.force !== true) {
    throw new Error(
      "The retiring branch is not an ancestor of the captured target branch; force must be true to authorize unmerged retirement.",
    );
  }

  requireLosslessRetirementMetadata(
    worktreeRoot,
    canonicalCommonGitDirectory,
    request,
    retiringRef,
    targetRef,
  );
  return {
    worktreeRoot,
    canonicalCommonGitDirectory,
    request,
    retiring: retirementRefIdentity(retiringRef, retiringHead),
    target: retirementRefIdentity(targetRef, targetHead),
    worktreeOccupancy,
    retiringIsAncestorOfTarget,
    mode: retiringIsAncestorOfTarget ? "merged" : "forced_unmerged",
  };
}

interface ImmediateRetirementState {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
  retiringHead: string;
  targetHead: string;
  worktreeOccupancy: RetireBranchWorktreeOccupancyProof;
  refreshedAncestry: boolean | null;
}

interface PostRetirementState {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
  retiringRef: DirectLocalBranchRefInspection;
  retiringHead: string | null;
  targetRef: DirectLocalBranchRefInspection;
  targetHead: string | null;
  worktreeOccupancy: LocalBranchWorktreeOccupancy;
}

function retirementTokens(prepared: PreparedBranchRetirement): string[] {
  return [
    prepared.worktreeRoot,
    prepared.canonicalCommonGitDirectory,
    prepared.request.branchName,
    prepared.request.targetBranch,
    prepared.retiring.fullRef,
    prepared.target.fullRef,
  ];
}

function boundedRetirementText(
  value: string,
  prepared: PreparedBranchRetirement,
): string {
  const redacted = redactSecrets(value, retirementTokens(prepared)).replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    (character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined
        ? ""
        : String.raw`\u${codePoint.toString(16).padStart(4, "0")}`;
    },
  );
  if (redacted.length <= GIT_RETIREMENT_SUMMARY_LIMIT_CHARS) return redacted;
  return `${redacted.slice(0, GIT_RETIREMENT_SUMMARY_LIMIT_CHARS - 14)}… [truncated]`;
}

function boundedRetirementError(
  prepared: PreparedBranchRetirement,
  error: unknown,
  fallback: string,
): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return new Error(boundedRetirementText(rawMessage || fallback, prepared));
}

function uncertainRetirementError(
  prepared: PreparedBranchRetirement,
  reason: unknown,
): Error {
  const rawReason = reason instanceof Error ? reason.message : String(reason);
  const reasonText = boundedRetirementText(
    rawReason || "post-mutation verification was inconclusive",
    prepared,
  );
  return new Error(
    boundedRetirementText(
      "Branch retirement postconditions are uncertain. Retirement may have completed; " +
      "manually inspect the repository, target ref, local retiring ref, and worktree inventory before retrying. " +
      "Do not recreate, reset, or otherwise modify either branch as an automatic rollback. " +
      `Reason: ${reasonText}`,
      prepared,
    ),
  );
}

function sameRepositoryIdentity(
  prepared: PreparedBranchRetirement,
  worktreeRoot: string,
  canonicalCommonGitDirectory: string,
): boolean {
  return worktreeRoot === prepared.worktreeRoot &&
    canonicalCommonGitDirectory === prepared.canonicalCommonGitDirectory;
}

async function inspectImmediateRetirementState(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchRetirement,
  signal?: AbortSignal,
): Promise<ImmediateRetirementState> {
  const rootCtx = { cwd: prepared.worktreeRoot };
  const worktreeRoot = await getCanonicalGitWorktreeRoot(pi, rootCtx, signal);
  const canonicalCommonGitDirectory = await getCanonicalCommonGitDirectory(pi, rootCtx, signal);
  const retiringRef = requirePresentDirectRef(
    await inspectDirectLocalBranchRef(pi, rootCtx, prepared.request.branchName, signal),
    "Retiring",
  );
  const targetRef = requirePresentDirectRef(
    await inspectDirectLocalBranchRef(pi, rootCtx, prepared.request.targetBranch, signal),
    "Target",
  );
  const retiringHead = await getLocalBranchCommit(
    pi,
    rootCtx,
    prepared.request.branchName,
    signal,
  );
  const targetHead = await getLocalBranchCommit(
    pi,
    rootCtx,
    prepared.request.targetBranch,
    signal,
  );
  requireDirectRefCommitIdentity(retiringRef, retiringHead, "Retiring");
  requireDirectRefCommitIdentity(targetRef, targetHead, "Target");
  const worktreeOccupancy = requireUnoccupiedRetiringBranch(
    await inspectLocalBranchWorktreeOccupancy(
      pi,
      rootCtx,
      prepared.request.branchName,
      signal,
    ),
  );
  const refsChanged = !sameObjectIdentity(retiringHead, prepared.retiring.head) ||
    !sameObjectIdentity(targetHead, prepared.target.head);
  const refreshedAncestry = refsChanged
    ? await isCommitAncestor(pi, rootCtx, retiringHead, targetHead, signal)
    : null;

  return {
    worktreeRoot,
    canonicalCommonGitDirectory,
    retiringHead: retiringHead.toLowerCase(),
    targetHead: targetHead.toLowerCase(),
    worktreeOccupancy,
    refreshedAncestry,
  };
}

function immediateRetirementProblems(
  prepared: PreparedBranchRetirement,
  immediate: ImmediateRetirementState,
): string[] {
  const problems: string[] = [];
  if (!sameRepositoryIdentity(
    prepared,
    immediate.worktreeRoot,
    immediate.canonicalCommonGitDirectory,
  )) {
    problems.push("the canonical repository identity changed");
  }
  if (!sameObjectIdentity(immediate.retiringHead, prepared.retiring.head)) {
    problems.push("the retiring local ref moved after preflight");
  }
  if (!sameObjectIdentity(immediate.targetHead, prepared.target.head)) {
    problems.push("the target local ref moved after preflight");
  }
  if (immediate.worktreeOccupancy.occupied) {
    problems.push("the retiring branch became occupied by a registered worktree");
  }
  if (immediate.refreshedAncestry !== null) {
    problems.push(
      `ancestry for the changed refs was rechecked as ${immediate.refreshedAncestry}`,
    );
  }
  return problems;
}

async function attemptRetirementMutation(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchRetirement,
  signal?: AbortSignal,
): Promise<Error | null> {
  const args = [
    "update-ref",
    "--no-deref",
    "-d",
    prepared.retiring.fullRef,
    prepared.retiring.head,
  ];
  try {
    const result = await runGit(pi, { cwd: prepared.worktreeRoot }, args, {
      signal,
      timeout: GIT_RETIREMENT_MUTATION_TIMEOUT_MS,
      allowFailure: true,
      tokens: retirementTokens(prepared),
    });
    if (result.code === 0) return null;
    return new Error(
      boundedRetirementText(
        formatGitFailure(args, result, retirementTokens(prepared)),
        prepared,
      ),
    );
  } catch (error) {
    return boundedRetirementError(
      prepared,
      error,
      "The leased local ref deletion did not report completion.",
    );
  }
}

async function inspectPostRetirementState(
  pi: Pick<ExtensionAPI, "exec">,
  prepared: PreparedBranchRetirement,
): Promise<PostRetirementState> {
  const rootCtx = { cwd: prepared.worktreeRoot };
  const worktreeRoot = await getCanonicalGitWorktreeRoot(pi, rootCtx);
  const canonicalCommonGitDirectory = await getCanonicalCommonGitDirectory(pi, rootCtx);
  const retiringRef = await inspectDirectLocalBranchRef(
    pi,
    rootCtx,
    prepared.request.branchName,
  );
  const targetRef = await inspectDirectLocalBranchRef(
    pi,
    rootCtx,
    prepared.request.targetBranch,
  );
  let retiringHead: string | null = null;
  if (retiringRef.status === "present") {
    retiringHead = await getLocalBranchCommit(pi, rootCtx, prepared.request.branchName);
    requireDirectRefCommitIdentity(retiringRef, retiringHead, "Retiring");
    retiringHead = retiringHead.toLowerCase();
  }
  let targetHead: string | null = null;
  if (targetRef.status === "present") {
    targetHead = await getLocalBranchCommit(pi, rootCtx, prepared.request.targetBranch);
    requireDirectRefCommitIdentity(targetRef, targetHead, "Target");
    targetHead = targetHead.toLowerCase();
  }
  const worktreeOccupancy = await inspectLocalBranchWorktreeOccupancy(
    pi,
    rootCtx,
    prepared.request.branchName,
  );
  return {
    worktreeRoot,
    canonicalCommonGitDirectory,
    retiringRef,
    retiringHead,
    targetRef,
    targetHead,
    worktreeOccupancy,
  };
}

function postRetirementProblems(
  prepared: PreparedBranchRetirement,
  post: PostRetirementState,
): string[] {
  const problems: string[] = [];
  if (!sameRepositoryIdentity(prepared, post.worktreeRoot, post.canonicalCommonGitDirectory)) {
    problems.push("the canonical repository identity changed");
  }
  if (post.targetRef.status === "absent") {
    problems.push("the captured target local ref is missing");
  } else if (post.targetHead === null || !sameObjectIdentity(post.targetHead, prepared.target.head)) {
    problems.push("the captured target local ref moved");
  }
  if (
    post.retiringRef.status === "absent" &&
    (post.worktreeOccupancy.occupied || post.worktreeOccupancy.matchingWorktreeCount !== 0)
  ) {
    problems.push("a registered worktree names the missing retiring branch");
  }
  return problems;
}

function successfulRetirementDetails(
  prepared: PreparedBranchRetirement,
  post: PostRetirementState,
): RetireBranchDetails {
  if (post.retiringRef.status !== "absent" || post.targetRef.status !== "present" ||
      post.targetHead === null || post.worktreeOccupancy.occupied ||
      post.worktreeOccupancy.matchingWorktreeCount !== 0) {
    throw uncertainRetirementError(prepared, "verified retirement details were contradictory");
  }
  const target = retirementRefIdentity(post.targetRef, post.targetHead);
  return {
    action: "retire_branch",
    status: "retired",
    mode: prepared.mode,
    request: prepared.request,
    verified: {
      repository: {
        before: {
          worktreeRoot: prepared.worktreeRoot,
          canonicalCommonGitDirectory: prepared.canonicalCommonGitDirectory,
        },
        after: {
          worktreeRoot: post.worktreeRoot,
          canonicalCommonGitDirectory: post.canonicalCommonGitDirectory,
        },
        identityPreserved: true,
      },
      refs: {
        before: {
          retiring: prepared.retiring,
          target: prepared.target,
          expectedHead: prepared.request.expectedHead,
          expectedHeadMatches: true,
        },
        after: {
          retiring: {
            branchName: post.retiringRef.branchName,
            fullRef: post.retiringRef.fullRef,
            absent: true,
          },
          target,
          targetHeadPreserved: true,
        },
      },
      ancestry: {
        retiringHead: prepared.retiring.head,
        targetHead: prepared.target.head,
        retiringIsAncestorOfTarget: prepared.retiringIsAncestorOfTarget,
      },
      worktreeOccupancy: {
        before: prepared.worktreeOccupancy,
        after: {
          branchName: post.worktreeOccupancy.branchName,
          completeInventoryInspected: true,
          occupied: false,
          matchingWorktreeCount: 0,
        },
      },
      mutation: {
        exactLocalRefDeletionAttempted: true,
        localBranchAbsentAfterDeletion: true,
        directRemoteDeletionAttempted: false,
        remoteTrackingRefDeletionAttempted: false,
      },
    },
  };
}

function classifyRetirementOutcome(
  prepared: PreparedBranchRetirement,
  post: PostRetirementState,
  mutationFailure: Error | null,
): RetireBranchDetails {
  const problems = postRetirementProblems(prepared, post);
  if (problems.length > 0) {
    throw uncertainRetirementError(prepared, problems.join("; "));
  }
  if (post.retiringRef.status === "absent") {
    return successfulRetirementDetails(prepared, post);
  }
  if (post.retiringHead === null) {
    throw uncertainRetirementError(
      prepared,
      "the retiring local ref was present but its commit could not be verified",
    );
  }
  if (mutationFailure === null) {
    throw uncertainRetirementError(
      prepared,
      "Git reported successful deletion but the retiring local ref is still present",
    );
  }
  if (sameObjectIdentity(post.retiringHead, prepared.retiring.head)) {
    throw new Error(
      boundedRetirementText(
        `Branch retirement failed safely. The retiring local ref remains at captured HEAD ${prepared.retiring.head}. ` +
        `Diagnostic: ${mutationFailure.message}`,
        prepared,
      ),
    );
  }
  throw new Error(
    boundedRetirementText(
      `Branch retirement was not performed because the retiring local ref moved to ${post.retiringHead}. ` +
      `The expected-old-value lease protected the moved ref. ${mutationFailure.message}`,
      prepared,
    ),
  );
}

async function retireBranchWithinQueue(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: RetireBranchToolInput,
  queuedWorktreeRoot: string,
  signal?: AbortSignal,
): Promise<RetireBranchDetails> {
  const prepared = await prepareBranchRetirement(pi, ctx, request, signal);
  if (prepared.worktreeRoot !== queuedWorktreeRoot) {
    throw new Error("The active worktree changed while preparing branch retirement.");
  }

  let immediate: ImmediateRetirementState;
  try {
    immediate = await inspectImmediateRetirementState(pi, prepared, signal);
  } catch (error) {
    throw boundedRetirementError(
      prepared,
      error,
      "Branch retirement preconditions could not be reverified immediately before deletion.",
    );
  }
  const immediateProblems = immediateRetirementProblems(prepared, immediate);
  if (immediateProblems.length > 0) {
    throw new Error(
      boundedRetirementText(
        `Branch retirement preconditions changed: ${immediateProblems.join("; ")}. No local ref was deleted.`,
        prepared,
      ),
    );
  }

  const mutationFailure = await attemptRetirementMutation(pi, prepared, signal);
  let post: PostRetirementState;
  try {
    post = await inspectPostRetirementState(pi, prepared);
  } catch (error) {
    throw uncertainRetirementError(prepared, error);
  }
  return classifyRetirementOutcome(prepared, post, mutationFailure);
}

export async function resolveRetirementWorktreeRoot(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  return getCanonicalGitWorktreeRoot(pi, ctx, signal);
}

export async function retireBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  request: RetireBranchToolInput,
  signal?: AbortSignal,
): Promise<RetireBranchDetails> {
  const worktreeRoot = await resolveRetirementWorktreeRoot(pi, ctx, signal);
  return withRepositoryMutationQueue(
    worktreeRoot,
    retireBranchWithinQueue.bind(
      undefined,
      pi,
      ctx,
      request,
      worktreeRoot,
      signal,
    ),
  );
}
