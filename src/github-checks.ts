import { getGitHubPullRequest } from "./github.ts";
import { apiPath, clientOptions, githubRequest, positiveNumber, record, type GitHubClient } from "./github-api.ts";
import { boundedGitText, decodeReadCursor, encodeReadCursor, fingerprint, OBJECT_ID } from "./git-read.ts";

export interface PullRequestChecksInput { number: number; after?: string }
export interface PullRequestPolicy { available: boolean; head: string | null; base: string | null; mergeable: string | null; mergeState: string | null; reviewDecision: string | null; rollup: string | null; reason?: string }
interface CheckEntry { source: string; key: string; id: number; name: string; state: string; conclusion: string | null; url: string }
function safe(value: unknown, client: GitHubClient, max = 256): string { return boundedGitText(typeof value === "string" ? value : "", [client.token], max, 1).text; }
const POLICY_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefOid mergeable mergeStateStatus reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}`;
export async function getPullRequestPolicy(client: GitHubClient, number: number): Promise<PullRequestPolicy> {
  try {
    const response = record(await githubRequest(client, "/graphql", "POST", { query: POLICY_QUERY, variables: { owner: client.repository.owner, repo: client.repository.repo, number } }));
    if (response.errors) throw new Error("GitHub did not expose complete PR readiness information.");
    const pr = record(record(record(response.data).repository).pullRequest);
    if (typeof pr.headRefOid !== "string" || typeof pr.baseRefOid !== "string" || !OBJECT_ID.test(pr.headRefOid) || !OBJECT_ID.test(pr.baseRefOid)) throw new Error("Missing PR readiness identities.");
    const nodes = record(pr.commits).nodes;
    if (!Array.isArray(nodes) || nodes.length !== 1) throw new Error("Missing head check rollup.");
    const rollup = record(nodes[0]).commit;
    const status = record(rollup).statusCheckRollup;
    const review = pr.reviewDecision;
    if (!([null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as unknown[]).includes(review)) throw new Error("Unknown review decision.");
    if (!["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(String(pr.mergeable)) || !["CLEAN", "BLOCKED", "BEHIND", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"].includes(String(pr.mergeStateStatus))) throw new Error("Unknown merge readiness state.");
    const state = status === null ? null : record(status).state;
    if (state !== null && (typeof state !== "string" || !["SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED"].includes(state))) throw new Error("Unknown head rollup state.");
    return { available: true, head: pr.headRefOid, base: pr.baseRefOid, mergeable: String(pr.mergeable), mergeState: String(pr.mergeStateStatus), reviewDecision: review as string | null, rollup: state as string | null };
  } catch (error) {
    if (client.signal?.aborted) throw error;
    return { available: false, head: null, base: null, mergeable: null, mergeState: null, reviewDecision: null, rollup: null, reason: safe(String(error), client) };
  }
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Missing check completeness count.");
  return Number(value);
}
async function checkPage(client: GitHubClient, head: string, page: number, source: "runs" | "statuses") {
  try {
    const suffix = source === "runs" ? `/commits/${head}/check-runs?filter=latest&per_page=25&page=${page}` : `/commits/${head}/status?per_page=25&page=${page}`;
    const result = record(await githubRequest(client, apiPath(client, suffix)));
    const rows = source === "runs" ? result.check_runs : result.statuses;
    if (!Array.isArray(rows) || rows.length > 25) throw new Error("Malformed check page.");
    const entries = new Map<string, CheckEntry>();
    for (const row of rows) {
      const entry = parseCheckEntry(client, source, row);
      if (!entries.has(entry.key) || entries.get(entry.key)!.id < entry.id) entries.set(entry.key, entry);
    }
    return { available: true, total: count(result.total_count), entries: [...entries.values()], error: null };
  } catch (error) {
    if (client.signal?.aborted) throw error;
    return { available: false, total: null, entries: [], error: safe(String(error), client) };
  }
}
function parseCheckEntry(client: GitHubClient, source: "runs" | "statuses", row: unknown): CheckEntry {
  const item = record(row);
  const id = positiveNumber(item.id);
  const rawName = source === "runs" ? item.name : item.context;
  if (typeof rawName !== "string" || !rawName) throw new Error("Check context missing.");
  const app = source === "runs" ? positiveNumber(record(item.app).id) : "legacy";
  const key = fingerprint(JSON.stringify([source, app, rawName]));
  const state = source === "runs" ? item.status : item.state;
  const conclusion = source === "runs" ? item.conclusion : item.state;
  if (typeof state !== "string" || (conclusion !== null && typeof conclusion !== "string")) throw new Error("Check state missing.");
  return { source, key, id, name: safe(rawName, client, 128), state: safe(state, client, 64), conclusion: conclusion === null ? null : safe(conclusion, client, 64), url: safe(item.html_url ?? item.target_url, client) };
}
function checkVerdict(unavailable: boolean, entryCount: number, page: number, complete: boolean, passed: boolean): string {
  if (unavailable) return "unknown";
  if (!entryCount && page === 1 && complete) return "no-checks";
  if (complete && page === 1 && passed) return "passed";
  return "inspect-states";
}
export async function getPullRequestChecks(client: GitHubClient, input: PullRequestChecksInput) {
  positiveNumber(input.number);
  const pr = await getGitHubPullRequest(client.repository, input.number, client.token, clientOptions(client));
  const binding = fingerprint(JSON.stringify([client.repository, input.number, pr.headSha]));
  let page = 1;
  if (input.after !== undefined) {
    const cursor = decodeReadCursor(input.after);
    if (cursor.length !== 3 || cursor[0] !== "checks1" || cursor[1] !== binding || !Number.isSafeInteger(cursor[2]) || Number(cursor[2]) < 2 || Number(cursor[2]) > 1000) throw new Error("PR checks continuation is stale or invalid; restart without after.");
    page = Number(cursor[2]);
  }
  const [runs, statuses, policy] = await Promise.all([checkPage(client, pr.headSha, page, "runs"), checkPage(client, pr.headSha, page, "statuses"), getPullRequestPolicy(client, input.number)]);
  const current = await getGitHubPullRequest(client.repository, input.number, client.token, clientOptions(client));
  const headChanged = current.headSha !== pr.headSha || current.baseSha !== pr.baseSha || (policy.available && (policy.head !== pr.headSha || policy.base !== pr.baseSha));
  const complete = !headChanged && runs.available && statuses.available && page * 25 >= Math.max(runs.total ?? Infinity, statuses.total ?? Infinity);
  const entries = [...runs.entries, ...statuses.entries];
  const allKnownGood = entries.every((entry) => entry.source === "runs" ? entry.state === "completed" && ["success", "neutral", "skipped"].includes(entry.conclusion ?? "") : entry.state === "success");
  const verdict = checkVerdict(headChanged || !runs.available || !statuses.available, entries.length, page, complete, allKnownGood && policy.available && policy.rollup === "SUCCESS");
  return { action: "pull_request_checks", number: pr.number, head: pr.headSha, base: pr.baseSha, headChanged, page, runs, statuses, policy, complete, verdict, policyScope: "Host readiness snapshot, not merge authorization. Required-context/ruleset details may be unavailable; no failing-check list is proof of approval.", next: !headChanged && runs.available && statuses.available && !complete && page < 1000 ? encodeReadCursor(["checks1", binding, page + 1]) : null };
}
