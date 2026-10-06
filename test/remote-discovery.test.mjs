import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Compile } from "typebox/compile";
import { fetchRemote } from "../src/git-discovery.ts";
import { listBranches } from "../src/git.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const exec = promisify(execFile);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "Discovery Test", GIT_COMMITTER_NAME: "Discovery Test",
  GIT_AUTHOR_EMAIL: "discovery@example.invalid", GIT_COMMITTER_EMAIL: "discovery@example.invalid",
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd, args, options = {}) {
  try {
    return { ...await exec("git", args, { cwd, env, encoding: "utf8", timeout: 30_000, ...options }), code: 0, killed: false };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, code: error.code ?? 1, killed: Boolean(error.killed) };
  }
}

async function checked(cwd, args) {
  const result = await git(cwd, args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trimEnd();
}

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "branchme-discovery-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  const remote = join(temp, "origin.git");
  await mkdir(root);
  await checked(root, ["init", "--initial-branch=main"]);
  await checked(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "initial.txt"), "initial\n");
  await checked(root, ["add", "."]);
  await checked(root, ["commit", "-m", "initial"]);
  await checked(root, ["init", "--bare", "--initial-branch=main", remote]);
  await checked(root, ["remote", "add", "origin", remote]);
  await checked(root, ["push", "-u", "origin", "main"]);
  const head = await checked(root, ["rev-parse", "HEAD"]);
  const calls = [];
  const pi = { async exec(command, args, options) {
    assert.equal(command, "git");
    assert.ok(options.cwd.startsWith(temp));
    calls.push({ args: [...args], options });
    return git(options.cwd, args, { signal: options.signal, timeout: options.timeout });
  } };
  return { temp, root, remote, head, pi, calls };
}

function tools(pi) {
  const registered = [];
  registerBranchMeTools({ exec: pi.exec, registerTool: registered.push.bind(registered) });
  return new Map(registered.map((tool) => [tool.name, tool]));
}

function noExec() {
  throw new Error("unexpected Git execution");
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

async function checkoutSnapshot(f) {
  return {
    head: await checked(f.root, ["rev-parse", "HEAD"]),
    branch: await checked(f.root, ["symbolic-ref", "--short", "HEAD"]),
    localRefs: await checked(f.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/tags/", "refs/remotes/other/"]),
    config: await checked(f.root, ["config", "--local", "--list"]),
    index: await readFile(join(f.root, ".git", "index")),
    dirty: await readFile(join(f.root, "initial.txt"), "utf8"),
    untracked: await readFile(join(f.root, "untracked.txt"), "utf8"),
  };
}

async function setRemoteHead(f, name, head = f.head) {
  await checked(f.remote, ["update-ref", `refs/heads/${name}`, head]);
}

test("real workflow refreshes unknown issue branches then lists exact and wildcard remote matches", async (t) => {
  const f = await fixture(t);
  for (const name of ["feat/23", "feat/23-fix", "feat/23-nested/topic", "feat/230", "other/23"]) await setRemoteHead(f, name);
  const registered = tools(f.pi);
  const before = await checked(f.root, ["show-ref", "--heads"]);
  const fetched = await registered.get("fetch_remote").execute("fetch", { remote: "origin", prune: true }, undefined, undefined, { cwd: f.root });
  assert.equal(fetched.details.action, "fetch_remote");
  assert.equal(fetched.details.prune, true);
  const found = await registered.get("list_branches").execute("list", {
    kind: "remote-tracking", patterns: ["origin/feat/23", "origin/feat/23-*"],
  }, undefined, undefined, { cwd: f.root });
  assert.deepEqual(found.details.branches.map((entry) => entry.name), ["origin/feat/23", "origin/feat/23-fix", "origin/feat/23-nested/topic"]);
  assert.equal(found.details.omitted, 0);
  assert.equal(await checked(f.root, ["show-ref", "--heads"]), before);
  const fetchCall = f.calls.find((call) => call.args[0] === "fetch");
  assert.deepEqual(fetchCall.args, [
    "fetch", "--atomic", "--no-tags", "--no-prune-tags", "--no-recurse-submodules",
    "--no-auto-maintenance", "--refmap=", "--prune", "--", "origin",
    "+refs/heads/*:refs/remotes/origin/*", "^refs/heads/HEAD",
  ]);
  assert.equal(fetchCall.options.timeout, 120_000);
});

test("fetch_remote defaults never prune even when Git configuration enables broad fetch and tag pruning", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["remote", "add", "other", f.remote]);
  await checked(f.root, ["tag", "local-only"]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/deleted", f.head]);
  await checked(f.root, ["update-ref", "refs/remotes/other/deleted", f.head]);
  await checked(f.root, ["config", "--replace-all", "remote.origin.fetch", "+refs/*:refs/*"]);
  await checked(f.root, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/other/*"]);
  await checked(f.root, ["config", "remote.origin.mirror", "true"]);
  for (const key of ["fetch.prune", "fetch.pruneTags", "remote.origin.prune", "remote.origin.pruneTags"]) await checked(f.root, ["config", key, "true"]);
  await checked(f.root, ["config", "remote.origin.tagOpt", "--tags"]);
  await checked(f.remote, ["update-ref", "refs/tags/server-only", f.head]);
  await setRemoteHead(f, "new");
  await writeFile(join(f.root, "initial.txt"), "dirty tracked\n");
  await writeFile(join(f.root, "untracked.txt"), "untracked\n");
  const before = await checkoutSnapshot(f);
  const fetched = await fetchRemote(f.pi, { cwd: f.root });
  assert.equal(fetched.remote, "origin");
  assert.equal(fetched.prune, false);
  assert.equal(await checked(f.root, ["rev-parse", "refs/remotes/origin/new"]), f.head);
  assert.equal(await checked(f.root, ["rev-parse", "refs/remotes/origin/deleted"]), f.head);
  assert.equal((await git(f.root, ["show-ref", "--verify", "--quiet", "refs/tags/server-only"])).code, 1);
  assert.deepEqual(await checkoutSnapshot(f), before);

  await fetchRemote(f.pi, { cwd: f.root }, "origin", true);
  assert.equal((await git(f.root, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/deleted"])).code, 1);
  assert.equal(await checked(f.root, ["rev-parse", "refs/remotes/other/deleted"]), f.head);
  assert.deepEqual(await checkoutSnapshot(f), before);
});

test("fetch_remote refreshes rewritten tips and works without an upstream or attached HEAD", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["branch", "--unset-upstream"]);
  await checked(f.root, ["switch", "--detach"]);
  await checked(f.root, ["commit", "--allow-empty", "-m", "local ahead"]);
  const detached = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/main", detached]);
  await fetchRemote(f.pi, { cwd: f.root });
  assert.equal(await checked(f.root, ["rev-parse", "refs/remotes/origin/main"]), f.head);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), detached);
  assert.equal((await git(f.root, ["symbolic-ref", "--quiet", "HEAD"])).code, 1);
  const filtered = await listBranches(f.pi, { cwd: f.root }, undefined, { patterns: ["*"] });
  assert.deepEqual(filtered.branches.map((entry) => entry.name), ["main", "origin/main"]);
  assert.ok(filtered.branches.every((entry) => !entry.current));
});

test("fetch_remote preserves conventional remote HEAD aliases, including with pruning and a server branch named HEAD", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await checked(f.root, ["commit", "--allow-empty", "-m", "different remote HEAD branch"]);
  const different = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["push", "origin", "HEAD:refs/heads/HEAD"]);
  // Restore main's cached tip after Git push followed the alias in this fixture.
  await checked(f.root, ["update-ref", "refs/remotes/origin/main", f.head]);
  await fetchRemote(f.pi, { cwd: f.root }, "origin", true);
  assert.equal(await checked(f.root, ["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
  assert.equal(await checked(f.root, ["rev-parse", "refs/remotes/origin/main"]), f.head);
  assert.notEqual(f.head, different);
});

test("fetch_remote rejects unsafe symbolic destinations before changing refs", async (t) => {
  for (const [ref, target] of [
    ["refs/remotes/origin/topic", "refs/heads/main"],
    ["refs/remotes/origin/HEAD", "refs/heads/main"],
    ["refs/remotes/origin/HEAD", "refs/remotes/other/main"],
    ["refs/remotes/origin/topic", "refs/remotes/origin/main"],
    ["refs/remotes/origin/topic", "refs/heads/absent"],
  ]) {
    const f = await fixture(t);
    await checked(f.root, ["symbolic-ref", ref, target]);
    const before = await checked(f.root, ["show-ref"]);
    await assert.rejects(fetchRemote(f.pi, { cwd: f.root }, "origin", true), /symbolic/);
    assert.equal(await checked(f.root, ["show-ref"]), before);
    assert.ok(f.calls.every((call) => call.args[0] !== "fetch"));
  }
});

test("fetch_remote validates remote and prune values, configured remote existence, and cancellation", async (t) => {
  for (const remote of ["", " ", ".", "-origin", "origin\n", "https://host/repo", "user@host", "ghp_secret123", null, 1]) {
    await assert.rejects(fetchRemote({ exec: noExec }, { cwd: "/unused" }, remote), /safe configured/);
  }
  for (const prune of [null, "true", 1]) await assert.rejects(fetchRemote({ exec: noExec }, { cwd: "/unused" }, "origin", prune), /boolean/);
  const f = await fixture(t);
  await assert.rejects(fetchRemote(f.pi, { cwd: f.root }, "missing"), /configured/);
  await assert.rejects(fetchRemote(f.pi, { cwd: f.root }, "origin/*"), /failed/);
  assert.ok(f.calls.every((call) => call.args[0] !== "fetch"));
  await assert.rejects(fetchRemote(f.pi, { cwd: f.root }, "origin", false, AbortSignal.abort()));
});

test("fetch_remote rejects malformed/oversized metadata and redacts bounded fetch failures", async (t) => {
  const f = await fixture(t);
  for (const output of ["broken\n", "refs/remotes/else/topic\0\n", "x".repeat(128 * 1024 + 1)]) {
    const pi = { async exec(command, args, options) {
      if (args[0] === "for-each-ref") return { stdout: output, stderr: "", code: 0, killed: false };
      return f.pi.exec(command, args, options);
    } };
    await assert.rejects(fetchRemote(pi, { cwd: f.root }), /metadata|safety limit/);
  }
  const pi = { async exec(command, args, options) {
    if (args[0] === "fetch") return { stdout: "", stderr: `ghp_secret123 ${"x".repeat(8_000)}`, code: 1, killed: false };
    return f.pi.exec(command, args, options);
  } };
  await assert.rejects(fetchRemote(pi, { cwd: f.root }), (error) => {
    assert.doesNotMatch(error.message, /ghp_secret123/);
    assert.ok(error.message.length <= 4_000);
    assert.match(error.message, /inspect before retrying.*No rollback/);
    return true;
  });
});

test("fetch_remote prunes packed stale refs against an empty remote and keeps safe dangling HEAD aliases", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await checked(f.root, ["pack-refs", "--all"]);
  await checked(f.remote, ["update-ref", "-d", "refs/heads/main"]);
  await fetchRemote(f.pi, { cwd: f.root }, "origin", true);
  assert.equal((await git(f.root, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"])).code, 1);
  assert.equal(await checked(f.root, ["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
  await fetchRemote(f.pi, { cwd: f.root }, "origin", true);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.head);
});

test("fetch_remote refuses unsupported ref backends and symlinked loose refs before fetching", async (t) => {
  const f = await fixture(t);
  const pi = { async exec(command, args, options) {
    if (args[0] === "config" && args[2] === "extensions.refStorage") return { stdout: "reftable\n", stderr: "", code: 0, killed: false };
    return f.pi.exec(command, args, options);
  } };
  await assert.rejects(fetchRemote(pi, { cwd: f.root }), /files ref backend/);
  await symlink(join(f.root, ".git", "refs", "heads", "main"), join(f.root, ".git", "refs", "remotes", "origin", "unsafe"));
  await assert.rejects(fetchRemote(f.pi, { cwd: f.root }), /unsafe loose ref/);
  assert.ok(f.calls.every((call) => call.args[0] !== "fetch"));
});

test("fetch_remote refuses overlapping remote namespaces rather than pruning another remote's cache", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["remote", "add", "origin/team", f.remote]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/team/main", f.head]);
  const before = await checked(f.root, ["show-ref"]);
  for (const remote of ["origin", "origin/team"]) {
    await assert.rejects(fetchRemote(f.pi, { cwd: f.root }, remote, true), /overlapping/);
  }
  assert.equal(await checked(f.root, ["show-ref"]), before);
  assert.ok(f.calls.every((call) => call.args[0] !== "fetch"));
});

test("fetch_remote serializes its shared branch cache across linked worktrees", async (t) => {
  const f = await fixture(t);
  const linked = join(f.temp, "linked");
  await checked(f.root, ["worktree", "add", "-b", "linked", linked]);
  const started = deferred();
  const release = deferred();
  const secondPrepared = deferred();
  let fetches = 0;
  const pi = { async exec(command, args, options) {
    if (args[0] === "fetch") {
      fetches += 1;
      if (fetches === 1) {
        started.resolve();
        await release.promise;
      }
    }
    const result = await f.pi.exec(command, args, options);
    if (options.cwd === linked && args.includes("--git-common-dir")) secondPrepared.resolve();
    return result;
  } };
  const first = fetchRemote(pi, { cwd: f.root });
  await started.promise;
  const second = fetchRemote(pi, { cwd: linked });
  await secondPrepared.promise;
  await nextTurn();
  try {
    assert.equal(fetches, 1, "second worktree fetch must wait for the common-directory lock");
  } finally {
    release.resolve();
  }
  await Promise.all([first, second]);
  assert.equal(fetches, 2);
});

test("list_branches filters each scope with Git glob semantics and preserves local occupancy", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["branch", "feat/23"]);
  await checked(f.root, ["branch", "feat/23-fix"]);
  const linked = join(f.temp, "linked");
  await checked(f.root, ["worktree", "add", linked, "feat/23"]);
  await setRemoteHead(f, "feat/23");
  await setRemoteHead(f, "feat/230");
  await fetchRemote(f.pi, { cwd: f.root });
  f.calls.length = 0;
  const before = await checked(f.root, ["show-ref"]);
  const local = await listBranches(f.pi, { cwd: f.root }, undefined, { kind: "local", patterns: ["feat/23", "feat/23-*"] });
  assert.deepEqual(local.branches.map((entry) => entry.name), ["feat/23", "feat/23-fix"]);
  assert.deepEqual(local.branches[0].worktreePaths, [linked]);
  const both = await listBranches(f.pi, { cwd: f.root }, undefined, { patterns: ["feat/23*", "origin/feat/23"] });
  assert.deepEqual(both.branches.map((entry) => entry.name), ["feat/23", "feat/23-fix", "origin/feat/23"]);
  const overlap = await listBranches(f.pi, { cwd: f.root }, undefined, { kind: "remote-tracking", patterns: ["origin/feat/23", "origin/feat/2[3]"] });
  assert.deepEqual(overlap.branches.map((entry) => entry.name), ["origin/feat/23"]);
  const empty = await listBranches(f.pi, { cwd: f.root }, undefined, { patterns: ["no-match*"] });
  assert.deepEqual(empty.branches, []);
  assert.equal(empty.omitted, 0);
  const remoteOnly = await listBranches(f.pi, { cwd: f.root }, undefined, { kind: "remote-tracking" });
  assert.ok(remoteOnly.branches.every((entry) => entry.kind === "remote-tracking"));
  assert.equal(await checked(f.root, ["show-ref"]), before);
  assert.ok(f.calls.every((call) => ["rev-parse", "for-each-ref", "branch", "worktree"].includes(call.args[0])));
});

test("list_branches filters before the 200-ref limit and before display redaction", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 205; index += 1) await checked(f.root, ["update-ref", `refs/remotes/origin/a-${index}`, f.head]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/feat/23", f.head]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/ghp_secret123", f.head]);
  const found = await listBranches(f.pi, { cwd: f.root }, undefined, { kind: "remote-tracking", patterns: ["origin/feat/23"] });
  assert.deepEqual(found.branches.map((entry) => entry.name), ["origin/feat/23"]);
  assert.equal(found.omitted, 0);
  const bounded = await listBranches(f.pi, { cwd: f.root }, undefined, { kind: "remote-tracking", patterns: ["origin/*"] });
  assert.equal(bounded.branches.length, 200);
  assert.equal(bounded.omitted, 8);
  const secret = await listBranches(f.pi, { cwd: f.root }, undefined, { patterns: ["origin/ghp_secret123"] });
  assert.equal(secret.branches.length, 1);
  assert.doesNotMatch(JSON.stringify(secret), /ghp_secret123/);
});

test("discovery tools have strict compatible schemas and named prompt guidance", async () => {
  const registered = tools({ exec: noExec });
  const fetch = registered.get("fetch_remote");
  const list = registered.get("list_branches");
  for (const tool of [fetch, list]) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(tool.description.includes(tool.name));
    assert.ok(tool.promptSnippet.includes(tool.name));
    assert.ok(tool.promptGuidelines.every((line) => line.includes(tool.name)));
  }
  const fetchSchema = Compile(fetch.parameters);
  for (const input of [{}, { remote: "origin" }, { prune: true }, { remote: "upstream", prune: false }]) assert.equal(fetchSchema.Check(input), true);
  for (const input of [{ remote: "" }, { prune: "true" }, { refspec: "refs/*" }, { force: true }]) assert.equal(fetchSchema.Check(input), false);
  const listSchema = Compile(list.parameters);
  for (const input of [{}, { kind: "local" }, { kind: "remote-tracking", patterns: ["origin/feat/23", "origin/feat/23-*"] }]) assert.equal(listSchema.Check(input), true);
  for (const input of [{ kind: "remote" }, { patterns: [] }, { patterns: [""] }, { patterns: [1] }, { patterns: ["x".repeat(513)] }, { patterns: Array(26).fill("x") }, { refresh: true }]) assert.equal(listSchema.Check(input), false);
  for (const filters of [{ kind: "unknown" }, { patterns: [] }, { patterns: ["-option"] }, { patterns: ["\n"] }, { patterns: [" "] }]) {
    await assert.rejects(listBranches({ exec: noExec }, { cwd: "/unused" }, undefined, filters), /list_branches/);
  }
});
