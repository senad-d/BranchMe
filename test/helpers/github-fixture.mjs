export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const MERGE = "c".repeat(40);
export function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
export function prPayload() {
  const repo = { name: "repo", full_name: "owner/repo", owner: { login: "owner" } };
  return { number: 7, node_id: "PR_test", title: "Original", body: "Original body", html_url: "https://github.com/owner/repo/pull/7", state: "open", merged: false, draft: false, merged_at: null, merge_commit_sha: null, head: { ref: "feature", sha: HEAD, repo }, base: { ref: "main", sha: BASE, repo } };
}
function policyPayload(f) { return { data: { repository: { pullRequest: { headRefOid: f.pr.head.sha, baseRefOid: f.pr.base.sha, mergeable: "MERGEABLE", mergeStateStatus: f.mergeState, reviewDecision: f.reviewDecision, commits: { nodes: [{ commit: { statusCheckRollup: f.rollup === null ? null : { state: f.rollup } } }] } } } } }; }
async function dispatch(f, url, init) {
  f.requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
  const override = await f.onRequest?.(url, init, f);
  if (override !== undefined) return override;
  if (url.endsWith("/graphql")) {
    const body = JSON.parse(init.body);
    if (body.query.startsWith("query")) return json(policyPayload(f));
    f.pr.draft = body.query.includes("convertPullRequestToDraft");
    return json({ data: { updated: { pullRequest: { id: "PR_test", isDraft: f.pr.draft } } } });
  }
  if (url.includes("/check-runs?")) return json({ total_count: f.runs.length, check_runs: f.runs.slice((Number(new URL(url).searchParams.get("page")) - 1) * 25, Number(new URL(url).searchParams.get("page")) * 25) });
  if (url.includes("/status?")) return json({ total_count: f.statuses.length, statuses: f.statuses.slice((Number(new URL(url).searchParams.get("page")) - 1) * 25, Number(new URL(url).searchParams.get("page")) * 25) });
  if (url.endsWith("/pulls/7/merge")) {
    f.pr.merged = true; f.pr.state = "closed"; f.pr.merged_at = "2026-10-23T10:00:00Z"; f.pr.merge_commit_sha = MERGE;
    return json({ merged: true, sha: MERGE, message: "Merged" });
  }
  if (url.endsWith("/pulls/7")) {
    if (init.method === "PATCH") Object.assign(f.pr, JSON.parse(init.body));
    return json(f.pr);
  }
  if (url.endsWith("/repos/owner/repo")) return json({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true });
  throw new Error(`Unexpected mock GitHub request ${init.method} ${url}`);
}
export function githubFixture() {
  const f = { pr: prPayload(), mergeState: "CLEAN", reviewDecision: "APPROVED", rollup: "SUCCESS", runs: [], statuses: [], requests: [], onRequest: undefined };
  f.client = { repository: { owner: "owner", repo: "repo" }, token: "private-github-test-token", fetchImpl: dispatch.bind(undefined, f) };
  return f;
}
export function checkRun(id, status = "completed", conclusion = "success") { return { id, app: { id: 1 }, name: `check-${id}`, status, conclusion, html_url: `https://github.com/owner/repo/runs/${id}` }; }
