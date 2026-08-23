import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { retireBranch } from "../src/git-retirement.ts";

const execFileAsync = promisify(execFile);

function gitEnvironment() {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...inheritedEnvironment,
    GIT_AUTHOR_EMAIL: "branchme-retirement-test@example.invalid",
    GIT_AUTHOR_NAME: "BranchMe Retirement Test",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_COMMITTER_EMAIL: "branchme-retirement-test@example.invalid",
    GIT_COMMITTER_NAME: "BranchMe Retirement Test",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function executeGit(cwd, args, options = {}) {
  try {
    const output = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env: gitEnvironment(),
      maxBuffer: 1024 * 1024,
      signal: options.signal,
      timeout: options.timeout ?? 30_000,
    });
    return { stdout: output.stdout, stderr: output.stderr, code: 0, killed: false };
  } catch (error) {
    return {
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? error),
      code: typeof error?.code === "number" ? error.code : 1,
      killed: Boolean(error?.killed),
    };
  }
}

async function runGit(cwd, args) {
  const result = await executeGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function createRetirementFixture() {
  const rawTemporaryRoot = await mkdtemp(join(tmpdir(), "branchme-retire-real-git-"));
  const temporaryRoot = await realpath(rawTemporaryRoot);
  const repoRoot = join(temporaryRoot, "source");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "--initial-branch=main"]);
  await runGit(repoRoot, ["config", "user.email", "branchme-retirement-test@example.invalid"]);
  await runGit(repoRoot, ["config", "user.name", "BranchMe Retirement Test"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, "README.md"), "# BranchMe retirement fixture\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial commit"]);
  assert.equal(await runGit(repoRoot, ["remote"]), "");
  return { repoRoot, temporaryRoot };
}

function pathIsInside(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function makeRealGitPi(repoRoot) {
  const temporaryRoot = dirname(repoRoot);
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      assert.equal(pathIsInside(options.cwd, temporaryRoot), true);
      calls.push({ command, args: [...args], options });
      return executeGit(options.cwd, args, options);
    },
  };
}

async function refHead(repoRoot, ref = "HEAD") {
  return (await runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

async function localRefExists(repoRoot, ref) {
  const result = await executeGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
  return result.code === 0;
}

async function commitFile(repoRoot, path, content, message) {
  await writeFile(join(repoRoot, path), content, "utf8");
  await runGit(repoRoot, ["add", "--", path]);
  await runGit(repoRoot, ["commit", "-m", message]);
  return refHead(repoRoot);
}

async function refSnapshot(repoRoot) {
  return runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/heads",
    "refs/remotes",
  ]);
}

async function worktreeSnapshot(repoRoot) {
  return runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
}

async function statusSnapshot(repoRoot) {
  return runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function assertReadOnlyExceptExactRetirement(calls, branchName, expectedHead, mutationExpected) {
  const expectedDeletion = [
    "update-ref",
    "--no-deref",
    "-d",
    `refs/heads/${branchName}`,
    expectedHead,
  ];
  const updateCalls = calls.filter((call) => call.args[0] === "update-ref");
  assert.deepEqual(
    updateCalls.map((call) => call.args),
    mutationExpected ? [expectedDeletion] : [],
  );
  assert.equal(
    calls.some((call) =>
      call.args[0] === "branch" && call.args.some((argument) => argument === "-d" || argument === "-D")),
    false,
  );
  assert.equal(calls.some((call) => ["fetch", "push"].includes(call.args[0])), false);
  assert.equal(
    calls.some((call) => call.args.some((argument) => argument.startsWith("refs/remotes/"))),
    false,
  );
  assert.equal(
    calls.some((call) => call.args[0] === "worktree" && call.args[1] !== "list"),
    false,
  );
}

function removeRetiringRefFromSnapshot(snapshot, retiringRef) {
  return snapshot
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(`${retiringRef}\0`))
    .join("\n") + "\n";
}

test("real Git retires only a merged local ref while preserving unrelated state", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/merged-retirement";
  const targetBranch = "release/non-current-target";
  const retiringRef = `refs/heads/${branchName}`;
  const remoteTrackingRef = `refs/remotes/origin/${branchName}`;
  const linkedWorktreePath = join(fixture.temporaryRoot, "unrelated-linked-worktree");
  try {
    await runGit(fixture.repoRoot, ["switch", "-c", branchName]);
    const retiringHead = await commitFile(
      fixture.repoRoot,
      "merged-feature.txt",
      "merged feature content\n",
      "add merged feature",
    );
    await runGit(fixture.repoRoot, ["switch", "main"]);
    await runGit(fixture.repoRoot, ["branch", targetBranch, retiringHead]);
    await runGit(fixture.repoRoot, ["update-ref", remoteTrackingRef, retiringHead]);
    await runGit(fixture.repoRoot, ["config", `branch.${branchName}.remote`, "origin"]);
    await runGit(fixture.repoRoot, ["config", `branch.${branchName}.merge`, `refs/heads/${branchName}`]);
    await runGit(fixture.repoRoot, [
      "worktree",
      "add",
      "-b",
      "feature/unrelated-linked",
      linkedWorktreePath,
      "main",
    ]);
    await writeFile(join(linkedWorktreePath, "linked-dirty.txt"), "linked dirty state\n", "utf8");
    await writeFile(join(fixture.repoRoot, "unrelated-dirty.txt"), "root dirty state\n", "utf8");

    const targetHeadBefore = await refHead(fixture.repoRoot, `refs/heads/${targetBranch}`);
    const remoteHeadBefore = await refHead(fixture.repoRoot, remoteTrackingRef);
    const refsBefore = await refSnapshot(fixture.repoRoot);
    const worktreesBefore = await worktreeSnapshot(fixture.repoRoot);
    const rootStatusBefore = await statusSnapshot(fixture.repoRoot);
    const linkedStatusBefore = await statusSnapshot(linkedWorktreePath);
    const readmeBefore = await readFile(join(fixture.repoRoot, "README.md"), "utf8");
    const branchConfigBefore = await runGit(fixture.repoRoot, [
      "config",
      "--local",
      "--get-regexp",
      `^branch\\.${branchName}\\.`,
    ]);
    const pi = makeRealGitPi(fixture.repoRoot);

    const details = await retireBranch(pi, { cwd: fixture.repoRoot }, {
      branchName,
      expectedHead: retiringHead,
      targetBranch,
      force: false,
    });

    assert.equal(details.status, "retired");
    assert.equal(details.mode, "merged");
    assert.equal(details.verified.ancestry.retiringIsAncestorOfTarget, true);
    assert.equal(await localRefExists(fixture.repoRoot, retiringRef), false);
    assert.equal(await refHead(fixture.repoRoot, `refs/heads/${targetBranch}`), targetHeadBefore);
    assert.equal(await refHead(fixture.repoRoot, remoteTrackingRef), remoteHeadBefore);
    assert.equal(await runGit(fixture.repoRoot, ["branch", "--show-current"]), "main\n");
    assert.equal(await runGit(fixture.repoRoot, ["remote"]), "");
    assert.equal(await refSnapshot(fixture.repoRoot), removeRetiringRefFromSnapshot(refsBefore, retiringRef));
    assert.equal(await worktreeSnapshot(fixture.repoRoot), worktreesBefore);
    assert.equal(await statusSnapshot(fixture.repoRoot), rootStatusBefore);
    assert.equal(await statusSnapshot(linkedWorktreePath), linkedStatusBefore);
    assert.equal(await readFile(join(fixture.repoRoot, "README.md"), "utf8"), readmeBefore);
    assert.equal(await readFile(join(fixture.repoRoot, "unrelated-dirty.txt"), "utf8"), "root dirty state\n");
    assert.equal(await readFile(join(linkedWorktreePath, "linked-dirty.txt"), "utf8"), "linked dirty state\n");
    assert.equal(
      await runGit(fixture.repoRoot, [
        "config",
        "--local",
        "--get-regexp",
        `^branch\\.${branchName}\\.`,
      ]),
      branchConfigBefore,
    );
    assertReadOnlyExceptExactRetirement(pi.calls, branchName, retiringHead, true);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git rejects a stale expected HEAD and retains the moved branch", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/stale-head";
  try {
    const staleHead = await refHead(fixture.repoRoot);
    await runGit(fixture.repoRoot, ["switch", "-c", branchName]);
    const movedHead = await commitFile(
      fixture.repoRoot,
      "stale-feature.txt",
      "moved branch\n",
      "move stale branch",
    );
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const targetHeadBefore = await refHead(fixture.repoRoot, "refs/heads/main");
    const worktreesBefore = await worktreeSnapshot(fixture.repoRoot);
    const pi = makeRealGitPi(fixture.repoRoot);

    await assert.rejects(
      () => retireBranch(pi, { cwd: fixture.repoRoot }, {
        branchName,
        expectedHead: staleHead,
        targetBranch: "main",
        force: false,
      }),
      /does not match the required expected HEAD/iu,
    );

    assert.equal(await refHead(fixture.repoRoot, `refs/heads/${branchName}`), movedHead);
    assert.equal(await refHead(fixture.repoRoot, "refs/heads/main"), targetHeadBefore);
    assert.equal(await worktreeSnapshot(fixture.repoRoot), worktreesBefore);
    assertReadOnlyExceptExactRetirement(pi.calls, branchName, staleHead, false);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git rejects a case-variant alias and preserves the exact local ref", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/Case-Exact";
  const requestedAlias = "feature/case-exact";
  const branchRef = `refs/heads/${branchName}`;
  try {
    await runGit(fixture.repoRoot, ["branch", branchName, "main"]);
    const branchHead = await refHead(fixture.repoRoot, branchRef);
    const refsBefore = await refSnapshot(fixture.repoRoot);
    const worktreesBefore = await worktreeSnapshot(fixture.repoRoot);
    const pi = makeRealGitPi(fixture.repoRoot);

    await assert.rejects(
      () => retireBranch(pi, { cwd: fixture.repoRoot }, {
        branchName: requestedAlias,
        expectedHead: branchHead,
        targetBranch: "main",
        force: false,
      }),
      /does not exist|different ref identity/iu,
    );

    assert.equal(await localRefExists(fixture.repoRoot, branchRef), true);
    assert.equal(await refHead(fixture.repoRoot, branchRef), branchHead);
    assert.equal(await refSnapshot(fixture.repoRoot), refsBefore);
    assert.equal(await worktreeSnapshot(fixture.repoRoot), worktreesBefore);
    assertReadOnlyExceptExactRetirement(pi.calls, requestedAlias, branchHead, false);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git requires explicit force before retiring unmerged history", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/forced-unmerged";
  const retiringRef = `refs/heads/${branchName}`;
  try {
    await runGit(fixture.repoRoot, ["switch", "-c", branchName]);
    const retiringHead = await commitFile(
      fixture.repoRoot,
      "unmerged-feature.txt",
      "unmerged content\n",
      "add unmerged feature",
    );
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const targetHeadBefore = await refHead(fixture.repoRoot, "refs/heads/main");
    const statusBefore = await statusSnapshot(fixture.repoRoot);
    const deniedPi = makeRealGitPi(fixture.repoRoot);

    await assert.rejects(
      () => retireBranch(deniedPi, { cwd: fixture.repoRoot }, {
        branchName,
        expectedHead: retiringHead,
        targetBranch: "main",
        force: false,
      }),
      /force must be true/iu,
    );
    assert.equal(await refHead(fixture.repoRoot, retiringRef), retiringHead);
    assertReadOnlyExceptExactRetirement(deniedPi.calls, branchName, retiringHead, false);

    const forcedPi = makeRealGitPi(fixture.repoRoot);
    const details = await retireBranch(forcedPi, { cwd: fixture.repoRoot }, {
      branchName,
      expectedHead: retiringHead,
      targetBranch: "main",
      force: true,
    });

    assert.equal(details.status, "retired");
    assert.equal(details.mode, "forced_unmerged");
    assert.equal(details.verified.ancestry.retiringIsAncestorOfTarget, false);
    assert.equal(await localRefExists(fixture.repoRoot, retiringRef), false);
    assert.equal(await refHead(fixture.repoRoot, "refs/heads/main"), targetHeadBefore);
    assert.equal(await statusSnapshot(fixture.repoRoot), statusBefore);
    assert.equal(await runGit(fixture.repoRoot, ["remote"]), "");
    assertReadOnlyExceptExactRetirement(forcedPi.calls, branchName, retiringHead, true);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git rejects retirement of the current branch", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/current-branch";
  try {
    await runGit(fixture.repoRoot, ["switch", "-c", branchName]);
    const retiringHead = await refHead(fixture.repoRoot);
    const worktreesBefore = await worktreeSnapshot(fixture.repoRoot);
    const statusBefore = await statusSnapshot(fixture.repoRoot);
    const pi = makeRealGitPi(fixture.repoRoot);

    await assert.rejects(
      () => retireBranch(pi, { cwd: fixture.repoRoot }, {
        branchName,
        expectedHead: retiringHead,
        targetBranch: "main",
        force: false,
      }),
      /occupied by 1 registered worktree/iu,
    );

    assert.equal(await runGit(fixture.repoRoot, ["branch", "--show-current"]), `${branchName}\n`);
    assert.equal(await refHead(fixture.repoRoot, `refs/heads/${branchName}`), retiringHead);
    assert.equal(await worktreeSnapshot(fixture.repoRoot), worktreesBefore);
    assert.equal(await statusSnapshot(fixture.repoRoot), statusBefore);
    assertReadOnlyExceptExactRetirement(pi.calls, branchName, retiringHead, false);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git rejects retirement from an ordinary or locked linked worktree", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/linked-occupied";
  const linkedWorktreePath = join(fixture.temporaryRoot, "occupied-linked-worktree");
  try {
    await runGit(fixture.repoRoot, ["worktree", "add", "-b", branchName, linkedWorktreePath, "main"]);
    const retiringHead = await refHead(fixture.repoRoot, `refs/heads/${branchName}`);
    await writeFile(join(linkedWorktreePath, "linked-dirty.txt"), "preserve linked file\n", "utf8");
    const ordinaryInventory = await worktreeSnapshot(fixture.repoRoot);
    const ordinaryStatus = await statusSnapshot(linkedWorktreePath);
    const ordinaryPi = makeRealGitPi(fixture.repoRoot);

    await assert.rejects(
      () => retireBranch(ordinaryPi, { cwd: fixture.repoRoot }, {
        branchName,
        expectedHead: retiringHead,
        targetBranch: "main",
        force: false,
      }),
      /occupied by 1 registered worktree/iu,
    );
    assert.equal(await worktreeSnapshot(fixture.repoRoot), ordinaryInventory);
    assert.equal(await statusSnapshot(linkedWorktreePath), ordinaryStatus);
    assertReadOnlyExceptExactRetirement(ordinaryPi.calls, branchName, retiringHead, false);

    await runGit(fixture.repoRoot, ["worktree", "lock", "--reason", "retirement occupancy test", linkedWorktreePath]);
    const lockedInventory = await worktreeSnapshot(fixture.repoRoot);
    assert.match(lockedInventory, /locked retirement occupancy test/u);
    const lockedPi = makeRealGitPi(fixture.repoRoot);
    await assert.rejects(
      () => retireBranch(lockedPi, { cwd: fixture.repoRoot }, {
        branchName,
        expectedHead: retiringHead,
        targetBranch: "main",
        force: false,
      }),
      /occupied by 1 registered worktree/iu,
    );

    assert.equal(await refHead(fixture.repoRoot, `refs/heads/${branchName}`), retiringHead);
    assert.equal(await worktreeSnapshot(fixture.repoRoot), lockedInventory);
    assert.equal(await readFile(join(linkedWorktreePath, "linked-dirty.txt"), "utf8"), "preserve linked file\n");
    assertReadOnlyExceptExactRetirement(lockedPi.calls, branchName, retiringHead, false);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git rejects retirement from a prunable registered worktree when supported", async () => {
  const fixture = await createRetirementFixture();
  const branchName = "feature/prunable-occupied";
  const linkedWorktreePath = join(fixture.temporaryRoot, "prunable-linked-worktree");
  try {
    await runGit(fixture.repoRoot, ["worktree", "add", "-b", branchName, linkedWorktreePath, "main"]);
    const retiringHead = await refHead(fixture.repoRoot, `refs/heads/${branchName}`);
    await rm(linkedWorktreePath, { recursive: true, force: true });
    const prunableInventory = await worktreeSnapshot(fixture.repoRoot);
    assert.match(prunableInventory, /prunable /u);
    assert.match(prunableInventory, new RegExp(`branch refs/heads/${branchName}`, "u"));
    const pi = makeRealGitPi(fixture.repoRoot);

    await assert.rejects(
      () => retireBranch(pi, { cwd: fixture.repoRoot }, {
        branchName,
        expectedHead: retiringHead,
        targetBranch: "main",
        force: false,
      }),
      /occupied by 1 registered worktree/iu,
    );

    assert.equal(await refHead(fixture.repoRoot, `refs/heads/${branchName}`), retiringHead);
    assert.equal(await worktreeSnapshot(fixture.repoRoot), prunableInventory);
    assertReadOnlyExceptExactRetirement(pi.calls, branchName, retiringHead, false);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
