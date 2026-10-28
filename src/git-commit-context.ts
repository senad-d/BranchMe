import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
  ChangedFile,
  CommitGitOptions,
  GitChangeScope,
  GitContext,
  GitDiffSummary,
  ProjectContext,
  ProjectContextEntry,
  ProjectContextEntryKind,
  SkippedProjectContextEntry,
} from "./types.ts";
import {
  DEFAULT_DIFF_FILE_LIMIT,
  DEFAULT_DIFF_MAX_BYTES,
  DEFAULT_DIFF_MAX_LINES,
  DEFAULT_PROJECT_CONTEXT_FILE_LIMIT,
  DEFAULT_PROJECT_FILE_MAX_BYTES,
  DEFAULT_PROJECT_FILE_MAX_LINES,
  PROJECT_METADATA_CANDIDATES,
} from "./constants.ts";
import { getCurrentBranch, getGitRoot, runGit } from "./git.ts";
import { appendTruncationNotice, truncateText } from "./truncation.ts";

const CONTENT_SENSITIVITY_SCAN_MAX_BYTES = 128_000;
const SECRET_SCAN_CHUNK_BYTES = 64_000;
const SECRET_SCAN_OVERLAP_CHARS = 4_096;
const CONTENT_SAFETY_SCAN_CONCURRENCY = 8;
const SECRET_KEY_SUFFIXES = [
  "api_key",
  "access_key",
  "access_token",
  "auth_token",
  "bearer_token",
  "client_secret",
  "credential",
  "credentials",
  "id_token",
  "password",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
  "session_token",
  "token",
];
const SECRET_PLACEHOLDER_TERMS = ["fake", "dummy", "example", "placeholder", "not-real", "not_real", "changeme", "redacted", "xxxx"];
const SECRET_PATH_BASENAMES = new Set([
  ".env",
  ".envrc",
  ".dockercfg",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "_netrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "kubeconfig",
]);
const SECRET_PATH_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".crt", ".cer"]);
const GENERATED_PATH_SEGMENTS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".cache", ".local", ".turbo", ".next", "vendor"]);
const BINARY_PATH_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".xz",
  ".7z",
  ".tar",
  ".mp4",
  ".mov",
  ".avi",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".wasm",
  ".bin",
]);
const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "bearer token", pattern: /Authorization:\s*Bearer\s+[-A-Z0-9._~+/=]{20,}/gi },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_\w{36,}\b/g },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_\w{20,}\b/g },
  { name: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "OpenAI token", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "Slack token", pattern: /\bxox[barps]-[A-Za-z0-9-]{20,}\b/g },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

export interface GatherGitContextOptions extends CommitGitOptions {
  diffFileLimit?: number;
  diffMaxLines?: number;
  diffMaxBytes?: number;
  projectContextFileLimit?: number;
  projectFileMaxLines?: number;
  projectFileMaxBytes?: number;
}

export const STATUS_PORCELAIN_ARGS = ["status", "--porcelain=v1", "--branch", "-uall"];
export const STATUS_PORCELAIN_Z_ARGS = ["status", "--porcelain=v1", "-z", "-uall"];

async function getBranchLabel(
  executor: Pick<ExtensionAPI, "exec">,
  options: CommitGitOptions,
): Promise<{ branch: string; isDetachedHead: boolean }> {
  const current = await getCurrentBranch(executor, options, options.signal);
  if (current.currentBranch) return { branch: current.currentBranch, isDetachedHead: false };

  const head = (await runGit(executor, options, ["rev-parse", "--short", "HEAD"], { signal: options.signal, timeout: options.timeout })).stdout.trim();
  return { branch: head.length > 0 ? `HEAD:${head}` : "HEAD", isDetachedHead: true };
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathBasename(path: string): string {
  return normalizeRepositoryPath(path).split("/").at(-1)?.toLowerCase() ?? "";
}

function pathSegments(path: string): string[] {
  return normalizeRepositoryPath(path).split("/").map((segment) => segment.toLowerCase());
}

function pathExtension(basename: string): string {
  const index = basename.lastIndexOf(".");
  return index === -1 ? "" : basename.slice(index);
}

function isNameDelimiter(character: string): boolean {
  return character === "." || character === "_" || character === "-";
}

function splitNameMarkers(value: string): string[] {
  const markers: string[] = [];
  let current = "";
  for (const character of value.toLowerCase()) {
    if (isNameDelimiter(character)) {
      if (current) markers.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) markers.push(current);
  return markers;
}

function hasMarkerSequence(markers: string[], first: string, second: string): boolean {
  return markers.some((marker, index) => marker === first && markers[index + 1] === second);
}

function hasSecretBasenameMarker(basename: string): boolean {
  const markers = splitNameMarkers(basename);
  return (
    markers.some((marker) => marker === "secret" || marker === "secrets" || marker === "credential" || marker === "credentials") ||
    hasMarkerSequence(markers, "private", "key") ||
    hasMarkerSequence(markers, "service", "account")
  );
}

function hasTokenBasenameMarker(basename: string): boolean {
  return splitNameMarkers(basename).includes("token");
}

function isDotEnvVariantPath(path: string): boolean {
  return pathBasename(path).startsWith(".env.");
}

export function isKnownSecretPath(path: string): boolean {
  const segments = pathSegments(path);
  const basename = segments.at(-1) ?? "";
  const parentDirectories = new Set(segments.slice(0, -1));

  if (isDotEnvVariantPath(path)) return false;

  return (
    SECRET_PATH_BASENAMES.has(basename) ||
    basename.endsWith(".kubeconfig") ||
    (parentDirectories.has(".kube") && basename === "config") ||
    (parentDirectories.has(".docker") && basename === "config.json") ||
    (parentDirectories.has(".aws") && (basename === "credentials" || basename === "config")) ||
    hasSecretBasenameMarker(basename) ||
    SECRET_PATH_EXTENSIONS.has(pathExtension(basename))
  );
}

export function isSensitivePath(path: string): boolean {
  if (isDotEnvVariantPath(path)) return false;
  return isKnownSecretPath(path) || hasTokenBasenameMarker(pathBasename(path));
}

export function isGeneratedPath(path: string): boolean {
  return pathSegments(path).some((segment) => GENERATED_PATH_SEGMENTS.has(segment));
}

export function looksBinaryByPath(path: string): boolean {
  return BINARY_PATH_EXTENSIONS.has(pathExtension(pathBasename(path)));
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
}

function normalizedSecretKeyName(key: string): string {
  return key.toLowerCase().replaceAll("-", "_");
}

function secretKeySuffixMatches(normalized: string, suffix: string): boolean {
  const compact = normalized.replaceAll("_", "");
  const compactSuffix = suffix.replaceAll("_", "");
  return normalized === suffix || normalized.endsWith(`_${suffix}`) || compact === compactSuffix;
}

function isSecretLikeKeyName(key: string): boolean {
  const normalized = normalizedSecretKeyName(key);
  return SECRET_KEY_SUFFIXES.some((suffix) => secretKeySuffixMatches(normalized, suffix));
}

function isSecretKeyCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  const isDigit = codePoint >= 48 && codePoint <= 57;
  const isUpper = codePoint >= 65 && codePoint <= 90;
  const isLower = codePoint >= 97 && codePoint <= 122;
  return isDigit || isUpper || isLower || character === "_" || character === "-";
}

function readKeyBeforeOperator(text: string, operatorIndex: number): string {
  let start = operatorIndex - 1;
  while (start >= 0 && isSecretKeyCharacter(text[start] ?? "")) start -= 1;
  return text.slice(start + 1, operatorIndex);
}

function hasAssignedValue(text: string, operatorIndex: number): boolean {
  const value = text.slice(operatorIndex + 1).trim();
  return value.length > 0 && !value.startsWith("#");
}

function hasSecretLikeAssignment(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== ":" && character !== "=") continue;
    const key = readKeyBeforeOperator(text, index);
    if (key && isSecretLikeKeyName(key) && hasAssignedValue(text, index)) return true;
  }
  return false;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return SECRET_PLACEHOLDER_TERMS.some((term) => normalized.includes(term));
}

function patternHasRealSecret(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    const value = match[0];
    if (!isPlaceholderSecret(value)) return true;
    match = pattern.exec(text);
  }
  return false;
}

export function looksHighConfidenceSecretContent(text: string): boolean {
  return HIGH_CONFIDENCE_SECRET_PATTERNS.some((entry) => patternHasRealSecret(entry.pattern, text));
}

export function looksSensitiveContent(text: string): boolean {
  return hasSecretLikeAssignment(text) || looksHighConfidenceSecretContent(text);
}

function lineEndingNormalizedLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function diffLinePrefix(line: string): string {
  const first = line[0] ?? "";
  return first === "+" || first === "-" || first === " " ? first : "";
}

function redactSensitiveLines(text: string): string {
  return lineEndingNormalizedLines(text)
    .map((line) => {
      if (!looksSensitiveContent(line)) return line;
      return `${diffLinePrefix(line)}[redacted sensitive line]`;
    })
    .join("\n");
}

function isInsidePath(root: string, candidate: string): boolean {
  const backToRoot = relative(root, candidate);
  return backToRoot === "" || (!backToRoot.startsWith("..") && !isAbsolute(backToRoot));
}

function resolveRepositoryPath(root: string, relativePath: string): string | undefined {
  if (!relativePath || isAbsolute(relativePath)) return undefined;
  const absolute = resolve(root, relativePath);
  if (!isInsidePath(root, absolute)) return undefined;
  return absolute;
}

function skippedReasonForRepositoryPath(path: string): SkippedProjectContextEntry["reason"] | undefined {
  if (isSensitivePath(path)) return "sensitive";
  if (isGeneratedPath(path)) return "generated";
  if (looksBinaryByPath(path)) return "binary";
  return undefined;
}

async function getReadableRepositoryFile(root: string, path: string): Promise<string | SkippedProjectContextEntry> {
  const repositoryRoot = await realpath(root);
  const absolute = resolveRepositoryPath(repositoryRoot, path);
  if (!absolute) return { path, reason: "outside-repository" };

  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    const targetPath = await readlink(absolute);
    const target = resolve(dirname(absolute), targetPath);
    if (!isInsidePath(repositoryRoot, target)) return { path, reason: "outside-repository" };

    const targetRelativePath = normalizeRepositoryPath(relative(repositoryRoot, target));
    const targetSkipReason = skippedReasonForRepositoryPath(targetRelativePath);
    if (targetSkipReason) return { path, reason: targetSkipReason };

    return { path, reason: "symlink" };
  }

  if (!info.isFile()) return { path, reason: "missing" };

  const canonicalFilePath = await realpath(absolute);
  if (!isInsidePath(repositoryRoot, canonicalFilePath)) return { path, reason: "outside-repository" };

  const canonicalRelativePath = normalizeRepositoryPath(relative(repositoryRoot, canonicalFilePath));
  if (canonicalRelativePath !== normalizeRepositoryPath(path)) {
    const canonicalSkipReason = skippedReasonForRepositoryPath(canonicalRelativePath);
    return { path, reason: canonicalSkipReason ?? "symlink" };
  }

  return canonicalFilePath;
}

async function readContextEntry(
  root: string,
  path: string,
  kind: ProjectContextEntryKind,
  options: Required<Pick<GatherGitContextOptions, "projectFileMaxBytes" | "projectFileMaxLines">>,
): Promise<ProjectContextEntry | SkippedProjectContextEntry> {
  const pathSkipReason = skippedReasonForRepositoryPath(path);
  if (pathSkipReason) return { path, reason: pathSkipReason };

  try {
    const resolved = await getReadableRepositoryFile(root, path);
    if (typeof resolved !== "string") return resolved;
    const fileInfo = await stat(resolved);
    if (fileInfo.size > CONTENT_SENSITIVITY_SCAN_MAX_BYTES) return { path, reason: "too-large" };

    const buffer = await readFile(resolved);
    if (isBinaryBuffer(buffer)) return { path, reason: "binary" };

    const content = buffer.toString("utf8");
    if (looksHighConfidenceSecretContent(content)) return { path, reason: "sensitive" };

    const redactedContent = redactSensitiveLines(content);
    const truncated = truncateText(redactedContent, {
      maxBytes: options.projectFileMaxBytes,
      maxLines: options.projectFileMaxLines,
      strategy: "head",
      label: path,
    });
    return {
      path,
      kind,
      content: appendTruncationNotice(truncated),
      truncation: truncated.metadata,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { path, reason: "missing" };
    if (code === "EACCES" || code === "EPERM") return { path, reason: "unreadable" };
    return { path, reason: "too-large" };
  }
}

function isProjectContextEntry(entry: ProjectContextEntry | SkippedProjectContextEntry): entry is ProjectContextEntry {
  return "content" in entry;
}

function dedupeChangedFileCandidates(files: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file });
      continue;
    }

    existing.sensitive = existing.sensitive || file.sensitive;
    existing.generated = existing.generated || file.generated;
    existing.binary = existing.binary || file.binary;
    existing.secretContent = existing.secretContent || file.secretContent;
    existing.unreadable = existing.unreadable || file.unreadable;
    const relatedPaths = [...(existing.relatedPaths ?? []), ...(file.relatedPaths ?? [])];
    if (relatedPaths.length > 0) existing.relatedPaths = [...new Set(relatedPaths)];
  }
  return [...byPath.values()];
}

function skippedReasonForChangedFile(file: ChangedFile): SkippedProjectContextEntry["reason"] | undefined {
  if (file.sensitive) return "sensitive";
  if (file.generated) return "generated";
  if (file.binary) return "binary";
  if (file.unreadable) return "unreadable";
  return undefined;
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Commit secret scan aborted.");
  error.name = "AbortError";
  return error;
}

async function scanFileForHighConfidenceSecret(path: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal));
      return;
    }

    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: SECRET_SCAN_CHUNK_BYTES });
    let settled = false;
    let tail = "";

    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }

    function resolveOnce(value: boolean) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
      stream.destroy();
    }

    function rejectOnce(error: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      stream.destroy();
    }

    function onAbort() {
      if (signal) rejectOnce(createAbortError(signal));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => {
      const text = `${tail}${chunk}`;
      if (looksHighConfidenceSecretContent(text)) {
        resolveOnce(true);
        return;
      }
      tail = text.slice(-SECRET_SCAN_OVERLAP_CHARS);
    });
    stream.once("end", () => resolveOnce(false));
    stream.once("error", (error) => rejectOnce(error));
  });
}

type ChangedFileContentSafety = "safe" | "secret" | "unreadable";

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

async function inspectChangedFileContentSafety(root: string, path: string, signal?: AbortSignal): Promise<ChangedFileContentSafety> {
  try {
    if (signal?.aborted) throw createAbortError(signal);
    const resolved = await getReadableRepositoryFile(root, path);
    if (typeof resolved !== "string") return resolved.reason === "sensitive" ? "secret" : "safe";
    return (await scanFileForHighConfidenceSecret(resolved, signal)) ? "secret" : "safe";
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") return "unreadable";
    return "safe";
  }
}

async function inspectContentSafetyEntry(root: string, path: string, signal?: AbortSignal): Promise<[string, ChangedFileContentSafety]> {
  return [path, await inspectChangedFileContentSafety(root, path, signal)];
}

async function* inspectContentSafetyBatches(root: string, paths: string[], signal?: AbortSignal) {
  for (let start = 0; start < paths.length; start += CONTENT_SAFETY_SCAN_CONCURRENCY) {
    if (signal?.aborted) throw createAbortError(signal);
    const batch = paths.slice(start, start + CONTENT_SAFETY_SCAN_CONCURRENCY);
    // Yield one batch at a time so concurrent secret scans cannot exhaust file descriptors.
    yield Promise.all(batch.map((path) => inspectContentSafetyEntry(root, path, signal)));
  }
}

function withContentSafety(file: ChangedFile, contentSafety?: ChangedFileContentSafety): ChangedFile {
  if (isKnownSecretPath(file.path) || file.status.startsWith("D")) return file;
  if (contentSafety === "secret") return { ...file, sensitive: true, secretContent: true };
  if (contentSafety === "unreadable") return { ...file, unreadable: true };
  return file;
}

async function applyContentSensitivity(root: string, changedFiles: ChangedFile[], signal?: AbortSignal): Promise<ChangedFile[]> {
  if (signal?.aborted) throw createAbortError(signal);
  const paths = [...new Set(changedFiles
    .filter((file) => !isKnownSecretPath(file.path) && !file.status.startsWith("D"))
    .map((file) => file.path))];
  const scannedPaths = new Map<string, ChangedFileContentSafety>();
  for await (const batch of inspectContentSafetyBatches(root, paths, signal)) {
    for (const [path, safety] of batch) scannedPaths.set(path, safety);
  }
  return changedFiles.map((file) => withContentSafety(file, scannedPaths.get(file.path)));
}

function readChangedFileContext(
  root: string,
  file: ChangedFile,
  options: Required<Pick<GatherGitContextOptions, "projectFileMaxBytes" | "projectFileMaxLines">>,
): Promise<ProjectContextEntry | SkippedProjectContextEntry> {
  const reason = skippedReasonForChangedFile(file);
  return reason ? Promise.resolve({ path: file.path, reason }) : readContextEntry(root, file.path, "changed-file-snippet", options);
}

export async function gatherProjectContext(
  root: string,
  changedFiles: ChangedFile[],
  options: Pick<GatherGitContextOptions, "projectContextFileLimit" | "projectFileMaxBytes" | "projectFileMaxLines"> = {},
): Promise<ProjectContext> {
  const resolvedOptions = {
    projectContextFileLimit: options.projectContextFileLimit ?? DEFAULT_PROJECT_CONTEXT_FILE_LIMIT,
    projectFileMaxBytes: options.projectFileMaxBytes ?? DEFAULT_PROJECT_FILE_MAX_BYTES,
    projectFileMaxLines: options.projectFileMaxLines ?? DEFAULT_PROJECT_FILE_MAX_LINES,
  };
  const changedFileSnippets: ProjectContextEntry[] = [];
  const skipped: SkippedProjectContextEntry[] = [];

  const metadataPaths = PROJECT_METADATA_CANDIDATES.slice(0, resolvedOptions.projectContextFileLimit);
  const metadataEntries = await Promise.all(metadataPaths.map((path) => readContextEntry(root, path, "metadata", resolvedOptions)));
  const metadata = metadataEntries.filter(isProjectContextEntry);

  const metadataSet = new Set(metadata.map((entry) => entry.path));
  const snippetCandidates = dedupeChangedFileCandidates(
    changedFiles
      .filter((file) => file.scope === "staged" || file.scope === "unstaged")
      .filter((file) => !metadataSet.has(file.path))
      .sort((a, b) => a.path.localeCompare(b.path)),
  ).slice(0, resolvedOptions.projectContextFileLimit);

  const snippetEntries = await Promise.all(snippetCandidates.map((file) => readChangedFileContext(root, file, resolvedOptions)));
  for (const entry of snippetEntries) {
    if (isProjectContextEntry(entry)) {
      changedFileSnippets.push(entry);
    } else if (entry.reason !== "missing") {
      skipped.push(entry);
    }
  }

  return { root, metadata, changedFileSnippets, skipped };
}

function isRenameOrCopyStatus(status: string): boolean {
  return status.startsWith("R") || status.startsWith("C");
}

export function parseNameStatusZ(output: string, scope: GitChangeScope): ChangedFile[] {
  const files: ChangedFile[] = [];
  const fields = output.split("\0");

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) continue;

    const firstPath = fields[index++];
    const secondPath = isRenameOrCopyStatus(status) ? fields[index++] : undefined;
    const path = secondPath ?? firstPath;
    if (!path) continue;

    files.push(createChangedFile(path, status, scope, secondPath && firstPath ? [firstPath] : []));
  }

  return files;
}

function createChangedFile(path: string, status: string, scope: GitChangeScope, relatedPaths: string[] = []): ChangedFile {
  const paths = [path, ...relatedPaths];
  return {
    path,
    status,
    scope,
    sensitive: paths.some(isSensitivePath),
    generated: paths.some(isGeneratedPath),
    binary: paths.some(looksBinaryByPath),
    ...(relatedPaths.length > 0 ? { relatedPaths } : {}),
  };
}

interface StatusPorcelainRecord {
  xy: string;
  path: string;
  previousPath?: string;
}

interface StatusPorcelainReadResult {
  nextIndex: number;
  record?: StatusPorcelainRecord;
}

function statusHasRenameOrCopySource(xy: string): boolean {
  return xy.includes("R") || xy.includes("C");
}

function readStatusPorcelainRecord(records: string[], index: number): StatusPorcelainReadResult {
  const record = records[index];
  const nextIndex = index + 1;
  if (!record) return { nextIndex };

  const xy = record.slice(0, 2);
  const path = record.slice(3);
  if (!path) return { nextIndex };
  if (!statusHasRenameOrCopySource(xy)) return { nextIndex, record: { xy, path } };

  return {
    nextIndex: nextIndex + 1,
    record: { xy, path, previousPath: records[nextIndex] },
  };
}

function hasStatusChange(status: string): boolean {
  return status !== " " && status !== "?";
}

function relatedPathsForStatus(record: StatusPorcelainRecord): string[] {
  return record.previousPath ? [record.previousPath] : [];
}

function changedFilesForStatusRecord(record: StatusPorcelainRecord): ChangedFile[] {
  const relatedPaths = relatedPathsForStatus(record);
  if (record.xy === "??") return [createChangedFile(record.path, "??", "unstaged", relatedPaths)];

  const files: ChangedFile[] = [];
  const indexStatus = record.xy[0] ?? " ";
  const worktreeStatus = record.xy[1] ?? " ";
  if (hasStatusChange(indexStatus)) files.push(createChangedFile(record.path, indexStatus, "staged", relatedPaths));
  if (hasStatusChange(worktreeStatus)) files.push(createChangedFile(record.path, worktreeStatus, "unstaged", relatedPaths));
  return files;
}

export function parseStatusPorcelainZ(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const records = output.split("\0");

  for (let index = 0; index < records.length; ) {
    const readResult = readStatusPorcelainRecord(records, index);
    index = readResult.nextIndex;
    if (readResult.record) files.push(...changedFilesForStatusRecord(readResult.record));
  }
  return files;
}

function dedupeChangedFiles(files: ChangedFile[]): ChangedFile[] {
  const seen = new Set<string>();
  const output: ChangedFile[] = [];
  for (const file of files) {
    const key = `${file.scope}:${file.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(file);
  }
  return output;
}

function diffArgsForScope(scope: GitChangeScope, extraArgs: string[] = []): string[] {
  const baseArgs = scope === "staged" ? ["diff", "--cached"] : ["diff"];
  return [...baseArgs, "--no-ext-diff", "--no-textconv", ...extraArgs];
}

async function collectDiffSummary(
  executor: Pick<ExtensionAPI, "exec">,
  scope: GitChangeScope,
  files: ChangedFile[],
  options: Required<Pick<GatherGitContextOptions, "diffFileLimit" | "diffMaxBytes" | "diffMaxLines">> & CommitGitOptions,
): Promise<GitDiffSummary> {
  const stat = (await runGit(executor, options, diffArgsForScope(scope, ["--stat"]), { signal: options.signal, timeout: options.timeout })).stdout.trim();
  const safePaths: string[] = [];
  const candidates = files
    .filter((file) => file.scope === scope && !file.sensitive && !file.generated && !file.binary && !file.status.startsWith("D"))
    .slice(0, options.diffFileLimit);

  const entryOptions = { projectFileMaxBytes: CONTENT_SENSITIVITY_SCAN_MAX_BYTES, projectFileMaxLines: Number.MAX_SAFE_INTEGER };
  const entries = await Promise.all(candidates.map((file) => readChangedFileContext(options.cwd, file, entryOptions)));
  safePaths.push(...entries.filter(isProjectContextEntry).map((entry) => entry.path));

  let rawExcerpt = "";
  if (safePaths.length > 0) {
    rawExcerpt = redactSensitiveLines((await runGit(executor, options, diffArgsForScope(scope, ["--", ...safePaths]), { signal: options.signal, timeout: options.timeout })).stdout).trim();
  }

  const truncated = truncateText(rawExcerpt, {
    maxLines: options.diffMaxLines,
    maxBytes: options.diffMaxBytes,
    strategy: "head",
    label: `${scope} diff`,
  });

  return {
    scope,
    stat,
    excerpt: appendTruncationNotice(truncated),
    truncation: truncated.metadata,
  };
}

export async function gatherGitContext(
  executor: Pick<ExtensionAPI, "exec">,
  options: GatherGitContextOptions,
): Promise<GitContext> {
  const repositoryRoot = await getGitRoot(executor, options, options.signal);
  const commonOptions = { ...options, cwd: repositoryRoot };
  const gitOptions = { signal: options.signal, timeout: options.timeout };
  const { branch, isDetachedHead } = await getBranchLabel(executor, commonOptions);
  const statusPorcelain = (await runGit(executor, commonOptions, STATUS_PORCELAIN_ARGS, gitOptions)).stdout.trim();

  const statusPorcelainZ = (await runGit(executor, commonOptions, STATUS_PORCELAIN_Z_ARGS, gitOptions)).stdout;
  const stagedNameStatusZ = (await runGit(executor, commonOptions, diffArgsForScope("staged", ["--name-status", "-z"]), gitOptions)).stdout;
  const unstagedNameStatusZ = (await runGit(executor, commonOptions, diffArgsForScope("unstaged", ["--name-status", "-z"]), gitOptions)).stdout;
  const changedFiles = await applyContentSensitivity(
    repositoryRoot,
    dedupeChangedFiles([
      ...parseNameStatusZ(stagedNameStatusZ, "staged"),
      ...parseNameStatusZ(unstagedNameStatusZ, "unstaged"),
      ...parseStatusPorcelainZ(statusPorcelainZ),
    ]),
    options.signal,
  );

  const diffOptions = {
    ...commonOptions,
    diffFileLimit: options.diffFileLimit ?? DEFAULT_DIFF_FILE_LIMIT,
    diffMaxBytes: options.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES,
    diffMaxLines: options.diffMaxLines ?? DEFAULT_DIFF_MAX_LINES,
  };

  const staged = await collectDiffSummary(executor, "staged", changedFiles, diffOptions);
  const unstaged = await collectDiffSummary(executor, "unstaged", changedFiles, diffOptions);
  const project = await gatherProjectContext(repositoryRoot, changedFiles, options);

  return {
    repositoryRoot,
    branch,
    isDetachedHead,
    statusPorcelain,
    staged,
    unstaged,
    changedFiles,
    project,
    hasChanges: changedFiles.length > 0,
    warnings: [],
  };
}
