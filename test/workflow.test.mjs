import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { Compile } from "typebox/compile";
import { listBranches, parseBranchRefs } from "../src/git.ts";
import { concludeMerge } from "../src/git-integration.ts";
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

async function fixture(t, initialPath = "initial.txt") {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "branchme-workflow-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  const remote = join(temp, "remote.git");
  await mkdir(root);
  await checked(root, ["init", "--initial-branch=main"]);
  await checked(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, initialPath), "initial\n");
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

function executeRegisteredTool(byName, ctx, name, params) {
  return byName.get(name).execute(name, params, undefined, undefined, ctx);
}

function realTools(f) {
  const tools = [];
  registerBranchMeTools({ registerTool: tools.push.bind(tools), exec: f.pi.exec });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return executeRegisteredTool.bind(undefined, byName, { cwd: f.root });
}

async function conflictFixture(t, initialPath = "initial.txt") {
  const f = await fixture(t, initialPath);
  await checked(f.root, ["switch", "-c", "feature"]);
  await writeFile(join(f.root, initialPath), "feature\n");
  await writeFile(join(f.root, "other.txt"), "other\n");
  await checked(f.root, ["add", "."]);
  await checked(f.root, ["commit", "-m", "feature"]);
  await checked(f.root, ["push", "-u", "origin", "feature"]);
  const base = join(f.temp, "base");
  await checked(f.root, ["worktree", "add", base, "main"]);
  await writeFile(join(base, initialPath), "base\n");
  await checked(base, ["add", "."]);
  await checked(base, ["commit", "-m", "base"]);
  await checked(base, ["push", "origin", "main"]);
  return { ...f, before: await checked(f.root, ["rev-parse", "HEAD"]), baseHead: await checked(base, ["rev-parse", "HEAD"]) };
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

test("real Git base-update conflicts list their paths, stay in progress with keepConflicts, and conclude or abort through conclude_merge", async (t) => {
  for (const action of ["conclude", "abort"]) {
    const f = await conflictFixture(t);
    const run = realTools(f);
    const noMerge = run("conclude_merge", { action });
    await assert.rejects(noMerge, /no merge is in progress/);

    const aborted = await run("update_from_base", { baseBranch: "main" });
    assert.equal(aborted.details.status, "conflict");
    assert.equal(aborted.content[0].text, [
      `update_from_base: conflict. Merging origin/main into feature conflicted; the merge was automatically aborted and restoration was verified at HEAD ${f.before.slice(0, 12)}. Rerun with keepConflicts: true to keep the conflicted merge in progress for resolution.`,
      "Conflict paths:",
      "- initial.txt",
    ].join("\n"));
    assert.equal(await checked(f.root, ["status", "--porcelain"]), "");

    const kept = await run("update_from_base", { baseBranch: "main", keepConflicts: true });
    assert.equal(kept.details.status, "conflict_kept");
    assert.deepEqual(kept.details.integration.conflict, { paths: [{ path: "initial.txt" }], omitted: 0, kept: true, mergeInProgress: true });
    assert.deepEqual(kept.details.integration.heads, { sourceHead: f.baseHead, targetHead: f.before });
    assert.match(kept.content[0].text, /^update_from_base: conflict_kept\. .*merge is in progress with MERGE_HEAD set.*conclude_merge.*\nConflict paths:\n- initial\.txt$/su);
    assert.equal(await checked(f.root, ["rev-parse", "--verify", "MERGE_HEAD"]), f.baseHead);
    assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
    assert.equal(await checked(f.root, ["diff", "--name-only", "--diff-filter=U"]), "initial.txt");
    assert.match(await readFile(join(f.root, "initial.txt"), "utf8"), /^<<<<<<< /mu);
    assert.equal(await checked(f.root, ["rev-parse", "--abbrev-ref", "@{u}"]), "origin/feature");
    await assert.rejects(run("update_from_base", { baseBranch: "main" }), /in-progress Git operation/);

    if (action === "abort") {
      const restored = await run("conclude_merge", { action: "abort" });
      assert.equal(restored.details.status, "aborted");
      assert.equal(restored.details.head, f.before);
      assert.equal(restored.details.mergeHead, f.baseHead);
      assert.equal(restored.content[0].text, `conclude_merge: aborted. git merge --abort restored feature to HEAD ${f.before.slice(0, 12)}; MERGE_HEAD ${f.baseHead.slice(0, 12)} is cleared, no Git operation is in progress, and the working tree is clean.`);
      assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
      assert.equal(await checked(f.root, ["status", "--porcelain"]), "");
      assert.equal((await git(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code, 1);
      assert.equal(await readFile(join(f.root, "initial.txt"), "utf8"), "feature\n");
      continue;
    }

    await writeFile(join(f.root, "other.txt"), "edited but unstaged\n");
    await writeFile(join(f.root, "untracked.txt"), "untracked\n");
    await assert.rejects(run("conclude_merge", { action: "conclude" }), (error) => {
      assert.equal(error.message, "conclude_merge: refused. Conflict markers remain in 1 path; remove every <<<<<<<, |||||||, =======, and >>>>>>> marker line, then retry conclude_merge or abort it.\nPaths with markers:\n- initial.txt");
      return true;
    });
    assert.equal(await checked(f.root, ["rev-parse", "--verify", "MERGE_HEAD"]), f.baseHead);
    assert.ok(f.calls.every((args) => args[0] !== "commit" && !args.includes("add")));

    await writeFile(join(f.root, "initial.txt"), "resolved\n");
    const concluded = await run("conclude_merge", { action: "conclude" });
    const head = await checked(f.root, ["rev-parse", "HEAD"]);
    assert.equal(concluded.details.status, "concluded");
    assert.deepEqual(concluded.details.heads, { before: f.before, after: head });
    assert.deepEqual(concluded.details.parents, { first: f.before, second: f.baseHead });
    assert.equal(concluded.details.mergeHead, f.baseHead);
    assert.deepEqual(concluded.details.resolvedPaths, [{ path: "initial.txt" }]);
    assert.equal(concluded.content[0].text, [
      `conclude_merge: concluded. Committed merge ${head.slice(0, 12)} on feature with parents ${f.before.slice(0, 12)} (previous HEAD) and ${f.baseHead.slice(0, 12)} (MERGE_HEAD); MERGE_HEAD is cleared and both parents were verified. Only the 1 resolved path listed below was staged during this call; other working-tree changes remain unstaged. The commit includes all previously staged entries.`,
      "Resolved paths:",
      "- initial.txt",
    ].join("\n"));
    assert.equal(await checked(f.root, ["rev-list", "--parents", "-n", "1", "HEAD"]), `${head} ${f.before} ${f.baseHead}`);
    assert.equal((await git(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code, 1);
    assert.equal(await checked(f.root, ["status", "--porcelain"]), " M other.txt\n?? untracked.txt");
    assert.equal(await checked(f.root, ["show", "HEAD:initial.txt"]), "resolved");
    assert.equal(await checked(f.root, ["show", "HEAD:other.txt"]), "other");
    assert.match(await checked(f.root, ["log", "-1", "--format=%s"]), /^Merge /u);
    assert.equal(await checked(f.root, ["rev-parse", "--abbrev-ref", "@{u}"]), "origin/feature");
    assert.deepEqual(f.calls.filter((args) => args.includes("add") || args[0] === "commit"), [
      ["--literal-pathspecs", "add", "--", "initial.txt"],
      ["commit", "--no-edit"],
    ]);
    await assert.rejects(run("conclude_merge", { action: "abort" }), /no merge is in progress/);
  }

  const schema = Compile(registered("conclude_merge").parameters);
  assert.equal(schema.Check({ action: "conclude" }), true);
  assert.equal(schema.Check({ action: "abort" }), true);
  assert.equal(schema.Check({}), false);
  assert.equal(schema.Check({ action: "continue" }), false);
  assert.equal(schema.Check({ action: "abort", force: true }), false);
  const updateSchema = Compile(registered("update_from_base").parameters);
  assert.equal(updateSchema.Check({ baseBranch: "main", keepConflicts: true }), true);
  assert.equal(updateSchema.Check({ baseBranch: "main", keepConflicts: "yes" }), false);
});

test("keepConflicts falls back to the verified abort when conflict paths cannot be captured", async (t) => {
  const f = await conflictFixture(t);
  const pi = {
    async exec(command, args, options) {
      if (args[0] === "diff" && args.includes("--diff-filter=U")) return { stdout: "", stderr: "diff unavailable", code: 128, killed: false };
      return f.pi.exec(command, args, options);
    },
  };
  await assert.rejects(
    updateFromBase(pi, { cwd: f.root }, { baseBranch: "main", keepConflicts: true }),
    /keepConflicts could not be honored\. The failed merge was restored, but conflict paths could not be classified safely/,
  );
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
  assert.equal(await checked(f.root, ["status", "--porcelain"]), "");
  assert.equal((await git(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code, 1);
  assert.deepEqual(f.calls.filter((args) => args[0] === "merge" && args[1] === "--abort"), [["merge", "--abort"]]);
});

test("conclude_merge checks the staged blob even when its worktree file is marker-free", async (t) => {
  const f = await conflictFixture(t);
  const run = realTools(f);
  await run("update_from_base", { baseBranch: "main", keepConflicts: true });
  await checked(f.root, ["add", "initial.txt"]);
  await writeFile(join(f.root, "initial.txt"), "resolved but unstaged\n");
  await assert.rejects(run("conclude_merge", { action: "conclude" }), /Conflict markers remain in 1 path in the index.*\nPaths with markers:\n- initial\.txt/su);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
  assert.equal(await checked(f.root, ["rev-parse", "MERGE_HEAD"]), f.baseHead);
  assert.ok(f.calls.every((args) => args[0] !== "commit"));
  await checked(f.root, ["add", "initial.txt"]);
  const result = await run("conclude_merge", { action: "conclude" });
  assert.equal(result.details.status, "concluded");
  assert.deepEqual(result.details.resolvedPaths, []);
  assert.equal(await checked(f.root, ["show", "HEAD:initial.txt"]), "resolved but unstaged");
});

test("conclude_merge detects custom-sized, bare, diff3, CRLF and binary marker lines", async (t) => {
  const f = await conflictFixture(t);
  const run = realTools(f);
  await run("update_from_base", { baseBranch: "main", keepConflicts: true });
  for (const size of [3, 9]) {
    await writeFile(join(f.root, ".gitattributes"), `initial.txt conflict-marker-size=${size}\n`);
    for (const marker of ["<", "|", "=", ">"]) {
      await writeFile(join(f.root, "initial.txt"), `prefix\0\n${marker.repeat(size)}\r\ncontent\n`);
      await assert.rejects(run("conclude_merge", { action: "conclude" }), /Conflict markers remain.*\n- initial\.txt$/su);
    }
  }
  assert.ok(f.calls.every((args) => args[0] !== "commit" && !args.includes("add")));
  await rm(join(f.root, ".gitattributes"));
  await run("conclude_merge", { action: "abort" });
});

test("conclude_merge starts independent marker-size groups concurrently and reports every flagged path", async (t) => {
  const f = await conflictFixture(t);
  const run = realTools(f);
  await run("update_from_base", { baseBranch: "main", keepConflicts: true });
  await writeFile(join(f.root, ".gitattributes"), "initial.txt conflict-marker-size=3\n");
  await writeFile(join(f.root, "initial.txt"), "<<< unresolved\n");
  await writeFile(join(f.root, "other.txt"), ">>>>>>> unresolved\n");
  await checked(f.root, ["add", "initial.txt", "other.txt", ".gitattributes"]);
  let groupReads = 0;
  const pi = {
    async exec(command, args, options) {
      if (args.includes("grep") && args.includes("--cached")) {
        groupReads += 1;
        await nextTurn();
        assert.equal(groupReads, 2, "both marker groups must start before either is awaited");
      }
      return f.pi.exec(command, args, options);
    },
  };
  await assert.rejects(concludeMerge(pi, { cwd: f.root }, { action: "conclude" }), (error) => {
    assert.match(error.message, /Conflict markers remain in 2 paths in the index/u);
    assert.match(error.message, /\n- initial\.txt/u);
    assert.match(error.message, /\n- other\.txt/u);
    return true;
  });
  assert.equal(groupReads, 2);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
  assert.ok(f.calls.every((args) => args[0] !== "commit" && !args.includes("add")));
});

test("conclude_merge checks clean-filter output and refuses markers introduced into the index", async (t) => {
  const f = await conflictFixture(t);
  const run = realTools(f);
  await run("update_from_base", { baseBranch: "main", keepConflicts: true });
  await writeFile(join(f.root, "initial.txt"), "resolved\n");
  await writeFile(join(f.root, ".gitattributes"), "initial.txt filter=inject-marker\n");
  await checked(f.root, ["config", "filter.inject-marker.clean", "printf '<<<<<<< injected\\n'"]);
  await assert.rejects(run("conclude_merge", { action: "conclude" }), /Conflict markers remain in 1 path in the index/su);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
  assert.equal(await checked(f.root, ["rev-parse", "MERGE_HEAD"]), f.baseHead);
  assert.ok(f.calls.some((args) => args.includes("add")));
  assert.ok(f.calls.every((args) => args[0] !== "commit"));
});

test("conclude_merge stages resolved deletions and uses literal pathspecs for special names", async (t) => {
  for (const deleted of [false, true]) {
    const path = ":(glob)*.txt";
    const f = await conflictFixture(t, path);
    const run = realTools(f);
    const kept = await run("update_from_base", { baseBranch: "main", keepConflicts: true });
    assert.equal(kept.details.status, "conflict_kept");
    assert.deepEqual(kept.details.integration.conflict.paths, [{ path }]);
    await assert.rejects(run("conclude_merge", { action: "conclude" }), /Conflict markers remain/u);
    if (deleted) await rm(join(f.root, path));
    else await writeFile(join(f.root, path), "resolved\n");
    const result = await run("conclude_merge", { action: "conclude" });
    assert.equal(result.details.parents.first, f.before);
    assert.deepEqual(result.details.resolvedPaths, [{ path }]);
    assert.equal(await checked(f.root, ["status", "--porcelain"]), "");
    if (deleted) assert.equal(await checked(f.root, ["ls-tree", "--name-only", "HEAD"]), "other.txt");
    else assert.equal(await checked(f.root, ["show", `HEAD:${path}`]), "resolved");
  }
});

test("conclude_merge rejects a multi-head merge before any staging or commit", async (t) => {
  const f = await conflictFixture(t);
  const run = realTools(f);
  await run("update_from_base", { baseBranch: "main", keepConflicts: true });
  const mergeHeadPath = await checked(f.root, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]);
  await writeFile(mergeHeadPath, `${f.baseHead}\n${f.before}\n`);
  await writeFile(join(f.root, "initial.txt"), "resolved\n");
  await assert.rejects(run("conclude_merge", { action: "conclude" }), /multi-head merges are not supported/u);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), f.before);
  assert.ok(f.calls.every((args) => args[0] !== "commit" && !args.includes("add")));
});

test("conclude_merge honors cancellation until staging and reports uncertainty after a lost commit response", async (t) => {
  const f = await conflictFixture(t);
  const run = realTools(f);
  await run("update_from_base", { baseBranch: "main", keepConflicts: true });
  await writeFile(join(f.root, "initial.txt"), "resolved\n");
  const controller = new AbortController();
  const cancellingPi = {
    async exec(command, args, options) {
      const result = await f.pi.exec(command, args, options);
      if (args.includes("grep")) controller.abort();
      return result;
    },
  };
  await assert.rejects(concludeMerge(cancellingPi, { cwd: f.root }, { action: "conclude" }, controller.signal), /abort/iu);
  assert.ok(f.calls.every((args) => args[0] !== "commit" && !args.includes("add")));
  const lostResponsePi = {
    async exec(command, args, options) {
      const result = await f.pi.exec(command, args, options);
      if (args[0] === "commit") throw new Error("commit response unavailable");
      return result;
    },
  };
  await assert.rejects(concludeMerge(lostResponsePi, { cwd: f.root }, { action: "conclude" }), /postconditions are uncertain.*inspect the repository before retrying.*commit response unavailable/su);
  const head = await checked(f.root, ["rev-parse", "HEAD"]);
  assert.notEqual(head, f.before);
  assert.equal(await checked(f.root, ["rev-list", "--parents", "-n", "1", "HEAD"]), `${head} ${f.before} ${f.baseHead}`);
  assert.equal((await git(f.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code, 1);
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

test("base updates start independent upstream configuration reads together", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["switch", "--track", "-c", "feature", "origin/main"]);
  const before = await checked(f.root, ["config", "--get-regexp", "^branch\\.feature\\."]);
  let remoteReads = 0;
  let mergeReads = 0;
  const pi = {
    async exec(command, args, options) {
      if (args[0] === "config" && args[3] === "branch.feature.remote") {
        remoteReads += 1;
        await nextTurn();
        assert.equal(mergeReads, remoteReads, "both independent config reads must start before either is awaited");
      }
      if (args[0] === "config" && args[3] === "branch.feature.merge") mergeReads += 1;
      return f.pi.exec(command, args, options);
    },
  };

  const result = await updateFromBase(pi, { cwd: f.root }, { baseBranch: "main" });
  assert.equal(result.status, "already_integrated");
  assert.equal(remoteReads, 2);
  assert.equal(mergeReads, 2);
  assert.equal(await checked(f.root, ["config", "--get-regexp", "^branch\\.feature\\."]), before);
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
