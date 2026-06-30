import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  MAX_SUMMARY_OUTPUT_CHARS,
} from "./constants.ts";
import { getGitRoot, getOriginUrl, type GitCommandContext } from "./git.ts";
import type { GitHubRepository, PullRequestDetails, PullRequestInput } from "./types.ts";

export interface TokenResolution {
  token: string;
  source: "GITHUB_TOKEN" | "GH_TOKEN";
}

export interface PullRequestFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function normalizeRepository(owner: string, repo: string): GitHubRepository | null {
  const normalizedOwner = owner.trim();
  const normalizedRepo = stripGitSuffix(repo.trim());
  if (!normalizedOwner || !normalizedRepo) return null;
  if (/[\s\\]/u.test(normalizedOwner) || /[\s\\]/u.test(normalizedRepo)) return null;
  if (normalizedOwner === "." || normalizedOwner === "..") return null;
  if (normalizedRepo === "." || normalizedRepo === "..") return null;
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

export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): TokenResolution {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) return { token: githubToken, source: "GITHUB_TOKEN" };

  const ghToken = env.GH_TOKEN?.trim();
  if (ghToken) return { token: ghToken, source: "GH_TOKEN" };

  throw new Error("GitHub token is required. Set GITHUB_TOKEN or GH_TOKEN in the process environment.");
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

export function redactSecrets(value: string, tokens: readonly string[] = []): string {
  let redacted = value;
  for (const token of tokens) {
    if (!token) continue;
    redacted = redacted.split(token).join("[REDACTED]");
  }

  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
  redacted = redacted.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/gu, "[REDACTED]");
  redacted = redacted.replace(/github_pat_[A-Za-z0-9_]+/giu, "[REDACTED]");
  redacted = redacted.replace(
    /\b(token|access_token|authorization|github_token|gh_token)(["'\s:=]+)([^\s"',}]+)/giu,
    (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
  );
  return redacted;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/giu, "/");
}

function validatePullRequestInput(input: PullRequestInput): void {
  if (!input.headBranch.trim()) throw new Error("headBranch is required.");
  if (!input.baseBranch.trim()) throw new Error("baseBranch is required.");
  if (!input.title.trim()) throw new Error("title is required.");
  if (typeof input.body !== "string") throw new Error("body must be a string.");
  if (typeof input.draft !== "boolean") throw new Error("draft must be a boolean.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`GitHub response is missing ${field}.`);
  return value;
}

export async function createGitHubPullRequest(
  repository: GitHubRepository,
  input: PullRequestInput,
  token: string,
  options: PullRequestFetchOptions = {},
): Promise<PullRequestDetails> {
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
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": GITHUB_USER_AGENT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub pull request request failed: ${redactSecrets(message, [token])}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub pull request request failed with HTTP ${response.status}: ${redactSecrets(truncate(body), [token])}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub pull request response was not valid JSON: ${redactSecrets(message, [token])}`);
  }

  if (!isRecord(payload)) throw new Error("GitHub pull request response was not an object.");
  if (typeof payload.number !== "number") throw new Error("GitHub response is missing pull request number.");

  const head = isRecord(payload.head) ? stringField(payload.head.ref, "head.ref") : input.headBranch;
  const base = isRecord(payload.base) ? stringField(payload.base.ref, "base.ref") : input.baseBranch;
  const draft = typeof payload.draft === "boolean" ? payload.draft : input.draft;

  return {
    repository,
    number: payload.number,
    url: stringField(payload.html_url, "html_url"),
    state: stringField(payload.state, "state"),
    head,
    base,
    draft,
  };
}
