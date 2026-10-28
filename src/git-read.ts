import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCanonicalGitWorktreeRoot, resolveRepositoryWorktreeCwd, runGit, type GitCommandContext } from "./git.ts";
import { redactSecrets } from "./redaction.ts";

export type GitAPI = Pick<ExtensionAPI, "exec">;
export interface GitReader { pi: GitAPI; ctx: GitCommandContext; signal?: AbortSignal; tokens: readonly string[] }
export const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const READ_RAW_BYTES = 4 * 1024 * 1024;
export const READ_PAGE_SIZE = 25;
export const READ_CURSOR_CHARS = 1024;

export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function fingerprint(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function escapeControl(character: string): string { return character === "\n" || character === "\t" ? character : String.raw`\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`; }
export function safeGitText(text: string, tokens: readonly string[] = []): string {
  return redactSecrets(text, tokens).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, escapeControl);
}
export function boundedGitText(raw: string, tokens: readonly string[] = [], maxBytes = 32 * 1024, maxLines = 1000): { text: string; truncated: boolean } {
  const text = safeGitText(raw, tokens);
  let result = "";
  let bytes = 0;
  let lines = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes || lines >= maxLines) break;
    result += character;
    bytes += size;
    if (character === "\n") lines++;
  }
  return { text: result, truncated: result.length !== text.length };
}
export function validateReadRef(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512 || value.startsWith("-") || /[\s:\p{Cc}\p{Cf}]/u.test(value) || value.includes("..")) throw new TypeError("Expected a bounded single local commit revision, not a range, option, or path.");
}
export function validateReadPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || isAbsolute(value) || win32.isAbsolute(value) || /[\\\p{Cc}\p{Cf}\ufffd]/u.test(value) || value.split("/").some(unsafeSegment)) throw new TypeError("Expected a literal root-relative path without traversal, .git, backslashes, or controls.");
}
function unsafeSegment(part: string): boolean { return part === ".." || part.toLowerCase() === ".git"; }
export function validateReadPaths(paths: unknown): asserts paths is string[] | undefined {
  if (paths === undefined) return;
  if (!Array.isArray(paths) || !paths.length || paths.length > 25) throw new TypeError("paths must contain 1–25 literal paths.");
  for (const path of paths) validateReadPath(path);
}
export function validateKeys(input: unknown, keys: string[]): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError("Only documented input fields are accepted.");
}
async function execRead(host: GitAPI, tokens: readonly string[], command: string, args: string[], options: Parameters<GitAPI["exec"]>[2]) {
  let result;
  try { result = await host.exec(command, ["--no-optional-locks", "--no-lazy-fetch", "--no-pager", "-c", "core.fsmonitor=false", ...args], options); }
  catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error(boundedGitText(String(error), tokens, 4000).text);
  }
  if (result.killed) throw new Error("Local Git inspection was killed or timed out; retry once, then report the failure.");
  if (result.code !== 0) {
    if (/unknown option[^\n]*no-lazy-fetch/iu.test(result.stderr)) throw new Error("Git with --no-lazy-fetch support is required; update Git rather than weakening read-only safeguards.");
    return { ...result, stdout: boundedGitText(result.stdout, tokens, 4000).text, stderr: boundedGitText(result.stderr, tokens, 4000).text };
  }
  if (Buffer.byteLength(result.stdout) > READ_RAW_BYTES) throw new Error("Local Git inspection exceeded the 4 MiB safety limit. Narrow the query; no completeness claim is possible.");
  return result;
}
export async function openGitReader(host: GitAPI, ctx: GitCommandContext, worktreePath?: string, signal?: AbortSignal, tokens: readonly string[] = []): Promise<GitReader> {
  signal?.throwIfAborted();
  if (worktreePath !== undefined && (typeof worktreePath !== "string" || !isAbsolute(worktreePath) || worktreePath.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(worktreePath))) throw new TypeError("worktreePath must be a bounded absolute worktree root.");
  const pi = { exec: execRead.bind(undefined, host, tokens) };
  const cwd = worktreePath === undefined ? ctx.cwd : await resolveRepositoryWorktreeCwd(pi, ctx, worktreePath, signal);
  return { pi, ctx: { cwd: await getCanonicalGitWorktreeRoot(pi, { cwd }, signal) }, signal, tokens };
}
export async function readGit(reader: GitReader, args: string[], allowFailure = false) {
  reader.signal?.throwIfAborted();
  return runGit(reader.pi, reader.ctx, args, { signal: reader.signal, tokens: reader.tokens, allowFailure });
}
export async function resolveReadCommit(reader: GitReader, ref: string): Promise<string> {
  validateReadRef(ref);
  const result = await readGit(reader, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], true);
  if (result.code !== 0 || !OBJECT_ID.test(result.stdout.trim())) throw new Error("Commit revision is not locally available. Inspect git_log/list_branches; fetch separately only when intended.");
  return result.stdout.trim();
}
export function encodeReadCursor(fields: unknown[]): string { return Buffer.from(JSON.stringify(fields)).toString("base64url"); }
export function decodeReadCursor(value: unknown): unknown[] {
  if (typeof value !== "string" || !value || value.length > READ_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("Invalid continuation; use the unchanged next cursor.");
  try {
    const fields: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(fields) || encodeReadCursor(fields) !== value) throw new Error("Noncanonical continuation fields.");
    return fields;
  } catch { throw new TypeError("Invalid continuation; restart without after."); }
}
export async function readBlob(reader: GitReader, oid: string): Promise<{ size: number; binary: boolean; text: string; truncated: boolean }> {
  if (!OBJECT_ID.test(oid)) throw new Error("Invalid blob identity.");
  const result = await readGit(reader, ["cat-file", "-s", oid]);
  if (!/^\d+\n?$/u.test(result.stdout)) throw new Error("Invalid blob size.");
  const size = Number(result.stdout.trim());
  if (!Number.isSafeInteger(size)) throw new Error("Invalid blob size.");
  if (size > READ_RAW_BYTES) return { size, binary: false, text: "Object too large for a safe preview.", truncated: true };
  const blob = await readGit(reader, ["cat-file", "blob", oid]);
  const binary = blob.stdout.includes("\0") || blob.stdout.includes("\ufffd");
  return { size, binary, ...(binary ? { text: "Binary or non-UTF-8 object; content omitted.", truncated: false } : boundedGitText(blob.stdout, reader.tokens)) };
}
