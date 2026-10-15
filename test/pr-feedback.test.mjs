import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLogTail, formatPullRequestFeedback, formatPullRequestFiles, formatPullRequestLabel, formatPullRequestReply, getPullRequestFeedback,
  getPullRequestFiles, labelPullRequest, replyPullRequestFeedback,
} from "../src/github-feedback.ts";

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
  assert.match(text, /- src\/app\.ts:12\n {2}@alice <https:\/\/github\.com\/example\/project\/pull\/7#c>: Fix this \[REDACTED\]\n {2}@bob <https:\/\/github\.com\/example\/project\/pull\/7#c>: Agreed/u);
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

test("feedback carries thread and comment ids, times, the token user and failing-check annotations", async () => {
  const payload = graphql({
    id: "PR_node7",
    reviewThreads: { totalCount: 1, nodes: [{
      id: "PRRT_thread1", isResolved: false, isOutdated: false, path: "src/app.ts", line: 12,
      comments: { nodes: [
        { ...comment("alice", "Rename this"), id: "PRRC_1", createdAt: "2026-10-14T10:00:00Z" },
        { ...comment("mission-bot", "Renamed in abc1234"), id: "PRRC_2", createdAt: "2026-10-14T11:00:00Z" },
      ] },
    }] },
    comments: { totalCount: 1, nodes: [{ ...comment("bob", "Why this approach?"), id: "IC_1", createdAt: "2026-10-14T12:00:00Z" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 1, nodes: [{
      __typename: "CheckRun", name: "lint", conclusion: "FAILURE", databaseId: 11, detailsUrl: "https://github.com/example/project/actions/runs/1/job/11",
      annotations: { nodes: [
        { path: "src/app.ts", location: { start: { line: 3 } }, annotationLevel: "FAILURE", message: `'x' is unused ${token}` },
        { path: "src/app.ts", location: { start: { line: 9 } }, annotationLevel: "NOTICE", message: "informational" },
      ] },
    }] } } } }] },
  });
  payload.data.viewer = { login: "mission-bot" };
  const feedback = await getPullRequestFeedback(repository, 7, token, fetchFor(payload));

  assert.equal(feedback.id, "PR_node7");
  assert.equal(feedback.viewer, "mission-bot");
  assert.equal(feedback.unresolvedThreads[0].id, "PRRT_thread1");
  assert.deepEqual(feedback.unresolvedThreads[0].comments.map((item) => item.byViewer), [false, true]);
  assert.equal(feedback.comments[0].createdAt, "2026-10-14T12:00:00Z");
  assert.deepEqual(feedback.failingChecks[0].annotations, [{ path: "src/app.ts", line: 3, level: "FAILURE", message: "'x' is unused [REDACTED]" }]);

  const text = formatPullRequestFeedback(feedback);
  assert.match(text, /Token user: @mission-bot; comments marked \(you\)/u);
  assert.match(text, /- \[thread PRRT_thread1\] src\/app\.ts:12\n {2}@alice 2026-10-14T10:00:00Z <https:\/\/github\.com\/example\/project\/pull\/7#c>: Rename this\n {2}@mission-bot \(you\) 2026-10-14T11:00:00Z <https:\/\/github\.com\/example\/project\/pull\/7#c>: Renamed/u);
  assert.match(text, /- \[comment IC_1\] @bob 2026-10-14T12:00:00Z <https:\/\/github\.com\/example\/project\/pull\/7#c>: Why this approach\?/u);
  assert.match(text, /- lint: FAILURE \S+\n {2}Annotations:\n {4}src\/app\.ts:3 FAILURE: 'x' is unused \[REDACTED\]\n {2}Log tail/u);
  assert.doesNotMatch(text, /informational|test-private-credential/u);
});

function replyFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, query: body?.query ?? "", variables: body?.variables ?? null, body: body?.body ?? null });
    const next = responses.shift();
    return new Response(JSON.stringify(next.payload), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
}

const threadOf = (number, isResolved = false) => ({ data: { node: { id: "PRRT_1", isResolved, pullRequest: { number, repository: { name: "project", owner: { login: "example" } } } } } });

test("a thread reply checks ownership, replies, then resolves", async () => {
  const { calls, fetchImpl } = replyFetch([
    { payload: threadOf(7) },
    { payload: { data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/example/project/pull/7#r1" } } } } },
    { payload: { data: { resolveReviewThread: { thread: { isResolved: true } } } } },
  ]);
  const details = await replyPullRequestFeedback(repository, { number: 7, threadId: "PRRT_1", body: " Renamed in abc1234. ", resolve: true }, token, { fetchImpl });
  assert.deepEqual(calls.map((call) => call.query.match(/node\(|addPullRequestReviewThreadReply|resolveReviewThread/u)?.[0]), ["node(", "addPullRequestReviewThreadReply", "resolveReviewThread"]);
  assert.equal(calls[1].variables.body, "Renamed in abc1234.");
  assert.equal(details.resolved, true);
  assert.equal(formatPullRequestReply(details), "Replied to thread PRRT_1 on PR #7; thread resolved: https://github.com/example/project/pull/7#r1");
});

test("reply formatting distinguishes unrequested, successful and unsuccessful resolution", () => {
  const details = {
    action: "reply_pull_request_feedback", repository, number: 7, threadId: "PRRT_1",
    commentUrl: "https://github.com/example/project/pull/7#r1",
  };
  for (const [resolved, suffix] of [[null, ""], [true, "; thread resolved"], [false, "; thread NOT resolved"]]) {
    assert.equal(
      formatPullRequestReply({ ...details, resolved }),
      `Replied to thread PRRT_1 on PR #7${suffix}: ${details.commentUrl}`,
    );
  }
});

test("a thread of another pull request is refused before anything is posted", async () => {
  const { calls, fetchImpl } = replyFetch([{ payload: threadOf(8) }]);
  await assert.rejects(
    replyPullRequestFeedback(repository, { number: 7, threadId: "PRRT_1", body: "Done", resolve: true }, token, { fetchImpl }),
    /PRRT_1 is not a thread of pull request #7 in example\/project; nothing was posted/u,
  );
  assert.equal(calls.length, 1);
});

test("a conversation comment confirms the pull request, then posts once", async () => {
  const { calls, fetchImpl } = replyFetch([
    { payload: { data: { repository: { pullRequest: { number: 7 } } } } },
    { status: 201, payload: { html_url: "https://github.com/example/project/pull/7#issuecomment-1" } },
  ]);
  const details = await replyPullRequestFeedback(repository, { number: 7, body: "Tracked in #12." }, token, { fetchImpl });
  assert.equal(calls[1].url, "https://api.github.com/repos/example/project/issues/7/comments");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body, "Tracked in #12.");
  assert.equal(details.resolved, null);
  assert.equal(formatPullRequestReply(details), "Commented on PR #7: https://github.com/example/project/pull/7#issuecomment-1");
});

test("reply input is validated before any request", async () => {
  const { calls, fetchImpl } = replyFetch([]);
  await assert.rejects(replyPullRequestFeedback(repository, { number: 7, body: "   " }, token, { fetchImpl }), /body is required/u);
  await assert.rejects(replyPullRequestFeedback(repository, { number: 7, body: "x".repeat(4001) }, token, { fetchImpl }), /exceeds 4000/u);
  await assert.rejects(replyPullRequestFeedback(repository, { number: 7, body: "ok", resolve: true }, token, { fetchImpl }), /resolve requires threadId/u);
  await assert.rejects(replyPullRequestFeedback(repository, { number: 7, body: "ok" }, token, { fetchImpl: replyFetch([{ payload: { data: { repository: { pullRequest: null } } } }]).fetchImpl }), /Pull request #7 was not found/u);
  assert.equal(calls.length, 0);
});

test("pull request files list paths, change types and labels", async () => {
  const { fetchImpl } = replyFetch([{ payload: { data: { repository: { pullRequest: {
    number: 7, labels: { nodes: [{ name: "bug" }] },
    files: { totalCount: 102, nodes: [{ path: "apps/api/src/main.ts", changeType: "MODIFIED", additions: 2, deletions: 1 }, { path: "apps/web/src/app.tsx", changeType: "ADDED", additions: 9, deletions: 0 }] },
  } } } } }]);
  const details = await getPullRequestFiles(repository, 7, token, { fetchImpl });
  assert.equal(details.omitted, 100);
  assert.equal(formatPullRequestFiles(details), "PR #7: 2 changed file(s); 100 more not listed. Labels: bug.\n- apps/api/src/main.ts (modified, +2 -1)\n- apps/web/src/app.tsx (added, +9 -0)");
});

test("labeling refuses an unknown label before changing the pull request, then adds existing ones", async () => {
  const exists = { payload: { data: { repository: { pullRequest: { number: 7 } } } } };
  const unknown = replyFetch([exists, { payload: { name: "bug" } }, { status: 404, payload: { message: "Not Found" } }]);
  await assert.rejects(labelPullRequest(repository, 7, ["bug", "area:nope"], token, { fetchImpl: unknown.fetchImpl }), /Label "area:nope" does not exist/u);
  assert.equal(unknown.calls.some((call) => call.method === "POST" && call.url.endsWith("/labels")), false);

  const ok = replyFetch([exists, { payload: { name: "bug" } }, { payload: { name: "area:backend" } }, { payload: [{ name: "bug" }, { name: "area:backend" }] }]);
  const details = await labelPullRequest(repository, 7, ["bug", "area:backend"], token, { fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls.at(-1).url, "https://api.github.com/repos/example/project/issues/7/labels");
  assert.equal(formatPullRequestLabel(details), "Labeled PR #7 with bug, area:backend; labels now: bug, area:backend.");
  await assert.rejects(labelPullRequest(repository, 7, [], token, { fetchImpl: ok.fetchImpl }), /1 to 5 labels/u);
});

test("feedback lines carry comment URLs and review ids", async () => {
  const payload = graphql({ reviews: { nodes: [{ ...comment("erin", "Add a test"), id: "PRR_1", state: "COMMENTED", submittedAt: "2026-10-14T09:00:00Z" }] } });
  const text = formatPullRequestFeedback(await getPullRequestFeedback(repository, 7, token, fetchFor(payload)));
  assert.match(text, /- \[review PRR_1\] @erin 2026-10-14T09:00:00Z <https:\/\/github\.com\/example\/project\/pull\/7#c> COMMENTED: Add a test/u);
});
