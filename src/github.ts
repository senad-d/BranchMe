import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./redaction.ts";
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_RELATED_PR_TIMEOUT_MS,
  GITHUB_RESPONSE_BODY_LIMIT_BYTES,
  GITHUB_USER_AGENT,
  GIT_CONTEXT_VALUE_LIMIT_CHARS,
  MAX_SUMMARY_OUTPUT_CHARS,
} from "./constants.ts";
import {
  getCurrentBranch,
  getGitRoot,
  getOriginUrl,
  validateBranchNameInput,
  type GitCommandContext,
} from "./git.ts";
import type {
  GitHubRepository,
  PullRequestDetails,
  PullRequestInput,
  RelatedPullRequest,
  RelatedPullRequestDetails,
} from "./types.ts";

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

export interface RelatedPullRequestLookupOptions extends PullRequestFetchOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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

function trimPathSlashes(pathname: string): string {
  let start = 0;
  let end = pathname.length;

  while (start < end && pathname.charAt(start) === "/") start += 1;
  while (end > start && pathname.charAt(end - 1) === "/") end -= 1;

  return pathname.slice(start, end);
}

export function parseGitHubRepository(value: string): GitHubRepository | null {
  const input = value.trim();
  if (!input) return null;

  const scpLike = /^git@github\.com:([^\s/]+)\/([^\s/]+)$/iu.exec(input);
  if (scpLike) {
    return normalizeRepository(scpLike[1] ?? "", scpLike[2] ?? "");
  }

  const shorthand = /^([^\s/:]+)\/([^\s/]+)$/u.exec(input);
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

  const parts = trimPathSlashes(parsed.pathname).split("/");
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

function isWhitespaceCharacter(character: string): boolean {
  return character.trim() === "";
}

function stripDotEnvInlineComment(value: string): string {
  for (let index = 1; index < value.length; index += 1) {
    if (value.charAt(index) === "#" && isWhitespaceCharacter(value.charAt(index - 1))) {
      return value.slice(0, index);
    }
  }

  return value;
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

  return stripDotEnvInlineComment(value).trim();
}

function parseDotEnvTokens(contents: string): Partial<Record<TokenEnvironmentKey, string>> {
  const tokens: Partial<Record<TokenEnvironmentKey, string>> = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = assignment.slice(0, separatorIndex).trim();
    if (!isTokenEnvironmentKey(key)) continue;

    tokens[key] = parseDotEnvValue(assignment.slice(separatorIndex + 1).trimStart());
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

const PULL_REQUEST_REF_INVALID_CHARACTER_PATTERN = /[~^?*[\]]/u;

function validatePullRequestRefCharacters(ref: string, field: "headBranch" | "baseBranch"): void {
  if (ref.includes(":")) throw new Error(`${field} cannot contain ':' or an owner-prefixed cross-repository ref.`);
  if (ref.includes("\\")) throw new Error(`${field} cannot contain backslashes.`);
  if (PULL_REQUEST_REF_INVALID_CHARACTER_PATTERN.test(ref)) {
    throw new Error(`${field} contains characters that are not valid in a branch ref.`);
  }
}

function validatePullRequestRefPathShape(ref: string, field: "headBranch" | "baseBranch"): void {
  if (ref.includes("..")) throw new Error(`${field} cannot contain path traversal-like '..' segments.`);
  if (ref.includes("@{")) throw new Error(`${field} cannot contain '@{'.`);
  if (ref.includes("//")) throw new Error(`${field} cannot contain empty path segments.`);
  if (ref.startsWith("/") || ref.endsWith("/")) throw new Error(`${field} cannot start or end with '/'.`);
  if (ref.endsWith(".")) throw new Error(`${field} cannot end with '.'.`);
  if (ref === "@") throw new Error(`${field} cannot be '@'.`);
  if (ref.startsWith("refs/")) throw new Error(`${field} must be a branch name, not a full ref path.`);
}

function validatePullRequestRefSegments(ref: string, field: "headBranch" | "baseBranch"): void {
  for (const segment of ref.split("/")) {
    if (segment === "." || segment === "..") throw new Error(`${field} cannot contain path traversal segments.`);
    if (segment.endsWith(".lock")) throw new Error(`${field} cannot contain '.lock' path segments.`);
  }
}

export function validatePullRequestBranchRef(value: unknown, field: "headBranch" | "baseBranch"): void {
  const ref = requireStringRef(value, field);
  validatePullRequestRefCharacters(ref, field);
  validatePullRequestRefPathShape(ref, field);
  validatePullRequestRefSegments(ref, field);
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

function requireFetchImplementation(fetchImpl: typeof fetch | undefined): typeof fetch {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this Node.js runtime.");
  return fetchImpl;
}

function redactedErrorMessage(error: unknown, tokens: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, tokens);
}

async function fetchGitHubResponse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  failurePrefix: string,
  token: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${failurePrefix}: ${redactedErrorMessage(error, [token])}`);
  }
}

async function readGitHubResponseBody(
  response: Response,
  signal: AbortSignal | undefined,
  failurePrefix: string,
  token: string,
): Promise<BoundedResponseBody> {
  try {
    return await readBoundedResponseText(response, signal);
  } catch (error) {
    throw new Error(`${failurePrefix}: ${redactedErrorMessage(error, [token])}`);
  }
}

function parseGitHubJson(text: string, responseContext: string, token: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${responseContext} was not valid JSON: ${redactedErrorMessage(error, [token])}`);
  }
}

function requireGitHubResponseObject(payload: unknown, responseContext: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error(`${responseContext} was not an object.`);
  return payload;
}

function requireGitHubResponseArray(payload: unknown, responseContext: string): unknown[] {
  if (!Array.isArray(payload)) throw new Error(`${responseContext} was not an array.`);
  return payload;
}

async function readGitHubJsonObject(
  response: Response,
  signal: AbortSignal | undefined,
  token: string,
  responseContext: string,
  readFailurePrefix: string,
): Promise<Record<string, unknown>> {
  const body = await readGitHubResponseBody(response, signal, readFailurePrefix, token);
  if (body.truncated) throw new Error(`${responseContext} exceeded the ${GITHUB_RESPONSE_BODY_LIMIT_BYTES} byte limit.`);
  return requireGitHubResponseObject(parseGitHubJson(body.text, responseContext, token), responseContext);
}

async function readGitHubJsonArray(
  response: Response,
  signal: AbortSignal | undefined,
  token: string,
  responseContext: string,
  readFailurePrefix: string,
): Promise<unknown[]> {
  const body = await readGitHubResponseBody(response, signal, readFailurePrefix, token);
  if (body.truncated) throw new Error(`${responseContext} exceeded the ${GITHUB_RESPONSE_BODY_LIMIT_BYTES} byte limit.`);
  return requireGitHubResponseArray(parseGitHubJson(body.text, responseContext, token), responseContext);
}

function parseGitHubBranchDetails(payload: Record<string, unknown>, branchName: string): GitHubBranchDetails {
  const commit = isRecord(payload.commit) ? stringField(payload.commit.sha, "commit.sha") : "";
  if (!/^[0-9a-f]{40,64}$/iu.test(commit)) throw new Error("GitHub branch preflight response is missing commit.sha.");

  return {
    name: typeof payload.name === "string" && payload.name ? payload.name : branchName,
    commitSha: commit,
  };
}

async function readGitHubBranchDetails(
  response: Response,
  signal: AbortSignal | undefined,
  token: string,
  branchName: string,
  field: "headBranch" | "baseBranch",
  branchLabel: string,
): Promise<GitHubBranchDetails> {
  const payload = await readGitHubJsonObject(
    response,
    signal,
    token,
    "GitHub branch preflight response",
    `GitHub branch preflight response for ${field} '${branchLabel}' could not be read`,
  );
  return parseGitHubBranchDetails(payload, branchName);
}

async function throwGitHubBranchPreflightHttpError(
  response: Response,
  signal: AbortSignal | undefined,
  token: string,
  repository: GitHubRepository,
  field: "headBranch" | "baseBranch",
  branchLabel: string,
): Promise<never> {
  const body = await readGitHubResponseBody(
    response,
    signal,
    `GitHub branch preflight failed for ${field} '${branchLabel}' with HTTP ${response.status}: unable to read error response`,
    token,
  );

  if (response.status === 404) {
    throw new Error(
      `${field} branch '${branchLabel}' is not visible in ${repositoryLabel(repository)} on GitHub. Run push_branch and wait for it to complete before calling pull_request, then retry.`,
    );
  }

  throw new Error(
    `GitHub branch preflight failed for ${field} '${branchLabel}' with HTTP ${response.status}: ${redactSecrets(truncate(body.text), [token])}`,
  );
}

function pullRequestRequestBody(input: PullRequestInput): Record<string, unknown> {
  return {
    title: input.title,
    head: input.headBranch,
    base: input.baseBranch,
    body: input.body,
    draft: input.draft,
  };
}

async function throwGitHubPullRequestHttpError(
  response: Response,
  signal: AbortSignal | undefined,
  token: string,
): Promise<never> {
  const body = await readGitHubResponseBody(
    response,
    signal,
    `GitHub pull request request failed with HTTP ${response.status}: unable to read error response`,
    token,
  );

  throw new Error(`GitHub pull request request failed with HTTP ${response.status}: ${redactSecrets(truncate(body.text), [token])}`);
}

async function readPullRequestPayload(
  response: Response,
  signal: AbortSignal | undefined,
  token: string,
): Promise<Record<string, unknown>> {
  return readGitHubJsonObject(response, signal, token, "GitHub pull request response", "GitHub pull request response could not be read");
}

function pullRequestDetailsFromPayload(
  repository: GitHubRepository,
  input: PullRequestInput,
  payload: Record<string, unknown>,
): PullRequestDetails {
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

function escapeRelatedPullRequestControlCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? "" : `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

function boundedRelatedPullRequestValue(value: string): string {
  const safeValue = redactSecrets(value).replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    escapeRelatedPullRequestControlCharacter,
  );
  if (safeValue.length <= GIT_CONTEXT_VALUE_LIMIT_CHARS) return safeValue;

  let end = GIT_CONTEXT_VALUE_LIMIT_CHARS - 1;
  const lastCodeUnit = safeValue.charCodeAt(end - 1);
  const nextCodeUnit = safeValue.charCodeAt(end);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    end -= 1;
  }
  return `${safeValue.slice(0, end)}…`;
}

function requireRelatedPullRequestString(value: unknown, field: string): string {
  const text = stringField(value, field);
  if (text.trim().length === 0) throw new Error(`GitHub response ${field} cannot be blank.`);
  return text;
}

function requireRelatedPullRequestUrl(
  value: unknown,
  repository: GitHubRepository,
  number: number,
): string {
  const rawUrl = requireRelatedPullRequestString(value, "html_url");
  if (rawUrl.length > GIT_CONTEXT_VALUE_LIMIT_CHARS || /[\p{Cc}\p{Cf}\s]/u.test(rawUrl)) {
    throw new Error("GitHub response html_url was invalid.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("GitHub response html_url was invalid.");
  }

  const expectedPath = `/${repository.owner}/${repository.repo}/pull/${number}`.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname.toLowerCase() !== expectedPath
  ) {
    throw new Error("GitHub response html_url did not match the resolved repository and pull request number.");
  }

  return rawUrl;
}

function requireRelatedPullRequestRepository(
  value: unknown,
  repository: GitHubRepository,
): void {
  const headRepository = requireGitHubResponseObject(value, "GitHub related pull request head.repo");
  const fullName = requireRelatedPullRequestString(headRepository.full_name, "head.repo.full_name");
  if (fullName.toLowerCase() !== repositoryLabel(repository).toLowerCase()) {
    throw new Error("GitHub related pull request head repository did not match the resolved repository.");
  }
}

function relatedPullRequestDetailsFromPayload(
  repository: GitHubRepository,
  currentBranch: string,
  payload: unknown,
): RelatedPullRequestDetails {
  const response = requireGitHubResponseObject(payload, "GitHub related pull request response item");
  const number = pullRequestNumberField(response.number);
  const state = requireRelatedPullRequestString(response.state, "state");
  if (state !== "open") throw new Error("GitHub related pull request response state was not open.");
  if (typeof response.draft !== "boolean") throw new Error("GitHub response draft must be a boolean.");

  const head = requireGitHubResponseObject(response.head, "GitHub related pull request head");
  const headRef = requireRelatedPullRequestString(head.ref, "head.ref");
  if (headRef !== currentBranch) {
    throw new Error("GitHub related pull request head did not match the current branch.");
  }
  requireRelatedPullRequestRepository(head.repo, repository);

  const base = requireGitHubResponseObject(response.base, "GitHub related pull request base");
  const baseRef = requireRelatedPullRequestString(base.ref, "base.ref");
  const title = requireRelatedPullRequestString(response.title, "title");

  return {
    repository: {
      owner: boundedRelatedPullRequestValue(repository.owner),
      repo: boundedRelatedPullRequestValue(repository.repo),
    },
    number,
    url: requireRelatedPullRequestUrl(response.html_url, repository, number),
    title: boundedRelatedPullRequestValue(title),
    state,
    draft: response.draft,
    head: boundedRelatedPullRequestValue(headRef),
    base: boundedRelatedPullRequestValue(baseRef),
  };
}

function unavailableRelatedPullRequest(reason: string): RelatedPullRequest {
  return { status: "unavailable", reason };
}

function abortedRelatedPullRequest(
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): RelatedPullRequest | null {
  if (callerSignal?.aborted) return unavailableRelatedPullRequest("Related pull request lookup was cancelled.");
  if (timeoutSignal.aborted) return unavailableRelatedPullRequest("Related pull request lookup timed out.");
  return null;
}

function validateRelatedPullRequestLookupBounds(repository: GitHubRepository, branch: string): void {
  if (
    repository.owner.length > GIT_CONTEXT_VALUE_LIMIT_CHARS ||
    repository.repo.length > GIT_CONTEXT_VALUE_LIMIT_CHARS ||
    branch.length > GIT_CONTEXT_VALUE_LIMIT_CHARS
  ) {
    throw new Error("GitHub related pull request lookup metadata exceeded its value limit.");
  }
}

function relatedPullRequestLookupUrl(repository: GitHubRepository, currentBranch: string): string {
  const query = new URLSearchParams({
    state: "open",
    head: `${repository.owner}:${currentBranch}`,
    per_page: "1",
  });
  return `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/pulls?${query.toString()}`;
}

async function lookupRelatedPullRequestWithSignal(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  options: RelatedPullRequestLookupOptions,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<RelatedPullRequest> {
  const initialAbort = abortedRelatedPullRequest(options.signal, timeoutSignal);
  if (initialAbort) return initialAbort;

  let repoRoot: string;
  let currentBranch: string;
  let repository: GitHubRepository;
  try {
    repoRoot = await getGitRoot(pi, ctx, signal);
    const rootCtx = { cwd: repoRoot };
    const branch = await getCurrentBranch(pi, rootCtx, signal);
    if (branch.detached || !branch.currentBranch) {
      return unavailableRelatedPullRequest("Related pull request lookup is unavailable for detached HEAD.");
    }
    currentBranch = branch.currentBranch;
    validatePullRequestBranchRef(currentBranch, "headBranch");
    repository = await resolveGitHubRepository(pi, rootCtx, signal, options.env ?? process.env);
    validateRelatedPullRequestLookupBounds(repository, currentBranch);
  } catch {
    return (
      abortedRelatedPullRequest(options.signal, timeoutSignal) ??
      unavailableRelatedPullRequest("The current GitHub repository or branch could not be resolved.")
    );
  }

  let token: string;
  try {
    token = (await resolveGitHubToken(options.env ?? process.env, { cwd: repoRoot, signal })).token;
  } catch {
    return (
      abortedRelatedPullRequest(options.signal, timeoutSignal) ??
      unavailableRelatedPullRequest("GitHub authentication is unavailable.")
    );
  }

  let response: Response;
  try {
    const fetchImpl = requireFetchImplementation(options.fetchImpl ?? globalThis.fetch);
    response = await fetchGitHubResponse(
      fetchImpl,
      relatedPullRequestLookupUrl(repository, currentBranch),
      { method: "GET", headers: gitHubJsonHeaders(token), signal },
      "GitHub related pull request request failed",
      token,
    );
  } catch {
    return (
      abortedRelatedPullRequest(options.signal, timeoutSignal) ??
      unavailableRelatedPullRequest("The GitHub related pull request request failed.")
    );
  }

  if (!response.ok) {
    try {
      await readGitHubResponseBody(
        response,
        signal,
        `GitHub related pull request request failed with HTTP ${response.status}: unable to read error response`,
        token,
      );
    } catch {
      return (
        abortedRelatedPullRequest(options.signal, timeoutSignal) ??
        unavailableRelatedPullRequest("The GitHub related pull request response could not be read.")
      );
    }
    return unavailableRelatedPullRequest(`GitHub related pull request lookup returned HTTP ${response.status}.`);
  }

  let payload: unknown[];
  try {
    payload = await readGitHubJsonArray(
      response,
      signal,
      token,
      "GitHub related pull request response",
      "GitHub related pull request response could not be read",
    );
  } catch {
    return (
      abortedRelatedPullRequest(options.signal, timeoutSignal) ??
      unavailableRelatedPullRequest("The GitHub related pull request response was invalid.")
    );
  }

  if (payload.length === 0) return { status: "none" };

  try {
    return {
      status: "found",
      pullRequest: relatedPullRequestDetailsFromPayload(repository, currentBranch, payload[0]),
    };
  } catch {
    return unavailableRelatedPullRequest("The GitHub related pull request response was invalid.");
  }
}

export async function lookupRelatedPullRequest(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  options: RelatedPullRequestLookupOptions = {},
): Promise<RelatedPullRequest> {
  const timeoutMs = options.timeoutMs ?? GITHUB_RELATED_PR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return unavailableRelatedPullRequest("Related pull request lookup timeout is invalid.");
  }
  if (options.signal?.aborted) {
    return unavailableRelatedPullRequest("Related pull request lookup was cancelled.");
  }

  // AbortSignal.timeout() uses an unref'ed timer, which can let Node exit while fetch is still pending.
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(timeoutController.abort.bind(timeoutController), timeoutMs);
  const timeoutSignal = timeoutController.signal;
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  try {
    return await lookupRelatedPullRequestWithSignal(pi, ctx, options, signal, timeoutSignal);
  } finally {
    clearTimeout(timeoutHandle);
  }
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

  const fetchImpl = requireFetchImplementation(options.fetchImpl ?? globalThis.fetch);
  const branchLabel = redactSecrets(branchName);
  const url = `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/branches/${encodePathSegment(branchName)}`;
  const response = await fetchGitHubResponse(
    fetchImpl,
    url,
    { method: "GET", headers: gitHubJsonHeaders(token), signal: options.signal },
    `GitHub branch preflight request failed for ${field} '${branchLabel}'`,
    token,
  );

  if (!response.ok) {
    return throwGitHubBranchPreflightHttpError(response, options.signal, token, repository, field, branchLabel);
  }

  return readGitHubBranchDetails(response, options.signal, token, branchName, field, branchLabel);
}

export async function createGitHubPullRequest(
  repository: GitHubRepository,
  input: PullRequestInput,
  token: string,
  options: PullRequestFetchOptions = {},
): Promise<PullRequestDetails> {
  validateGitHubRepository(repository);
  validatePullRequestInput(input);

  const fetchImpl = requireFetchImplementation(options.fetchImpl ?? globalThis.fetch);
  const url = `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/pulls`;
  const requestBody = pullRequestRequestBody(input);
  const response = await fetchGitHubResponse(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: gitHubJsonHeaders(token),
      body: JSON.stringify(requestBody),
      signal: options.signal,
    },
    "GitHub pull request request failed",
    token,
  );

  if (!response.ok) return throwGitHubPullRequestHttpError(response, options.signal, token);

  const payload = await readPullRequestPayload(response, options.signal, token);
  return pullRequestDetailsFromPayload(repository, input, payload);
}
