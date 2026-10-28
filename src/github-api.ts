import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGitRoot } from "./git.ts";
import { gitHubJsonHeaders, readBoundedResponseText, resolveGitHubRepository, resolveGitHubToken, type PullRequestFetchOptions } from "./github.ts";
import { boundedGitText } from "./git-read.ts";
import type { GitHubRepository } from "./types.ts";
import type { BranchMeToolOptions } from "./tools/branchme-tools.ts";
export interface GitHubClient { repository: GitHubRepository; token: string; fetchImpl: typeof fetch; signal?: AbortSignal }
export async function openGitHubClient(pi: Pick<ExtensionAPI, "exec">, ctx: { cwd: string }, options: BranchMeToolOptions, signal?: AbortSignal): Promise<GitHubClient> {
  signal?.throwIfAborted();
  const cwd = await getGitRoot(pi, ctx, signal);
  const repository = await resolveGitHubRepository(pi, { cwd }, signal, options.env);
  const token = (await resolveGitHubToken(options.env, { cwd, signal })).token;
  return { repository, token, signal, fetchImpl: options.fetchImpl ?? globalThis.fetch };
}
export function clientOptions(client: GitHubClient): PullRequestFetchOptions { return { fetchImpl: client.fetchImpl, signal: client.signal }; }
export function apiPath(client: GitHubClient, suffix: string): string { return `/repos/${encodeURIComponent(client.repository.owner)}/${encodeURIComponent(client.repository.repo)}${suffix}`; }
export async function githubRequest(client: GitHubClient, path: string, method = "GET", body?: unknown): Promise<unknown> {
  client.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(10000);
  const signal = client.signal ? AbortSignal.any([client.signal, deadline]) : deadline;
  try {
    const response = await client.fetchImpl(`https://api.github.com${path}`, { method, headers: gitHubJsonHeaders(client.token), redirect: "error", signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await readBoundedResponseText(response, signal);
    if (result.truncated) throw new Error("GitHub response exceeded the 64 KiB safety limit.");
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}; request refused or unavailable.`);
    return JSON.parse(result.text) as unknown;
  } catch (error) {
    if (client.signal?.aborted) throw error;
    throw new Error(boundedGitText(String(error), [client.token], 2000).text);
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed GitHub object.");
  return value as Record<string, unknown>;
}
export function positiveNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Invalid GitHub numeric identity.");
  return Number(value);
}
