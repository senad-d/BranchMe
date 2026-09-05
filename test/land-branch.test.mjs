import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { landBranch, formatLandBranch } from "../src/git-landing.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";
import { LAND_BRANCH_TOOL_NAME, BRANCHME_TOOL_NAMES } from "../src/constants.ts";

const execFileAsync = promisify(execFile);
const sourceBranch = "feature/land-me";
const targetBranch = "main";

function gitEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_AUTHOR_NAME: "BranchMe Landing Test",
    GIT_AUTHOR_EMAIL: "branchme-landing@example.invalid",
    GIT_COMMITTER_NAME: "BranchMe Landing Test",
    GIT_COMMITTER_EMAIL: "branchme-landing@example.invalid",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function executeGit(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd, env: gitEnvironment(), encoding: "utf8", maxBuffer: 1024 * 1024,
      signal: options.signal, timeout: options.timeout ?? 30_000,
    });
    return { ...result, code: 0, killed: false };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, code: error.code ?? 1, killed: Boolean(error.killed) };
  }
}

async function git(cwd, args) {
  const result = await executeGit(cwd, args);
  assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trimEnd();
}

async function head(cwd, ref = "HEAD") {
  return git(cwd, ["rev-parse", "--verify", ref]);
}

async function fixture(merged = true) {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "branchme-land-")));
  const root = join(temporaryRoot, "primary");
  const origin = join(temporaryRoot, "origin.git");
  const worktree = join(temporaryRoot, "linked");
  await mkdir(root);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "README.md"), "initial\n");
  await writeFile(join(root, ".gitignore"), ".env\n.pi/\nnode_modules/\ndist/\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", origin]);
  await git(root, ["push", "-u", "origin", "main"]);
  const before = await head(root, "refs/heads/main");
  await git(root, ["worktree", "add", "-b", sourceBranch, worktree]);
  await writeFile(join(worktree, "merged.txt"), "feature\n");
  await git(worktree, ["add", "merged.txt"]);
  await git(worktree, ["commit", "-m", "feature"]);
  const sourceHead = await head(worktree);
  await git(worktree, ["push", "origin", `HEAD:refs/heads/${sourceBranch}`]);
  if (merged) await git(worktree, ["push", "origin", "HEAD:refs/heads/main"]);
  // Restore a stale tracking ref so landing must actually fetch the remote target.
  await git(root, ["update-ref", "refs/remotes/origin/main", before]);
  const remoteRefs = await git(origin, ["show-ref"]);
  return { temporaryRoot, root, origin, worktree, before, sourceHead, remoteRefs };
}

function realGitPi(f) {
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.equal(args[0], "-C", "every landing command must use explicit -C");
      assert.equal(args[1], options.cwd);
      assert.ok(options.cwd.startsWith(f.temporaryRoot));
      calls.push([...args]);
      return executeGit(options.cwd, args, options);
    },
  };
}

async function land(f, overrides = {}, cwd = f.root, pi = realGitPi(f)) {
  const receipt = await landBranch(pi, { cwd }, { sourceBranch, targetBranch, ...overrides });
  assert.deepEqual(receipt.steps.map((entry) => entry.step), ["repository", "cwd", "fetch", "ancestry", "worktree", "branch", "targetSync"]);
  assert.equal(receipt.repositoryRoot, f.root);
  assert.equal(receipt.remote, "origin");
  assert.equal(await git(f.origin, ["show-ref"]), f.remoteRefs, "remote refs must never change");
  for (const args of pi.calls) {
    assert.equal(args.some((arg) => ["--force", "-f", "-D", "stash", "reset", "checkout", "switch", "prune", "push"].includes(arg)), false);
  }
  return receipt;
}

async function assertCleaned(f, receipt, mode) {
  assert.equal(receipt.worktree.outcome, "removed", JSON.stringify(receipt));
  assert.equal(receipt.branch.outcome, "deleted", JSON.stringify(receipt));
  assert.equal(receipt.sourceHead, f.sourceHead);
  assert.equal(receipt.branch.expectedHead, f.sourceHead);
  assert.equal(receipt.remoteTargetHead, f.sourceHead);
  assert.equal(receipt.ancestry.isAncestor, true);
  assert.equal(receipt.targetSync.mode, mode, JSON.stringify(receipt));
  await assert.rejects(access(f.worktree));
  assert.equal((await executeGit(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${sourceBranch}`])).code, 1);
  assert.equal(await head(f.root, `refs/remotes/origin/${sourceBranch}`), f.sourceHead);
}

async function ignoredResidue(path) {
  await writeFile(join(path, ".env"), "TEST_SECRET=keep-out-of-receipt\n");
  for (const directory of [".pi", "node_modules", "dist"]) {
    await mkdir(join(path, directory, "nested"), { recursive: true });
    await writeFile(join(path, directory, "nested", "residue"), "ignored\n");
  }
}

test("happy path repairs main parked in linked worktree with ignored residue while primary is dirty on another branch", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await git(f.root, ["switch", "-c", "unrelated-work"]);
  await git(f.worktree, ["switch", "main"]);
  await writeFile(join(f.root, "README.md"), "dirty primary\n");
  await ignoredResidue(f.worktree);
  await mkdir(join(f.root, "subdir"));
  const statusBefore = await git(f.root, ["status", "--porcelain=v1"]);
  const reflogBefore = await git(f.root, ["reflog", "show", "--format=%H", "main"]);
  const pi = realGitPi(f);
  const receipt = await land(f, { worktreePath: f.worktree }, join(f.root, "subdir"), pi);
  await assertCleaned(f, receipt, "fetch-refspec");
  assert.deepEqual(receipt.worktree.deletedIgnoredPaths, [".env", ".pi", "dist", "node_modules"]);
  assert.equal(JSON.stringify(receipt).includes("keep-out-of-receipt"), false);
  assert.equal(receipt.targetSync.before, f.before);
  assert.equal(receipt.targetSync.after, f.sourceHead);
  assert.equal(receipt.targetSync.worktreePath, null);
  assert.deepEqual(receipt.targetSync.aheadBehind, { ahead: 0, behind: 0 });
  assert.equal(await head(f.root, "refs/heads/main"), f.sourceHead);
  assert.notEqual(await git(f.root, ["reflog", "show", "--format=%H", "main"]), reflogBefore);
  assert.equal(await head(f.root), f.before);
  assert.equal(await git(f.root, ["symbolic-ref", "--short", "HEAD"]), "unrelated-work");
  assert.equal(await git(f.root, ["status", "--porcelain=v1"]), statusBefore);
  const mutationCalls = pi.calls.filter((args) => args.includes("fetch") || args.includes("update-ref") || args.includes("remove"));
  assert.deepEqual(mutationCalls.map((args) => args[2]), ["fetch", "worktree", "update-ref", "fetch"]);
  assert.deepEqual(mutationCalls[2].slice(2), ["update-ref", "--no-deref", "-d", `refs/heads/${sourceBranch}`, f.sourceHead]);
  assert.ok(mutationCalls[3].includes("refs/heads/main:refs/heads/main"));
});

test("clean target in primary uses pull-ff and moves the ref and reflog", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  // No configured upstream is needed for an explicit target pull.
  await git(f.root, ["branch", "--unset-upstream", "main"]);
  const receipt = await land(f);
  await assertCleaned(f, receipt, "pull-ff");
  assert.equal(receipt.targetSync.worktreePath, f.root);
  assert.equal(receipt.targetSync.before, f.before);
  assert.equal(receipt.targetSync.after, f.sourceHead);
  assert.equal(await head(f.root), f.sourceHead);
  assert.equal((await git(f.root, ["reflog", "show", "--format=%H", "main"])).split("\n")[0], f.sourceHead);
});

test("dirty target is skipped independently of successful worktree removal and branch retirement", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await writeFile(join(f.root, "README.md"), "do not touch\n");
  await git(f.root, ["branch", "--unset-upstream", "main"]);
  const receipt = await land(f);
  await assertCleaned(f, receipt, "skipped-dirty");
  assert.equal(receipt.targetSync.worktreePath, f.root);
  assert.equal(receipt.targetSync.before, f.before);
  assert.equal(receipt.targetSync.after, f.before);
  assert.deepEqual(receipt.targetSync.aheadBehind, { ahead: 0, behind: 1 });
  assert.equal(await readFile(join(f.root, "README.md"), "utf8"), "do not touch\n");
});

test("unmerged source refuses all cleanup and target sync", async (t) => {
  const f = await fixture(false);
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  const receipt = await land(f);
  assert.equal(receipt.ancestry.isAncestor, false);
  assert.equal(receipt.worktree.outcome, "refused");
  assert.equal(receipt.branch.outcome, "refused");
  assert.equal(receipt.targetSync.mode, "not-run");
  assert.equal(await head(f.root, `refs/heads/${sourceBranch}`), f.sourceHead);
  assert.equal(await head(f.root), f.before);
  await access(f.worktree);
});

test("untracked non-ignored file refuses removal and retirement but still syncs target", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await writeFile(join(f.worktree, "untracked.txt"), "preserve me\n");
  await git(f.worktree, ["config", "status.showUntrackedFiles", "no"]);
  const receipt = await land(f);
  assert.equal(receipt.worktree.outcome, "refused");
  assert.match(receipt.worktree.reason, /untracked/iu);
  assert.equal(receipt.branch.outcome, "refused");
  assert.equal(receipt.targetSync.mode, "pull-ff");
  assert.equal(receipt.targetSync.after, f.sourceHead);
  assert.equal(await head(f.root, `refs/heads/${sourceBranch}`), f.sourceHead);
  assert.equal(await readFile(join(f.worktree, "untracked.txt"), "utf8"), "preserve me\n");
});

test("cwd inside the selected worktree refuses before fetch with a run-from-root message", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await mkdir(join(f.worktree, "subdir"));
  const pi = realGitPi(f);
  const receipt = await land(f, { worktreePath: f.worktree }, join(f.worktree, "subdir"), pi);
  assert.equal(receipt.worktree.outcome, "refused");
  assert.match(formatLandBranch(receipt), /run from the repository root/u);
  assert.equal(receipt.branch.outcome, "refused");
  assert.equal(receipt.targetSync.mode, "not-run");
  assert.equal(pi.calls.some((args) => args.includes("fetch")), false);
  assert.equal(await head(f.root, `refs/heads/${sourceBranch}`), f.sourceHead);
  await access(f.worktree);
});

test("second call after success is idempotent with explicit or inferred missing worktree", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await assertCleaned(f, await land(f), "pull-ff");
  const reflogBefore = await git(f.root, ["reflog", "show", "--format=%H", "main"]);
  for (const params of [{ worktreePath: f.worktree }, {}]) {
    const receipt = await land(f, params);
    assert.equal(receipt.worktree.outcome, "absent");
    assert.equal(receipt.branch.outcome, "absent");
    assert.equal(receipt.sourceHead, null);
    assert.equal(receipt.ancestry.isAncestor, null);
    assert.equal(receipt.targetSync.mode, "noop");
    assert.equal(receipt.targetSync.before, f.sourceHead);
    assert.equal(receipt.targetSync.after, f.sourceHead);
  }
  assert.equal(await git(f.root, ["reflog", "show", "--format=%H", "main"]), reflogBefore);
});

test("divergent unoccupied target is never force-updated and reports real unchanged refs", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await writeFile(join(f.root, "local-only"), "local history\n");
  await git(f.root, ["add", "local-only"]);
  await git(f.root, ["commit", "-m", "local divergence"]);
  const divergent = await head(f.root);
  await git(f.root, ["switch", "-c", "other"]);
  const receipt = await land(f);
  await assertCleaned(f, receipt, "failed");
  assert.equal(receipt.targetSync.before, divergent);
  assert.equal(receipt.targetSync.after, divergent);
  assert.deepEqual(receipt.targetSync.aheadBehind, { ahead: 1, behind: 1 });
});

test("fetch diagnostics are redacted in both receipt and summary", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  const pi = realGitPi(f);
  const routed = { calls: pi.calls, exec: failFetch.bind(undefined, pi) };
  const receipt = await land(f, {}, f.root, routed);
  assert.equal(receipt.worktree.outcome, "refused");
  assert.equal(receipt.targetSync.mode, "not-run");
  assert.doesNotMatch(JSON.stringify(receipt) + formatLandBranch(receipt), /password123|ghp_testSecret/);
  assert.match(receipt.worktree.reason, /REDACTED/u);
});

async function failFetch(pi, command, args, options) {
  if (args.includes("fetch")) return { stdout: "", stderr: "failed https://user:password123@host/repo token=ghp_testSecret", code: 1, killed: false };
  return pi.exec(command, args, options);
}

test("a successful pull exit without a ref update is reported as failed, never a fast-forward", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  const pi = realGitPi(f);
  const routed = { calls: pi.calls, exec: pretendPullSucceeded.bind(undefined, pi) };
  const receipt = await land(f, {}, f.root, routed);
  await assertCleaned(f, receipt, "failed");
  assert.equal(receipt.targetSync.before, f.before);
  assert.equal(receipt.targetSync.after, f.before);
  assert.match(receipt.targetSync.reason, /did not produce a verified target fast-forward/u);
});

async function pretendPullSucceeded(pi, command, args, options) {
  if (args.includes("pull")) return { stdout: "Fast-forward\n", stderr: "", code: 0, killed: false };
  return pi.exec(command, args, options);
}

test("a source move at the deletion boundary is protected by the expected-HEAD lease and does not block target sync", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  const pi = realGitPi(f);
  const routed = { calls: pi.calls, exec: moveSourceBeforeDeletion.bind(undefined, f, pi) };
  const receipt = await land(f, {}, f.root, routed);
  assert.equal(receipt.worktree.outcome, "removed");
  assert.equal(receipt.branch.outcome, "refused");
  assert.equal(receipt.branch.expectedHead, f.sourceHead);
  assert.equal(await head(f.root, `refs/heads/${sourceBranch}`), f.before);
  assert.equal(receipt.targetSync.mode, "pull-ff");
  assert.equal(receipt.targetSync.after, f.sourceHead);
});

async function moveSourceBeforeDeletion(f, pi, command, args, options) {
  if (args.includes("update-ref") && args.includes("-d")) {
    await git(f.root, ["update-ref", `refs/heads/${sourceBranch}`, f.before, f.sourceHead]);
  }
  return pi.exec(command, args, options);
}

test("configured prune and extra fetch mappings cannot mutate unrelated local or tracking refs", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await git(f.root, ["update-ref", "refs/remotes/origin/stale", f.before]);
  await git(f.root, ["branch", "unrelated", f.before]);
  await git(f.root, ["config", "fetch.prune", "true"]);
  await git(f.root, ["config", "remote.origin.prune", "true"]);
  await git(f.root, ["config", "fetch.pruneTags", "true"]);
  await git(f.root, ["config", "remote.origin.pruneTags", "true"]);
  await git(f.root, ["config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/unrelated"]);
  const receipt = await land(f);
  await assertCleaned(f, receipt, "pull-ff");
  assert.equal(await head(f.root, "refs/remotes/origin/stale"), f.before);
  assert.equal(await head(f.root, "refs/heads/unrelated"), f.before);
});

test("actual process cwd is protected even when the tool context points at the primary", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  const previousCwd = process.cwd();
  try {
    process.chdir(f.worktree);
    const receipt = await land(f, { worktreePath: f.worktree });
    assert.equal(receipt.worktree.outcome, "refused");
    assert.match(receipt.worktree.reason, /run from the repository root/u);
  } finally {
    process.chdir(previousCwd);
  }
});

test("registered tool returns receipts and refuses target mergeOptions without blocking cleanup", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temporaryRoot, { recursive: true, force: true }));
  await git(f.root, ["config", "branch.main.mergeOptions", "--squash"]);
  const tools = [];
  registerBranchMeTools({ ...realGitPi(f), registerTool: tools.push.bind(tools) });
  const tool = tools.find((entry) => entry.name === LAND_BRANCH_TOOL_NAME);
  const result = await tool.execute("landing-test", { sourceBranch, targetBranch }, undefined, undefined, { cwd: f.root });
  await assertCleaned(f, result.details, "failed");
  assert.equal(result.content[0].text, formatLandBranch(result.details));
  assert.doesNotMatch(result.content[0].text, /\n/u);
  assert.match(result.details.targetSync.reason, /mergeOptions/u);
  assert.equal(await head(f.root), f.before);
  assert.equal(await git(f.root, ["status", "--porcelain=v1"]), "");
});

test("registration is lazy and exposes strict landing schema and safety guidance", () => {
  const tools = [];
  registerBranchMeTools({ registerTool: tools.push.bind(tools), exec: unexpectedExec });
  const tool = tools.find((entry) => entry.name === LAND_BRANCH_TOOL_NAME);
  assert.ok(BRANCHME_TOOL_NAMES.includes(LAND_BRANCH_TOOL_NAME));
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["sourceBranch", "targetBranch"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["sourceBranch", "targetBranch", "remote", "worktreePath"]);
  assert.equal(tool.parameters.additionalProperties, false);
  const guidance = tool.promptGuidelines.join(" ");
  assert.match(guidance, /cwd-independent/u);
  assert.match(guidance, /run from the repository root/u);
  assert.match(guidance, /deletes ignored files/u);
  assert.match(guidance, /never touches a dirty checkout/u);
  assert.match(guidance, /pull request merged on the host/u);
});

function unexpectedExec() {
  assert.fail("tool registration must not execute Git");
}
