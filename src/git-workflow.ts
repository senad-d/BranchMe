import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_MUTATION_TIMEOUT_MS } from "./constants.ts";
import { integrateBranchWithinQueue } from "./git-integration.ts";
import {
  fetchRemoteBranchWithinQueue, getCanonicalGitWorktreeRoot, getCurrentBranch,
  getGitOperationState, getLocalBranchCommit, getRemoteTrackingRefCommit, getUpstreamBranch,
  getWorkingTreeStatus, inspectDirectRemoteTrackingRef, localBranchExists,
  requireLosslessWorktreeIdentity, runGit, validateBranchName, withRepositoryMutationQueue,
  type GitCommandContext,
} from "./git.ts";

export interface TrackBranchInput {
  branchName: string;
  remote?: string;
  remoteBranch?: string;
}

export interface TrackBranchDetails {
  action: "track_branch";
  branchName: string;
  previousBranch: string | null;
  head: string;
  upstream: string;
  repoRoot: string;
}

type GitAPI = Pick<ExtensionAPI, "exec">;

async function executeNarrowFetch(pi: GitAPI, command: string, args: string[], options: Parameters<GitAPI["exec"]>[2]) {
  const safeArgs = args[0] === "fetch" ? ["fetch", "--no-prune", "--no-prune-tags", "--refmap=", ...args.slice(1)] : args;
  return pi.exec(command, safeArgs, options);
}

export async function fetchWorkflowBase(pi: GitAPI, ctx: GitCommandContext, remote: string, branch: string, signal?: AbortSignal): Promise<void> {
  // Fetch dereferences a symbolic destination, potentially updating a local branch.
  // Reject it before fetching, not only when inspecting the fetched commit.
  await inspectDirectRemoteTrackingRef(pi, ctx, `${remote}/${branch}`, signal);
  const scopedPi: GitAPI = { exec: executeNarrowFetch.bind(undefined, pi) };
  await fetchRemoteBranchWithinQueue(scopedPi, ctx, remote, branch, signal);
}

export async function requireCleanIdleCheckout(pi: GitAPI, ctx: GitCommandContext, signal?: AbortSignal): Promise<void> {
  if ((await getGitOperationState(pi, ctx, signal)).active.length > 0) {
    throw new Error("An in-progress Git operation must be completed or aborted first.");
  }
  if ((await getWorkingTreeStatus(pi, ctx, signal)).workingTree.state !== "clean") {
    throw new Error("The working tree must be clean before this operation.");
  }
}

async function trackBranchWithinQueue(pi: GitAPI, ctx: GitCommandContext, input: TrackBranchInput, signal?: AbortSignal): Promise<TrackBranchDetails> {
  const remote = input.remote ?? "origin";
  const remoteBranch = input.remoteBranch ?? input.branchName;
  requireLosslessWorktreeIdentity(input.branchName, "branch");
  requireLosslessWorktreeIdentity(remote, "branch");
  requireLosslessWorktreeIdentity(remoteBranch, "branch");
  await validateBranchName(pi, ctx, input.branchName, signal);
  await validateBranchName(pi, ctx, remoteBranch, signal);
  if (input.branchName.startsWith("refs/") || remoteBranch.startsWith("refs/")) {
    throw new Error("track_branch requires branch names, not full refs.");
  }
  if (await localBranchExists(pi, ctx, input.branchName, signal)) throw new Error("Local branch already exists; use change_branch.");
  await requireCleanIdleCheckout(pi, ctx, signal);
  const previous = await getCurrentBranch(pi, ctx, signal);
  if (previous.currentBranch !== null) requireLosslessWorktreeIdentity(previous.currentBranch, "branch");
  await fetchWorkflowBase(pi, ctx, remote, remoteBranch, signal);
  const upstream = `${remote}/${remoteBranch}`;
  const ref = await inspectDirectRemoteTrackingRef(pi, ctx, upstream, signal);
  const head = await getRemoteTrackingRefCommit(pi, ctx, upstream, signal);
  if (ref.status !== "present" || ref.objectId !== head) throw new Error("Fetched branch is not a direct remote-tracking commit ref.");
  await requireCleanIdleCheckout(pi, ctx, signal);
  try {
    await runGit(pi, ctx, ["switch", "--no-overwrite-ignore", "--track=direct", "-c", input.branchName, `refs/remotes/${upstream}`], {
      signal, timeout: GIT_MUTATION_TIMEOUT_MS,
    });
    if ((await getCurrentBranch(pi, ctx)).currentBranch !== input.branchName ||
        await getLocalBranchCommit(pi, ctx, input.branchName) !== head ||
        await getUpstreamBranch(pi, ctx) !== upstream) {
      throw new Error("Branch, commit, or configured upstream did not match the captured remote branch.");
    }
    await requireCleanIdleCheckout(pi, ctx);
  } catch {
    throw new Error("Tracking checkout did not complete with verified postconditions; inspect the repository before retrying. No automatic rollback was attempted.");
  }
  return { action: "track_branch", repoRoot: ctx.cwd, branchName: input.branchName, previousBranch: previous.currentBranch, head, upstream };
}

export interface UpdateFromBaseInput {
  baseBranch: string;
  remote?: string;
}

async function captureUpstreamConfiguration(pi: GitAPI, ctx: GitCommandContext, branch: string, signal?: AbortSignal): Promise<string> {
  const values: string[] = [];
  for (const key of ["remote", "merge"]) {
    const result = await runGit(pi, ctx, ["config", "--null", "--get-all", `branch.${branch}.${key}`], { signal, allowFailure: true });
    if (result.code !== 0 && (result.code !== 1 || result.stdout || result.stderr)) {
      throw new Error("Unable to inspect upstream configuration.");
    }
    values.push(result.stdout);
  }
  return JSON.stringify(values);
}

async function updateFromBaseWithinQueue(pi: GitAPI, ctx: GitCommandContext, input: UpdateFromBaseInput, signal?: AbortSignal) {
  const remote = input.remote ?? "origin";
  requireLosslessWorktreeIdentity(remote, "branch");
  requireLosslessWorktreeIdentity(input.baseBranch, "branch");
  await validateBranchName(pi, ctx, input.baseBranch, signal);
  await requireCleanIdleCheckout(pi, ctx, signal);
  const current = await getCurrentBranch(pi, ctx, signal);
  if (!current.currentBranch || current.detached) throw new Error("update_from_base requires a current local branch.");
  if (current.currentBranch === input.baseBranch) throw new Error("Use pull_branch for the base branch itself.");
  requireLosslessWorktreeIdentity(current.currentBranch, "branch");
  const upstreamBefore = await captureUpstreamConfiguration(pi, ctx, current.currentBranch, signal);
  await fetchWorkflowBase(pi, ctx, remote, input.baseBranch, signal);
  const integration = await integrateBranchWithinQueue(pi, ctx, {
    sourceBranch: `${remote}/${input.baseBranch}`, targetBranch: current.currentBranch,
  }, ctx.cwd, signal, true);
  if (await captureUpstreamConfiguration(pi, ctx, current.currentBranch) !== upstreamBefore) {
    throw new Error("Upstream configuration changed during update; inspect the repository before retrying.");
  }
  return { action: "update_from_base" as const, request: input, status: integration.status, integration };
}

export async function updateFromBase(pi: GitAPI, ctx: GitCommandContext, input: UpdateFromBaseInput, signal?: AbortSignal) {
  const root = await getCanonicalGitWorktreeRoot(pi, ctx, signal);
  requireLosslessWorktreeIdentity(root, "cwd");
  return withRepositoryMutationQueue(root, updateFromBaseWithinQueue.bind(undefined, pi, { cwd: root }, input, signal));
}

export async function trackBranch(pi: GitAPI, ctx: GitCommandContext, input: TrackBranchInput, signal?: AbortSignal): Promise<TrackBranchDetails> {
  const root = await getCanonicalGitWorktreeRoot(pi, ctx, signal);
  requireLosslessWorktreeIdentity(root, "cwd");
  return withRepositoryMutationQueue(root, trackBranchWithinQueue.bind(undefined, pi, { cwd: root }, input, signal));
}
