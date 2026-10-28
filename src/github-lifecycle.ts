import { getGitHubPullRequest } from "./github.ts";
import { apiPath, clientOptions, githubRequest, positiveNumber, record, type GitHubClient } from "./github-api.ts";
import { getPullRequestPolicy } from "./github-checks.ts";
import { boundedGitText, errorText, OBJECT_ID, safeGitText, validateKeys } from "./git-read.ts";

export interface EditPullRequestInput { number: number; title?: string; body?: string; draft?: boolean }
export interface MergePullRequestInput { number: number; expectedHead: string; mergeMethod: "merge" | "squash" | "rebase" }
async function rawPullRequest(client: GitHubClient, number: number) {
  const value = record(await githubRequest(client, apiPath(client, `/pulls/${number}`)));
  if (value.number !== number || typeof value.title !== "string" || (value.body !== null && typeof value.body !== "string") || typeof value.draft !== "boolean" || typeof value.node_id !== "string" || !value.node_id || value.node_id.length > 256) throw new Error("PR metadata response is incomplete.");
  return { title: value.title, body: value.body ?? "", draft: value.draft, id: value.node_id, head: record(value.head).sha, base: record(value.base).ref };
}
function metadataMatches(actual: Awaited<ReturnType<typeof rawPullRequest>>, original: Awaited<ReturnType<typeof rawPullRequest>>, input: EditPullRequestInput): boolean {
  return actual.title === (input.title ?? original.title) && actual.body === (input.body ?? original.body) && actual.draft === (input.draft ?? original.draft) && actual.head === original.head && actual.base === original.base;
}
function validateEditInput(client: GitHubClient, input: EditPullRequestInput): void {
  validateKeys(input, ["number", "title", "body", "draft"]); positiveNumber(input.number);
  if (input.title === undefined && input.body === undefined && input.draft === undefined) throw new TypeError("Supply at least one explicit title, body, or draft change.");
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 512)) throw new TypeError("title must be a nonempty bounded string.");
  if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > 60000)) throw new TypeError("body must be a bounded string; an empty string deliberately clears it.");
  if (input.draft !== undefined && typeof input.draft !== "boolean") throw new TypeError("draft must be boolean.");
  for (const value of [input.title, input.body]) if (value !== undefined && safeGitText(value, [client.token]) !== value) throw new Error("PR metadata must not contain credentials or unsafe control characters.");
}
export async function editPullRequest(client: GitHubClient, input: EditPullRequestInput) {
  validateEditInput(client, input);
  const before = await getGitHubPullRequest(client.repository, input.number, client.token, clientOptions(client));
  if (before.state !== "open" || before.merged) throw new Error("Only an open PR can be edited.");
  const original = await rawPullRequest(client, input.number);
  if (original.head !== before.headSha || original.base !== before.base) throw new Error("PR changed during preparation; inspect pull_request_status.");
  let attempted = false;
  try {
    client.signal?.throwIfAborted();
    if (input.title !== undefined || input.body !== undefined) {
      attempted = true;
      await githubRequest(client, apiPath(client, `/pulls/${input.number}`), "PATCH", { ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { body: input.body }) });
    }
    if (input.draft !== undefined && original.draft !== input.draft) {
      attempted = true;
      await updateDraft(client, original.id, input.draft);
    }
    const final = { ...client, signal: undefined };
    const after = await rawPullRequest(final, input.number);
    const status = await getGitHubPullRequest(final.repository, input.number, final.token, clientOptions(final));
    requireEditedMetadata(after, original, input, status, before.headSha);
    return { action: "edit_pull_request", number: input.number, verified: true, changedFields: editedFields(input), head: status.headSha, url: status.url };
  } catch (error) {
    if (!attempted) throw error;
    const reconciled = await reconcileEdit(client, input, original, before.headSha);
    if (reconciled) return reconciled;
    throw new Error(`PR metadata may be partially updated; inspect the PR before retrying. No automatic rollback/retry occurred. ${boundedGitText(String(error), [client.token], 1000).text}`);
  }
}
function editedFields(input: EditPullRequestInput): string[] {
  return ["title", "body", "draft"].filter((key) => input[key as keyof EditPullRequestInput] !== undefined);
}
function requireEditedMetadata(after: Awaited<ReturnType<typeof rawPullRequest>>, original: Awaited<ReturnType<typeof rawPullRequest>>, input: EditPullRequestInput, status: Awaited<ReturnType<typeof getGitHubPullRequest>>, head: string): void {
  if (!metadataMatches(after, original, input) || status.state !== "open" || status.merged || status.headSha !== head) throw new Error("PR metadata postconditions did not match.");
}
async function updateDraft(client: GitHubClient, id: string, draft: boolean): Promise<void> {
  const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  const response = record(await githubRequest(client, "/graphql", "POST", { query: `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`, variables: { id } }));
  if (response.errors) throw new Error("Draft-state update was not confirmed.");
}
async function reconcileEdit(client: GitHubClient, input: EditPullRequestInput, original: Awaited<ReturnType<typeof rawPullRequest>>, head: string) {
  try {
    const final = { ...client, signal: undefined };
    const after = await rawPullRequest(final, input.number);
    const status = await getGitHubPullRequest(final.repository, input.number, final.token, clientOptions(final));
    if (metadataMatches(after, original, input) && status.state === "open" && !status.merged && status.headSha === head) return { action: "edit_pull_request", number: input.number, verified: true, reconciledAfterUncertainResponse: true, head: status.headSha, url: status.url };
  } catch { /* Preserve the uncertain mutation outcome in the caller. */ }
  return null;
}
function requireMergePolicy(policy: Awaited<ReturnType<typeof getPullRequestPolicy>>, before: Awaited<ReturnType<typeof getGitHubPullRequest>>): void {
  if (!policy.available || policy.head !== before.headSha || policy.base !== before.baseSha || policy.mergeable !== "MERGEABLE" || policy.mergeState !== "CLEAN" || (policy.reviewDecision !== null && policy.reviewDecision !== "APPROVED") || (policy.rollup !== null && policy.rollup !== "SUCCESS")) throw new Error("Host readiness is blocked, unknown, or stale; inspect pull_request_checks. No merge/bypass was attempted.");
}
export async function mergePullRequest(client: GitHubClient, input: MergePullRequestInput) {
  validateKeys(input, ["number", "expectedHead", "mergeMethod"]); positiveNumber(input.number);
  if (typeof input.expectedHead !== "string" || !OBJECT_ID.test(input.expectedHead) || !["merge", "squash", "rebase"].includes(input.mergeMethod)) throw new TypeError("Require expectedHead and an explicit supported merge method.");
  const before = await getGitHubPullRequest(client.repository, input.number, client.token, clientOptions(client));
  if (before.headSha !== input.expectedHead) throw new Error("PR head changed; inspect pull_request_status before authorizing a merge.");
  if (before.merged) return { action: "merge_pull_request", outcome: "already-merged", pullRequest: before, cleanupPerformed: false };
  if (before.state !== "open" || before.draft) throw new Error("Only an open non-draft PR can be merged.");
  const policy = await getPullRequestPolicy(client, input.number);
  requireMergePolicy(policy, before);
  const repo = record(await githubRequest(client, apiPath(client, "")));
  const setting = { merge: "allow_merge_commit", squash: "allow_squash_merge", rebase: "allow_rebase_merge" }[input.mergeMethod];
  if (repo[setting] !== true) throw new Error("The repository does not explicitly allow the selected merge method.");
  const immediate = await getGitHubPullRequest(client.repository, input.number, client.token, clientOptions(client));
  if (immediate.headSha !== before.headSha || immediate.base !== before.base || immediate.baseSha !== before.baseSha || immediate.state !== "open" || immediate.draft) throw new Error("PR head/base/state changed during preparation; no merge was attempted.");
  client.signal?.throwIfAborted();
  let reported: string | null = null;
  let failure: unknown;
  try {
    const result = record(await githubRequest(client, apiPath(client, `/pulls/${input.number}/merge`), "PUT", { sha: input.expectedHead, merge_method: input.mergeMethod }));
    if (result.merged !== true || typeof result.sha !== "string" || !OBJECT_ID.test(result.sha)) throw new Error("Host did not confirm the requested merge.");
    reported = result.sha;
  } catch (error) { failure = error; }
  try {
    const final = { ...client, signal: undefined };
    const after = await getGitHubPullRequest(final.repository, input.number, final.token, clientOptions(final));
    if (!after.merged || after.headSha !== before.headSha || after.base !== before.base || (reported !== null && after.mergeCommitSha !== reported)) throw new Error("Exact merged identities were not verified.");
    return { action: "merge_pull_request", outcome: "merged", mergeMethod: input.mergeMethod, reconciledAfterUncertainResponse: Boolean(failure), pullRequest: after, cleanupPerformed: false, note: "Host merge verified; local cleanup requires a separate land_branch call. GitHub enforces protections. The merge API leases HEAD but has no atomic base-SHA lease." };
  } catch {
    throw new Error(`Merge outcome was not verified; inspect pull_request_status before retrying. No local merge, cleanup, or remote branch deletion occurred. ${failure ? boundedGitText(errorText(failure), [client.token], 1000).text : ""}`);
  }
}
