import { lstat } from "node:fs/promises";
import { getGitOperationState, runGit, withRepositoryMutationQueue, type GitCommandContext } from "./git.ts";
import { checkedFilePath, fileExpectation, getGitStatus } from "./git-status.ts";
import { fingerprint, OBJECT_ID, openGitReader, readGit, safeGitText, validateKeys, validateReadPaths, type GitAPI, type GitReader } from "./git-read.ts";

export interface IndexInput { paths: string[]; expectedHead: string | null; expectedIndex: string; worktreePath?: string }
export interface IndexRecord { flag: string; mode: string; oid: string; path: string }
export async function inspectIndex(reader: GitReader): Promise<{ raw: string; index: string; entries: IndexRecord[] }> {
  const raw = (await readGit(reader, ["ls-files", "--stage", "-v", "-z"])).stdout;
  if (raw && !raw.endsWith("\0")) throw new Error("Incomplete index inspection.");
  const entries = [];
  for (const record of raw ? raw.slice(0, -1).split("\0") : []) {
    const match = /^([A-Za-z]) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([^\0]+)$/u.exec(record);
    if (match?.[4] !== "0") throw new Error("Unmerged or unsupported index; use git_conflicts/conclude_merge for conflicts.");
    if (match[1] !== "H" || !["100644", "100755", "120000"].includes(match[2])) throw new Error("Index contains assume-unchanged, skip-worktree, gitlink, or unsupported entries; no mutation performed.");
    entries.push({ flag: match[1], mode: match[2], oid: match[3], path: match[5] });
  }
  return { raw, index: fingerprint(raw), entries };
}
export async function requireSimpleIndex(reader: GitReader): Promise<void> {
  for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) if (process.env[key] !== undefined) throw new Error("Git path environment overrides must be unset for guarded file/index mutations.");
  if ((await getGitOperationState(reader.pi, reader.ctx, reader.signal)).active.length) throw new Error("An in-progress Git operation must be completed or aborted first.");
  const visible = await readGit(reader, ["diff", "--cached", "--raw", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--ita-visible-in-index"]);
  const invisible = await readGit(reader, ["diff", "--cached", "--raw", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--ita-invisible-in-index"]);
  if (visible.stdout !== invisible.stdout) throw new Error("Intent-to-add entries are unsupported for guarded file/index mutations.");
  const split = await readGit(reader, ["rev-parse", "--shared-index-path"]);
  if (split.stdout.trim()) throw new Error("Split indexes are unsupported for guarded file/index mutations.");
  const configs = await Promise.all(["core.sparsecheckout", "index.sparse"].map(readSparseConfig.bind(undefined, reader)));
  for (const config of configs) {
    if (config.code !== 0 && config.code !== 1) throw new Error("Cannot verify sparse-index configuration.");
    if (config.code === 0 && config.stdout.trim() !== "false") throw new Error("Sparse checkouts/indexes are unsupported for guarded file/index mutations.");
  }
}
function readSparseConfig(reader: GitReader, name: string) { return readGit(reader, ["config", "--bool", "--get", name], true); }
export function validateIndexInput(input: IndexInput, extraKeys: string[] = []): void {
  validateKeys(input, ["paths", "expectedHead", "expectedIndex", "worktreePath", ...extraKeys]);
  validateReadPaths(input.paths);
  if (!input.paths?.length || input.paths.some((path) => path.length > 512 || path.split("/").some((part) => !part || part === ".")) || input.paths.reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > 8192 || new Set(input.paths).size !== input.paths.length) throw new TypeError("Require distinct exact file paths, at most 512 characters each / 8 KiB combined; split larger batches. Directories and normalized aliases are unsupported.");
  if ((input.expectedHead !== null && (typeof input.expectedHead !== "string" || !OBJECT_ID.test(input.expectedHead))) || typeof input.expectedIndex !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedIndex)) throw new TypeError("Require expectedHead (or null before the first commit) and expectedIndex from git_status.");
}
export async function captureSelectedFiles(reader: GitReader, paths: string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(captureSelectedFile.bind(undefined, reader))));
}
async function captureSelectedFile(reader: GitReader, path: string): Promise<[string, string]> {
  const file = await checkedFilePath(reader.ctx.cwd, path);
  if (!file || safeGitText(path, reader.tokens) !== path) throw new Error("A selected path is not a reusable repository-local identity.");
  try {
    const info = await lstat(file);
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Selected paths must be exact regular files or symlinks, not directories/gitlinks.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const expectation = await fileExpectation(reader.ctx.cwd, path, reader.signal);
  if (!expectation.fingerprint) throw new Error("A selected file has no safe content expectation (oversized or unsupported).");
  return [path, expectation.fingerprint];
}
export async function requireExpectedState(reader: GitReader, input: IndexInput, checkRenameSides = true) {
  const status = await getGitStatus(reader.pi, reader.ctx, { paths: input.paths }, reader.signal, reader.tokens);
  if (status.head !== input.expectedHead || status.index !== input.expectedIndex) throw new Error("HEAD/index changed; inspect git_status and use fresh expectations.");
  for (const entry of status.entries) if (checkRenameSides && entry.originalPath && (input.paths.includes(entry.path) || input.paths.includes(entry.originalPath)) && (!input.paths.includes(entry.path) || !input.paths.includes(entry.originalPath))) throw new Error("Both sides of a selected rename must be explicitly approved.");
  return status;
}
function unrelated(entries: IndexRecord[], paths: string[]): string { return JSON.stringify(entries.filter((entry) => !paths.includes(entry.path))); }
async function mutateIndexInside(host: GitAPI, reader: GitReader, input: IndexInput, action: "stage_changes" | "unstage_changes") {
  await requireSimpleIndex(reader);
  const before = await inspectIndex(reader);
  const statusBefore = await requireExpectedState(reader, input);
  const files = await captureSelectedFiles(reader, input.paths);
  await Promise.all(input.paths.map(validateSelectedIndexPath.bind(undefined, reader, input, action, before.entries, statusBefore, files)));
  await requireExpectedState(reader, input);
  if (JSON.stringify([...files]) !== JSON.stringify([...await captureSelectedFiles(reader, input.paths)])) throw new Error("Selected files changed during preparation; inspect git_status again.");
  const stagePaths = input.paths.filter((path) => files.get(path) !== fingerprint("missing") || before.entries.some((entry) => entry.path === path));
  const args = indexMutationArgs(input, action, stagePaths);
  reader.signal?.throwIfAborted();
  try {
    if (action !== "stage_changes" || stagePaths.length) await runGit(host, reader.ctx, ["--no-lazy-fetch", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], { signal: reader.signal, tokens: reader.tokens });
    const final = { ...reader, signal: undefined };
    const after = await inspectIndex(final);
    const status = await getGitStatus(host, reader.ctx, {}, undefined, reader.tokens);
    if (status.head !== input.expectedHead || status.branch !== statusBefore.branch || status.operations.length || unrelated(before.entries, input.paths) !== unrelated(after.entries, input.paths) || JSON.stringify([...files]) !== JSON.stringify([...await captureSelectedFiles(final, input.paths)])) throw new Error("Unrelated index entries, HEAD, or working-file bytes changed.");
    await verifySelectedIndex(final, input, action, files, after.entries);
    return { action, paths: input.paths, head: status.head, index: after.index, committed: false, workingFilesPreserved: true };
  } catch (error) { throw new Error(`${action} outcome requires inspection with git_status; index may have changed. No rollback attempted. ${safeGitText(String(error), reader.tokens).slice(0, 2000)}`); }
}
function indexMutationArgs(input: IndexInput, action: string, stagePaths: string[]): string[] {
  if (action === "stage_changes") return ["add", "--", ...stagePaths];
  if (input.expectedHead === null) return ["update-index", "--force-remove", "--", ...input.paths];
  return ["restore", "--staged", `--source=${input.expectedHead}`, "--", ...input.paths];
}
async function validateSelectedIndexPath(reader: GitReader, input: IndexInput, action: string, entries: IndexRecord[], statusBefore: Awaited<ReturnType<typeof requireExpectedState>>, files: Map<string, string>, path: string) {
  const tracked = entries.some((entry) => entry.path === path);
  const atHead = input.expectedHead === null ? "" : (await readGit(reader, ["--literal-pathspecs", "ls-tree", "-z", input.expectedHead, "--", path])).stdout;
  if (atHead && !atHead.endsWith(`\t${path}\0`)) throw new Error("Selected path does not exactly match its tracked identity.");
  if (!tracked && !atHead) {
    if (action === "unstage_changes") throw new Error("Selected path is not staged or tracked at HEAD.");
    if (!statusBefore.entries.some((entry) => entry.kind === "untracked" && entry.path === path && entry.reusablePath)) throw new Error("Selected addition is ignored or not an exact reusable untracked path; aliases and implicit expansion are refused.");
    const ignored = await readGit(reader, ["check-ignore", "--quiet", "--", path], true);
    if (ignored.code !== 1) throw new Error("Selected addition is ignored or could not be verified; force-add is unsupported.");
    if (files.get(path) === fingerprint("missing")) throw new Error("Selected path is missing and untracked.");
  }
}
async function verifySelectedIndex(final: GitReader, input: IndexInput, action: string, files: Map<string, string>, entries: IndexRecord[]) {
  if (action === "stage_changes") {
    const unstaged = await readGit(final, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--quiet", "--ignore-submodules=all", "--", ...input.paths], true);
    if (unstaged.code !== 0) throw new Error("Selected content is not fully staged.");
    for (const path of input.paths) if (files.get(path) !== fingerprint("missing") && !entries.some((entry) => entry.path === path)) throw new Error("Selected file was not added to the index.");
  } else {
    await Promise.all(input.paths.map(verifyUnstagedPath.bind(undefined, final, input, entries)));
  }
}
async function verifyUnstagedPath(final: GitReader, input: IndexInput, entries: IndexRecord[], path: string) {
  const entry = entries.find((candidate) => candidate.path === path);
  const atHead = input.expectedHead === null ? "" : (await readGit(final, ["--literal-pathspecs", "ls-tree", "-z", input.expectedHead, "--", path])).stdout;
  if (!atHead && entry) throw new Error("Selected addition remained staged.");
  if (atHead && (!entry || !atHead.startsWith(`${entry.mode} blob ${entry.oid}\t`))) throw new Error("Selected index entry does not match captured HEAD.");
}
export async function changeIndex(host: GitAPI, ctx: GitCommandContext, input: IndexInput, action: "stage_changes" | "unstage_changes", signal?: AbortSignal, tokens: readonly string[] = []) {
  validateIndexInput(input);
  const reader = await openGitReader(host, ctx, input.worktreePath, signal, tokens);
  return withRepositoryMutationQueue(reader.ctx.cwd, mutateIndexInside.bind(undefined, host, reader, input, action));
}
