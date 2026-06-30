import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./redaction.ts";
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_RESPONSE_BODY_LIMIT_BYTES,
  GITHUB_USER_AGENT,
  MAX_SUMMARY_OUTPUT_CHARS,
} from "./constants.ts";
import { getGitRoot, getOriginUrl, validateBranchNameInput, type GitCommandContext } from "./git.ts";
import type { GitHubRepository, PullRequestDetails, PullRequestInput } from "./types.ts";

type TokenEnvironmentKey = "GITHUB_TOKEN" | "GH_TOKEN";

export type TokenResolutionSource = TokenEnvironmentKey | `${TokenEnvironmentKey} (.env)`;

export interface TokenResolution {
  token: string;
  source: TokenResolutionSource;
}

// Exported for focused tests and future embedders that call GitHub helpers directly.
export interface TokenResolutionOptions {
  cwd?: string;
  signal?: AbortSignal;
}

// Exported for focused tests and future embedders that inject fetch/cancellation.
export interface PullRequestFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface GitHubBranchDetails {
  name: string;
  commitSha: string;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function requireRepositorySegment(value: unknown, field: "owner" | "repo"): string {
  if (typeof value !== "string") throw new Error(`GitHub repository ${field} must be a string.`);
  if (!value) throw new Error(`GitHub repository ${field} is required.`);
  if (value !== value.trim()) throw new Error(`GitHub repository ${field} cannot start or end with whitespace.`);
  if (/[/\\]/u.test(value)) throw new Error(`GitHub repository ${field} must be a single path segment.`);
  if (value === "." || value === "..") throw new Error(`GitHub repository ${field} cannot be a dot segment.`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`GitHub repository ${field} cannot contain control characters.`);
  if (/\s/u.test(value)) throw new Error(`GitHub repository ${field} cannot contain whitespace.`);
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) throw new Error(`GitHub repository ${field} contains unsupported characters.`);
  return value;
}

export function validateGitHubRepository(repository: GitHubRepository): void {
  if (!isRecord(repository)) throw new Error("GitHub repository must be an object.");
  requireRepositorySegment(repository.owner, "owner");
  requireRepositorySegment(repository.repo, "repo");
}

function normalizeRepository(owner: string, repo: string): GitHubRepository | null {
  const normalizedOwner = owner.trim();
  const normalizedRepo = stripGitSuffix(repo.trim());
  try {
    requireRepositorySegment(normalizedOwner, "owner");
    requireRepositorySegment(normalizedRepo, "repo");
  } catch {
    return null;
  }
  return { owner: normalizedOwner, repo: normalizedRepo };
}

export function repositoriesEqual(left: GitHubRepository, right: GitHubRepository): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}

export function repositoryLabel(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.repo}`;
}

export function parseGitHubRepository(value: string): GitHubRepository | null {
  const input = value.trim();
  if (!input) return null;

  const scpLike = input.match(/^git@github\.com:([^\s/]+)\/([^\s/]+)$/iu);
  if (scpLike) {
    return normalizeRepository(scpLike[1] ?? "", scpLike[2] ?? "");
  }

  const shorthand = input.match(/^([^\s/:]+)\/([^\s/]+)$/u);
  if (shorthand) {
    return normalizeRepository(shorthand[1] ?? "", shorthand[2] ?? "");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
  if (parsed.protocol === "ssh:" && parsed.username && parsed.username !== "git") return null;

  const parts = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length !== 2) return null;
  return normalizeRepository(parts[0] ?? "", parts[1] ?? "");
}

function resolveProcessToken(env: NodeJS.ProcessEnv): TokenResolution | null {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) return { token: githubToken, source: "GITHUB_TOKEN" };

  const ghToken = env.GH_TOKEN?.trim();
  if (ghToken) return { token: ghToken, source: "GH_TOKEN" };

  return null;
}

function isTokenEnvironmentKey(value: string): value is TokenEnvironmentKey {
  return value === "GITHUB_TOKEN" || value === "GH_TOKEN";
}

function decodeDoubleQuotedDotEnvValue(value: string): string {
  return value.replace(/\\([nrt"\\])/gu, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) return "";

  if (value.startsWith("\"") && value.endsWith("\"")) {
    return decodeDoubleQuotedDotEnvValue(value.slice(1, -1)).trim();
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).trim();
  }

  return value.replace(/\s+#.*$/u, "").trim();
}

function parseDotEnvTokens(contents: string): Partial<Record<TokenEnvironmentKey, string>> {
  const tokens: Partial<Record<TokenEnvironmentKey, string>> = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = assignment.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;

    const key = match[1] ?? "";
    if (!isTokenEnvironmentKey(key)) continue;

    tokens[key] = parseDotEnvValue(match[2] ?? "");
  }

  return tokens;
}

const MAX_DOTENV_BYTES = 64 * 1024;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("GitHub token .env fallback was aborted.");
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

async function readDotEnvTokens(
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<Partial<Record<TokenEnvironmentKey, string>>> {
  if (!cwd) return {};

  const envPath = join(cwd, ".env");
  throwIfAborted(signal);

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(envPath);
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw new Error(`Unable to inspect .env file for GitHub token fallback: ${errorMessage(error)}`);
  }

  if (!stats.isFile()) {
    throw new Error("Unable to read .env file for GitHub token fallback: .env must be a small regular file.");
  }
  if (stats.size > MAX_DOTENV_BYTES) {
    throw new Error(
      `Unable to read .env file for GitHub token fallback: .env is too large (${stats.size} bytes; limit ${MAX_DOTENV_BYTES} bytes).`,
    );
  }

  throwIfAborted(signal);

  let contents: string;
  try {
    contents = await readFile(envPath, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw new Error(`Unable to read .env file for GitHub token fallback: ${errorMessage(error)}`);
  }

  if (Buffer.byteLength(contents, "utf8") > MAX_DOTENV_BYTES) {
    throw new Error(`Unable to read .env file for GitHub token fallback: .env exceeded the ${MAX_DOTENV_BYTES} byte limit.`);
  }

  return parseDotEnvTokens(contents);
}

export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  options: TokenResolutionOptions = {},
): Promise<TokenResolution> {
  const processToken = resolveProcessToken(env);
  if (processToken) return processToken;

  const dotEnvTokens = await readDotEnvTokens(options.cwd, options.signal);
  const githubToken = dotEnvTokens.GITHUB_TOKEN?.trim();
  if (githubToken) return { token: githubToken, source: "GITHUB_TOKEN (.env)" };

  const ghToken = dotEnvTokens.GH_TOKEN?.trim();
  if (ghToken) return { token: ghToken, source: "GH_TOKEN (.env)" };

  throw new Error("GitHub token is required. Set GITHUB_TOKEN or GH_TOKEN in the process environment or repository .env file.");
}

export async function resolveGitHubRepository(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubRepository> {
  await getGitRoot(pi, ctx, signal);
  const originUrl = await getOriginUrl(pi, ctx, signal);
  const localRepository = originUrl ? parseGitHubRepository(originUrl) : null;
  const envValue = env.GITHUB_REPOSITORY?.trim();
  const envRepository = envValue ? parseGitHubRepository(envValue) : null;

  if (envValue && !envRepository) {
    throw new Error("Invalid GITHUB_REPOSITORY. Expected owner/repo for the current GitHub repository.");
  }

  if (localRepository && envRepository && !repositoriesEqual(localRepository, envRepository)) {
    throw new Error(
      `Repository boundary mismatch: local origin resolves to ${repositoryLabel(localRepository)} but GITHUB_REPOSITORY resolves to ${repositoryLabel(envRepository)}.`,
    );
  }

  const repository = localRepository ?? envRepository;
  if (!repository) {
    throw new Error("Unable to resolve a GitHub repository from origin or GITHUB_REPOSITORY.");
  }

  return repository;
}

function truncate(value: string): string {
  if (value.length <= MAX_SUMMARY_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_SUMMARY_OUTPUT_CHARS)}… [truncated]`;
}

export { redactSecrets } from "./redaction.ts";

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function requireStringRef(value: unknown, field: "headBranch" | "baseBranch"): string {
  validateBranchNameInput(value, field);
  return value;
}

export function validatePullRequestBranchRef(value: unknown, field: "headBranch" | "baseBranch"): void {
  const ref = requireStringRef(value, field);

  if (/[\u0000-\u001f\u007f]/u.test(ref)) throw new Error(`${field} cannot contain control characters.`);
  if (/\s/u.test(ref)) throw new Error(`${field} cannot contain whitespace.`);
  if (ref.includes(":")) throw new Error(`${field} cannot contain ':' or an owner-prefixed cross-repository ref.`);
  if (ref.includes("\\")) throw new Error(`${field} cannot contain backslashes.`);
  if (/[~^?*[\]]/u.test(ref)) throw new Error(`${field} contains characters that are not valid in a branch ref.`);
  if (ref.includes("..")) throw new Error(`${field} cannot contain path traversal-like '..' segments.`);
  if (ref.includes("@{")) throw new Error(`${field} cannot contain '@{'.`);
  if (ref.includes("//")) throw new Error(`${field} cannot contain empty path segments.`);
  if (ref.startsWith("/") || ref.endsWith("/")) throw new Error(`${field} cannot start or end with '/'.`);
  if (ref.startsWith("-")) throw new Error(`${field} cannot start with '-'.`);
  if (ref.endsWith(".")) throw new Error(`${field} cannot end with '.'.`);
  if (ref === "@") throw new Error(`${field} cannot be '@'.`);
  if (ref.startsWith("refs/")) throw new Error(`${field} must be a branch name, not a full ref path.`);

  for (const segment of ref.split("/")) {
    if (segment === "." || segment === "..") throw new Error(`${field} cannot contain path traversal segments.`);
    if (segment.endsWith(".lock")) throw new Error(`${field} cannot contain '.lock' path segments.`);
  }
}

function validatePullRequestInput(input: unknown): asserts input is PullRequestInput {
  if (!isRecord(input)) throw new Error("Pull request input must be an object.");
  validatePullRequestBranchRef(input.headBranch, "headBranch");
  validatePullRequestBranchRef(input.baseBranch, "baseBranch");
  if (typeof input.title !== "string") throw new Error("title must be a string.");
  if (!input.title.trim()) throw new Error("title is required.");
  if (typeof input.body !== "string") throw new Error("body must be a string.");
  if (typeof input.draft !== "boolean") throw new Error("draft must be a boolean.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`GitHub response is missing ${field}.`);
  return value;
}

function pullRequestNumberField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("GitHub response pull request number must be a finite positive safe integer.");
  }
  return value;
}

interface BoundedResponseBody {
  text: string;
  truncated: boolean;
}

function throwIfResponseReadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("GitHub pull request response read was aborted.");
}

async function readBoundedResponseText(response: Response, signal: AbortSignal | undefined): Promise<BoundedResponseBody> {
  throwIfResponseReadAborted(signal);
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      throwIfResponseReadAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remainingBytes = GITHUB_RESPONSE_BODY_LIMIT_BYTES - capturedBytes;
      if (remainingBytes > 0) {
        const capturedChunk = value.byteLength <= remainingBytes ? value : value.subarray(0, remainingBytes);
        chunks.push(Buffer.from(capturedChunk));
        capturedBytes += capturedChunk.byteLength;
      }

      if (value.byteLength > remainingBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return { text: truncated ? `${text}… [truncated]` : text, truncated };
}

function gitHubJsonHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": GITHUB_USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

export async function ensureGitHubBranchExists(
  repository: GitHubRepository,
  branchName: string,
  field: "headBranch" | "baseBranch",
  token: string,
  options: PullRequestFetchOptions = {},
): Promise<GitHubBranchDetails> {
  validateGitHubRepository(repository);
  validatePullRequestBranchRef(branchName, field);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this Node.js runtime.");

  const branchLabel = redactSecrets(branchName);
  const url = `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/branches/${encodePathSegment(branchName)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: gitHubJsonHeaders(token),
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub branch preflight request failed for ${field} '${branchLabel}': ${redactSecrets(message, [token])}`);
  }

  if (response.ok) {
    let body: BoundedResponseBody;
    try {
      body = await readBoundedResponseText(response, options.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub branch preflight response for ${field} '${branchLabel}' could not be read: ${redactSecrets(message, [token])}`);
    }

    if (body.truncated) throw new Error(`GitHub branch preflight response exceeded the ${GITHUB_RESPONSE_BODY_LIMIT_BYTES} byte limit.`);

    let payload: unknown;
    try {
      payload = JSON.parse(body.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub branch preflight response was not valid JSON: ${redactSecrets(message, [token])}`);
    }

    if (!isRecord(payload)) throw new Error("GitHub branch preflight response was not an object.");
    const commit = isRecord(payload.commit) ? stringField(payload.commit.sha, "commit.sha") : "";
    if (!/^[0-9a-f]{40,64}$/iu.test(commit)) throw new Error("GitHub branch preflight response is missing commit.sha.");

    return {
      name: typeof payload.name === "string" && payload.name ? payload.name : branchName,
      commitSha: commit,
    };
  }

  let body: BoundedResponseBody;
  try {
    body = await readBoundedResponseText(response, options.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `GitHub branch preflight failed for ${field} '${branchLabel}' with HTTP ${response.status}: unable to read error response: ${redactSecrets(message, [token])}`,
    );
  }

  if (response.status === 404) {
    throw new Error(
      `${field} branch '${branchLabel}' is not visible in ${repositoryLabel(repository)} on GitHub. Run push_branch and wait for it to complete before calling pull_request, then retry.`,
    );
  }

  throw new Error(
    `GitHub branch preflight failed for ${field} '${branchLabel}' with HTTP ${response.status}: ${redactSecrets(truncate(body.text), [token])}`,
  );
}

export async function createGitHubPullRequest(
  repository: GitHubRepository,
  input: PullRequestInput,
  token: string,
  options: PullRequestFetchOptions = {},
): Promise<PullRequestDetails> {
  validateGitHubRepository(repository);
  validatePullRequestInput(input);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this Node.js runtime.");

  const url = `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/pulls`;
  const requestBody = {
    title: input.title,
    head: input.headBranch,
    base: input.baseBranch,
    body: input.body,
    draft: input.draft,
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: gitHubJsonHeaders(token),
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub pull request request failed: ${redactSecrets(message, [token])}`);
  }

  if (!response.ok) {
    let body: BoundedResponseBody;
    try {
      body = await readBoundedResponseText(response, options.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `GitHub pull request request failed with HTTP ${response.status}: unable to read error response: ${redactSecrets(message, [token])}`,
      );
    }

    throw new Error(
      `GitHub pull request request failed with HTTP ${response.status}: ${redactSecrets(truncate(body.text), [token])}`,
    );
  }

  let responseBody: BoundedResponseBody;
  try {
    responseBody = await readBoundedResponseText(response, options.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub pull request response could not be read: ${redactSecrets(message, [token])}`);
  }

  if (responseBody.truncated) {
    throw new Error(`GitHub pull request response exceeded the ${GITHUB_RESPONSE_BODY_LIMIT_BYTES} byte limit.`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseBody.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub pull request response was not valid JSON: ${redactSecrets(message, [token])}`);
  }

  if (!isRecord(payload)) throw new Error("GitHub pull request response was not an object.");
  const number = pullRequestNumberField(payload.number);

  const head = isRecord(payload.head) ? stringField(payload.head.ref, "head.ref") : input.headBranch;
  const base = isRecord(payload.base) ? stringField(payload.base.ref, "base.ref") : input.baseBranch;
  const draft = typeof payload.draft === "boolean" ? payload.draft : input.draft;

  return {
    repository,
    number,
    url: stringField(payload.html_url, "html_url"),
    state: stringField(payload.state, "state"),
    head,
    base,
    draft,
  };
}
