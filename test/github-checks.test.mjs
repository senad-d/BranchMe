import assert from "node:assert/strict";
import test from "node:test";
import { getPullRequestChecks } from "../src/github-checks.ts";
import { checkRun, githubFixture, json } from "./helpers/github-fixture.mjs";

test("PR checks distinguish all run and legacy states, no checks, unknown permissions and changed heads", async () => {
  const f = githubFixture();
  f.runs = [checkRun(1), checkRun(2, "queued", null), checkRun(3, "in_progress", null), checkRun(4, "completed", "failure"), checkRun(5, "completed", "cancelled"), checkRun(6, "completed", "neutral"), checkRun(7, "completed", "skipped")];
  f.statuses = [{ id: 10, context: "legacy", state: "pending", target_url: "https://example.invalid/check" }];
  const result = await getPullRequestChecks(f.client, { number: 7 });
  assert.equal(result.runs.entries.length, 7);
  assert.equal(result.statuses.entries[0].state, "pending");
  assert.notEqual(result.verdict, "passed");
  f.runs = [checkRun(1)]; f.statuses = [];
  assert.equal((await getPullRequestChecks(f.client, { number: 7 })).verdict, "passed");
  f.runs = []; f.rollup = null;
  assert.equal((await getPullRequestChecks(f.client, { number: 7 })).verdict, "no-checks");
  f.onRequest = (url) => url.includes("/check-runs?") ? json({}, 403) : undefined;
  const unavailable = await getPullRequestChecks(f.client, { number: 7 });
  assert.equal(unavailable.verdict, "unknown"); assert.equal(unavailable.complete, false);
  f.onRequest = (url, _init, state) => { if (url.includes("/status?")) state.pr.head.sha = "d".repeat(40); };
  assert.equal((await getPullRequestChecks(f.client, { number: 7 })).headChanged, true);
});

test("PR checks paginate pinned heads and never turn a partial page or absent policy into blanket success", async () => {
  const f = githubFixture();
  f.runs = Array.from({ length: 28 }, (_unused, index) => checkRun(index + 1));
  const first = await getPullRequestChecks(f.client, { number: 7 });
  assert.equal(first.complete, false); assert.notEqual(first.verdict, "passed");
  const rest = await getPullRequestChecks(f.client, { number: 7, after: first.next });
  assert.equal(rest.runs.entries.length, 3); assert.equal(rest.complete, true); assert.notEqual(rest.verdict, "passed");
  f.pr.head.sha = "d".repeat(40);
  await assert.rejects(getPullRequestChecks(f.client, { number: 7, after: first.next }), /stale/u);
  f.runs = [checkRun(1)];
  f.onRequest = (url) => url.endsWith("/graphql") ? json({ errors: [{ message: "private-github-test-token" }] }) : undefined;
  const unknown = await getPullRequestChecks(f.client, { number: 7 });
  assert.equal(unknown.policy.available, false); assert.notEqual(unknown.verdict, "passed");
  assert.doesNotMatch(JSON.stringify(unknown), /private-github-test-token/u);
});
