import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Compile } from "typebox/compile";
import { GIT_STATUS_FILE_LIMIT_BYTES, GIT_STATUS_PAGE_LIMIT, GIT_STATUS_RAW_LIMIT_BYTES } from "../src/constants.ts";
import { formatGitStatus, getGitStatus } from "../src/git-status.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const exec = promisify(execFile);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "Status Test", GIT_COMMITTER_NAME: "Status Test",
  GIT_AUTHOR_EMAIL: "status@example.invalid", GIT_COMMITTER_EMAIL: "status@example.invalid",
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};
async function git(cwd, args, options = {}) {
  try { return { ...await exec("git", args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options }), code: 0, killed: false }; }
  catch (error) {
    if (error.name === "AbortError") throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, code: error.code ?? 1, killed: Boolean(error.killed) };
  }
}
async function checked(cwd, args) {
  const result = await git(cwd, args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trimEnd();
}
async function fixture(t, unborn = false) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "branchme-status-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  await mkdir(root);
  await checked(root, ["init", "--initial-branch=main"]);
  await checked(root, ["config", "commit.gpgsign", "false"]);
  if (!unborn) {
    await writeFile(join(root, "file.txt"), "original\n");
    await checked(root, ["add", "."]);
    await checked(root, ["commit", "-m", "initial"]);
  }
  const calls = [];
  const pi = { async exec(command, args, options) {
    assert.equal(command, "git");
    calls.push(args);
    return git(options.cwd, args, { signal: options.signal, timeout: options.timeout });
  } };
  return { root, temp, pi, calls };
}
function tool(pi, options = {}) {
  const tools = [];
  registerBranchMeTools({ exec: pi.exec, registerTool: tools.push.bind(tools) }, options);
  return tools.find((entry) => entry.name === "git_status");
}
async function state(root) {
  return { index: await readFile(join(root, ".git", "index")), config: await readFile(join(root, ".git", "config")), head: await readFile(join(root, ".git", "HEAD")), refs: await checked(root, ["show-ref"]), file: await readFile(join(root, "file.txt")) };
}
function noExec() { throw new Error("Unexpected execution"); }

test("git_status enumerates all pages, including staged-only and untracked paths, without mutating repository state", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file.txt"), "staged\n");
  await checked(f.root, ["add", "file.txt"]);
  for (let i = 0; i < 112; i++) await writeFile(join(f.root, `new-${String(i).padStart(3, "0")}.txt`), "untracked\n");
  const before = await state(f.root);
  let page = await getGitStatus(f.pi, { cwd: f.root });
  const paths = [];
  assert.equal(page.total, 113);
  assert.equal(page.entries.length, GIT_STATUS_PAGE_LIMIT);
  assert.equal(page.complete, false);
  assert.match(formatGitStatus(page), /Output: incomplete/u);
  const index = page.index;
  do {
    paths.push(...page.entries.map((entry) => entry.path));
    if (!page.next) break;
    page = await getGitStatus(f.pi, { cwd: f.root }, { after: page.next });
    assert.equal(page.index, index);
  } while (true);
  assert.equal(page.complete, true);
  assert.equal(paths.length, 113);
  assert.equal(new Set(paths).size, 113);
  assert.deepEqual(await state(f.root), before);
  for (const args of f.calls) assert.deepEqual(args.slice(0, 5), ["--no-optional-locks", "--no-lazy-fetch", "--no-pager", "-c", "core.fsmonitor=false"]);
});

test("git_status preserves staged deletion and untracked records for the same path", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["rm", "--cached", "file.txt"]);
  const result = await getGitStatus(f.pi, { cwd: f.root });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(new Set(result.entries.map((entry) => entry.kind)), new Set(["tracked", "untracked"]));
  assert.ok(result.entries.every((entry) => entry.path === "file.txt"));
});

test("git_status distinguishes index/worktree states, renames and deletions; filters match either rename side", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["mv", "file.txt", "renamed.txt"]);
  await writeFile(join(f.root, "renamed.txt"), "edited after rename\n");
  const renamed = await getGitStatus(f.pi, { cwd: f.root }, { paths: ["file.txt"] });
  assert.equal(renamed.entries.length, 1);
  assert.equal(renamed.entries[0].originalPath, "file.txt");
  assert.equal(renamed.entries[0].path, "renamed.txt");
  assert.equal(renamed.entries[0].indexStatus, "R");
  assert.equal(renamed.entries[0].worktreeStatus, "M");
  assert.match(renamed.entries[0].worktreeExpectation.fingerprint, /^[a-f0-9]{64}$/u);
  await rm(join(f.root, "renamed.txt"));
  const deleted = await getGitStatus(f.pi, { cwd: f.root }, { paths: ["renamed.txt"] });
  assert.equal(deleted.entries[0].worktreeStatus, "D");
  assert.ok(deleted.entries[0].worktreeExpectation.fingerprint);
});

test("git_status clean, empty filtered, unborn and detached outputs are distinct", async (t) => {
  const f = await fixture(t);
  const clean = await getGitStatus(f.pi, { cwd: f.root });
  assert.equal(clean.hasChanges, false);
  assert.equal(clean.complete, true);
  await writeFile(join(f.root, "file.txt"), "changed\n");
  const filtered = await getGitStatus(f.pi, { cwd: f.root }, { paths: ["absent"] });
  assert.equal(filtered.hasChanges, true);
  assert.equal(filtered.total, 0);
  assert.equal(filtered.filtered, true);
  assert.match(formatGitStatus(filtered), /does not establish a clean checkout/u);
  await checked(f.root, ["switch", "--detach"]);
  assert.equal((await getGitStatus(f.pi, { cwd: f.root })).detached, true);
  const unborn = await fixture(t, true);
  await writeFile(join(unborn.root, "first.txt"), "new\n");
  await checked(unborn.root, ["add", "first.txt"]);
  const first = await getGitStatus(unborn.pi, { cwd: unborn.root });
  assert.equal(first.head, null);
  assert.equal(first.branch, "main");
  assert.equal(first.entries[0].indexStatus, "A");
});

test("git_status rejects stale continuation after edits with unchanged XY, index/HEAD changes, filters or worktree changes", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) await writeFile(join(f.root, `new-${i}`), "a");
  const first = await getGitStatus(f.pi, { cwd: f.root });
  await assert.rejects(getGitStatus(f.pi, { cwd: f.root }, { after: first.next, paths: ["new-1"] }), /continuation is stale/u);
  await writeFile(join(f.root, "new-59"), "b");
  await assert.rejects(getGitStatus(f.pi, { cwd: f.root }, { after: first.next }), /continuation is stale/u);
  const second = await getGitStatus(f.pi, { cwd: f.root });
  await checked(f.root, ["add", "new-59"]);
  await assert.rejects(getGitStatus(f.pi, { cwd: f.root }, { after: second.next }), /continuation is stale/u);
  const third = await getGitStatus(f.pi, { cwd: f.root });
  await checked(f.root, ["commit", "-m", "new head"]);
  await assert.rejects(getGitStatus(f.pi, { cwd: f.root }, { after: third.next }), /continuation is stale/u);
});

test("git_status inspects kept conflicts and operation markers without concluding or editing", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["switch", "-c", "other"]);
  await writeFile(join(f.root, "file.txt"), "other\n");
  await checked(f.root, ["commit", "-am", "other"]);
  await checked(f.root, ["switch", "main"]);
  await writeFile(join(f.root, "file.txt"), "main\n");
  await checked(f.root, ["commit", "-am", "main"]);
  assert.notEqual((await git(f.root, ["merge", "other"])).code, 0);
  const before = await state(f.root);
  const result = await getGitStatus(f.pi, { cwd: f.root });
  assert.equal(result.entries[0].kind, "conflict");
  assert.equal(result.entries[0].indexStatus, "U");
  assert.deepEqual(result.operations, ["merge"]);
  assert.deepEqual(await state(f.root), before);
});

test("git_status root-relative filters are literal and selectors are verified same-repository worktrees", async (t) => {
  const f = await fixture(t);
  const linked = join(f.temp, "linked");
  await checked(f.root, ["worktree", "add", "-b", "linked", linked]);
  for (const name of ["*.txt", ":(glob)*.txt", "-option.txt", "with space.txt"]) await writeFile(join(linked, name), "literal\n");
  await mkdir(join(linked, "sub"));
  const result = await getGitStatus(f.pi, { cwd: join(linked, "sub") }, { paths: ["*.txt"] });
  assert.deepEqual(result.entries.map((entry) => entry.path), ["*.txt"]);
  const selected = await getGitStatus(f.pi, { cwd: f.root }, { worktreePath: linked });
  assert.equal(selected.repoRoot, linked);
  assert.equal(selected.total, 4);
  assert.equal((await getGitStatus(f.pi, { cwd: f.root })).total, 0);
  const foreign = await fixture(t);
  await assert.rejects(getGitStatus(f.pi, { cwd: f.root }, { worktreePath: foreign.root }));
  await assert.rejects(getGitStatus(f.pi, { cwd: f.root }, { worktreePath: join(linked, "sub") }));
});

test("git_status marks redacted/control/long paths as non-reusable in text and details", async (t) => {
  const f = await fixture(t);
  const secret = "custom-secret-name";
  for (const name of [secret, "control\u001b\n.txt", "ghp_exampleSecret"]) await writeFile(join(f.root, name), "private content not returned");
  const longParent = join(f.root, "a".repeat(200), "b".repeat(200));
  await mkdir(longParent, { recursive: true });
  await writeFile(join(longParent, "c".repeat(200)), "long path");
  // Some filesystems refuse non-UTF-8 names; simulate exec's lossy decoding.
  const pi = { async exec(command, args, options) {
    const result = await f.pi.exec(command, args, options);
    return args.includes("status") ? { ...result, stdout: `${result.stdout}? invalid-\ufffd\0` } : result;
  } };
  const result = await tool(pi, { env: { GH_TOKEN: secret } }).execute("status", {}, undefined, undefined, { cwd: f.root });
  assert.doesNotMatch(JSON.stringify(result), /custom-secret-name|ghp_exampleSecret|private content/u);
  assert.ok(result.details.entries.every((entry) => !entry.reusablePath));
  assert.match(result.content[0].text, /reusablePath/u);
});

test("git_status never fingerprints a path through a symlink ancestor", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "dir"));
  await writeFile(join(f.root, "dir", "tracked.txt"), "tracked\n");
  await checked(f.root, ["add", "."]);
  await checked(f.root, ["commit", "-m", "directory"]);
  await rm(join(f.root, "dir"), { recursive: true });
  await symlink(f.temp, join(f.root, "dir"));
  const result = await getGitStatus(f.pi, { cwd: f.root }, { paths: ["dir/tracked.txt"] });
  assert.equal(result.entries[0].reusablePath, false);
  assert.equal(result.entries[0].worktreeExpectation, undefined);
});

test("git_status bounded content expectations handle regular, binary, symlink and oversized files without returning content", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(f.root, "large"), Buffer.alloc(GIT_STATUS_FILE_LIMIT_BYTES + 1));
  await symlink("file.txt", join(f.root, "link"));
  const result = await getGitStatus(f.pi, { cwd: f.root }, { paths: ["binary", "large", "link"] });
  for (const entry of result.entries) {
    if (entry.path === "large") assert.match(entry.worktreeExpectation.reason, /8 MiB/u);
    else assert.match(entry.worktreeExpectation.fingerprint, /^[a-f0-9]{64}$/u);
  }
  assert.equal(result.entries.find((entry) => entry.path === "large").worktreeExpectation.fingerprint, null);
});

test("git_status rejects invalid arguments/schema without executing Git", async () => {
  for (const args of [null, [], { force: true }, { paths: [] }, { paths: ["../escape"] }, { paths: [".git/config"] }, { paths: ["/absolute"] }, { paths: ["C:\\escape"] }, { paths: ["bad\npath"] }, { paths: Array(26).fill("x") }, { worktreePath: "relative" }, { after: "bad" }]) {
    await assert.rejects(getGitStatus({ exec: noExec }, { cwd: "/unused" }, args));
  }
  const schema = Compile(tool({ exec: noExec }).parameters);
  for (const args of [{}, { paths: ["src"], worktreePath: "/tmp/linked" }, { after: `v1.${"a".repeat(64)}.50` }]) assert.equal(schema.Check(args), true);
  for (const args of [{ paths: [] }, { after: "bad" }, { force: true }, null]) assert.equal(schema.Check(args), false);
});

test("git_status failures, raw limits, unsupported Git and cancellation never become empty status", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getGitStatus({ exec: noExec }, { cwd: f.root }, {}, controller.signal), { name: "AbortError" });
  for (const result of [
    { stdout: "", stderr: "unknown option `no-lazy-fetch'", code: 129, killed: false },
    { stdout: "", stderr: "ghp_privateError", code: 1, killed: false },
    { stdout: "", stderr: "", code: 0, killed: true },
    { stdout: "x".repeat(GIT_STATUS_RAW_LIMIT_BYTES + 1), stderr: "", code: 0, killed: false },
  ]) {
    await assert.rejects(getGitStatus({ exec: async () => result }, { cwd: f.root }), (error) => !error.message.includes("ghp_privateError"));
  }
  for (const raw of ["broken\0", "# branch.oid invalid\0", "# branch.oid (initial)\0# branch.head main\0? path", "# branch.oid (initial)\0# branch.head main\x002 R. broken\0"]) {
    const pi = { async exec(command, args, options) {
      if (args.includes("status")) return { stdout: raw, stderr: "", code: 0, killed: false };
      return f.pi.exec(command, args, options);
    } };
    await assert.rejects(getGitStatus(pi, { cwd: f.root }));
  }
});

test("git_status detects an external edit during collection and disables fsmonitor execution", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["config", "core.fsmonitor", "sh -c 'exit 89'"]);
  await writeFile(join(f.root, "file.txt"), "before\n");
  let reads = 0;
  const pi = { async exec(command, args, options) {
    if (args.includes("status") && ++reads === 2) await writeFile(join(f.root, "file.txt"), "after\n");
    return f.pi.exec(command, args, options);
  } };
  await assert.rejects(getGitStatus(pi, { cwd: f.root }), /changed during inspection/u);
  assert.equal((await getGitStatus(f.pi, { cwd: f.root })).total, 1);
});
