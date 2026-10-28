import assert from "node:assert/strict";
import test from "node:test";
import { editPullRequest, mergePullRequest } from "../src/github-lifecycle.ts";
import { BASE, HEAD, MERGE, githubFixture, json } from "./helpers/github-fixture.mjs";

test("PR edits preserve omitted fields, deliberately clear bodies, change draft and reconcile lost mutation responses", async () => {
  const f = githubFixture();
  await editPullRequest(f.client, { number: 7, title: "Updated" });
  assert.equal(f.pr.body, "Original body"); assert.equal(f.pr.title, "Updated");
  await editPullRequest(f.client, { number: 7, body: "", draft: true });
  assert.equal(f.pr.body, ""); assert.equal(f.pr.draft, true);
  f.onRequest = (_url, init, state) => { if (init.method === "PATCH") { state.pr.title = JSON.parse(init.body).title; throw new Error("response lost"); } };
  assert.equal((await editPullRequest(f.client, { number: 7, title: "Reconciled" })).reconciledAfterUncertainResponse, true);
  await assert.rejects(editPullRequest(f.client, { number: 7 }));
  await assert.rejects(editPullRequest(f.client, { number: 7, body: f.client.token }));
});

test("host merging uses only the expected-head lease and selected method, verifies exact identities, and never cleans up", async () => {
  const f = githubFixture();
  const result = await mergePullRequest(f.client, { number: 7, expectedHead: HEAD, mergeMethod: "squash" });
  assert.equal(result.pullRequest.headSha, HEAD); assert.equal(result.pullRequest.baseSha, BASE); assert.equal(result.pullRequest.mergeCommitSha, MERGE);
  assert.equal(result.cleanupPerformed, false);
  const request = f.requests.find((item) => item.method === "PUT");
  assert.deepEqual(request.body, { sha: HEAD, merge_method: "squash" });
  const count = f.requests.filter((item) => item.method === "PUT").length;
  assert.equal((await mergePullRequest(f.client, { number: 7, expectedHead: HEAD, mergeMethod: "merge" })).outcome, "already-merged");
  assert.equal(f.requests.filter((item) => item.method === "PUT").length, count);
});

test("host merge refuses changed heads, blocked/unknown policy, draft PRs and disabled methods before writing", async () => {
  for (const scenario of ["head", "blocked", "unknown", "draft", "method"]) {
    const f = githubFixture();
    if (scenario === "head") f.pr.head.sha = "d".repeat(40);
    if (scenario === "blocked") f.mergeState = "BLOCKED";
    if (scenario === "unknown") f.onRequest = (url) => url.endsWith("/graphql") ? json({ errors: [{}] }) : undefined;
    if (scenario === "draft") f.pr.draft = true;
    if (scenario === "method") f.onRequest = (url) => url.endsWith("/repos/owner/repo") ? json({ allow_squash_merge: false }) : undefined;
    await assert.rejects(mergePullRequest(f.client, { number: 7, expectedHead: HEAD, mergeMethod: "squash" }));
    assert.equal(f.requests.some((item) => item.method === "PUT"), false);
  }
});

test("ambiguous merge responses are reconciled by reading status, with no second merge request", async () => {
  const f = githubFixture();
  f.onRequest = (url, init, state) => {
    if (url.endsWith("/merge")) {
      state.pr.merged = true; state.pr.state = "closed"; state.pr.merged_at = "2026-10-23T10:00:00Z"; state.pr.merge_commit_sha = MERGE;
      throw new Error("response lost private-github-test-token");
    }
  };
  const result = await mergePullRequest(f.client, { number: 7, expectedHead: HEAD, mergeMethod: "merge" });
  assert.equal(result.reconciledAfterUncertainResponse, true);
  assert.equal(f.requests.filter((item) => item.method === "PUT").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-github-test-token/u);
  const failed = githubFixture();
  failed.onRequest = (url) => url.endsWith("/merge") ? json({ merged: false }, 405) : undefined;
  await assert.rejects(mergePullRequest(failed.client, { number: 7, expectedHead: HEAD, mergeMethod: "merge" }), /not verified/u);
});
