import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GIT_MUTATION_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
  MAX_SUMMARY_OUTPUT_CHARS,
} from "./constants.ts";
import type {
  AheadBehindCount,
  BranchStatusDetails,
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

function trimOutput(value: string): string {
  return value.replace(/\s+$/u, "");
}

function compactOutput(value: string): string {
  const text = trimOutput(value);
  if (text.length <= MAX_SUMMARY_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_OUTPUT_CHARS)}… [truncated]`;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

export function formatGitFailure(args: readonly string[], result: GitExecResult): string {
  const reason = compactOutput(result.stderr || result.stdout) || `exit code ${result.code}`;
  const killed = result.killed ? " (killed)" : "";
  return `${commandLabel(args)} failed${killed}: ${reason}`;
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
    throw new Error(`Not a git repository: ${compactOutput(result.stderr || result.stdout) || "git rev-parse failed"}`);
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

  throw new Error(`Unable to determine current branch: ${compactOutput(result.stderr || verify.stderr) || "HEAD is invalid"}`);
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
    throw new Error(`Unable to parse ahead/behind counts from git output: ${compactOutput(result.stdout)}`);
  }
  return { ahead, behind };
}

export function validateBranchNameInput(branchName: string): void {
  if (typeof branchName !== "string") throw new Error("Branch name must be a string.");
  if (branchName.length === 0) throw new Error("Branch name is required.");
  if (branchName.trim().length === 0) throw new Error("Branch name cannot be blank.");
  if (branchName !== branchName.trim()) throw new Error("Branch name cannot start or end with whitespace.");
  if (branchName.startsWith("-")) throw new Error("Branch name cannot start with '-'.");
  if (/[\u0000-\u001f\u007f]/u.test(branchName)) {
    throw new Error("Branch name cannot contain NUL, newline, or control characters.");
  }
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
    throw new Error(`Invalid branch name '${branchName}': ${compactOutput(result.stderr || result.stdout) || "git rejected the ref"}`);
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

export async function createLocalBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  branchName: string,
  signal?: AbortSignal,
): Promise<CreateBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const previousBranch = await requireCurrentBranch(pi, ctx, signal);
  await validateBranchName(pi, ctx, branchName, signal);

  if (await localBranchExists(pi, ctx, branchName, signal)) {
    throw new Error(`Local branch '${branchName}' already exists.`);
  }

  await runGit(pi, ctx, ["switch", "-c", branchName], {
    signal,
    timeout: GIT_MUTATION_TIMEOUT_MS,
  });

  return { repoRoot, previousBranch, newBranch: branchName };
}

export async function pushCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<PushBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const currentBranch = await requireCurrentBranch(pi, ctx, signal);
  const upstream = await getUpstreamBranch(pi, ctx, signal);
  const args = upstream ? ["push"] : ["push", "--set-upstream", "origin", currentBranch];
  const result = await runGit(pi, ctx, args, {
    signal,
    timeout: GIT_PUSH_TIMEOUT_MS,
  });

  return {
    repoRoot,
    currentBranch,
    upstream,
    mode: upstream ? "push" : "publish",
    output: compactOutput(result.stdout || result.stderr),
  };
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
  const counts = upstream ? await getAheadBehindCount(pi, ctx, signal) : { ahead: null, behind: null };

  return {
    repoRoot,
    currentBranch: current.currentBranch,
    detached: current.detached,
    upstream,
    hasChanges,
    ahead: counts.ahead,
    behind: counts.behind,
  };
}
