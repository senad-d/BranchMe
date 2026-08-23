import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GIT_CONTEXT_CHANGE_LIMIT,
  GIT_CONTEXT_RECENT_COMMIT_LIMIT,
  GIT_CONTEXT_VALUE_LIMIT_CHARS,
  GIT_FETCH_TIMEOUT_MS,
  GIT_MUTATION_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_REBASE_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
  GIT_WORKTREE_ENTRY_LIMIT,
  GIT_WORKTREE_MUTATION_TIMEOUT_MS,
  GIT_WORKTREE_PATH_LIMIT_CHARS,
  GIT_WORKTREE_RAW_OUTPUT_LIMIT_BYTES,
  GIT_WORKTREE_REASON_LIMIT_CHARS,
  GIT_WORKTREE_SUMMARY_LIMIT_CHARS,
  MAX_SUMMARY_OUTPUT_CHARS,
  PULL_REQUEST_AUTOFILL_COMMIT_LIMIT,
  PULL_REQUEST_AUTOFILL_SUBJECT_LIMIT_CHARS,
} from "./constants.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  AheadBehindCount,
  BranchStatusDetails,
  ChangeBranchDetails,
  CreateBranchDetails,
  CreateWorktreeDetails,
  CreateWorktreeMode,
  CurrentBranchInfo,
  FetchBranchDetails,
  GitExecResult,
  GitFileChange,
  GitFileChangeSummary,
  ListWorktreesDetails,
  PullBranchDetails,
  PushBranchDetails,
  RebaseBranchDetails,
  RemoveWorktreeDetails,
  RecentCommit,
  VerifiedLinkedWorktreeEntry,
  WorkingTreeDetails,
  WorktreeEntry,
} from "./types.ts";

export interface GitCommandContext {
  cwd: string;
}

export interface GitRunOptions {
  signal?: AbortSignal;
  timeout?: number;
  allowFailure?: boolean;
  tokens?: readonly string[];
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
  return value.trimEnd();
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
    throw new Error(formatGitFailure(args, result, options.tokens));
  }

  if (!options.allowFailure && result.code !== 0) {
    throw new Error(formatGitFailure(args, result, options.tokens));
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

interface ConfiguredUpstreamTarget {
  upstream: string;
  remote: string;
  remoteRef: string;
}

interface PushTarget {
  upstream: string | null;
  mode: "push" | "publish";
  remote: string;
  remoteRef: string;
  refspec: string;
  args: string[];
}

type UpstreamOperation = "fetch" | "pull" | "push" | "rebase";

function validateRemoteName(remote: string, operation: UpstreamOperation): void {
  if (!remote) throw new Error(`Unable to ${operation} current branch: upstream remote is missing.`);
  if (remote === ".") throw new Error(`Unable to ${operation} current branch: upstream is a local branch, not a remote.`);
  if (remote.startsWith("-")) throw new Error(`Unable to ${operation} current branch: upstream remote cannot start with '-'.`);
  if (remote.includes(":") || remote.includes("@")) {
    throw new Error(`Unable to ${operation} current branch: upstream remote name cannot be a URL or user-prefixed target.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(remote) || /\s/u.test(remote)) {
    throw new Error(`Unable to ${operation} current branch: upstream remote contains whitespace or control characters.`);
  }
}

function normalizeRemoteHeadRef(mergeRef: string, operation: UpstreamOperation): string {
  if (!mergeRef.startsWith("refs/heads/")) {
    throw new Error(`Unable to ${operation} current branch: upstream merge ref is not a branch ref.`);
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

function remoteTrackingRef(upstream: string, remote: string): string {
  const prefix = `${remote}/`;
  if (!upstream.startsWith(prefix)) {
    throw new Error("Unable to fetch current branch: configured upstream does not match its remote.");
  }

  const trackingBranch = upstream.slice(prefix.length);
  validateBranchNameInput(trackingBranch, "Upstream branch name");
  return `refs/remotes/${upstream}`;
}

async function resolveConfiguredUpstreamTarget(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  currentBranch: string,
  operation: UpstreamOperation,
  signal?: AbortSignal,
): Promise<ConfiguredUpstreamTarget | null> {
  validateBranchNameInput(currentBranch);
  const upstream = await getUpstreamBranch(pi, ctx, signal);
  if (!upstream) return null;

  const remote = await getBranchConfigValue(pi, ctx, currentBranch, "remote", signal);
  const mergeRef = await getBranchConfigValue(pi, ctx, currentBranch, "merge", signal);
  if (!remote || !mergeRef) {
    throw new Error(`Unable to ${operation} current branch: upstream exists but branch remote/merge configuration is incomplete.`);
  }

  validateRemoteName(remote, operation);
  return {
    upstream,
    remote,
    remoteRef: normalizeRemoteHeadRef(mergeRef, operation),
  };
}

async function resolvePushTarget(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  currentBranch: string,
  signal?: AbortSignal,
): Promise<PushTarget> {
  const upstreamTarget = await resolveConfiguredUpstreamTarget(pi, ctx, currentBranch, "push", signal);
  if (!upstreamTarget) {
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

  const refspec = `HEAD:${upstreamTarget.remoteRef}`;
  return {
    ...upstreamTarget,
    mode: "push",
    refspec,
    args: ["push", upstreamTarget.remote, refspec],
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

export interface WorkingTreeStatus {
  workingTree: WorkingTreeDetails;
  unstagedChanges: GitFileChangeSummary;
}

const UNMERGED_GIT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const GIT_STATUS_CODE_PATTERN = /^[ MADRCUT?!]{2}$/u;
const GIT_LOG_FIELD_SEPARATOR = "\u001f";
const NUL_SEPARATOR = "\u0000";
const GIT_LOG_FORMAT = `%x00%H%x1f%h%x1f%ad%x1f%s`;
const GIT_WORKTREE_REMOVAL_IGNORED_STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=normal",
  "--ignored=matching",
];

function truncateGitContextValue(value: string): string {
  if (value.length <= GIT_CONTEXT_VALUE_LIMIT_CHARS) return value;

  let end = GIT_CONTEXT_VALUE_LIMIT_CHARS - 1;
  const lastCodePoint = value.codePointAt(end - 1);
  if (lastCodePoint !== undefined && lastCodePoint > 0xffff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function escapeGitContextControlCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? "" : String.raw`\u${codePoint.toString(16).padStart(4, "0")}`;
}

function safeGitContextValue(value: string): string {
  const redacted = redactSecrets(value);
  const escaped = redacted.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, escapeGitContextControlCharacter);
  return truncateGitContextValue(escaped);
}

interface ParsedWorktreeRecord {
  rawPath: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}

interface WorktreeAttribute {
  key: string;
  value: string | null;
}

function worktreeParseError(): TypeError {
  return new TypeError("Unable to parse worktrees: malformed git worktree output.");
}

function truncateWorktreeValue(value: string, limit: number): string {
  if (value.length <= limit) return value;

  let end = limit - 1;
  const lastCodePoint = value.codePointAt(end - 1);
  if (lastCodePoint !== undefined && lastCodePoint > 0xffff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function safeWorktreeValue(value: string, limit: number): string {
  const redacted = redactSecrets(value);
  const escaped = redacted.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, escapeGitContextControlCharacter);
  return truncateWorktreeValue(escaped, limit);
}

function splitWorktreeAttribute(line: string): WorktreeAttribute {
  const separator = line.indexOf(" ");
  if (separator < 0) return { key: line, value: null };
  return { key: line.slice(0, separator), value: line.slice(separator + 1) };
}

function assertUniqueWorktreeAttribute(seen: Set<string>, key: string): void {
  if (seen.has(key)) throw worktreeParseError();
  seen.add(key);
}

function parseWorktreeRecord(lines: string[]): ParsedWorktreeRecord {
  const worktreeLine = lines[0];
  if (!worktreeLine?.startsWith("worktree ")) throw worktreeParseError();

  const rawPath = worktreeLine.slice("worktree ".length);
  if (!rawPath || !isAbsolute(rawPath)) throw worktreeParseError();

  const seen = new Set<string>();
  let head: string | null = null;
  let headSeen = false;
  let branch: string | null = null;
  let branchSeen = false;
  let detached = false;
  let bare = false;
  let locked = false;
  let lockReason: string | null = null;
  let prunable = false;
  let pruneReason: string | null = null;

  for (const line of lines.slice(1)) {
    const attribute = splitWorktreeAttribute(line);
    switch (attribute.key) {
      case "HEAD":
        assertUniqueWorktreeAttribute(seen, attribute.key);
        if (attribute.value === null || !/^[0-9a-f]{40,64}$/iu.test(attribute.value)) {
          throw worktreeParseError();
        }
        head = attribute.value;
        headSeen = true;
        break;
      case "branch": {
        assertUniqueWorktreeAttribute(seen, attribute.key);
        const prefix = "refs/heads/";
        if (attribute.value === null || !attribute.value.startsWith(prefix)) throw worktreeParseError();
        const branchName = attribute.value.slice(prefix.length);
        if (!branchName) throw worktreeParseError();
        branch = branchName;
        branchSeen = true;
        break;
      }
      case "detached":
        assertUniqueWorktreeAttribute(seen, attribute.key);
        if (attribute.value !== null) throw worktreeParseError();
        detached = true;
        break;
      case "bare":
        assertUniqueWorktreeAttribute(seen, attribute.key);
        if (attribute.value !== null) throw worktreeParseError();
        bare = true;
        break;
      case "locked":
        assertUniqueWorktreeAttribute(seen, attribute.key);
        locked = true;
        lockReason = attribute.value ? safeWorktreeValue(attribute.value, GIT_WORKTREE_REASON_LIMIT_CHARS) : null;
        break;
      case "prunable":
        assertUniqueWorktreeAttribute(seen, attribute.key);
        prunable = true;
        pruneReason = attribute.value ? safeWorktreeValue(attribute.value, GIT_WORKTREE_REASON_LIMIT_CHARS) : null;
        break;
      case "worktree":
        throw worktreeParseError();
      default:
        break;
    }
  }

  if (bare) {
    if (branchSeen || detached) throw worktreeParseError();
  } else if (!headSeen || branchSeen === detached) {
    throw worktreeParseError();
  }

  return { rawPath, head, branch, detached, bare, locked, lockReason, prunable, pruneReason };
}

function splitWorktreeRecords(output: string): string[][] {
  if (Buffer.byteLength(output, "utf8") > GIT_WORKTREE_RAW_OUTPUT_LIMIT_BYTES) {
    throw new TypeError("Unable to parse worktrees: git worktree output exceeded the safety limit.");
  }

  const records: string[][] = [];
  let current: string[] = [];
  for (const field of output.split(NUL_SEPARATOR)) {
    if (field.length > 0) {
      current.push(field);
      continue;
    }
    if (current.length > 0) {
      records.push(current);
      current = [];
    }
  }
  if (current.length > 0) records.push(current);
  if (records.length === 0) throw worktreeParseError();
  return records;
}

function parseWorktreeRecords(output: string): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  for (const lines of splitWorktreeRecords(output)) records.push(parseWorktreeRecord(lines));
  return records;
}

function worktreeEntry(record: ParsedWorktreeRecord, index: number, current: boolean): WorktreeEntry {
  return {
    path: safeWorktreeValue(record.rawPath, GIT_WORKTREE_PATH_LIMIT_CHARS),
    head: record.head,
    branch: record.branch === null ? null : safeWorktreeValue(record.branch, GIT_CONTEXT_VALUE_LIMIT_CHARS),
    detached: record.detached,
    bare: record.bare,
    locked: record.locked,
    lockReason: record.lockReason,
    prunable: record.prunable,
    pruneReason: record.pruneReason,
    main: index === 0,
    current,
  };
}

export function parseWorktreePorcelain(output: string): Pick<ListWorktreesDetails, "worktrees" | "omitted"> {
  const records = parseWorktreeRecords(output);
  const worktrees: WorktreeEntry[] = [];
  const returnedCount = Math.min(records.length, GIT_WORKTREE_ENTRY_LIMIT);
  for (let index = 0; index < returnedCount; index += 1) {
    worktrees.push(worktreeEntry(records[index], index, false));
  }
  return { worktrees, omitted: records.length - returnedCount };
}

interface WorktreeInventoryEntry {
  record: ParsedWorktreeRecord;
  index: number;
  canonicalPath: string | null;
}

interface WorktreeInventory {
  repoRoot: string;
  canonicalCurrentPath: string;
  entries: WorktreeInventoryEntry[];
}

interface ResolvedWorktreeRemovalTarget {
  repoRoot: string;
  canonicalPath: string;
  entry: WorktreeInventoryEntry;
  current: boolean;
  inventory: WorktreeInventory;
}

interface PreparedWorktreeCreation {
  inventory: WorktreeInventory;
  commonGitDir: string;
  canonicalPath: string;
}

export interface WorktreeCreationPathValidation {
  repoRoot: string;
  commonGitDir: string;
  canonicalPath: string;
}

export interface WorktreeRemovalPathValidation {
  repoRoot: string;
  canonicalPath: string;
  worktree: WorktreeEntry;
}

function filesystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isMissingFilesystemPath(error: unknown): boolean {
  const code = filesystemErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function safeWorktreePathLabel(path: string): string {
  return JSON.stringify(safeWorktreeValue(path, GIT_WORKTREE_PATH_LIMIT_CHARS));
}

function safeWorktreeBranchLabel(branchName: string): string {
  return JSON.stringify(safeWorktreeValue(branchName, GIT_CONTEXT_VALUE_LIMIT_CHARS));
}

export function validateWorktreePathInput(worktreePath: unknown): string {
  if (typeof worktreePath !== "string") throw new TypeError("worktreePath must be a string.");
  if (worktreePath.trim().length === 0) throw new Error("worktreePath is required and cannot be blank.");
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(worktreePath)) {
    throw new Error("worktreePath cannot contain NUL, newline, or control characters.");
  }
  if (!isAbsolute(worktreePath)) throw new Error("worktreePath must be an absolute path.");

  const normalizedPath = normalize(worktreePath);
  if (!basename(normalizedPath)) throw new Error("worktreePath must identify a destination below a parent directory.");
  return normalizedPath;
}

async function canonicalizePathAllowMissing(path: string): Promise<string | null> {
  let candidate = normalize(path);
  const suffix: string[] = [];

  for (;;) {
    try {
      const canonicalAncestor = await realpath(candidate);
      return suffix.length === 0 ? canonicalAncestor : join(canonicalAncestor, ...suffix);
    } catch (error) {
      if (!isMissingFilesystemPath(error)) return null;
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function collectWorktreeInventory(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<WorktreeInventory> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const args = ["worktree", "list", "--porcelain", "-z"];
  const result = await runGit(pi, { cwd: repoRoot }, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const records = parseWorktreeRecords(result.stdout);
  const canonicalCurrentPath = await canonicalizePathAllowMissing(repoRoot);
  if (!canonicalCurrentPath) {
    throw new Error("Unable to inspect worktrees: current repository path could not be resolved.");
  }

  const entries: WorktreeInventoryEntry[] = [];
  for (const [index, record] of records.entries()) {
    entries.push({ record, index, canonicalPath: await canonicalizePathAllowMissing(record.rawPath) });
  }
  return { repoRoot, canonicalCurrentPath, entries };
}

function pathIsInsideOrEqual(candidatePath: string, boundaryPath: string): boolean {
  const relation = relative(boundaryPath, candidatePath);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function requireCanonicalCreationPath(worktreePath: string): Promise<string> {
  const parentPath = dirname(worktreePath);
  let parentStats;
  try {
    parentStats = await stat(parentPath);
  } catch {
    throw new Error(`worktreePath parent ${safeWorktreePathLabel(parentPath)} must exist as a directory.`);
  }
  if (!parentStats.isDirectory()) {
    throw new Error(`worktreePath parent ${safeWorktreePathLabel(parentPath)} must be a directory.`);
  }

  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parentPath);
  } catch {
    throw new Error(`worktreePath parent ${safeWorktreePathLabel(parentPath)} could not be resolved.`);
  }

  const canonicalPath = join(canonicalParent, basename(worktreePath));
  try {
    await lstat(canonicalPath);
  } catch (error) {
    if (isMissingFilesystemPath(error)) return canonicalPath;
    throw new Error(`worktreePath destination ${safeWorktreePathLabel(canonicalPath)} could not be inspected.`);
  }
  throw new Error(`worktreePath destination ${safeWorktreePathLabel(canonicalPath)} already exists.`);
}

function stripSingleLineTerminator(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

async function getCommonGitDirectory(
  pi: Pick<ExtensionAPI, "exec">,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const result = await runGit(pi, { cwd: repoRoot }, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const commonGitDir = stripSingleLineTerminator(result.stdout);
  if (
    !commonGitDir ||
    !isAbsolute(commonGitDir) ||
    /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(commonGitDir)
  ) {
    throw new Error("Unable to validate worktree path: Git returned an invalid common directory.");
  }

  try {
    return await realpath(commonGitDir);
  } catch {
    throw new Error("Unable to validate worktree path: Git common directory could not be resolved.");
  }
}

async function prepareWorktreeCreation(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  worktreePath: unknown,
  signal?: AbortSignal,
): Promise<PreparedWorktreeCreation> {
  const normalizedPath = validateWorktreePathInput(worktreePath);
  const canonicalPath = await requireCanonicalCreationPath(normalizedPath);
  const inventory = await collectWorktreeInventory(pi, ctx, signal);

  for (const entry of inventory.entries) {
    if (!entry.canonicalPath) {
      throw new Error("Unable to validate worktree path: a registered worktree path could not be resolved.");
    }
    if (pathIsInsideOrEqual(canonicalPath, entry.canonicalPath)) {
      throw new Error("worktreePath destination cannot be inside a registered worktree.");
    }
  }

  const commonGitDir = await getCommonGitDirectory(pi, inventory.repoRoot, signal);
  if (pathIsInsideOrEqual(canonicalPath, commonGitDir)) {
    throw new Error("worktreePath destination cannot be inside the repository common Git directory.");
  }

  return { inventory, commonGitDir, canonicalPath };
}

export async function validateWorktreeCreationPath(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  worktreePath: unknown,
  signal?: AbortSignal,
): Promise<WorktreeCreationPathValidation> {
  const prepared = await prepareWorktreeCreation(pi, ctx, worktreePath, signal);
  return {
    repoRoot: prepared.inventory.repoRoot,
    commonGitDir: prepared.commonGitDir,
    canonicalPath: prepared.canonicalPath,
  };
}

async function resolveWorktreeRemovalTarget(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  worktreePath: unknown,
  signal?: AbortSignal,
): Promise<ResolvedWorktreeRemovalTarget> {
  const normalizedPath = validateWorktreePathInput(worktreePath);
  const canonicalPath = await canonicalizePathAllowMissing(normalizedPath);
  if (!canonicalPath) throw new Error("worktreePath could not be resolved for removal.");

  const inventory = await collectWorktreeInventory(pi, ctx, signal);
  const matches: WorktreeInventoryEntry[] = [];
  for (const entry of inventory.entries) {
    if (entry.canonicalPath === canonicalPath) matches.push(entry);
  }
  if (matches.length !== 1) {
    throw new Error("worktreePath must exactly match a registered worktree in the current repository.");
  }

  const entry = matches[0];
  return {
    repoRoot: inventory.repoRoot,
    canonicalPath,
    entry,
    current: canonicalPath === inventory.canonicalCurrentPath,
    inventory,
  };
}

export async function validateWorktreeRemovalPath(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  worktreePath: unknown,
  signal?: AbortSignal,
): Promise<WorktreeRemovalPathValidation> {
  const resolved = await resolveWorktreeRemovalTarget(pi, ctx, worktreePath, signal);
  return {
    repoRoot: resolved.repoRoot,
    canonicalPath: resolved.canonicalPath,
    worktree: worktreeEntry(resolved.entry.record, resolved.entry.index, resolved.current),
  };
}

export async function listWorktrees(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<ListWorktreesDetails> {
  const inventory = await collectWorktreeInventory(pi, ctx, signal);
  const worktrees: WorktreeEntry[] = [];
  const returnedCount = Math.min(inventory.entries.length, GIT_WORKTREE_ENTRY_LIMIT);
  for (let index = 0; index < returnedCount; index += 1) {
    const entry = inventory.entries[index];
    worktrees.push(
      worktreeEntry(entry.record, entry.index, entry.canonicalPath === inventory.canonicalCurrentPath),
    );
  }

  return {
    action: "list_worktrees",
    repoRoot: safeWorktreeValue(inventory.repoRoot, GIT_WORKTREE_PATH_LIMIT_CHARS),
    worktrees,
    omitted: inventory.entries.length - returnedCount,
  };
}

function validateCreateWorktreeMode(branchMode: unknown): asserts branchMode is CreateWorktreeMode {
  if (branchMode !== "new" && branchMode !== "existing") {
    throw new Error("branchMode must be either 'new' or 'existing'.");
  }
}

async function getCurrentHeadCommit(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  const args = ["rev-parse", "--verify", "HEAD^{commit}"];
  const result = await runGit(pi, ctx, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  const head = trimOutput(result.stdout);
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/iu.test(head)) {
    throw new Error("Current HEAD must resolve to a valid commit before creating a worktree.");
  }
  return head;
}

function requireSourceWorktreeEntry(
  inventory: WorktreeInventory,
  source: CurrentBranchInfo,
  sourceHead: string,
): WorktreeInventoryEntry {
  const matches = inventory.entries.filter(
    (entry) => entry.canonicalPath === inventory.canonicalCurrentPath,
  );
  if (matches.length !== 1) {
    throw new Error("Unable to verify the source worktree in the current repository inventory.");
  }

  const sourceEntry = matches[0];
  const record = sourceEntry.record;
  const branchMatches = source.detached
    ? record.detached && record.branch === null
    : !record.detached && record.branch === source.currentBranch;
  if (
    record.bare ||
    record.head === null ||
    record.head.toLowerCase() !== sourceHead.toLowerCase() ||
    !branchMatches
  ) {
    throw new Error("Unable to verify the source branch and HEAD against the worktree inventory.");
  }
  return sourceEntry;
}

function branchIsCheckedOut(inventory: WorktreeInventory, branchName: string): boolean {
  return inventory.entries.some((entry) => entry.record.branch === branchName);
}

function requireCreatedWorktreeEntry(
  inventory: WorktreeInventory,
  canonicalPath: string,
  branchName: string,
  expectedHead: string,
): VerifiedLinkedWorktreeEntry {
  const matches = inventory.entries.filter((entry) => entry.canonicalPath === canonicalPath);
  if (matches.length !== 1) {
    throw new Error("The created destination was not registered exactly once in the worktree inventory.");
  }

  const matched = matches[0];
  const record = matched.record;
  const current = canonicalPath === inventory.canonicalCurrentPath;
  if (
    matched.index === 0 ||
    current ||
    record.head === null ||
    record.head.toLowerCase() !== expectedHead.toLowerCase() ||
    record.branch !== branchName ||
    record.detached ||
    record.bare ||
    record.locked ||
    record.prunable
  ) {
    throw new Error("The created worktree did not match the requested path, local branch, and HEAD.");
  }

  return {
    path: safeWorktreeValue(canonicalPath, GIT_WORKTREE_PATH_LIMIT_CHARS),
    head: record.head,
    branch: safeWorktreeValue(branchName, GIT_CONTEXT_VALUE_LIMIT_CHARS),
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    main: false,
    current: false,
  };
}

async function inspectWorktreeState(
  pi: Pick<ExtensionAPI, "exec">,
  canonicalPath: string,
  signal?: AbortSignal,
): Promise<WorkingTreeDetails> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];
  const result = await runGit(pi, { cwd: canonicalPath }, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  return parseWorkingTreeStatus(result.stdout).workingTree;
}

async function inspectCreatedWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  canonicalPath: string,
  signal?: AbortSignal,
): Promise<WorkingTreeDetails> {
  const workingTree = await inspectWorktreeState(pi, canonicalPath, signal);
  if (workingTree.state !== "clean") {
    throw new Error("The created worktree was not clean after checkout.");
  }
  return workingTree;
}

function worktreeCreationFailure(
  error: unknown,
  canonicalPath: string,
  branchName: string,
): Error {
  const rawReason = error instanceof Error ? error.message : String(error);
  const reason = safeOutput(rawReason, [canonicalPath, branchName]);
  const reasonText = reason ? ` Reason: ${reason}` : "";
  return new Error(
    `Worktree creation at ${safeWorktreePathLabel(canonicalPath)} did not complete with verified postconditions.${reasonText} ` +
    "The repository and destination should be inspected; no automatic cleanup was attempted.",
  );
}

export async function createWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  worktreePath: unknown,
  branchName: string,
  branchMode: CreateWorktreeMode,
  signal?: AbortSignal,
): Promise<CreateWorktreeDetails> {
  validateCreateWorktreeMode(branchMode);
  const requestedWorktreePath = validateWorktreePathInput(worktreePath);
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const source = await getCurrentBranch(pi, rootCtx, signal);
    const sourceHead = await getCurrentHeadCommit(pi, rootCtx, signal);
    const prepared = await prepareWorktreeCreation(pi, rootCtx, requestedWorktreePath, signal);
    if (prepared.inventory.repoRoot !== repoRoot) {
      throw new Error("The current repository changed while preparing worktree creation.");
    }
    requireSourceWorktreeEntry(prepared.inventory, source, sourceHead);

    await validateBranchName(pi, rootCtx, branchName, signal);
    const branchExisted = await localBranchExists(pi, rootCtx, branchName, signal);
    if (branchMode === "new" && branchExisted) {
      throw new Error(`Local branch ${safeWorktreeBranchLabel(branchName)} already exists.`);
    }
    if (branchMode === "existing" && !branchExisted) {
      throw new Error(`Local branch ${safeWorktreeBranchLabel(branchName)} does not exist.`);
    }
    if (branchMode === "existing" && branchIsCheckedOut(prepared.inventory, branchName)) {
      throw new Error(`Local branch ${safeWorktreeBranchLabel(branchName)} is already checked out in a worktree.`);
    }

    const expectedHead = branchMode === "new"
      ? sourceHead
      : await getLocalBranchCommit(pi, rootCtx, branchName, signal);
    const args = branchMode === "new"
      ? ["worktree", "add", "-b", branchName, prepared.canonicalPath, "HEAD"]
      : ["worktree", "add", prepared.canonicalPath, branchName];

    try {
      await runGit(pi, rootCtx, args, {
        signal,
        timeout: GIT_WORKTREE_MUTATION_TIMEOUT_MS,
      });
      const afterInventory = await collectWorktreeInventory(pi, rootCtx, signal);
      if (
        afterInventory.repoRoot !== repoRoot ||
        afterInventory.canonicalCurrentPath !== prepared.inventory.canonicalCurrentPath
      ) {
        throw new Error("The source repository changed while verifying worktree creation.");
      }
      requireSourceWorktreeEntry(afterInventory, source, sourceHead);
      const worktree = requireCreatedWorktreeEntry(
        afterInventory,
        prepared.canonicalPath,
        branchName,
        expectedHead,
      );
      const workingTree = await inspectCreatedWorktree(pi, prepared.canonicalPath, signal);
      const safeCanonicalPath = safeWorktreeValue(prepared.canonicalPath, GIT_WORKTREE_PATH_LIMIT_CHARS);
      const safeBranchName = safeWorktreeValue(branchName, GIT_CONTEXT_VALUE_LIMIT_CHARS);
      const summary = safeWorktreeValue(
        `Worktree ready at ${safeCanonicalPath} on branch ${safeBranchName} at ${worktree.head}.`,
        GIT_WORKTREE_SUMMARY_LIMIT_CHARS,
      );

      return {
        action: "create_worktree",
        repoRoot: safeWorktreeValue(repoRoot, GIT_WORKTREE_PATH_LIMIT_CHARS),
        request: {
          worktreePath: safeWorktreeValue(requestedWorktreePath, GIT_WORKTREE_PATH_LIMIT_CHARS),
          branchName: safeBranchName,
          branchMode,
        },
        verified: {
          before: {
            sourcePath: safeWorktreeValue(
              prepared.inventory.canonicalCurrentPath,
              GIT_WORKTREE_PATH_LIMIT_CHARS,
            ),
            sourceBranch: source.currentBranch === null
              ? null
              : safeWorktreeValue(source.currentBranch, GIT_CONTEXT_VALUE_LIMIT_CHARS),
            sourceDetached: source.detached,
            sourceHead,
            canonicalWorktreePath: safeCanonicalPath,
            branchExisted,
            destinationRegistered: false,
          },
          after: {
            worktreePresent: true,
            worktree,
            workingTree,
          },
        },
        handoff: {
          cwd: safeCanonicalPath,
          branch: safeBranchName,
          head: worktree.head,
          ready: true,
          summary,
        },
      };
    } catch (error) {
      throw worktreeCreationFailure(error, prepared.canonicalPath, branchName);
    }
  });
}

function requireRemovableWorktreeEntry(
  resolved: ResolvedWorktreeRemovalTarget,
): VerifiedLinkedWorktreeEntry {
  const record = resolved.entry.record;
  if (resolved.entry.index === 0) throw new Error("The main worktree cannot be removed.");
  if (resolved.current) throw new Error("The current worktree cannot be removed.");
  if (record.bare) throw new Error("A bare worktree entry cannot be removed.");
  if (record.locked) throw new Error("A locked worktree cannot be removed.");
  if (record.prunable) throw new Error("A prunable or missing worktree cannot be removed.");
  if (record.detached || record.branch === null) {
    throw new Error("A detached worktree cannot be removed by this operation.");
  }
  if (record.head === null) throw new Error("The target worktree HEAD could not be verified.");

  return {
    path: safeWorktreeValue(resolved.canonicalPath, GIT_WORKTREE_PATH_LIMIT_CHARS),
    head: record.head,
    branch: safeWorktreeValue(record.branch, GIT_CONTEXT_VALUE_LIMIT_CHARS),
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    main: false,
    current: false,
  };
}

async function requirePresentWorktreeDirectory(canonicalPath: string): Promise<void> {
  let targetStats;
  try {
    targetStats = await stat(canonicalPath);
  } catch {
    throw new Error(`Worktree ${safeWorktreePathLabel(canonicalPath)} is missing and cannot be removed.`);
  }
  if (!targetStats.isDirectory()) {
    throw new Error(`Worktree ${safeWorktreePathLabel(canonicalPath)} is not a directory.`);
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(canonicalPath);
  } catch {
    throw new Error(`Worktree ${safeWorktreePathLabel(canonicalPath)} could not be resolved.`);
  }
  if (resolvedPath !== canonicalPath) {
    throw new Error("The target worktree path changed while preparing removal.");
  }
}

interface WorktreeRemovalStatus {
  workingTree: WorkingTreeDetails;
  hasIgnoredEntries: boolean;
}

function parseWorktreeRemovalStatus(output: string): WorktreeRemovalStatus {
  if (Buffer.byteLength(output, "utf8") > GIT_WORKTREE_RAW_OUTPUT_LIMIT_BYTES) {
    throw new Error("Unable to inspect ignored worktree entries: git status output exceeded the safety limit.");
  }

  const records = output.split(NUL_SEPARATOR);
  let hasIgnoredEntries = false;
  let skipNextRecord = false;
  for (const [index, record] of records.entries()) {
    if (skipNextRecord) {
      skipNextRecord = false;
      continue;
    }
    if (record.length === 0) continue;

    const parsed = parsePorcelainChange(records, index);
    skipNextRecord = parsed.nextIndex > index;
    if (parsed.status === "!!") hasIgnoredEntries = true;
  }

  return {
    workingTree: parseWorkingTreeStatus(output).workingTree,
    hasIgnoredEntries,
  };
}

async function inspectRemovableWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  canonicalPath: string,
  signal?: AbortSignal,
): Promise<WorkingTreeDetails> {
  const workingTree = await inspectWorktreeState(pi, canonicalPath, signal);
  if (workingTree.state !== "clean") {
    throw new Error("The target worktree has staged, unstaged, untracked, or unmerged changes; clean it before removal.");
  }

  const ignoredResult = await runGit(pi, { cwd: canonicalPath }, GIT_WORKTREE_REMOVAL_IGNORED_STATUS_ARGS, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  const removalStatus = parseWorktreeRemovalStatus(ignoredResult.stdout);
  if (removalStatus.workingTree.state !== "clean") {
    throw new Error("The target worktree has staged, unstaged, untracked, or unmerged changes; clean it before removal.");
  }
  if (removalStatus.hasIgnoredEntries) {
    throw new Error(
      "The target worktree contains ignored files or directories; remove or preserve them outside the checkout before removal.",
    );
  }
  return workingTree;
}

function assertWorktreeRemoved(
  inventory: WorktreeInventory,
  canonicalPath: string,
): void {
  if (inventory.entries.some((entry) => entry.canonicalPath === canonicalPath)) {
    throw new Error("The target remained registered after git worktree remove.");
  }
}

function worktreeRemovalFailure(
  error: unknown,
  canonicalPath: string,
  branchName: string,
): Error {
  const rawReason = error instanceof Error ? error.message : String(error);
  const reason = safeOutput(rawReason, [canonicalPath, branchName]);
  const reasonText = reason ? ` Reason: ${reason}` : "";
  return new Error(
    `Worktree removal at ${safeWorktreePathLabel(canonicalPath)} did not complete with verified postconditions.${reasonText} ` +
    "The repository and target should be inspected; no force or branch deletion was attempted.",
  );
}

export async function removeWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  worktreePath: unknown,
  signal?: AbortSignal,
): Promise<RemoveWorktreeDetails> {
  const requestedWorktreePath = validateWorktreePathInput(worktreePath);
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const resolved = await resolveWorktreeRemovalTarget(
      pi,
      rootCtx,
      requestedWorktreePath,
      signal,
    );
    if (resolved.repoRoot !== repoRoot) {
      throw new Error("The current repository changed while preparing worktree removal.");
    }

    const worktree = requireRemovableWorktreeEntry(resolved);
    await requirePresentWorktreeDirectory(resolved.canonicalPath);
    const workingTree = await inspectRemovableWorktree(pi, resolved.canonicalPath, signal);
    const branchName = resolved.entry.record.branch;
    const head = resolved.entry.record.head;
    if (branchName === null || head === null) {
      throw new Error("The target branch and HEAD could not be captured before removal.");
    }
    const branchHeadBefore = await getLocalBranchCommit(pi, rootCtx, branchName, signal);
    if (branchHeadBefore.toLowerCase() !== head.toLowerCase()) {
      throw new Error("The target local branch did not match the worktree HEAD before removal.");
    }

    const args = ["worktree", "remove", resolved.canonicalPath];
    try {
      await runGit(pi, rootCtx, args, {
        signal,
        timeout: GIT_WORKTREE_MUTATION_TIMEOUT_MS,
      });
      const afterInventory = await collectWorktreeInventory(pi, rootCtx, signal);
      if (
        afterInventory.repoRoot !== repoRoot ||
        afterInventory.canonicalCurrentPath !== resolved.inventory.canonicalCurrentPath
      ) {
        throw new Error("The source repository changed while verifying worktree removal.");
      }
      assertWorktreeRemoved(afterInventory, resolved.canonicalPath);
      const branchHeadAfter = await getLocalBranchCommit(pi, rootCtx, branchName, signal);
      if (branchHeadAfter.toLowerCase() !== head.toLowerCase()) {
        throw new Error("The retained local branch moved after worktree removal.");
      }

      const safeCanonicalPath = safeWorktreeValue(resolved.canonicalPath, GIT_WORKTREE_PATH_LIMIT_CHARS);
      const safeBranchName = safeWorktreeValue(branchName, GIT_CONTEXT_VALUE_LIMIT_CHARS);
      const summary = safeWorktreeValue(
        `Worktree directory ${safeCanonicalPath} was removed; local branch ${safeBranchName} was retained at ${head}.`,
        GIT_WORKTREE_SUMMARY_LIMIT_CHARS,
      );
      return {
        action: "remove_worktree",
        repoRoot: safeWorktreeValue(repoRoot, GIT_WORKTREE_PATH_LIMIT_CHARS),
        request: {
          worktreePath: safeWorktreeValue(requestedWorktreePath, GIT_WORKTREE_PATH_LIMIT_CHARS),
        },
        verified: {
          before: {
            worktree,
            workingTree,
          },
          after: {
            worktreePresent: false,
            branchRetained: true,
            branch: safeBranchName,
            head,
          },
        },
        handoff: {
          cwd: null,
          branch: safeBranchName,
          head,
          ready: false,
          summary,
        },
      };
    } catch (error) {
      throw worktreeRemovalFailure(error, resolved.canonicalPath, branchName);
    }
  });
}

function isRenameOrCopyStatus(status: string): boolean {
  return status.startsWith("R") || status.startsWith("C") || status.endsWith("R") || status.endsWith("C");
}

function parsePorcelainRecord(record: string): { status: string; path: string } {
  if (record.length < 4 || record[2] !== " ") {
    throw new TypeError("Unable to parse working-tree state: malformed git status record.");
  }

  const status = record.slice(0, 2);
  const path = record.slice(3);
  if (!GIT_STATUS_CODE_PATTERN.test(status) || status === "  " || path.length === 0) {
    throw new TypeError("Unable to parse working-tree state: malformed git status record.");
  }
  return { status, path };
}

function appendUnstagedChange(
  entries: GitFileChange[],
  change: GitFileChange,
  omitted: number,
): number {
  if (entries.length < GIT_CONTEXT_CHANGE_LIMIT) {
    entries.push(change);
    return omitted;
  }
  return omitted + 1;
}

interface ParsedPorcelainChange {
  status: string;
  path: string;
  originalPath?: string;
  nextIndex: number;
}

interface WorkingTreeChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  includeInUnstagedChanges: boolean;
}

function parsePorcelainChange(records: string[], index: number): ParsedPorcelainChange {
  const parsed = parsePorcelainRecord(records[index]);
  if (!isRenameOrCopyStatus(parsed.status)) return { ...parsed, nextIndex: index };

  const originalPath = records[index + 1];
  if (originalPath === undefined || originalPath.length === 0) {
    throw new TypeError("Unable to parse working-tree state: rename or copy source path is missing.");
  }
  return { ...parsed, originalPath, nextIndex: index + 1 };
}

function workingTreeChangeCounts(status: string): WorkingTreeChangeCounts {
  const isUntracked = status === "??";
  const isUnmerged = UNMERGED_GIT_STATUSES.has(status);
  const hasStagedChange = !isUntracked && !isUnmerged && !status.startsWith(" ");
  const hasUnstagedChange = !isUntracked && (isUnmerged || !status.endsWith(" "));

  return {
    staged: Number(hasStagedChange),
    unstaged: Number(hasUnstagedChange),
    untracked: Number(isUntracked),
    includeInUnstagedChanges: isUntracked || hasUnstagedChange,
  };
}

function gitFileChange(parsed: ParsedPorcelainChange): GitFileChange {
  return {
    status: parsed.status,
    path: safeGitContextValue(parsed.path),
    ...(parsed.originalPath === undefined
      ? {}
      : { originalPath: safeGitContextValue(parsed.originalPath) }),
  };
}

export function parseWorkingTreeStatus(output: string): WorkingTreeStatus {
  const records = output.split(NUL_SEPARATOR);
  const entries: GitFileChange[] = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let omitted = 0;
  let dirty = false;
  let skipNextRecord = false;

  for (const [index, record] of records.entries()) {
    if (skipNextRecord) {
      skipNextRecord = false;
      continue;
    }
    if (record.length === 0) continue;

    const parsed = parsePorcelainChange(records, index);
    skipNextRecord = parsed.nextIndex > index;
    if (parsed.status === "!!") continue;
    dirty = true;

    const counts = workingTreeChangeCounts(parsed.status);
    staged += counts.staged;
    unstaged += counts.unstaged;
    untracked += counts.untracked;
    if (!counts.includeInUnstagedChanges) continue;

    omitted = appendUnstagedChange(entries, gitFileChange(parsed), omitted);
  }

  return {
    workingTree: {
      state: dirty ? "dirty" : "clean",
      staged,
      unstaged,
      untracked,
    },
    unstagedChanges: { entries, omitted },
  };
}

export async function getWorkingTreeStatus(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<WorkingTreeStatus> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];
  const result = await runGit(pi, { cwd: repoRoot }, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  return parseWorkingTreeStatus(result.stdout);
}

function stripGitLogRecordTerminator(record: string): string {
  if (record.endsWith("\r\n")) return record.slice(0, -2);
  if (record.endsWith("\n")) return record.slice(0, -1);
  return record;
}

function parseRecentCommitRecord(record: string): RecentCommit {
  const firstSeparator = record.indexOf(GIT_LOG_FIELD_SEPARATOR);
  const secondSeparator = record.indexOf(GIT_LOG_FIELD_SEPARATOR, firstSeparator + 1);
  const thirdSeparator = record.indexOf(GIT_LOG_FIELD_SEPARATOR, secondSeparator + 1);
  if (firstSeparator < 1 || secondSeparator <= firstSeparator + 1 || thirdSeparator <= secondSeparator + 1) {
    throw new TypeError("Unable to parse recent commits: malformed git log output.");
  }

  const hash = record.slice(0, firstSeparator);
  const shortHash = record.slice(firstSeparator + 1, secondSeparator);
  const date = record.slice(secondSeparator + 1, thirdSeparator);
  const subject = record.slice(thirdSeparator + 1);
  if (
    !/^[0-9a-f]{40,64}$/iu.test(hash) ||
    !/^[0-9a-f]{4,64}$/iu.test(shortHash) ||
    !hash.toLowerCase().startsWith(shortHash.toLowerCase()) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date)
  ) {
    throw new TypeError("Unable to parse recent commits: malformed git log output.");
  }

  return {
    hash,
    shortHash,
    date,
    subject: safeGitContextValue(subject),
  };
}

export function parseRecentCommits(output: string): RecentCommit[] {
  const records = output.split(NUL_SEPARATOR);
  const commits: RecentCommit[] = [];
  for (const rawRecord of records) {
    if (rawRecord.length === 0) continue;
    const record = stripGitLogRecordTerminator(rawRecord);
    if (record.length === 0) continue;
    commits.push(parseRecentCommitRecord(record));
    if (commits.length === GIT_CONTEXT_RECENT_COMMIT_LIMIT) break;
  }
  return commits;
}

export async function getRecentCommits(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<RecentCommit[]> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };
  const args = [
    "log",
    "-n",
    String(GIT_CONTEXT_RECENT_COMMIT_LIMIT),
    "--date=short",
    `--format=${GIT_LOG_FORMAT}`,
    "HEAD",
  ];
  const result = await runGit(pi, rootCtx, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code === 0) return parseRecentCommits(result.stdout);
  if (signal?.aborted) throw new Error(formatGitFailure(args, result));

  const verifyHead = await runGit(pi, rootCtx, ["rev-parse", "--verify", "HEAD"], {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  if (verifyHead.code !== 0) return [];
  throw new Error(formatGitFailure(args, result));
}

function truncatePullRequestCommitSubject(value: string): string {
  if (value.length <= PULL_REQUEST_AUTOFILL_SUBJECT_LIMIT_CHARS) return value;

  let end = PULL_REQUEST_AUTOFILL_SUBJECT_LIMIT_CHARS - 1;
  const lastCodePoint = value.codePointAt(end - 1);
  if (lastCodePoint !== undefined && lastCodePoint > 0xffff) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

function safePullRequestCommitSubject(value: string, tokens: readonly string[]): string {
  const normalized = redactSecrets(value, tokens)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncatePullRequestCommitSubject(normalized);
}

async function getOriginDefaultBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const args = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];
  const result = await runGit(pi, ctx, args, {
    signal,
    timeout: GIT_STATUS_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code !== 0) return null;

  const remoteBranch = trimOutput(result.stdout);
  const prefix = "origin/";
  if (!remoteBranch.startsWith(prefix)) return null;

  const branch = remoteBranch.slice(prefix.length);
  try {
    validateBranchNameInput(branch, "Default base branch");
  } catch {
    return null;
  }
  return branch;
}

export async function inferPullRequestBaseBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  headBranch: string,
  signal?: AbortSignal,
): Promise<string> {
  validateBranchNameInput(headBranch, "headBranch");
  const originDefault = await getOriginDefaultBranch(pi, ctx, signal);
  if (originDefault) {
    if (originDefault === headBranch) {
      throw new Error("Unable to infer baseBranch because the current branch is the origin default branch.");
    }
    if (await localBranchExists(pi, ctx, originDefault, signal)) return originDefault;
  }

  for (const candidate of ["main", "master", "trunk", "develop"]) {
    if (candidate !== headBranch && await localBranchExists(pi, ctx, candidate, signal)) return candidate;
  }

  throw new Error(
    "Unable to infer baseBranch from origin/HEAD or a local main, master, trunk, or develop branch; provide baseBranch explicitly.",
  );
}

export async function getPullRequestCommitSubjects(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  headBranch: string,
  baseBranch: string,
  signal?: AbortSignal,
  tokens: readonly string[] = [],
): Promise<string[]> {
  validateBranchNameInput(headBranch, "headBranch");
  validateBranchNameInput(baseBranch, "baseBranch");
  const revisionRange = `refs/heads/${baseBranch}..refs/heads/${headBranch}`;
  const args = [
    "log",
    `--max-count=${PULL_REQUEST_AUTOFILL_COMMIT_LIMIT}`,
    "--format=%s",
    revisionRange,
    "--",
  ];
  const result = await runGit(pi, ctx, args, { signal, timeout: GIT_STATUS_TIMEOUT_MS, tokens });
  return result.stdout
    .split(/\r?\n/u)
    .map((subject) => safePullRequestCommitSubject(subject, tokens))
    .filter(Boolean);
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
    throw new TypeError(`Unable to parse ahead/behind counts from git output: ${safeOutput(result.stdout)}`);
  }
  return { ahead, behind };
}

export function validateBranchNameInput(branchName: unknown, label = "Branch name"): asserts branchName is string {
  if (typeof branchName !== "string") throw new TypeError(`${label} must be a string.`);
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
    throw new Error(`Invalid branch name '${safeGitContextValue(branchName)}': ${safeOutput(result.stderr || result.stdout) || "git rejected the ref"}`);
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
    throw new Error(`Unable to resolve local branch '${safeGitContextValue(branchName)}' to a commit: ${safeOutput(result.stdout) || "empty output"}`);
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

export async function fetchCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<FetchBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const currentBranch = await requireCurrentBranch(pi, rootCtx, signal);
    const target = await resolveConfiguredUpstreamTarget(pi, rootCtx, currentBranch, "fetch", signal);
    if (!target) {
      throw new Error(`Unable to fetch current branch '${safeDetail(currentBranch)}': no upstream is configured.`);
    }

    const trackingRef = remoteTrackingRef(target.upstream, target.remote);
    const refspec = `${target.remoteRef}:${trackingRef}`;
    const result = await runGit(
      pi,
      rootCtx,
      ["fetch", "--no-tags", "--no-recurse-submodules", target.remote, refspec],
      {
        signal,
        timeout: GIT_FETCH_TIMEOUT_MS,
      },
    );

    return {
      repoRoot,
      currentBranch: safeDetail(currentBranch),
      upstream: safeDetail(target.upstream),
      remote: safeDetail(target.remote),
      remoteRef: safeDetail(target.remoteRef),
      remoteTrackingRef: safeDetail(trackingRef),
      refspec: safeDetail(refspec),
      output: safeOutput(result.stdout || result.stderr),
    };
  });
}

export async function pullCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<PullBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const currentBranch = await requireCurrentBranch(pi, rootCtx, signal);
    if (await hasWorkingTreeChanges(pi, rootCtx, signal)) {
      throw new Error("Working tree has uncommitted changes; clean it before pulling the current branch.");
    }

    const target = await resolveConfiguredUpstreamTarget(pi, rootCtx, currentBranch, "pull", signal);
    if (!target) {
      throw new Error(`Unable to pull current branch '${safeDetail(currentBranch)}': no upstream is configured.`);
    }

    const result = await runGit(pi, rootCtx, ["pull", "--ff-only", "--no-rebase", "--no-autostash", target.remote, target.remoteRef], {
      signal,
      timeout: GIT_PULL_TIMEOUT_MS,
    });

    return {
      repoRoot,
      currentBranch: safeDetail(currentBranch),
      upstream: safeDetail(target.upstream),
      remote: safeDetail(target.remote),
      remoteRef: safeDetail(target.remoteRef),
      output: safeOutput(result.stdout || result.stderr),
    };
  });
}

async function abortFailedRebase(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  failureMessage: string,
): Promise<never> {
  const abortArgs = ["rebase", "--abort"];
  let abortResult: GitExecResult;
  try {
    abortResult = await runGit(pi, ctx, abortArgs, {
      timeout: GIT_MUTATION_TIMEOUT_MS,
      allowFailure: true,
    });
  } catch (error) {
    const reason = safeOutput(error instanceof Error ? error.message : String(error)) || "git rebase --abort failed";
    throw new Error(`${failureMessage}. Automatic rebase cleanup failed: ${reason}. Inspect the repository before continuing.`);
  }

  if (abortResult.code === 0) {
    throw new Error(`${failureMessage}. Rebase was aborted and the current branch was restored.`);
  }

  const reason = safeOutput(abortResult.stderr || abortResult.stdout) || `exit code ${abortResult.code}`;
  throw new Error(`${failureMessage}. Automatic git rebase --abort did not complete: ${reason}. Inspect the repository before continuing.`);
}

export async function rebaseCurrentBranch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
): Promise<RebaseBranchDetails> {
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };

  return withRepositoryMutationQueue(repoRoot, async () => {
    const currentBranch = await requireCurrentBranch(pi, rootCtx, signal);
    if (await hasWorkingTreeChanges(pi, rootCtx, signal)) {
      throw new Error("Working tree has uncommitted changes; clean it before rebasing the current branch.");
    }

    const target = await resolveConfiguredUpstreamTarget(pi, rootCtx, currentBranch, "rebase", signal);
    if (!target) {
      throw new Error(`Unable to rebase current branch '${safeDetail(currentBranch)}': no upstream is configured.`);
    }

    const args = ["rebase", "--no-autostash", "--no-update-refs", target.upstream];
    let result: GitExecResult;
    try {
      result = await runGit(pi, rootCtx, args, {
        signal,
        timeout: GIT_REBASE_TIMEOUT_MS,
        allowFailure: true,
      });
    } catch (error) {
      const failureMessage = safeOutput(error instanceof Error ? error.message : String(error)) || "git rebase failed";
      return abortFailedRebase(pi, rootCtx, failureMessage);
    }

    if (result.code !== 0) {
      return abortFailedRebase(pi, rootCtx, formatGitFailure(args, result));
    }

    return {
      repoRoot,
      currentBranch: safeDetail(currentBranch),
      upstream: safeDetail(target.upstream),
      remote: safeDetail(target.remote),
      remoteRef: safeDetail(target.remoteRef),
      output: safeOutput(result.stdout || result.stderr),
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
