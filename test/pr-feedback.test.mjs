import assert from "node:assert/strict";
import test from "node:test";
import { extractLogTail, formatPullRequestFeedback, getPullRequestFeedback } from "../src/github-feedback.ts";

const repository = { owner: "example", repo: "project" };
const token = "test-private-credential";

function comment(login, body) {
  return { author: { login }, body, url: "https://github.com/example/project/pull/7#c" };
}

function graphql(overrides = {}) {
  return {
    data: { repository: { pullRequest: {
      number: 7, url: "https://github.com/example/project/pull/7", headRefOid: "a".repeat(40),
      reviewThreads: { totalCount: 3, nodes: [
        { isResolved: false, isOutdated: false, path: "src/app.ts", line: 12, comments: { nodes: [comment("alice", `Fix this ${token}`), comment("bob", "Agreed")] } },
        { isResolved: true, isOutdated: false, path: "src/done.ts", line: 1, comments: { nodes: [comment("alice", "resolved")] } },
        { isResolved: false, isOutdated: true, path: "src/old.ts", line: null, comments: { nodes: [comment("alice", "outdated")] } },
      ] },
      reviews: { nodes: [{ ...comment("carol", ""), state: "APPROVED" }, { ...comment("dave", ""), state: "CHANGES_REQUESTED" }, { ...comment("erin", "Add a test"), state: "COMMENTED" }] },
      comments: { totalCount: 51, nodes: [comment("sonar[bot]", "Quality gate failed"), comment("frank", "")] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 4, nodes: [
        { __typename: "CheckRun", name: "build", conclusion: "FAILURE", databaseId: 11, detailsUrl: "https://github.com/example/project/actions/runs/1/job/11" },
        { __typename: "CheckRun", name: "lint", conclusion: "TIMED_OUT", databaseId: 12, detailsUrl: "https://github.com/example/project/actions/runs/1/job/12" },
        { __typename: "CheckRun", name: "docs", conclusion: "SUCCESS", databaseId: 13, detailsUrl: "https://github.com/example/project/actions/runs/1/job/13" },
        { __typename: "StatusContext", context: "external/ci", state: "ERROR", targetUrl: "https://ci.example/1" },
      ] } } } }] },
      ...overrides,
    } } },
  };
}

const LOG = [
  "2026-10-10T19:50:15.0593961Z \u001b[32m✓\u001b[39m passing test",
  "2026-10-10T19:50:15.2215292Z \u001b[31mError: Test timed out in 30000ms.\u001b[39m",
  "2026-10-10T19:50:15.3594657Z ##[error]Process completed with exit code 1.",
  "2026-10-10T19:50:16.0000000Z Post job cleanup.",
].join("\n");

function fetchFor(payload, logStatus = { 11: 200, 12: 403 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith("/graphql")) return new Response(JSON.stringify(payload), { status: 200 });
    const job = Number(url.match(/jobs\/(\d+)\/logs$/u)?.[1]);
    return new Response(logStatus[job] === 200 ? LOG : "denied", { status: logStatus[job] ?? 404 });
  };
  return { calls, fetchImpl };
}

test("pull request feedback lists unresolved current threads, meaningful reviews and failing checks with log tails", async () => {
  const { calls, fetchImpl } = fetchFor(graphql());
  const feedback = await getPullRequestFeedback(repository, 7, token, { fetchImpl });

  assert.equal(feedback.unresolvedThreads.length, 1);
  assert.equal(feedback.unresolvedThreads[0].path, "src/app.ts");
  assert.equal(feedback.unresolvedThreads[0].comments[0].body, "Fix this [REDACTED]");
  assert.equal(feedback.resolvedThreadCount, 1);
  assert.equal(feedback.outdatedThreadCount, 1);
  assert.deepEqual(feedback.reviews.map((review) => review.author), ["dave", "erin"]);
  assert.deepEqual(feedback.comments.map((item) => item.author), ["sonar[bot]"]);
  assert.equal(feedback.omitted.comments, 49);
  assert.deepEqual(feedback.failingChecks.map((check) => check.name), ["build", "lint", "external/ci"]);
  assert.match(feedback.failingChecks[0].logTail, /Test timed out in 30000ms\.\n##\[error\]Process completed/u);
  assert.doesNotMatch(feedback.failingChecks[0].logTail, /Post job cleanup|\u001b|2026-10-10T/u);
  assert.equal(feedback.failingChecks[1].logError, "job log returned HTTP 403");
  assert.equal(feedback.failingChecks[2].jobId, null);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET", "GET"]);

  const text = formatPullRequestFeedback(feedback);
  assert.match(text, /Unresolved review threads: 1 \(1 resolved and 1 outdated not listed\)/u);
  assert.match(text, /- src\/app\.ts:12\n {2}@alice: Fix this \[REDACTED\]\n {2}@bob: Agreed/u);
  assert.match(text, /Log unavailable: job log returned HTTP 403/u);
  assert.doesNotMatch(text, new RegExp(token, "u"));
});

async function fetchGatedJobLogs(state, url) {
  if (url.endsWith("/graphql")) return new Response(JSON.stringify(state.payload), { status: 200 });
  const job = Number(url.match(/jobs\/(\d+)\/logs$/u)?.[1]);
  state.started.push(job);
  if (state.started.length === 3) state.gate.resolve();
  await state.gate.promise;
  state.concurrentCounts.push(state.started.length);
  return new Response(job === 12 ? "denied" : LOG, { status: job === 12 ? 403 : 200 });
}

test("feedback fetches at most three job logs concurrently while preserving check order and partial errors", async () => {
  const payload = graphql();
  payload.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [11, 12, 13, 14].map((job) => ({
    __typename: "CheckRun", name: `job-${job}`, conclusion: "FAILURE", databaseId: job,
    detailsUrl: `https://github.com/example/project/actions/runs/1/job/${job}`,
  }));
  const state = { payload, gate: Promise.withResolvers(), started: [], concurrentCounts: [] };
  const timer = setTimeout(state.gate.resolve, 1000);
  try {
    const feedback = await getPullRequestFeedback(repository, 7, token, { fetchImpl: fetchGatedJobLogs.bind(null, state) });
    assert.deepEqual(state.started, [11, 12, 13]);
    assert.deepEqual(state.concurrentCounts, [3, 3, 3]);
    assert.deepEqual(feedback.failingChecks.map((check) => check.jobId), [11, 12, 13, 14]);
    assert.match(feedback.failingChecks[0].logTail, /Test timed out/u);
    assert.equal(feedback.failingChecks[1].logError, "job log returned HTTP 403");
    assert.match(feedback.failingChecks[2].logTail, /Test timed out/u);
    assert.equal(feedback.failingChecks[3].logTail, undefined);
  } finally {
    clearTimeout(timer);
  }
});

test("feedback formatting preserves omitted-count notices", async () => {
  const payload = graphql();
  payload.data.repository.pullRequest.reviewThreads.totalCount = 103;
  payload.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.totalCount = 105;
  const feedback = await getPullRequestFeedback(repository, 7, token, fetchFor(payload));
  const text = formatPullRequestFeedback(feedback);
  assert.match(text, /; 100 beyond the first 100 not read/u);
  assert.match(text, /Conversation comments: 1 \(latest 50; 49 older not read\)\./u);
  assert.match(text, /Failing checks: 3 \(101 checks beyond the first 100 not read\)\./u);
});

test("pull request feedback fails on GraphQL errors and missing pull requests", async () => {
  await assert.rejects(
    getPullRequestFeedback(repository, 7, token, fetchFor({ errors: [{ message: "Resource not accessible by integration" }] })),
    /feedback query failed: Resource not accessible by integration/u,
  );
  await assert.rejects(
    getPullRequestFeedback(repository, 7, token, fetchFor({ data: { repository: { pullRequest: null } } })),
    /Pull request #7 was not found/u,
  );
  await assert.rejects(getPullRequestFeedback(repository, 7, token, fetchFor(graphql({ number: 8 }))), /different pull request number/u);
});

test("log tail without an error annotation keeps the end of the log", () => {
  const log = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
  const tail = extractLogTail(log, token);
  assert.match(tail, /^line 40\n/u);
  assert.match(tail, /line 99$/u);
});
