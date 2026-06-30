import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GIT_MUTATION_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
  MAX_SUMMARY_OUTPUT_CHARS,
} from "./constants.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  AheadBehindCount,
  BranchStatusDetails,
  ChangeBranchDetails,
  CreateBranchDetails,
  CurrentBranchInfo,
  GitExecResult,
  PushBranchDetails,
} from "./types.ts";

export interface GitCommandContext {
  cwd: string;
}

export interface GitRunOptions {
  signal?: AbortSignal;
  timeout?: number;
  allowFailure?: boolean;
}

const repositoryMutationQueues = new Map<string, Promise<void>>();

export async function withRepositoryMutationQueue<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositoryMutationQueues.get(repoRoot) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  repositoryMutationQueues.set(repoRoot, queued);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (repositoryMutationQueues.get(repoRoot) === queued) {
      void queued.finally(() => {
        if (repositoryMutationQueues.get(repoRoot) === queued) repositoryMutationQueues.delete(repoRoot);
      });
    }
  }
}

function trimOutput(value: string): string {
  return value.replace(/\s+$/u, "");
}

function compactOutput(value: string): string {
  const text = trimOutput(value);
  if (text.length <= MAX_SUMMARY_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_OUTPUT_CHARS)}… [truncated]`;
}

function safeOutput(value: string, tokens: readonly string[] = []): string {
  return compactOutput(redactSecrets(value, tokens));
}

function safeDetail(value: string): string {
  return redactSecrets(value);
}

function safeNullableDetail(value: string | null): string | null {
  return value === null ? null : safeDetail(value);
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function safeCommandLabel(args: readonly string[], tokens: readonly string[] = []): string {
  return redactSecrets(commandLabel(args), tokens);
}

export function formatGitFailure(args: readonly string[], result: GitExecResult, tokens: readonly string[] = []): string {
  const fallbackReason = result.killed ? "command was killed or timed out" : `exit code ${result.code}`;
  const reason = safeOutput(result.stderr || result.stdout, tokens) || fallbackReason;
  const killed = result.killed ? " (killed)" : "";
  return `${safeCommandLabel(args, tokens)} failed${killed}: ${reason}`;
}

export async function runGit(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitExecResult> {
  const result = await pi.exec("git", args, {
    cwd: ctx.cwd,
    signal: options.signal,
    timeout: options.timeout ?? GIT_STATUS_TIMEOUT_MS,
  });

  if (result.killed) {
    throw new Error(formatGitFailure(args, result));
  }

  if (!options.allowFailure && result.code !== 0) {
    throw new Error(formatGitFailure(args, result));
  }

  return result;
}

export async function getGitRoot(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  const args = ["rev-parse", "--show-toplevel"];
  const result = await runGit(pi, ctx, args, { signal, timeout: GIT_STATUS_TIMEOUT_MS, allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`Not a git repository: ${safeOutput(result.stderr || result.stdout) || "git rev-parse failed"}`);
  }

  const root = trimOutput(result.stdout);
  if (!root) throw new Error("Not a git repository: git did not return a repository root.");
  return root;
}

export async function getCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<CurrentBranchInfo> {
  const args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
  const result = await runGit(pi, ctx, args, { signal, timeout: GIT_STATUS_TIMEOUT_MS, allowFailure: true });
  if (result.code === 0) {
    const branch = trimOutput(result.stdout);
    if (!branch) throw new Error("Unable to determine current branch: git returned an empty branch name.");
    return { currentBranch: branch, detached: false };
  }

  const verify = await runGit(pi, ctx, ["rev-parse", "--verify", "HEAD"], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  if (verify.code === 0) return { currentBranch: null, detached: true };

  throw new Error(`Unable to determine current branch: ${safeOutput(result.stderr || verify.stderr) || "HEAD is invalid"}`);
}

export async function requireCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  const current = await getCurrentBranch(pi, ctx, signal);
  if (current.detached || !current.currentBranch) {
    throw new Error("Cannot continue while HEAD is detached. Checkout a branch first.");
  }
  return current.currentBranch;
}

export async function getUpstreamBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const args = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
  const result = await runGit(pi, ctx, args, { signal, timeout: GIT_STATUS_TIMEOUT_MS, allowFailure: true });
  if (result.code !== 0) return null;

  const upstream = trimOutput(result.stdout);
  return upstream || null;
}

interface PushTarget {
  upstream: string | null;
  mode: "push" | "publish";
  remote: string;
  remoteRef: string;
  refspec: string;
  args: string[];
}

function validateRemoteName(remote: string): void {
  if (!remote) throw new Error("Unable to push current branch: upstream remote is missing.");
  if (remote === ".") throw new Error("Unable to push current branch: upstream is a local branch, not a remote.");
  if (remote.startsWith("-")) throw new Error("Unable to push current branch: upstream remote cannot start with '-'.");
  if (remote.includes(":") || remote.includes("@")) {
    throw new Error("Unable to push current branch: upstream remote name cannot be a URL or user-prefixed target.");
  }
  if (/[\u0000-\u001f\u007f\s]/u.test(remote)) {
    throw new Error("Unable to push current branch: upstream remote contains whitespace or control characters.");
  }
}

function normalizeRemoteHeadRef(mergeRef: string): string {
  if (!mergeRef.startsWith("refs/heads/")) {
    throw new Error("Unable to push current branch: upstream merge ref is not a branch ref.");
  }

  const branchName = mergeRef.slice("refs/heads/".length);
  validateBranchNameInput(branchName);
  return mergeRef;
}

async function getBranchConfigValue(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  currentBranch: string,
  key: "remote" | "merge",
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(pi, ctx, ["config", "--get", `branch.${currentBranch}.${key}`], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code !== 0) return null;

  const value = trimOutput(result.stdout);
  return value || null;
}

async function resolvePushTarget(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  currentBranch: string,
  signal?: AbortSignal,
): Promise<PushTarget> {
  validateBranchNameInput(currentBranch);
  const upstream = await getUpstreamBranch(pi, ctx, signal);
  if (!upstream) {
    const remoteRef = `refs/heads/${currentBranch}`;
    return {
      upstream: null,
      mode: "publish",
      remote: "origin",
      remoteRef,
      refspec: currentBranch,
      args: ["push", "--set-upstream", "origin", currentBranch],
    };
  }

  const remote = await getBranchConfigValue(pi, ctx, currentBranch, "remote", signal);
  const mergeRef = await getBranchConfigValue(pi, ctx, currentBranch, "merge", signal);
  if (!remote || !mergeRef) {
    throw new Error("Unable to push current branch: upstream exists but branch remote/merge configuration is incomplete.");
  }

  validateRemoteName(remote);
  const remoteRef = normalizeRemoteHeadRef(mergeRef);
  const refspec = `HEAD:${remoteRef}`;
  return {
    upstream,
    mode: "push",
    remote,
    remoteRef,
    refspec,
    args: ["push", remote, refspec],
  };
}

export async function hasWorkingTreeChanges(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runGit(pi, ctx, ["status", "--porcelain=v1", "--branch"], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  return result.stdout
    .split("\n")
    .some((line) => line.length > 0 && !line.startsWith("## "));
}

export async function getAheadBehindCount(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<AheadBehindCount> {
  const result = await runGit(pi, ctx, ["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const [aheadText, behindText] = trimOutput(result.stdout).split(/\s+/u);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    throw new Error(`Unable to parse ahead/behind counts from git output: ${safeOutput(result.stdout)}`);
  }
  return { ahead, behind };
}

export function validateBranchNameInput(branchName: unknown, label = "Branch name"): asserts branchName is string {
  if (typeof branchName !== "string") throw new Error(`${label} must be a string.`);
  if (branchName.length === 0) throw new Error(`${label} is required.`);
  if (branchName.trim().length === 0) throw new Error(`${label} cannot be blank.`);
  if (branchName !== branchName.trim()) throw new Error(`${label} cannot start or end with whitespace.`);
  if (branchName.startsWith("-")) throw new Error(`${label} cannot start with '-'.`);
  if (/[\u0000-\u001f\u007f]/u.test(branchName)) {
    throw new Error(`${label} cannot contain NUL, newline, or control characters.`);
  }
  if (/\s/u.test(branchName)) throw new Error(`${label} cannot contain whitespace.`);
}

export async function validateBranchName(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  branchName: string,
  signal?: AbortSignal,
): Promise<void> {
  validateBranchNameInput(branchName);
  const args = ["check-ref-format", "--branch", branchName];
  const result = await runGit(pi, ctx, args, { signal, timeout: GIT_STATUS_TIMEOUT_MS, allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`Invalid branch name '${redactSecrets(branchName)}': ${safeOutput(result.stderr || result.stdout) || "git rejected the ref"}`);
  }
}

export async function localBranchExists(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  branchName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runGit(pi, ctx, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  return result.code === 0;
}

export async function getLocalBranchCommit(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  branchName: string,
  signal?: AbortSignal,
): Promise<string> {
  validateBranchNameInput(branchName);
  const result = await runGit(pi, ctx, ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const commit = trimOutput(result.stdout);
  if (!/^[0-9a-f]{40,64}$/iu.test(commit)) {
    throw new Error(`Unable to resolve local branch '${redactSecrets(branchName)}' to a commit: ${safeOutput(result.stdout) || "empty output"}`);
  }
  return commit;
}

export async function createLocalBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  branchName: string,
  signal?: AbortSignal,
): Promise<CreateBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const previousBranch = await requireCurrentBranch(pi, rootCtx, signal);
    await validateBranchName(pi, rootCtx, branchName, signal);

    if (await localBranchExists(pi, rootCtx, branchName, signal)) {
      throw new Error(`Local branch '${redactSecrets(branchName)}' already exists.`);
    }

    await runGit(pi, rootCtx, ["switch", "-c", branchName], {
      signal,
      timeout: GIT_MUTATION_TIMEOUT_MS,
    });

    return { repoRoot, previousBranch: safeDetail(previousBranch), newBranch: safeDetail(branchName) };
  });
}

export async function changeExistingLocalBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  branchName: string,
  signal?: AbortSignal,
): Promise<ChangeBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    await validateBranchName(pi, rootCtx, branchName, signal);

    if (!(await localBranchExists(pi, rootCtx, branchName, signal))) {
      throw new Error(`Local branch '${redactSecrets(branchName)}' does not exist.`);
    }

    const previous = await getCurrentBranch(pi, rootCtx, signal);
    if (!previous.detached && previous.currentBranch === branchName) {
      throw new Error(`Already on branch '${redactSecrets(branchName)}'.`);
    }

    if (await hasWorkingTreeChanges(pi, rootCtx, signal)) {
      throw new Error("Working tree has uncommitted changes; clean it before changing branches.");
    }

    await runGit(pi, rootCtx, ["switch", branchName], {
      signal,
      timeout: GIT_MUTATION_TIMEOUT_MS,
    });

    const current = await getCurrentBranch(pi, rootCtx, signal);
    if (current.detached || current.currentBranch !== branchName) {
      throw new Error(`git switch did not end on branch '${redactSecrets(branchName)}'.`);
    }

    return {
      repoRoot,
      previousBranch: safeNullableDetail(previous.currentBranch),
      previousDetached: previous.detached,
      currentBranch: safeDetail(current.currentBranch),
      hasChangesBeforeSwitch: false,
    };
  });
}

export async function pushCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<PushBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const currentBranch = await requireCurrentBranch(pi, rootCtx, signal);
    const target = await resolvePushTarget(pi, rootCtx, currentBranch, signal);
    const result = await runGit(pi, rootCtx, target.args, {
      signal,
      timeout: GIT_PUSH_TIMEOUT_MS,
    });

    return {
      repoRoot,
      currentBranch: safeDetail(currentBranch),
      upstream: safeNullableDetail(target.upstream),
      mode: target.mode,
      remote: safeDetail(target.remote),
      remoteRef: safeDetail(target.remoteRef),
      refspec: safeDetail(target.refspec),
      output: safeOutput(result.stdout || result.stderr),
    };
  });
}

export async function getOriginUrl(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(pi, ctx, ["remote", "get-url", "origin"], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code !== 0) return null;

  const url = trimOutput(result.stdout);
  return url || null;
}

export async function getBranchStatus(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<BranchStatusDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const current = await getCurrentBranch(pi, ctx, signal);
  const upstream = current.detached ? null : await getUpstreamBranch(pi, ctx, signal);
  const hasChanges = await hasWorkingTreeChanges(pi, ctx, signal);
  const warnings: string[] = [];
  let counts: AheadBehindCount = { ahead: null, behind: null };
  if (upstream) {
    try {
      counts = await getAheadBehindCount(pi, ctx, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = safeOutput(error instanceof Error ? error.message : String(error)) || "git rev-list failed";
      warnings.push(`ahead/behind unavailable: ${message}`);
    }
  }

  return {
    repoRoot,
    currentBranch: safeNullableDetail(current.currentBranch),
    detached: current.detached,
    upstream: safeNullableDetail(upstream),
    hasChanges,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
