import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Compile } from "typebox/compile";
import { listBranches, parseBranchRefs } from "../src/git.ts";
import { trackBranch, updateFromBase } from "../src/git-workflow.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const exec = promisify(execFile);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "Workflow Test", GIT_COMMITTER_NAME: "Workflow Test",
  GIT_AUTHOR_EMAIL: "workflow@example.invalid", GIT_COMMITTER_EMAIL: "workflow@example.invalid",
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
  const temp = await realpath(await mkdtemp(join(tmpdir(), "branchme-workflow-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  const remote = join(temp, "remote.git");
  await mkdir(root);
  await checked(root, ["init", "--initial-branch=main"]);
  await checked(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "initial.txt"), "initial\n");
  await checked(root, ["add", "."]);
  await checked(root, ["commit", "-m", "initial"]);
  await checked(root, ["init", "--bare", "--initial-branch=main", remote]);
  await checked(root, ["remote", "add", "origin", remote]);
  await checked(root, ["push", "-u", "origin", "main"]);
  const calls = [];
  const pi = { async exec(command, args, options) {
    assert.equal(command, "git");
    assert.ok(options.cwd.startsWith(temp));
    calls.push([...args]);
    return git(options.cwd, args, { signal: options.signal, timeout: options.timeout });
  } };
  return { temp, root, remote, pi, calls };
}

function registered(name) {
  const tools = [];
  registerBranchMeTools({ registerTool: tools.push.bind(tools), exec() { throw new Error("unexpected execution"); } });
  return tools.find((tool) => tool.name === name);
}

function record(ref, extra = "") {
  return `${ref}\0${"a".repeat(40)}\0 \0\0\0${extra}\n`;
}

test("branch discovery parses bounded local and symbolic remote refs safely", () => {
  const output = `${record("refs/heads/main")}refs/remotes/origin/HEAD\0${"b".repeat(40)}\0 \0\0refs/remotes/origin/main\0\n`;
  const result = parseBranchRefs(output);
  assert.equal(result.branches[0].kind, "local");
  assert.equal(result.branches[1].kind, "remote-tracking");
  assert.equal(result.branches[1].symbolicTarget, "refs/remotes/origin/main");
  assert.deepEqual(parseBranchRefs(""), { branches: [], omitted: 0 });
  assert.throws(() => parseBranchRefs("broken\n"), /malformed/);
  assert.throws(() => parseBranchRefs(record("refs/heads/main").repeat(2)), /duplicate/);
  assert.throws(() => parseBranchRefs("x".repeat(128 * 1024 + 1)), /safety limit/);
  assert.equal(parseBranchRefs(Array.from({ length: 205 }, (_, index) => record(`refs/heads/branch-${index}`)).join("")).omitted, 5);
  assert.doesNotMatch(JSON.stringify(parseBranchRefs(record("refs/heads/ghp_secret123"))), /ghp_secret123/);
});

test("real Git branch discovery includes upstream counts and linked worktree occupancy without mutations", async (t) => {
  const f = await fixture(t);
  const linked = join(f.temp, "linked");
  await checked(f.root, ["worktree", "add", "-b", "feature", linked]);
  const before = await checked(f.root, ["show-ref"]);
  const result = await listBranches(f.pi, { cwd: f.root });
  const main = result.branches.find((branch) => branch.name === "main");
  assert.equal(main.current, true);
  assert.equal(main.upstream, "refs/remotes/origin/main");
  assert.equal(main.ahead, 0);
  assert.equal(main.behind, 0);
  assert.deepEqual(result.branches.find((branch) => branch.name === "feature").worktreePaths, [linked]);
  assert.ok(result.branches.some((branch) => branch.name === "origin/main"));
  assert.equal(await checked(f.root, ["show-ref"]), before);
  assert.ok(f.calls.every((args) => ["rev-parse", "for-each-ref", "worktree"].includes(args[0])));
});

test("real Git tracking creates the exact local checkout and upstream; existing and dirty branches are refused", async (t) => {
  const f = await fixture(t);
  const head = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["push", "origin", "HEAD:refs/heads/shared/topic"]);
  const details = await trackBranch(f.pi, { cwd: f.root }, { branchName: "topic", remoteBranch: "shared/topic" });
  assert.equal(details.head, head);
  assert.equal(details.upstream, "origin/shared/topic");
  assert.equal(await checked(f.root, ["symbolic-ref", "--short", "HEAD"]), "topic");
  assert.equal(await checked(f.root, ["config", "branch.topic.merge"]), "refs/heads/shared/topic");
  await assert.rejects(trackBranch(f.pi, { cwd: f.root }, { branchName: "topic" }), /already exists/);
  await writeFile(join(f.root, "dirty"), "keep");
  await assert.rejects(trackBranch(f.pi, { cwd: f.root }, { branchName: "other" }), /clean/);
  await rm(join(f.root, "dirty"));
  await assert.rejects(trackBranch(f.pi, { cwd: f.root }, { branchName: "missing" }), /failed/);
  await assert.rejects(trackBranch(f.pi, { cwd: f.root }, { branchName: "new", remote: "missing" }), /configured/);
  assert.equal(await checked(f.root, ["symbolic-ref", "--short", "HEAD"]), "topic");
  const schema = Compile(registered("track_branch").parameters);
  assert.equal(schema.Check({ branchName: "a" }), true);
  assert.equal(schema.Check({ branchName: "a", force: true }), false);
  assert.equal(schema.Check({}), false);
});

test("real Git base updates verify no-op, fast-forward, divergent merge, and restored conflict", async (t) => {
  for (const mode of ["noop", "ff", "merge", "conflict"]) {
    const f = await fixture(t);
    await checked(f.root, ["switch", "-c", "feature"]);
    await checked(f.root, ["push", "-u", "origin", "feature"]);
    if (["merge", "conflict"].includes(mode)) {
      await writeFile(join(f.root, mode === "conflict" ? "initial.txt" : "feature.txt"), "feature\n");
      await checked(f.root, ["add", "."]);
      await checked(f.root, ["commit", "-m", "feature"]);
    }
    const before = await checked(f.root, ["rev-parse", "HEAD"]);
    if (mode !== "noop") {
      const base = join(f.temp, "base");
      await checked(f.root, ["worktree", "add", base, "main"]);
      await writeFile(join(base, "initial.txt"), "base\n");
      await checked(base, ["add", "."]);
      await checked(base, ["commit", "-m", "base"]);
      await checked(base, ["push", "origin", "main"]);
    }
    const details = await updateFromBase(f.pi, { cwd: f.root }, { baseBranch: "main" });
    assert.equal(details.status, { noop: "already_integrated", ff: "fast_forward", merge: "merge_commit", conflict: "conflict" }[mode]);
    assert.equal(await checked(f.root, ["rev-parse", "--abbrev-ref", "@{u}"]), "origin/feature");
    assert.equal(await checked(f.root, ["status", "--porcelain"]), "");
    if (mode === "conflict") assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), before);
    else {
      await checked(f.root, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
      await checked(f.root, ["merge-base", "--is-ancestor", before, "HEAD"]);
    }
    await writeFile(join(f.root, "dirty"), "keep");
    await assert.rejects(updateFromBase(f.pi, { cwd: f.root }, { baseBranch: "main" }), /clean/);
  }
  const schema = Compile(registered("update_from_base").parameters);
  assert.equal(schema.Check({ baseBranch: "main" }), true);
  assert.equal(schema.Check({ baseBranch: "main", strategy: "theirs" }), false);
});

test("base updates preserve upstream configuration when fetching restores a missing tracking ref", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["switch", "--track", "-c", "feature", "origin/main"]);
  await checked(f.root, ["update-ref", "-d", "refs/remotes/origin/main"]);
  const before = await checked(f.root, ["config", "--get-regexp", "^branch\\.feature\\."]);
  const result = await updateFromBase(f.pi, { cwd: f.root }, { baseBranch: "main" });
  assert.equal(result.status, "already_integrated");
  assert.equal(await checked(f.root, ["config", "--get-regexp", "^branch\\.feature\\."]), before);
  assert.equal(await checked(f.root, ["rev-parse", "--abbrev-ref", "@{u}"]), "origin/main");
});

test("workflow fetches reject symbolic destinations before changing any refs", async (t) => {
  for (const action of ["track", "update"]) {
    const f = await fixture(t);
    await checked(f.root, ["branch", "victim"]);
    await writeFile(join(f.root, "remote.txt"), "remote change\n");
    await checked(f.root, ["add", "."]);
    await checked(f.root, ["commit", "-m", "remote change"]);
    await checked(f.root, ["push", "origin", "HEAD:refs/heads/base"]);
    await checked(f.root, ["symbolic-ref", "refs/remotes/origin/base", "refs/heads/victim"]);
    const before = await checked(f.root, ["show-ref"]);
    const request = action === "track"
      ? trackBranch(f.pi, { cwd: f.root }, { branchName: "topic", remoteBranch: "base" })
      : updateFromBase(f.pi, { cwd: f.root }, { baseBranch: "base" });
    await assert.rejects(request, /symbolic/);
    assert.equal(await checked(f.root, ["show-ref"]), before);
    assert.ok(f.calls.every((args) => args[0] !== "fetch"));
  }
});

test("list_branches has strict schema and named prompt metadata", () => {
  const tool = registered("list_branches");
  const schema = Compile(tool.parameters);
  assert.equal(schema.Check({}), true);
  assert.equal(schema.Check({ force: true }), false);
  assert.ok(tool.promptGuidelines.every((line) => line.includes("list_branches")));
});
