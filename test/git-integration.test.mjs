import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { changeExistingLocalBranch, createLocalBranch, getBranchStatus, pushCurrentBranch } from "../src/git.ts";

function gitEnv() {
  const env = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "branchme-test@example.invalid",
    GIT_AUTHOR_NAME: "BranchMe Test",
    GIT_COMMITTER_EMAIL: "branchme-test@example.invalid",
    GIT_COMMITTER_NAME: "BranchMe Test",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  return env;
}

function execFileResult(command, args, options) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: gitEnv(),
        maxBuffer: 1024 * 1024,
        signal: options.signal,
        timeout: options.timeout ?? 30_000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0, killed: false });
          return;
        }

        const code = typeof error.code === "number" ? error.code : 1;
        resolve({ stdout: error.stdout ?? stdout ?? "", stderr: error.stderr ?? stderr ?? error.message, code, killed: Boolean(error.killed) });
      },
    );
  });
}

async function runGit(cwd, args) {
  const output = await execFileResult("git", args, { cwd });
  if (output.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${output.stderr || output.stdout}`);
  return output;
}

function makeRealGitPi(repoRoot) {
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args), "git args must be passed as an argv array");
      assert.ok(
        options.cwd === repoRoot || options.cwd.startsWith(`${repoRoot}${sep}`),
        `git cwd ${options.cwd} must stay inside temporary repo ${repoRoot}`,
      );
      calls.push({ command, args: [...args], options });
      return execFileResult(command, args, options);
    },
  };
}

async function withTempGitRepo(fn) {
  const rawRoot = await mkdtemp(join(tmpdir(), "branchme-real-git-"));
  const repoRoot = await realpath(rawRoot);
  try {
    await runGit(repoRoot, ["init", "--initial-branch=main"]);
    await runGit(repoRoot, ["config", "user.email", "branchme-test@example.invalid"]);
    await runGit(repoRoot, ["config", "user.name", "BranchMe Test"]);
    await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(repoRoot, "README.md"), "# BranchMe real git fixture\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "initial commit"]);

    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function currentBranch(repoRoot) {
  return (await runGit(repoRoot, ["branch", "--show-current"])).stdout.trim();
}

test("real git getBranchStatus reports a clean local repository", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const pi = makeRealGitPi(repoRoot);
    const details = await getBranchStatus(pi, { cwd: repoRoot });

    assert.equal(details.repoRoot, repoRoot);
    assert.equal(details.currentBranch, "main");
    assert.equal(details.detached, false);
    assert.equal(details.upstream, null);
    assert.equal(details.hasChanges, false);
    assert.equal(details.ahead, null);
    assert.equal(details.behind, null);
    assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
  });
});

test("real git createLocalBranch creates and checks out a branch from HEAD", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const pi = makeRealGitPi(repoRoot);
    const details = await createLocalBranch(pi, { cwd: repoRoot }, "feature/integration");

    assert.deepEqual(details, { repoRoot, previousBranch: "main", newBranch: "feature/integration" });
    assert.equal(await currentBranch(repoRoot), "feature/integration");
    assert.deepEqual(pi.calls.filter((call) => call.args[0] === "switch").map((call) => call.args), [["switch", "-c", "feature/integration"]]);
  });
});

test("real git changeExistingLocalBranch rejects a dirty worktree before switching", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await runGit(repoRoot, ["branch", "feature/target"]);
    await writeFile(join(repoRoot, "dirty.txt"), "dirty\n", "utf8");

    const pi = makeRealGitPi(repoRoot);
    await assert.rejects(() => changeExistingLocalBranch(pi, { cwd: repoRoot }, "feature/target"), /uncommitted changes/i);

    assert.equal(await currentBranch(repoRoot), "main");
    assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
  });
});

test("real git branch-required operations fail clearly on detached HEAD", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await runGit(repoRoot, ["switch", "--detach", "HEAD"]);

    const pi = makeRealGitPi(repoRoot);
    await assert.rejects(() => pushCurrentBranch(pi, { cwd: repoRoot }), /detached/i);

    assert.equal(pi.calls.some((call) => call.args[0] === "push"), false);
  });
});
