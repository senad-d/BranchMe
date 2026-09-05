import { lstat, realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_FETCH_TIMEOUT_MS, GIT_PULL_TIMEOUT_MS, MAX_SUMMARY_OUTPUT_CHARS } from "./constants.ts";
import {
  canonicalizePathAllowMissing,
  collectWorktreeInventory,
  fetchRemoteBranchWithinQueue,
  formatGitFailure,
  getAheadBehindCount,
  getCanonicalCommonGitDirectory,
  getCanonicalGitWorktreeRoot,
  getCurrentBranch,
  getGitOperationState,
  getLocalBranchCommit,
  getRemoteTrackingRefCommit,
  getWorkingTreeStatus,
  inspectDirectLocalBranchRef,
  inspectDirectRemoteTrackingRef,
  isCommitAncestor,
  pathIsInsideOrEqual,
  removeWorktreeWithinQueue,
  requireLosslessWorktreeIdentity,
  runGit,
  validateBranchName,
  validateBranchNameInput,
  validateWorktreePathInput,
  validateWorktreeRemovalPath,
  withRepositoryMutationQueue,
  type GitCommandContext,
} from "./git.ts";
import { retireBranchWithinQueue } from "./git-retirement.ts";
import { redactSecrets } from "./redaction.ts";
import type { AheadBehindCount } from "./types.ts";

type GitAPI = Pick<ExtensionAPI, "exec">;
type Inventory = Awaited<ReturnType<typeof collectWorktreeInventory>>;

export interface LandBranchInput {
  sourceBranch: string;
  targetBranch: string;
  remote?: string;
  worktreePath?: string;
}

export interface LandBranchReceipt {
  repositoryRoot: string;
  remote: string;
  targetBranch: string;
  remoteTargetHead: string | null;
  sourceBranch: string;
  sourceHead: string | null;
  ancestry: { isAncestor: boolean | null };
  worktree: {
    path: string | null;
    outcome: "removed" | "absent" | "refused";
    reason: string | null;
    deletedIgnoredPaths: string[];
  };
  branch: {
    outcome: "deleted" | "absent" | "refused";
    reason: string | null;
    expectedHead: string | null;
  };
  targetSync: {
    mode: "fetch-refspec" | "pull-ff" | "skipped-dirty" | "noop" | "not-run" | "failed";
    worktreePath: string | null;
    before: string | null;
    after: string | null;
    aheadBehind: AheadBehindCount | null;
    reason: string | null;
  };
  steps: {
    step: "repository" | "cwd" | "fetch" | "ancestry" | "worktree" | "branch" | "targetSync";
    outcome: string;
    reason: string | null;
  }[];
}

function landingError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").slice(0, MAX_SUMMARY_OUTPUT_CHARS);
}

function validateLandingInput(input: LandBranchInput): void {
  for (const key of Object.keys(input)) {
    if (!["sourceBranch", "targetBranch", "remote", "worktreePath"].includes(key)) {
      throw new Error("land_branch accepts only sourceBranch, targetBranch, remote, and worktreePath.");
    }
  }
  for (const branch of [input.sourceBranch, input.targetBranch]) {
    validateBranchNameInput(branch);
    requireLosslessWorktreeIdentity(branch, "branch");
    if (branch.startsWith("refs/") || branch.includes("@{")) {
      throw new Error("land_branch requires exact local branch names, not full refs or revision expressions.");
    }
  }
  if (input.sourceBranch === input.targetBranch) throw new Error("Source and target branches must be distinct.");
  if (input.remote !== undefined) {
    validateBranchNameInput(input.remote, "Remote");
    requireLosslessWorktreeIdentity(input.remote, "branch");
  }
  if (input.worktreePath !== undefined) validateWorktreePathInput(input.worktreePath);
}

// Reused Git helpers all receive explicit -C routing. Disable config-driven pruning,
// extra fetch mappings and submodule recursion as well as command-line force options.
async function executeLandingGit(
  pi: GitAPI,
  remote: string,
  command: string,
  args: string[],
  options: Parameters<GitAPI["exec"]>[2],
) {
  if (!options?.cwd) throw new Error("Landing Git commands require an explicit working directory.");
  let routedArgs = args;
  if (args[0] === "fetch") {
    routedArgs = ["fetch", "--no-prune", "--no-prune-tags", "--refmap=", ...args.slice(1)];
  } else if (args[0] === "pull") {
    routedArgs = [
      "-c", "fetch.prune=false", "-c", "fetch.pruneTags=false",
      "-c", `remote.${remote}.prune=false`, "-c", `remote.${remote}.pruneTags=false`,
      "pull", "--no-tags", "--no-prune", "--refmap=", "--no-recurse-submodules", ...args.slice(1),
    ];
  }
  return pi.exec(command, ["-C", options.cwd, ...routedArgs], options);
}

function newLandingReceipt(root: string, input: LandBranchInput): LandBranchReceipt {
  return {
    repositoryRoot: root,
    remote: input.remote ?? "origin",
    targetBranch: input.targetBranch,
    remoteTargetHead: null,
    sourceBranch: input.sourceBranch,
    sourceHead: null,
    ancestry: { isAncestor: null },
    worktree: { path: null, outcome: "refused", reason: "Not attempted.", deletedIgnoredPaths: [] },
    branch: { outcome: "refused", reason: "Not attempted.", expectedHead: null },
    targetSync: { mode: "not-run", worktreePath: null, before: null, after: null, aheadBehind: null, reason: "Not attempted." },
    steps: [{ step: "repository", outcome: "resolved", reason: null }],
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function registeredBranchEntries(inventory: Inventory, branch: string) {
  return inventory.entries.filter((entry) => entry.record.branch === branch);
}

async function resolveLandingWorktree(
  inventory: Inventory,
  input: LandBranchInput,
): Promise<string | null> {
  if (input.worktreePath !== undefined) {
    const path = await canonicalizePathAllowMissing(validateWorktreePathInput(input.worktreePath));
    if (!path) throw new Error("worktreePath could not be resolved.");
    return requireLosslessWorktreeIdentity(path, "cwd");
  }
  const entries = registeredBranchEntries(inventory, input.sourceBranch).filter((entry) => entry.index !== 0);
  if (entries.length > 1) throw new Error("Source branch occupies multiple worktrees; provide an exact worktreePath.");
  if (entries.length === 0) return null;
  const path = entries[0].canonicalPath;
  if (!path) throw new Error("Source worktree path could not be resolved.");
  return requireLosslessWorktreeIdentity(path, "cwd");
}

async function requireSafeLandingCwd(cwd: string, worktreePath: string | null): Promise<void> {
  if (worktreePath === null) return;
  const callerCwd = await realpath(cwd);
  const processCwd = await realpath(process.cwd());
  if (pathIsInsideOrEqual(callerCwd, worktreePath) || pathIsInsideOrEqual(processCwd, worktreePath)) {
    throw new Error("The running cwd is inside worktreePath; run from the repository root.");
  }
}

async function captureLocalHead(pi: GitAPI, ctx: GitCommandContext, branch: string, signal?: AbortSignal) {
  const ref = await inspectDirectLocalBranchRef(pi, ctx, branch, signal);
  if (ref.status === "absent") return null;
  const head = await getLocalBranchCommit(pi, ctx, branch, signal);
  if (ref.objectId !== head) throw new Error("Local branch is not a direct ref to its captured commit.");
  return head;
}

async function requireIdleWorktree(pi: GitAPI, ctx: GitCommandContext, signal?: AbortSignal): Promise<void> {
  const state = await getGitOperationState(pi, ctx, signal);
  if (state.active.length > 0) throw new Error("Worktree has an in-progress Git operation; it will not be touched.");
}

async function removeLandingWorktree(pi: GitAPI, receipt: LandBranchReceipt, signal?: AbortSignal): Promise<void> {
  const worktree = receipt.worktree;
  const ctx = { cwd: receipt.repositoryRoot };
  const inventory = await collectWorktreeInventory(pi, ctx, signal);
  if (worktree.path === null) {
    if (registeredBranchEntries(inventory, receipt.sourceBranch).some((entry) => entry.index !== 0)) {
      throw new Error("Source branch became occupied after preflight.");
    }
    worktree.outcome = "absent";
    worktree.reason = null;
    return;
  }
  const matches = inventory.entries.filter((entry) => entry.canonicalPath === worktree.path);
  if (matches.some((entry) => entry.index === 0) || worktree.path === receipt.repositoryRoot) {
    throw new Error("The primary checkout / repository root can never be removed.");
  }
  if (!(await pathExists(worktree.path))) {
    worktree.outcome = "absent";
    worktree.reason = matches.length > 0 ? "Directory absent; registration retained (no prune)." : null;
    return;
  }
  const validated = await validateWorktreeRemovalPath(pi, ctx, worktree.path, signal);
  if (![receipt.sourceBranch, receipt.targetBranch].includes(validated.worktree.branch ?? "")) {
    throw new Error("The selected worktree must hold the source or target branch, not an unrelated branch.");
  }
  if (receipt.sourceHead === null) throw new Error("Source branch is absent; cannot prove this existing worktree is merged.");
  const sourceHead = await captureLocalHead(pi, ctx, receipt.sourceBranch, signal);
  if (sourceHead !== receipt.sourceHead) throw new Error("Source branch moved after the ancestry proof; no worktree removed.");
  const worktreeHead = validated.worktree.head;
  if (!worktreeHead || !receipt.remoteTargetHead ||
      !(await isCommitAncestor(pi, ctx, worktreeHead, receipt.remoteTargetHead, signal))) {
    throw new Error("Selected worktree HEAD is not merged into the fetched target.");
  }
  await requireIdleWorktree(pi, { cwd: worktree.path }, signal);
  const removed = await removeWorktreeWithinQueue(pi, ctx, worktree.path, signal, true, {
    branch: validated.worktree.branch!, head: worktreeHead,
  });
  if (await pathExists(worktree.path)) throw new Error("Git unregistered the worktree but its directory is still present.");
  worktree.outcome = "removed";
  worktree.reason = null;
  worktree.deletedIgnoredPaths = removed.deletedIgnoredPaths;
}

async function retireLandingBranch(pi: GitAPI, receipt: LandBranchReceipt, signal?: AbortSignal): Promise<void> {
  const ctx = { cwd: receipt.repositoryRoot };
  const head = await captureLocalHead(pi, ctx, receipt.sourceBranch, signal);
  if (head === null) {
    receipt.branch.outcome = "absent";
    receipt.branch.reason = null;
    return;
  }
  if (receipt.worktree.outcome === "refused") throw new Error("Worktree removal was refused; source branch retained.");
  if (head !== receipt.sourceHead || receipt.remoteTargetHead === null) {
    throw new Error("Source branch moved after the captured expected-HEAD lease; branch retained.");
  }
  await retireBranchWithinQueue(pi, ctx, {
    branchName: receipt.sourceBranch,
    expectedHead: head,
    targetBranch: `${receipt.remote}/${receipt.targetBranch}`,
    force: false,
  }, ctx.cwd, signal, "remote-tracking", receipt.remoteTargetHead);
  receipt.branch.outcome = "deleted";
  receipt.branch.reason = null;
}

async function requireLandingPullPolicy(pi: GitAPI, ctx: GitCommandContext, branch: string, signal?: AbortSignal): Promise<void> {
  const args = ["config", "--get-all", `branch.${branch}.mergeOptions`];
  const result = await runGit(pi, ctx, args, { signal, allowFailure: true });
  if (result.code === 1) return;
  if (result.code !== 0) throw new Error(formatGitFailure(args, result));
  if (result.stdout.trim()) {
    throw new Error("Target has branch-specific mergeOptions; sync refused to preserve the fixed fast-forward policy.");
  }
}

async function syncLandingTarget(pi: GitAPI, receipt: LandBranchReceipt, signal?: AbortSignal): Promise<void> {
  const ctx = { cwd: receipt.repositoryRoot };
  const sync = receipt.targetSync;
  sync.before = await captureLocalHead(pi, ctx, receipt.targetBranch, signal);
  if (sync.before === null) throw new Error("Local target branch is absent; landing will not create it.");
  const inventory = await collectWorktreeInventory(pi, ctx, signal);
  const entries = registeredBranchEntries(inventory, receipt.targetBranch);
  if (entries.length > 1) throw new Error("Target branch is checked out in multiple worktrees; sync refused.");
  if (entries.length === 1) {
    sync.worktreePath = entries[0].canonicalPath;
    if (!sync.worktreePath) throw new Error("Target worktree path could not be resolved.");
    requireLosslessWorktreeIdentity(sync.worktreePath, "cwd");
  }
  if (sync.before === receipt.remoteTargetHead) {
    sync.mode = "noop";
    sync.reason = null;
    return;
  }
  if (sync.worktreePath !== null) {
    const targetCtx = { cwd: sync.worktreePath };
    const root = await getCanonicalGitWorktreeRoot(pi, targetCtx, signal);
    if (root !== sync.worktreePath ||
        await getCanonicalCommonGitDirectory(pi, targetCtx, signal) !== await getCanonicalCommonGitDirectory(pi, ctx, signal) ||
        (await getCurrentBranch(pi, targetCtx, signal)).currentBranch !== receipt.targetBranch) {
      throw new Error("Target checkout identity changed; sync refused.");
    }
    const status = await getWorkingTreeStatus(pi, targetCtx, signal);
    if (status.workingTree.state !== "clean") {
      sync.mode = "skipped-dirty";
      sync.reason = "Target checkout is dirty; no pull attempted.";
      return;
    }
    await requireIdleWorktree(pi, targetCtx, signal);
    await requireLandingPullPolicy(pi, targetCtx, receipt.targetBranch, signal);
    await runGit(pi, targetCtx, ["pull", "--ff-only", "--no-rebase", "--no-autostash", receipt.remote, `refs/heads/${receipt.targetBranch}`], {
      signal, timeout: GIT_PULL_TIMEOUT_MS,
    });
    sync.mode = "pull-ff";
  } else {
    await runGit(pi, ctx, ["fetch", "--no-tags", "--no-recurse-submodules", receipt.remote, `refs/heads/${receipt.targetBranch}:refs/heads/${receipt.targetBranch}`], {
      signal, timeout: GIT_FETCH_TIMEOUT_MS,
    });
    sync.mode = "fetch-refspec";
  }
  sync.reason = null;
}

async function recordTargetAfter(pi: GitAPI, receipt: LandBranchReceipt): Promise<void> {
  const ctx = { cwd: receipt.repositoryRoot };
  const sync = receipt.targetSync;
  sync.after = await captureLocalHead(pi, ctx, receipt.targetBranch);
  if (sync.after !== null && receipt.remoteTargetHead !== null) {
    sync.aheadBehind = await getAheadBehindCount(pi, ctx, undefined, `${sync.after}...${receipt.remoteTargetHead}`);
  }
  if (["fetch-refspec", "pull-ff"].includes(sync.mode)) {
    if (sync.before === null || sync.after === null ||
        !(await isCommitAncestor(pi, ctx, sync.before, sync.after)) ||
        receipt.remoteTargetHead === null || !(await isCommitAncestor(pi, ctx, receipt.remoteTargetHead, sync.after)) ||
        (sync.after === sync.before && sync.before !== receipt.remoteTargetHead)) {
      throw new Error("Git did not produce a verified target fast-forward; inspect the recorded before/after refs.");
    }
  } else if (["noop", "skipped-dirty"].includes(sync.mode) && sync.before !== sync.after) {
    throw new Error("Target ref moved concurrently during a read-only sync decision.");
  }
}

async function finishLandingSync(pi: GitAPI, receipt: LandBranchReceipt, signal?: AbortSignal): Promise<void> {
  try {
    await syncLandingTarget(pi, receipt, signal);
  } catch (error) {
    receipt.targetSync.mode = "failed";
    receipt.targetSync.reason = landingError(error);
  }
  try {
    // Verification is deliberately uncancelled after a possible mutation.
    await recordTargetAfter(pi, receipt);
  } catch (error) {
    receipt.targetSync.mode = "failed";
    receipt.targetSync.reason = landingError(error);
  }
  receipt.steps.push({ step: "targetSync", outcome: receipt.targetSync.mode, reason: receipt.targetSync.reason });
}

async function refuseLanding(pi: GitAPI, receipt: LandBranchReceipt, error: unknown): Promise<LandBranchReceipt> {
  const reason = landingError(error);
  receipt.worktree.reason = reason;
  receipt.branch.reason = reason;
  receipt.targetSync.reason = reason;
  try {
    receipt.targetSync.before ??= await captureLocalHead(pi, { cwd: receipt.repositoryRoot }, receipt.targetBranch);
    await recordTargetAfter(pi, receipt);
  } catch (verificationError) {
    receipt.targetSync.reason = `${reason} Verification: ${landingError(verificationError)}`;
  }
  const recorded = new Set(receipt.steps.map((step) => step.step));
  for (const step of ["cwd", "fetch", "ancestry", "worktree", "branch", "targetSync"] as const) {
    if (!recorded.has(step)) receipt.steps.push({ step, outcome: "not-run", reason });
  }
  return receipt;
}

async function landBranchWithinQueue(
  pi: GitAPI,
  cwd: string,
  root: string,
  input: LandBranchInput,
  signal?: AbortSignal,
): Promise<LandBranchReceipt> {
  const ctx = { cwd: root };
  const receipt = newLandingReceipt(root, input);
  let step: "cwd" | "fetch" | "ancestry" = "cwd";
  try {
    const inventory = await collectWorktreeInventory(pi, ctx, signal);
    receipt.worktree.path = await resolveLandingWorktree(inventory, input);
    await requireSafeLandingCwd(cwd, receipt.worktree.path);
    receipt.steps.push({ step: "cwd", outcome: "safe", reason: null });
    step = "fetch";
    await validateBranchName(pi, ctx, input.sourceBranch, signal);
    await validateBranchName(pi, ctx, input.targetBranch, signal);
    receipt.sourceHead = await captureLocalHead(pi, ctx, input.sourceBranch, signal);
    receipt.branch.expectedHead = receipt.sourceHead;
    receipt.targetSync.before = await captureLocalHead(pi, ctx, input.targetBranch, signal);
    if (receipt.targetSync.before === null) throw new Error("Local target branch does not exist.");
    await fetchRemoteBranchWithinQueue(pi, ctx, receipt.remote, receipt.targetBranch, signal);
    const tracking = `${receipt.remote}/${receipt.targetBranch}`;
    const ref = await inspectDirectRemoteTrackingRef(pi, ctx, tracking, signal);
    receipt.remoteTargetHead = await getRemoteTrackingRefCommit(pi, ctx, tracking, signal);
    if (ref.status !== "present" || ref.objectId !== receipt.remoteTargetHead) {
      throw new Error("Fetched target is not a direct ref to its captured commit.");
    }
    receipt.steps.push({ step: "fetch", outcome: "fetched", reason: null });
    step = "ancestry";
    if (receipt.sourceHead !== null) {
      receipt.ancestry.isAncestor = await isCommitAncestor(pi, ctx, receipt.sourceHead, receipt.remoteTargetHead, signal);
      if (!receipt.ancestry.isAncestor) throw new Error("Source branch is not merged into the fetched remote target; landing refused.");
    }
    receipt.steps.push({ step: "ancestry", outcome: receipt.sourceHead === null ? "absent" : "verified", reason: null });
  } catch (error) {
    receipt.steps.push({ step, outcome: "refused", reason: landingError(error) });
    return refuseLanding(pi, receipt, error);
  }
  try {
    await removeLandingWorktree(pi, receipt, signal);
  } catch (error) {
    receipt.worktree.reason = landingError(error);
  }
  receipt.steps.push({ step: "worktree", outcome: receipt.worktree.outcome, reason: receipt.worktree.reason });
  try {
    await retireLandingBranch(pi, receipt, signal);
  } catch (error) {
    receipt.branch.reason = landingError(error);
  }
  receipt.steps.push({ step: "branch", outcome: receipt.branch.outcome, reason: receipt.branch.reason });
  await finishLandingSync(pi, receipt, signal);
  return receipt;
}

export async function landBranch(pi: GitAPI, ctx: GitCommandContext, input: LandBranchInput, signal?: AbortSignal): Promise<LandBranchReceipt> {
  validateLandingInput(input);
  const routedPi: GitAPI = { exec: executeLandingGit.bind(undefined, pi, input.remote ?? "origin") };
  const callerRoot = await getCanonicalGitWorktreeRoot(routedPi, ctx, signal);
  const inventory = await collectWorktreeInventory(routedPi, { cwd: callerRoot }, signal);
  const primary = inventory.entries[0];
  if (!primary?.canonicalPath || primary.record.bare) throw new Error("Landing requires a primary non-bare checkout.");
  const root = await getCanonicalGitWorktreeRoot(routedPi, { cwd: primary.canonicalPath }, signal);
  requireLosslessWorktreeIdentity(root, "cwd");
  if (root !== primary.canonicalPath ||
      await getCanonicalCommonGitDirectory(routedPi, { cwd: root }, signal) !== await getCanonicalCommonGitDirectory(routedPi, { cwd: callerRoot }, signal)) {
    throw new Error("Primary checkout repository identity could not be verified.");
  }
  return withRepositoryMutationQueue(root, landBranchWithinQueue.bind(undefined, routedPi, ctx.cwd, root, input, signal));
}

export function formatLandBranch(receipt: LandBranchReceipt): string {
  const summary = `land_branch: worktree ${receipt.worktree.outcome}; branch ${receipt.branch.outcome}; target sync ${receipt.targetSync.mode}.`;
  const reason = receipt.worktree.reason ?? receipt.branch.reason ?? receipt.targetSync.reason;
  return reason ? `${summary} ${landingError(reason)}` : summary;
}
