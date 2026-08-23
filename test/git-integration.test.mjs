import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import {
  changeExistingLocalBranch,
  createLocalBranch,
  fetchCurrentBranch,
  getBranchStatus,
  createWorktree,
  getRecentCommits,
  getWorkingTreeStatus,
  listWorktrees,
  pullCurrentBranch,
  removeWorktree,
  pushCurrentBranch,
  rebaseCurrentBranch,
} from "../src/git.ts";

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

function pathIsInside(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function makeRealGitPi(repoRoot, approvedWorktreePaths = []) {
  const temporaryRoot = dirname(repoRoot);
  assert.equal(
    approvedWorktreePaths.every((worktreePath) => pathIsInside(worktreePath, temporaryRoot)),
    true,
    "approved worktrees must stay inside the temporary test root",
  );

  const allowedRoots = [repoRoot, ...approvedWorktreePaths];
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args), "git args must be passed as an argv array");
      assert.ok(
        allowedRoots.some((allowedRoot) => pathIsInside(options.cwd, allowedRoot)),
        `git cwd ${options.cwd} must stay inside an approved temporary checkout`,
      );
      calls.push({ command, args: [...args], options });
      return execFileResult(command, args, options);
    },
  };
}

async function withTempGitRepo(fn) {
  const rawTemporaryRoot = await mkdtemp(join(tmpdir(), "branchme-real-git-"));
  const temporaryRoot = await realpath(rawTemporaryRoot);
  const repoRoot = join(temporaryRoot, "source");
  try {
    await mkdir(repoRoot);
    await runGit(repoRoot, ["init", "--initial-branch=main"]);
    await runGit(repoRoot, ["config", "user.email", "branchme-test@example.invalid"]);
    await runGit(repoRoot, ["config", "user.name", "BranchMe Test"]);
    await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(repoRoot, "README.md"), "# BranchMe real git fixture\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "initial commit"]);

    return await fn(repoRoot, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function currentBranch(repoRoot) {
  return (await runGit(repoRoot, ["branch", "--show-current"])).stdout.trim();
}

test("real git getBranchStatus reports a clean local repository", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const pi = makeRealGitPi(repoRoot);
    const details = await getBranchStatus(pi, { cwd: repoRoot });
    const workingTree = await getWorkingTreeStatus(pi, { cwd: repoRoot });
    const recentCommits = await getRecentCommits(pi, { cwd: repoRoot });

    assert.equal(details.repoRoot, repoRoot);
    assert.equal(details.currentBranch, "main");
    assert.equal(details.detached, false);
    assert.equal(details.upstream, null);
    assert.equal(details.hasChanges, false);
    assert.equal(details.ahead, null);
    assert.equal(details.behind, null);
    assert.deepEqual(workingTree, {
      workingTree: { state: "clean", staged: 0, unstaged: 0, untracked: 0 },
      unstagedChanges: { entries: [], omitted: 0 },
    });
    assert.equal(recentCommits.length, 1);
    assert.equal(recentCommits[0].subject, "initial commit");
    assert.equal(recentCommits[0].hash.startsWith(recentCommits[0].shortHash), true);
    assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
  });
});

test("real git listWorktrees reports the main worktree", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const pi = makeRealGitPi(repoRoot);
    const head = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const details = await listWorktrees(pi, { cwd: repoRoot });

    assert.equal(details.action, "list_worktrees");
    assert.equal(details.repoRoot, repoRoot);
    assert.equal(details.omitted, 0);
    assert.deepEqual(details.worktrees, [
      {
        path: repoRoot,
        head,
        branch: "main",
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        main: true,
        current: true,
      },
    ]);
    assert.deepEqual(pi.calls.filter((call) => call.args[0] === "worktree").map((call) => call.args), [
      ["worktree", "list", "--porcelain", "-z"],
    ]);
  });
});

test("real git worktree lifecycle preserves a dirty source and retained branch", async () => {
  await withTempGitRepo(async (repoRoot, temporaryRoot) => {
    const worktreePath = join(temporaryRoot, "feature-new");
    const pi = makeRealGitPi(repoRoot, [worktreePath]);
    const sourceHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repoRoot, "README.md"), "# Dirty source remains\n", "utf8");

    const created = await createWorktree(
      pi,
      { cwd: repoRoot },
      worktreePath,
      "feature/integration-worktree",
      "new",
    );

    assert.equal(created.action, "create_worktree");
    assert.equal(created.verified.before.sourceHead, sourceHead);
    assert.equal(created.verified.before.branchExisted, false);
    assert.equal(created.verified.after.worktree.path, worktreePath);
    assert.deepEqual(created.verified.after.workingTree, {
      state: "clean",
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
    assert.deepEqual(
      {
        cwd: created.handoff.cwd,
        branch: created.handoff.branch,
        head: created.handoff.head,
        ready: created.handoff.ready,
      },
      {
        cwd: worktreePath,
        branch: "feature/integration-worktree",
        head: sourceHead,
        ready: true,
      },
    );
    assert.equal(await currentBranch(repoRoot), "main");
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "# Dirty source remains\n");
    assert.equal((await runGit(repoRoot, ["status", "--porcelain"])).stdout, " M README.md\n");
    assert.equal(await currentBranch(worktreePath), "feature/integration-worktree");
    assert.equal((await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(), sourceHead);
    assert.equal((await runGit(worktreePath, ["status", "--porcelain"])).stdout, "");

    const listed = await listWorktrees(pi, { cwd: repoRoot });
    assert.equal(listed.worktrees.length, 2);
    assert.equal(listed.worktrees[0].main, true);
    assert.equal(listed.worktrees[0].current, true);
    assert.equal(listed.worktrees[1].path, worktreePath);
    assert.equal(listed.worktrees[1].branch, "feature/integration-worktree");
    assert.equal(listed.worktrees[1].main, false);
    assert.equal(listed.worktrees[1].current, false);

    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(
      () => removeWorktree(pi, { cwd: repoRoot }, worktreePath),
      /staged, unstaged, untracked, or unmerged changes/i,
    );
    assert.equal(await realpath(worktreePath), worktreePath);
    assert.equal((await listWorktrees(pi, { cwd: repoRoot })).worktrees.length, 2);

    await rm(join(worktreePath, "dirty.txt"));
    const removed = await removeWorktree(pi, { cwd: repoRoot }, worktreePath);

    assert.equal(removed.action, "remove_worktree");
    assert.equal(removed.verified.before.worktree.path, worktreePath);
    assert.equal(removed.verified.before.worktree.branch, "feature/integration-worktree");
    assert.deepEqual(removed.verified.after, {
      worktreePresent: false,
      branchRetained: true,
      branch: "feature/integration-worktree",
      head: sourceHead,
    });
    assert.equal(removed.handoff.cwd, null);
    assert.equal(removed.handoff.ready, false);
    assert.equal(removed.handoff.branch, "feature/integration-worktree");
    assert.equal(removed.handoff.head, sourceHead);
    await assert.rejects(() => realpath(worktreePath), { code: "ENOENT" });
    assert.equal((await listWorktrees(pi, { cwd: repoRoot })).worktrees.length, 1);
    assert.equal(
      (await runGit(repoRoot, ["rev-parse", "refs/heads/feature/integration-worktree"])).stdout.trim(),
      sourceHead,
    );
    assert.equal(
      pi.calls.some((call) => call.args[0] === "worktree" && call.args.includes("--force")),
      false,
    );
  });
});

test("real git removeWorktree preserves a linked checkout containing an ignored local file", async () => {
  await withTempGitRepo(async (repoRoot, temporaryRoot) => {
    const worktreePath = join(temporaryRoot, "feature-ignored-removal");
    const ignoredPath = join(worktreePath, ".env");
    const pi = makeRealGitPi(repoRoot, [worktreePath]);
    await writeFile(join(repoRoot, ".gitignore"), ".env\n", "utf8");
    await runGit(repoRoot, ["add", ".gitignore"]);
    await runGit(repoRoot, ["commit", "-m", "ignore local environment file"]);

    await createWorktree(
      pi,
      { cwd: repoRoot },
      worktreePath,
      "feature/ignored-removal",
      "new",
    );
    await writeFile(ignoredPath, "local-only test data\n", "utf8");

    await assert.rejects(
      () => removeWorktree(pi, { cwd: repoRoot }, worktreePath),
      /contains ignored files or directories/i,
    );

    assert.equal(await realpath(worktreePath), worktreePath);
    assert.equal(await readFile(ignoredPath, "utf8"), "local-only test data\n");
    assert.equal((await listWorktrees(pi, { cwd: repoRoot })).worktrees.length, 2);
    assert.equal(
      pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove"),
      false,
    );
  });
});

test("real git createWorktree uses an existing local branch only when it is not checked out", async () => {
  await withTempGitRepo(async (repoRoot, temporaryRoot) => {
    const worktreePath = join(temporaryRoot, "feature-existing");
    const rejectedPath = join(temporaryRoot, "feature-existing-duplicate");
    const pi = makeRealGitPi(repoRoot, [worktreePath, rejectedPath]);
    const branchHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(repoRoot, ["branch", "feature/existing-worktree"]);

    const created = await createWorktree(
      pi,
      { cwd: repoRoot },
      worktreePath,
      "feature/existing-worktree",
      "existing",
    );

    assert.equal(created.verified.before.branchExisted, true);
    assert.equal(created.handoff.cwd, worktreePath);
    assert.equal(created.handoff.branch, "feature/existing-worktree");
    assert.equal(created.handoff.head, branchHead);
    assert.equal(await currentBranch(worktreePath), "feature/existing-worktree");
    assert.equal((await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(), branchHead);
    assert.equal((await runGit(worktreePath, ["status", "--porcelain"])).stdout, "");

    await assert.rejects(
      () => createWorktree(
        pi,
        { cwd: repoRoot },
        rejectedPath,
        "feature/existing-worktree",
        "existing",
      ),
      /already checked out in a worktree/i,
    );
    await assert.rejects(() => realpath(rejectedPath), { code: "ENOENT" });

    await removeWorktree(pi, { cwd: repoRoot }, worktreePath);
    assert.equal(
      (await runGit(repoRoot, ["rev-parse", "refs/heads/feature/existing-worktree"])).stdout.trim(),
      branchHead,
    );
  });
});

test("real git working-tree collection distinguishes staged, unstaged, and untracked paths", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await writeFile(join(repoRoot, "staged.txt"), "staged\n", "utf8");
    await runGit(repoRoot, ["add", "staged.txt"]);
    await writeFile(join(repoRoot, "README.md"), "unstaged\n", "utf8");
    await writeFile(join(repoRoot, "untracked.txt"), "untracked\n", "utf8");

    const pi = makeRealGitPi(repoRoot);
    const details = await getWorkingTreeStatus(pi, { cwd: repoRoot });

    assert.deepEqual(details.workingTree, { state: "dirty", staged: 1, unstaged: 1, untracked: 1 });
    assert.deepEqual(
      details.unstagedChanges.entries.map((entry) => ({ status: entry.status, path: entry.path })),
      [
        { status: " M", path: "README.md" },
        { status: "??", path: "untracked.txt" },
      ],
    );
    assert.equal(details.unstagedChanges.omitted, 0);
    assert.deepEqual(
      pi.calls.map((call) => call.args),
      [
        ["rev-parse", "--show-toplevel"],
        ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      ],
    );
    assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
  });
});

test("real git getRecentCommits returns an empty list for an unborn repository", async () => {
  const rawRoot = await mkdtemp(join(tmpdir(), "branchme-unborn-git-"));
  const repoRoot = await realpath(rawRoot);
  try {
    await runGit(repoRoot, ["init", "--initial-branch=main"]);
    const pi = makeRealGitPi(repoRoot);

    assert.deepEqual(await getRecentCommits(pi, { cwd: repoRoot }), []);
    assert.deepEqual(await getWorkingTreeStatus(pi, { cwd: repoRoot }), {
      workingTree: { state: "clean", staged: 0, unstaged: 0, untracked: 0 },
      unstagedChanges: { entries: [], omitted: 0 },
    });
    assert.equal(pi.calls.filter((call) => call.args[0] === "log").length, 1);
    assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
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

test("real git pullCurrentBranch fast-forwards main and refuses divergent history", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const rawRemoteRoot = await mkdtemp(join(tmpdir(), "branchme-real-remote-"));
    const remoteRoot = await realpath(rawRemoteRoot);
    const rawUpdaterRoot = await mkdtemp(join(tmpdir(), "branchme-real-updater-"));
    const updaterRoot = await realpath(rawUpdaterRoot);
    const updaterCheckout = join(updaterRoot, "checkout");

    try {
      await runGit(remoteRoot, ["init", "--bare", "--initial-branch=main"]);
      await runGit(repoRoot, ["remote", "add", "origin", remoteRoot]);
      await runGit(repoRoot, ["push", "--set-upstream", "origin", "main"]);
      await runGit(updaterRoot, ["clone", remoteRoot, updaterCheckout]);
      await runGit(updaterCheckout, ["config", "user.email", "branchme-test@example.invalid"]);
      await runGit(updaterCheckout, ["config", "user.name", "BranchMe Test"]);
      await writeFile(join(updaterCheckout, "README.md"), "# Updated base branch\n", "utf8");
      await runGit(updaterCheckout, ["add", "README.md"]);
      await runGit(updaterCheckout, ["commit", "-m", "update base branch"]);
      await runGit(updaterCheckout, ["push", "origin", "main"]);

      const pi = makeRealGitPi(repoRoot);
      const details = await pullCurrentBranch(pi, { cwd: repoRoot });

      assert.equal(details.currentBranch, "main");
      assert.equal(details.upstream, "origin/main");
      assert.equal(details.remote, "origin");
      assert.equal(details.remoteRef, "refs/heads/main");
      assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "# Updated base branch\n");
      assert.deepEqual(pi.calls.filter((call) => call.args[0] === "pull").map((call) => call.args), [
        ["pull", "--ff-only", "--no-rebase", "--no-autostash", "origin", "refs/heads/main"],
      ]);

      await writeFile(join(repoRoot, "local-only.txt"), "local\n", "utf8");
      await runGit(repoRoot, ["add", "local-only.txt"]);
      await runGit(repoRoot, ["commit", "-m", "local divergence"]);
      await writeFile(join(updaterCheckout, "remote-only.txt"), "remote\n", "utf8");
      await runGit(updaterCheckout, ["add", "remote-only.txt"]);
      await runGit(updaterCheckout, ["commit", "-m", "remote divergence"]);
      await runGit(updaterCheckout, ["push", "origin", "main"]);
      const localCommitBeforePull = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
      const divergentPi = makeRealGitPi(repoRoot);

      await assert.rejects(() => pullCurrentBranch(divergentPi, { cwd: repoRoot }), /fast-forward|divergent/i);

      assert.equal((await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim(), localCommitBeforePull);
      assert.deepEqual(divergentPi.calls.filter((call) => call.args[0] === "pull").map((call) => call.args), [
        ["pull", "--ff-only", "--no-rebase", "--no-autostash", "origin", "refs/heads/main"],
      ]);
    } finally {
      await rm(remoteRoot, { recursive: true, force: true });
      await rm(updaterRoot, { recursive: true, force: true });
    }
  });
});

test("real git fetchCurrentBranch refreshes upstream state and rebaseCurrentBranch replays local commits", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const rawRemoteRoot = await mkdtemp(join(tmpdir(), "branchme-fetch-rebase-remote-"));
    const remoteRoot = await realpath(rawRemoteRoot);
    const rawUpdaterRoot = await mkdtemp(join(tmpdir(), "branchme-fetch-rebase-updater-"));
    const updaterRoot = await realpath(rawUpdaterRoot);
    const updaterCheckout = join(updaterRoot, "checkout");

    try {
      await runGit(remoteRoot, ["init", "--bare", "--initial-branch=main"]);
      await runGit(repoRoot, ["remote", "add", "origin", remoteRoot]);
      await runGit(repoRoot, ["push", "--set-upstream", "origin", "main"]);
      await runGit(repoRoot, ["switch", "-c", "feature/rebase"]);
      await runGit(repoRoot, ["push", "--set-upstream", "origin", "feature/rebase"]);

      await writeFile(join(repoRoot, "local-only.txt"), "local\n", "utf8");
      await runGit(repoRoot, ["add", "local-only.txt"]);
      await runGit(repoRoot, ["commit", "-m", "local feature commit"]);
      const localCommitBeforeFetch = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

      await runGit(updaterRoot, ["clone", remoteRoot, updaterCheckout]);
      await runGit(updaterCheckout, ["config", "user.email", "branchme-test@example.invalid"]);
      await runGit(updaterCheckout, ["config", "user.name", "BranchMe Test"]);
      await runGit(updaterCheckout, ["switch", "feature/rebase"]);
      await writeFile(join(updaterCheckout, "remote-only.txt"), "remote\n", "utf8");
      await runGit(updaterCheckout, ["add", "remote-only.txt"]);
      await runGit(updaterCheckout, ["commit", "-m", "remote feature commit"]);
      await runGit(updaterCheckout, ["push", "origin", "feature/rebase"]);
      const remoteCommit = (await runGit(updaterCheckout, ["rev-parse", "HEAD"])).stdout.trim();

      const fetchPi = makeRealGitPi(repoRoot);
      const fetchDetails = await fetchCurrentBranch(fetchPi, { cwd: repoRoot });

      assert.equal(fetchDetails.currentBranch, "feature/rebase");
      assert.equal(fetchDetails.upstream, "origin/feature/rebase");
      assert.equal(fetchDetails.remote, "origin");
      assert.equal((await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim(), localCommitBeforeFetch);
      assert.equal((await runGit(repoRoot, ["rev-parse", "origin/feature/rebase"])).stdout.trim(), remoteCommit);
      assert.deepEqual(fetchPi.calls.filter((call) => call.args[0] === "fetch").map((call) => call.args), [
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          "refs/heads/feature/rebase:refs/remotes/origin/feature/rebase",
        ],
      ]);

      const rebasePi = makeRealGitPi(repoRoot);
      const rebaseDetails = await rebaseCurrentBranch(rebasePi, { cwd: repoRoot });
      const rebasedCommit = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

      assert.equal(rebaseDetails.currentBranch, "feature/rebase");
      assert.equal(rebaseDetails.upstream, "origin/feature/rebase");
      assert.notEqual(rebasedCommit, localCommitBeforeFetch);
      await runGit(repoRoot, ["merge-base", "--is-ancestor", remoteCommit, rebasedCommit]);
      assert.equal(await readFile(join(repoRoot, "local-only.txt"), "utf8"), "local\n");
      assert.equal(await readFile(join(repoRoot, "remote-only.txt"), "utf8"), "remote\n");
      assert.deepEqual(rebasePi.calls.filter((call) => call.args[0] === "rebase").map((call) => call.args), [
        ["rebase", "--no-autostash", "--no-update-refs", "origin/feature/rebase"],
      ]);
    } finally {
      await rm(remoteRoot, { recursive: true, force: true });
      await rm(updaterRoot, { recursive: true, force: true });
    }
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

test("real git recent commits remain available on detached HEAD while branch-required operations fail", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await runGit(repoRoot, ["switch", "--detach", "HEAD"]);

    const pi = makeRealGitPi(repoRoot);
    const recentCommits = await getRecentCommits(pi, { cwd: repoRoot });
    await assert.rejects(() => pushCurrentBranch(pi, { cwd: repoRoot }), /detached/i);

    assert.equal(recentCommits.length, 1);
    assert.equal(recentCommits[0].subject, "initial commit");
    assert.equal(pi.calls.some((call) => call.args[0] === "push"), false);
  });
});
