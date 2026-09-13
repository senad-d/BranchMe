import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { createOrReuseGitHubPullRequest, findGitHubPullRequest, getGitHubPullRequest } from "../src/github.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const repository = { owner: "example", repo: "project" };
const token = "test-private-credential";
const sha = "a".repeat(40);

function payload(overrides = {}) {
  return {
    number: 7, html_url: "https://github.com/example/project/pull/7", title: "Feature", state: "closed", draft: false,
    merged: true, merged_at: "2026-01-02T12:00:00Z", merge_commit_sha: "b".repeat(40),
    head: { ref: "feature", sha, repo: { full_name: "example/project" } },
    base: { ref: "main", sha: "c".repeat(40), repo: { full_name: "example/project" } },
    ...overrides,
  };
}

function json(value, status = 200) { return new Response(JSON.stringify(value), { status }); }

function responding(value) { return async () => json(value); }

test("PR lifecycle status validates open, closed-unmerged, and merged evidence", async () => {
  for (const data of [payload(), payload({ merged: false, merged_at: null, merge_commit_sha: null }), payload({ state: "open", merged: false, merged_at: null, draft: true })]) {
    const result = await getGitHubPullRequest(repository, 7, token, { fetchImpl: responding(data) });
    assert.equal(result.merged, data.merged);
    assert.equal(result.draft, data.draft);
    assert.equal(result.headSha, sha);
    assert.equal(result.state, data.state);
  }
  for (const overrides of [
    { number: 8 }, { state: "open" }, { merged_at: null }, { merge_commit_sha: null }, { merge_commit_sha: "invalid" },
    { html_url: "https://evil.invalid/pull/7" }, { head: { ref: "feature", sha, repo: { full_name: "other/project" } } },
    { base: { ref: "main", sha, repo: { full_name: "other/project" } } },
  ]) {
    await assert.rejects(getGitHubPullRequest(repository, 7, token, { fetchImpl: responding(payload(overrides)) }));
  }
});

test("branch lookup selects the latest exact PR and distinguishes none from failure", async () => {
  const urls = [];
  const result = await findGitHubPullRequest(repository, "feature", token, { fetchImpl: async (url) => {
    urls.push(url);
    return json(url.includes("?") ? [{ number: 7 }] : payload());
  } });
  assert.equal(result.number, 7);
  assert.match(urls[0], /state=all/);
  assert.match(urls[0], /head=example%3Afeature/);
  assert.match(urls[1], /pulls\/7$/);
  assert.equal(await findGitHubPullRequest(repository, "feature", token, { fetchImpl: responding([]) }), null);
  await assert.rejects(findGitHubPullRequest(repository, "feature", token, { fetchImpl: responding([{ number: 7 }, { number: 8 }]) }, "open"), /Multiple/);
  await assert.rejects(getGitHubPullRequest(repository, 7, token, { fetchImpl: async () => json({}, 401) }), /401/);
  await assert.rejects(getGitHubPullRequest(repository, 7, token, { fetchImpl: async () => new Response("x".repeat(70 * 1024)) }), /byte limit/);
  await assert.rejects(getGitHubPullRequest(repository, 7, token, { fetchImpl: async () => { throw new Error(token); } }), (error) => !error.message.includes(token));
  await assert.rejects(getGitHubPullRequest(repository, 7, token, { signal: AbortSignal.abort(), fetchImpl: async () => { throw new Error("must not request"); } }), /abort/i);
});

test("PR lookup redacts cancellation reasons before truncating diagnostics", async () => {
  const reason = new Error(`${"x".repeat(3990)}${token}`);
  await assert.rejects(getGitHubPullRequest(repository, 7, token, {
    signal: AbortSignal.abort(reason),
    fetchImpl: async () => assert.fail("cancelled lookup must not fetch"),
  }), (error) => {
    assert.ok(!error.message.includes(token.slice(0, 10)), "a truncated credential prefix must not leak");
    return true;
  });
});

test("PR creation is idempotent, preserves existing fields, rejects mismatches, and recovers a 422 race", async () => {
  const input = { headBranch: "feature", baseBranch: "main", title: "new title", body: "", draft: false };
  let exists = false;
  let posts = 0;
  const open = payload({ state: "open", merged: false, merged_at: null, draft: true });
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") { posts++; exists = true; return json(open, 201); }
    return json(url.includes("?") ? exists ? [{ number: 7 }] : [] : open);
  };
  const first = await createOrReuseGitHubPullRequest(repository, input, sha, token, { fetchImpl });
  const second = await createOrReuseGitHubPullRequest(repository, input, sha, token, { fetchImpl });
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "existing");
  assert.equal(second.number, first.number);
  assert.equal(second.draft, true);
  assert.equal(posts, 1);
  await assert.rejects(createOrReuseGitHubPullRequest(repository, { ...input, baseBranch: "release" }, sha, token, { fetchImpl }), /does not match/);
  await assert.rejects(createOrReuseGitHubPullRequest(repository, input, "d".repeat(40), token, { fetchImpl }), /does not match/);
  exists = false;
  const raced = await createOrReuseGitHubPullRequest(repository, input, sha, token, { fetchImpl: async (url, init) => {
    if (init.method === "POST") { exists = true; return json({ message: "already exists" }, 422); }
    return fetchImpl(url, init);
  } });
  assert.equal(raced.outcome, "existing");
});

test("pull_request_status has a strict schema and executes read-only exact lookup", async () => {
  const tools = [];
  const pi = {
    registerTool: tools.push.bind(tools),
    async exec(_command, args) {
      if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
      if (args.join(" ") === "remote get-url origin") return { stdout: "git@github.com:example/project.git\n", stderr: "", code: 0, killed: false };
      throw new Error(`Unexpected command: ${args}`);
    },
  };
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: token }, fetchImpl: responding(payload()) });
  const tool = tools.find((entry) => entry.name === "pull_request_status");
  const schema = Compile(tool.parameters);
  assert.equal(schema.Check({ number: 7 }), true);
  for (const input of [{ number: 0 }, { number: 1.5 }, { headBranch: "" }, { repo: "other" }]) assert.equal(schema.Check(input), false);
  const result = await tool.execute("id", { number: 7 }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.details.pullRequest.merged, true);
  await assert.rejects(tool.execute("id", { number: 7, headBranch: "feature" }, undefined, undefined, { cwd: "/repo" }), /not both/);
});
