import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createGitHubPullRequest,
  parseGitHubRepository,
  redactSecrets,
  resolveGitHubRepository,
  resolveGitHubToken,
  validatePullRequestBranchRef,
} from "../src/github.ts";

function result(overrides = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function makePi(routes) {
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.equal(options.cwd, "/repo");
      calls.push({ command, args: [...args], options });
      const route = routes[args.join("\0")];
      if (!route) throw new Error(`Unexpected git command: ${args.join(" ")}`);
      return result(route);
    },
  };
}

const ctx = { cwd: "/repo" };

test("parseGitHubRepository supports HTTPS, SSH, and owner/repo formats", () => {
  assert.deepEqual(parseGitHubRepository("https://github.com/senad-d/branchme.git"), {
    owner: "senad-d",
    repo: "branchme",
  });
  assert.deepEqual(parseGitHubRepository("git@github.com:senad-d/branchme.git"), {
    owner: "senad-d",
    repo: "branchme",
  });
  assert.deepEqual(parseGitHubRepository("ssh://git@github.com/senad-d/branchme.git"), {
    owner: "senad-d",
    repo: "branchme",
  });
  assert.deepEqual(parseGitHubRepository("senad-d/branchme"), { owner: "senad-d", repo: "branchme" });
  assert.equal(parseGitHubRepository("https://example.com/senad-d/branchme.git"), null);
});

test("resolveGitHubRepository uses current repository and fails closed on mismatch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  const repository = await resolveGitHubRepository(pi, ctx, undefined, { GITHUB_REPOSITORY: "senad-d/branchme" });
  assert.deepEqual(repository, { owner: "senad-d", repo: "branchme" });

  await assert.rejects(
    () => resolveGitHubRepository(pi, ctx, undefined, { GITHUB_REPOSITORY: "other/repo" }),
    /boundary mismatch/i,
  );
});

test("resolveGitHubRepository falls back to GITHUB_REPOSITORY when origin is unavailable", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["remote\0get-url\0origin"]: { code: 1, stderr: "origin missing\n" },
  });
  const repository = await resolveGitHubRepository(pi, ctx, undefined, { GITHUB_REPOSITORY: "senad-d/branchme" });
  assert.deepEqual(repository, { owner: "senad-d", repo: "branchme" });
});

test("resolveGitHubRepository fails outside a git repository even with env fallback", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { code: 128, stderr: "fatal: not a git repository\n" },
  });

  await assert.rejects(
    () => resolveGitHubRepository(pi, ctx, undefined, { GITHUB_REPOSITORY: "senad-d/branchme" }),
    /not a git repository/i,
  );
});

test("resolveGitHubToken uses process environment and prefers GITHUB_TOKEN", async () => {
  assert.deepEqual(await resolveGitHubToken({ GITHUB_TOKEN: " github-token ", GH_TOKEN: "gh-token" }), {
    token: "github-token",
    source: "GITHUB_TOKEN",
  });
  assert.deepEqual(await resolveGitHubToken({ GH_TOKEN: " gh-token " }), { token: "gh-token", source: "GH_TOKEN" });
  await assert.rejects(() => resolveGitHubToken({}), /GITHUB_TOKEN or GH_TOKEN/);
});

test("resolveGitHubToken falls back to local .env tokens", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "branchme-env-"));
  try {
    await writeFile(
      join(cwd, ".env"),
      ["# token fallback", "GITHUB_TOKEN= github_pat_from_file ", "GH_TOKEN=ghp_secondary"].join("\n"),
      "utf8",
    );

    assert.deepEqual(await resolveGitHubToken({}, { cwd }), {
      token: "github_pat_from_file",
      source: "GITHUB_TOKEN (.env)",
    });
    assert.deepEqual(await resolveGitHubToken({ GH_TOKEN: " process-token " }, { cwd }), {
      token: "process-token",
      source: "GH_TOKEN",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveGitHubToken rejects unsafe, oversized, and aborted .env fallback reads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "branchme-env-hardening-"));
  try {
    await assert.rejects(() => resolveGitHubToken({}, { cwd }), /GITHUB_TOKEN or GH_TOKEN/);

    await mkdir(join(cwd, ".env"));
    await assert.rejects(() => resolveGitHubToken({}, { cwd }), /regular file/i);
    await rm(join(cwd, ".env"), { recursive: true, force: true });

    await writeFile(join(cwd, ".env"), `GITHUB_TOKEN=ghp_${"a".repeat(70 * 1024)}\n`, "utf8");
    await assert.rejects(() => resolveGitHubToken({}, { cwd }), /too large|byte limit/i);
    await rm(join(cwd, ".env"), { force: true });

    await writeFile(join(cwd, ".env"), "GITHUB_TOKEN=ghp_filetoken123\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => resolveGitHubToken({}, { cwd, signal: controller.signal }), /aborted/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("redactSecrets removes tokens and token-like request data", () => {
  const token = "ghp_secret123";
  const redacted = redactSecrets(
    `Authorization: Bearer ${token}; token=${token}; github_pat_abc123; plain ${token}`,
    [token],
  );

  assert.doesNotMatch(redacted, /secret123|github_pat_abc123/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("validatePullRequestBranchRef accepts local branch names and rejects cross-repository or unsafe refs", () => {
  assert.doesNotThrow(() => validatePullRequestBranchRef("feature/current", "headBranch"));
  assert.doesNotThrow(() => validatePullRequestBranchRef("release/v1.2", "baseBranch"));

  for (const value of [
    "other-owner:feature/current",
    "../feature",
    "feature/../main",
    "feature branch",
    "feature\nmain",
    "refs/heads/feature",
    "feature.lock",
    "feature//main",
  ]) {
    assert.throws(() => validatePullRequestBranchRef(value, "headBranch"), /headBranch/u);
  }
});

test("createGitHubPullRequest rejects owner-prefixed head branches before fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };

  await assert.rejects(
    () =>
      createGitHubPullRequest(
        { owner: "senad-d", repo: "branchme" },
        { headBranch: "other-owner:feature", baseBranch: "main", title: "Title", body: "", draft: false },
        "ghp_secret123",
        { fetchImpl },
      ),
    /owner-prefixed|cross-repository|:/i,
  );
  assert.equal(called, false);
});

test("createGitHubPullRequest sends expected request and parses response", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(
      JSON.stringify({
        number: 42,
        html_url: "https://github.com/senad-d/branchme/pull/42",
        state: "open",
        draft: true,
        head: { ref: "feature/current" },
        base: { ref: "main" },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  const details = await createGitHubPullRequest(
    { owner: "senad-d", repo: "branchme" },
    {
      headBranch: "feature/current",
      baseBranch: "main",
      title: "Add BranchMe",
      body: "Body",
      draft: true,
    },
    "ghp_secret123",
    { fetchImpl },
  );

  assert.deepEqual(details, {
    repository: { owner: "senad-d", repo: "branchme" },
    number: 42,
    url: "https://github.com/senad-d/branchme/pull/42",
    state: "open",
    head: "feature/current",
    base: "main",
    draft: true,
  });
  assert.equal(requests[0].url, "https://api.github.com/repos/senad-d/branchme/pulls");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Accept, "application/vnd.github+json");
  assert.equal(requests[0].init.headers.Authorization, "Bearer ghp_secret123");
  assert.equal(requests[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    title: "Add BranchMe",
    head: "feature/current",
    base: "main",
    body: "Body",
    draft: true,
  });
});

test("createGitHubPullRequest redacts API errors", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ message: "bad token ghp_secret123" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    () =>
      createGitHubPullRequest(
        { owner: "senad-d", repo: "branchme" },
        { headBranch: "feature/current", baseBranch: "main", title: "Title", body: "", draft: false },
        "ghp_secret123",
        { fetchImpl },
      ),
    (error) => error instanceof Error && /HTTP 401/.test(error.message) && !/secret123/.test(error.message),
  );
});
