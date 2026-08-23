import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  changeExistingLocalBranch,
  createLocalBranch,
  createWorktree,
  fetchCurrentBranch,
  formatGitFailure,
  getBranchStatus,
  getGitRoot,
  getPullRequestCommitSubjects,
  getRecentCommits,
  getWorkingTreeStatus,
  parseRecentCommits,
  parseWorkingTreeStatus,
  inferPullRequestBaseBranch,
  listWorktrees,
  parseWorktreePorcelain,
  pullCurrentBranch,
  pushCurrentBranch,
  rebaseCurrentBranch,
  removeWorktree,
  validateBranchName,
  validateBranchNameInput,
  validateWorktreeCreationPath,
  validateWorktreePathInput,
  validateWorktreeRemovalPath,
} from "../src/git.ts";

function result(overrides = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function makePi(routes) {
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args), "git args must be an argv array");
      assert.equal(options.cwd, "/repo");
      calls.push({ command, args: [...args], options });
      const key = args.join("\0");
      const route = routes[key];
      if (!route) throw new Error(`Unexpected git command: ${args.join(" ")}`);
      if (Array.isArray(route)) {
        const next = route.shift();
        if (!next) throw new Error(`No remaining result for git command: ${args.join(" ")}`);
        return result(next);
      }
      if (typeof route === "function") return result(route(args));
      return result(route);
    },
  };
}

const ctx = { cwd: "/repo" };
const detailedStatusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];
const ignoredWorktreeStatusArgs = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=normal",
  "--ignored=matching",
];
const recentLogArgs = [
  "log",
  "-n",
  "5",
  "--date=short",
  "--format=%x00%H%x1f%h%x1f%ad%x1f%s",
  "HEAD",
];

function recentLogRecord(hash, shortHash, date, subject) {
  return `\0${hash}\u001f${shortHash}\u001f${date}\u001f${subject}\n`;
}

function worktreePorcelainRecord(...lines) {
  return `${lines.join("\0")}\0\0`;
}

function makeWorktreeValidationPi(repoRoot, porcelain, commonGitDir) {
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      calls.push({ args: [...args], options });
      const key = args.join("\0");
      if (key === "rev-parse\0--show-toplevel") return result({ stdout: `${repoRoot}\n` });
      if (key === "worktree\0list\0--porcelain\0-z") return result({ stdout: porcelain });
      if (key === "rev-parse\0--path-format=absolute\0--git-common-dir") {
        return result({ stdout: `${commonGitDir}\n` });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };
}

function makeWorktreeCreationPi(options) {
  const calls = [];
  let inventoryCall = 0;
  return {
    calls,
    async exec(command, args, execOptions) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      calls.push({ args: [...args], options: execOptions });
      const key = args.join("\0");
      if (key === "rev-parse\0--show-toplevel") return result({ stdout: `${options.repoRoot}\n` });
      if (key === "symbolic-ref\0--quiet\0--short\0HEAD") {
        if (options.sourceDetached) return result({ code: 1, stderr: "fatal: ref HEAD is not symbolic\n" });
        return result({ stdout: `${options.sourceBranch ?? "main"}\n` });
      }
      if (key === "rev-parse\0--verify\0HEAD") return result({ stdout: `${options.sourceHead}\n` });
      if (key === "rev-parse\0--verify\0HEAD^{commit}") {
        return result(options.sourceHeadResult ?? { stdout: `${options.sourceHead}\n` });
      }
      if (key === "worktree\0list\0--porcelain\0-z") {
        const inventory = options.inventories[Math.min(inventoryCall, options.inventories.length - 1)];
        inventoryCall += 1;
        return result({ stdout: inventory });
      }
      if (key === "rev-parse\0--path-format=absolute\0--git-common-dir") {
        return result({ stdout: `${options.commonGitDir}\n` });
      }
      if (key === `check-ref-format\0--branch\0${options.branchName}`) {
        return result({ stdout: `${options.branchName}\n` });
      }
      if (key === `show-ref\0--verify\0--quiet\0refs/heads/${options.branchName}`) {
        return result({ code: options.branchExists ? 0 : 1 });
      }
      if (key === `rev-parse\0--verify\0refs/heads/${options.branchName}^{commit}`) {
        return result({ stdout: `${options.branchHead}\n` });
      }
      if (args[0] === "worktree" && args[1] === "add") return result(options.addResult);
      if (key === detailedStatusArgs.join("\0")) {
        assert.equal(execOptions.cwd, options.destination);
        return result({ stdout: options.statusOutput ?? "" });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };
}

function makeWorktreeRemovalPi(options) {
  const calls = [];
  let inventoryCall = 0;
  let branchHeadCall = 0;
  return {
    calls,
    async exec(command, args, execOptions) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      calls.push({ args: [...args], options: execOptions });
      const key = args.join("\0");
      if (key === "rev-parse\0--show-toplevel") return result({ stdout: `${options.repoRoot}\n` });
      if (key === "worktree\0list\0--porcelain\0-z") {
        const inventory = options.inventories[Math.min(inventoryCall, options.inventories.length - 1)];
        inventoryCall += 1;
        return result({ stdout: inventory });
      }
      if (key === detailedStatusArgs.join("\0")) {
        assert.equal(execOptions.cwd, options.targetPath);
        return result({ stdout: options.statusOutput ?? "" });
      }
      if (key === ignoredWorktreeStatusArgs.join("\0")) {
        assert.equal(execOptions.cwd, options.targetPath);
        return result({ stdout: options.ignoredStatusOutput ?? "" });
      }
      if (key === `rev-parse\0--verify\0refs/heads/${options.branchName}^{commit}`) {
        const branchHead = options.branchHeads?.[Math.min(branchHeadCall, options.branchHeads.length - 1)] ?? {
          stdout: `${options.head}\n`,
        };
        branchHeadCall += 1;
        return result(branchHead);
      }
      if (key === `worktree\0remove\0${options.targetPath}`) return result(options.removeResult);
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };
}

function assertNoUnsafeWorktreeRemovalCommands(calls) {
  const unsafe = calls.filter((call) =>
    call.args.includes("--force") ||
    call.args.includes("-f") ||
    call.args[0] === "branch" ||
    call.args[0] === "update-ref" ||
    (call.args[0] === "worktree" && !["list", "remove"].includes(call.args[1])));
  assert.deepEqual(unsafe.map((call) => call.args), []);
}

function assertNoUnsafeWorktreeCreationCommands(calls) {
  const forbiddenArguments = new Set(["--force", "-f", "-B", "--detach", "--orphan"]);
  const unsafe = calls.filter((call) =>
    call.args.some((argument) => forbiddenArguments.has(argument)) ||
    call.args.some((argument) => argument.startsWith("refs/remotes/")) ||
    (call.args[0] === "worktree" && ["remove", "move", "prune", "repair"].includes(call.args[1])));
  assert.deepEqual(unsafe.map((call) => call.args), []);
}

function assertNoUnsafeBranchSwitchCommands(calls) {
  const forbiddenCommands = new Set(["checkout", "stash", "reset", "merge", "rebase", "add", "commit", "push"]);
  const unsafe = calls.filter(
    (call) => forbiddenCommands.has(call.args[0]) || call.args.includes("--force") || call.args.includes("-f"),
  );
  assert.deepEqual(
    unsafe.map((call) => call.args),
    [],
  );
}

test("getBranchStatus reads current git state with argv-style commands", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/test\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/test\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/test...origin/feature/test [ahead 1]\n M src/a.ts\n" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { stdout: "1\t0\n" },
  });

  const details = await getBranchStatus(pi, ctx);

  assert.deepEqual(details, {
    repoRoot: "/repo",
    currentBranch: "feature/test",
    detached: false,
    upstream: "origin/feature/test",
    hasChanges: true,
    ahead: 1,
    behind: 0,
  });
  assert.deepEqual(
    pi.calls.map((call) => call.args),
    [
      ["rev-parse", "--show-toplevel"],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      ["status", "--porcelain=v1", "--branch"],
      ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    ],
  );
});

test("getGitRoot trims trailing whitespace from git output", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo \t\n\n" },
  });

  assert.equal(await getGitRoot(pi, ctx), "/repo");
});

test("getBranchStatus preserves partial status when ahead/behind counting fails", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/stale\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/stale\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/stale...origin/feature/stale\n M src/a.ts\n" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: {
      code: 128,
      stderr: "fatal: ambiguous argument 'HEAD...@{u}': unknown revision\n",
    },
  });

  const details = await getBranchStatus(pi, ctx);

  assert.equal(details.repoRoot, "/repo");
  assert.equal(details.currentBranch, "feature/stale");
  assert.equal(details.detached, false);
  assert.equal(details.upstream, "origin/feature/stale");
  assert.equal(details.hasChanges, true);
  assert.equal(details.ahead, null);
  assert.equal(details.behind, null);
  assert.match(details.warnings[0], /ahead\/behind unavailable/i);
  assert.match(details.warnings[0], /rev-list|ambiguous/i);
});

test("getWorkingTreeStatus uses bounded porcelain v1 -z data from the verified repository root", async () => {
  const controller = new AbortController();
  const output = [
    "M  staged.ts",
    " M unstaged.ts",
    "MM staged-and-unstaged.ts",
    "?? untracked file.ts",
    " R renamed.ts",
    "old-name.ts",
    " C copied.ts",
    "source.ts",
    "UU conflicted.ts",
    "",
  ].join("\0");
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    [detailedStatusArgs.join("\0")]: { stdout: output },
  });

  const details = await getWorkingTreeStatus(pi, ctx, controller.signal);

  assert.deepEqual(details, {
    workingTree: { state: "dirty", staged: 2, unstaged: 5, untracked: 1 },
    unstagedChanges: {
      entries: [
        { status: " M", path: "unstaged.ts" },
        { status: "MM", path: "staged-and-unstaged.ts" },
        { status: "??", path: "untracked file.ts" },
        { status: " R", path: "renamed.ts", originalPath: "old-name.ts" },
        { status: " C", path: "copied.ts", originalPath: "source.ts" },
        { status: "UU", path: "conflicted.ts" },
      ],
      omitted: 0,
    },
  });
  assert.deepEqual(
    pi.calls.map((call) => call.args),
    [["rev-parse", "--show-toplevel"], detailedStatusArgs],
  );
  assert.equal(pi.calls[1].options.cwd, "/repo");
  assert.equal(pi.calls[1].options.signal, controller.signal);
  assert.equal(pi.calls[1].options.timeout, 5_000);
});

test("parseWorkingTreeStatus reports clean state and skips ignored records", () => {
  assert.deepEqual(parseWorkingTreeStatus(""), {
    workingTree: { state: "clean", staged: 0, unstaged: 0, untracked: 0 },
    unstagedChanges: { entries: [], omitted: 0 },
  });
  assert.deepEqual(parseWorkingTreeStatus("!! ignored.log\0"), {
    workingTree: { state: "clean", staged: 0, unstaged: 0, untracked: 0 },
    unstagedChanges: { entries: [], omitted: 0 },
  });
});

test("parseWorkingTreeStatus bounds paths and reports omitted unstaged entries", () => {
  const unsafePath = `dir/line\n\u001b[31m-ghp_pathsecret123-${"x".repeat(600)}`;
  const output = Array.from({ length: 22 }, (_, index) => ` M ${index === 0 ? unsafePath : `file-${index}.ts`}\0`).join("");

  const details = parseWorkingTreeStatus(output);

  assert.deepEqual(details.workingTree, { state: "dirty", staged: 0, unstaged: 22, untracked: 0 });
  assert.equal(details.unstagedChanges.entries.length, 20);
  assert.equal(details.unstagedChanges.omitted, 2);
  assert.ok(details.unstagedChanges.entries[0].path.length <= 512);
  assert.match(details.unstagedChanges.entries[0].path, /\\u000a|\\u001b/u);
  assert.doesNotMatch(details.unstagedChanges.entries[0].path, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.doesNotMatch(details.unstagedChanges.entries[0].path, /pathsecret/u);
});

test("parseWorkingTreeStatus truncates paths without splitting Unicode code points", () => {
  const path = `${"x".repeat(510)}🦄tail`;
  const details = parseWorkingTreeStatus(` M ${path}\0`);

  assert.equal(details.unstagedChanges.entries[0].path, `${"x".repeat(510)}…`);
});

test("parseWorkingTreeStatus rejects malformed rename records without exposing raw output", () => {
  assert.throws(() => parseWorkingTreeStatus("R  renamed.ts\0"), /source path is missing/u);
  assert.throws(() => parseWorkingTreeStatus("malformed\0"), /malformed git status record/u);
});

test("parseWorktreePorcelain handles linked, detached, locked, bare, prunable, and future records", () => {
  const output = [
    worktreePorcelainRecord(
      "worktree /repo",
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
      "future-attribute future-value",
    ),
    worktreePorcelainRecord("worktree /repo/detached", `HEAD ${"b".repeat(40)}`, "detached"),
    worktreePorcelainRecord(
      "worktree /repo/locked-reason",
      `HEAD ${"c".repeat(40)}`,
      "branch refs/heads/feature/locked-reason",
      "locked administrative reason",
    ),
    worktreePorcelainRecord(
      "worktree /repo/locked",
      `HEAD ${"d".repeat(40)}`,
      "branch refs/heads/feature/locked",
      "locked",
    ),
    worktreePorcelainRecord("worktree /repo/bare", "bare"),
    worktreePorcelainRecord(
      "worktree /repo/prunable",
      `HEAD ${"e".repeat(40)}`,
      "branch refs/heads/feature/prunable",
      "prunable gitdir file points to a missing location",
    ),
  ].join("");

  const details = parseWorktreePorcelain(output);

  assert.equal(details.omitted, 0);
  assert.equal(details.worktrees.length, 6);
  assert.deepEqual(
    details.worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      detached: worktree.detached,
      bare: worktree.bare,
      locked: worktree.locked,
      lockReason: worktree.lockReason,
      prunable: worktree.prunable,
      pruneReason: worktree.pruneReason,
      main: worktree.main,
      current: worktree.current,
    })),
    [
      {
        path: "/repo",
        branch: "main",
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        main: true,
        current: false,
      },
      {
        path: "/repo/detached",
        branch: null,
        detached: true,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        main: false,
        current: false,
      },
      {
        path: "/repo/locked-reason",
        branch: "feature/locked-reason",
        detached: false,
        bare: false,
        locked: true,
        lockReason: "administrative reason",
        prunable: false,
        pruneReason: null,
        main: false,
        current: false,
      },
      {
        path: "/repo/locked",
        branch: "feature/locked",
        detached: false,
        bare: false,
        locked: true,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        main: false,
        current: false,
      },
      {
        path: "/repo/bare",
        branch: null,
        detached: false,
        bare: true,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        main: false,
        current: false,
      },
      {
        path: "/repo/prunable",
        branch: "feature/prunable",
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: true,
        pruneReason: "gitdir file points to a missing location",
        main: false,
        current: false,
      },
    ],
  );
  assert.equal(details.worktrees[4].head, null);
});

test("parseWorktreePorcelain bounds and sanitizes paths and lock or prune reasons", () => {
  const unsafePath = `/repo/space and line\n\u001b[31m-ghp_pathsecret123-${"x".repeat(5_000)}`;
  const unsafeReason = `reason with whitespace\n\u001b[31m-github_pat_reasonsecret123-${"y".repeat(800)}`;
  const output = worktreePorcelainRecord(
    `worktree ${unsafePath}`,
    `HEAD ${"a".repeat(40)}`,
    "branch refs/heads/feature/safe",
    `locked ${unsafeReason}`,
    `prunable ${unsafeReason}`,
  );

  const [worktree] = parseWorktreePorcelain(output).worktrees;

  assert.ok(worktree.path.length <= 4_096);
  assert.ok(worktree.lockReason.length <= 512);
  assert.ok(worktree.pruneReason.length <= 512);
  assert.match(worktree.path, /space and line\\u000a\\u001b/u);
  assert.match(worktree.lockReason, /whitespace\\u000a\\u001b/u);
  assert.doesNotMatch(worktree.path, /pathsecret/u);
  assert.doesNotMatch(worktree.lockReason, /reasonsecret/u);
  assert.doesNotMatch(worktree.path, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  assert.doesNotMatch(worktree.lockReason, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  assert.equal(worktree.path.isWellFormed(), true);
  assert.equal(worktree.lockReason.isWellFormed(), true);
});

test("parseWorktreePorcelain rejects malformed records without exposing raw metadata", () => {
  const secret = "ghp_worktreesecret123";
  const malformedOutputs = [
    "",
    worktreePorcelainRecord(`HEAD ${"a".repeat(40)}`, "branch refs/heads/main"),
    worktreePorcelainRecord("worktree /repo", `HEAD ${"a".repeat(40)}`),
    worktreePorcelainRecord("worktree /repo", `HEAD ${secret}`, "branch refs/heads/main"),
    worktreePorcelainRecord("worktree /repo", `HEAD ${"a".repeat(40)}`, "branch refs/remotes/origin/main"),
    worktreePorcelainRecord("worktree /repo", "bare", "detached"),
    worktreePorcelainRecord(
      "worktree /repo",
      `HEAD ${"a".repeat(40)}`,
      `HEAD ${"b".repeat(40)}`,
      "branch refs/heads/main",
    ),
  ];

  for (const output of malformedOutputs) {
    assert.throws(
      () => parseWorktreePorcelain(output),
      (error) => error instanceof TypeError && /malformed git worktree output/u.test(error.message) && !error.message.includes(secret),
    );
  }
});

test("parseWorktreePorcelain bounds returned entries and rejects oversized raw output", () => {
  const output = Array.from({ length: 102 }, (_, index) =>
    worktreePorcelainRecord(
      `worktree /repo/worktree-${index}`,
      `HEAD ${index.toString(16).padStart(40, "0")}`,
      `branch refs/heads/feature/worktree-${index}`,
    ),
  ).join("");

  const details = parseWorktreePorcelain(output);

  assert.equal(details.worktrees.length, 100);
  assert.equal(details.omitted, 2);
  assert.equal(details.worktrees[0].main, true);
  assert.equal(details.worktrees.slice(1).every((worktree) => !worktree.main), true);
  assert.throws(
    () => parseWorktreePorcelain("x".repeat(128 * 1024 + 1)),
    /output exceeded the safety limit/u,
  );
});

test("listWorktrees uses read-only Git commands, canonical path comparison, and the caller signal", async () => {
  const repoRoot = await realpath(".");
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-list-"));
  const aliasPath = join(tempRoot, "current-alias");
  await symlink(repoRoot, aliasPath, "dir");

  try {
    const controller = new AbortController();
    const calls = [];
    const pi = {
      async exec(command, args, options) {
        assert.equal(command, "git");
        assert.ok(Array.isArray(args));
        calls.push({ args: [...args], options });
        if (args.join("\0") === "rev-parse\0--show-toplevel") return result({ stdout: `${repoRoot}\n` });
        if (args.join("\0") === "worktree\0list\0--porcelain\0-z") {
          return result({
            stdout: worktreePorcelainRecord(
              `worktree ${aliasPath}`,
              `HEAD ${"a".repeat(40)}`,
              "branch refs/heads/main",
            ),
          });
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    };

    const details = await listWorktrees(pi, { cwd: repoRoot }, controller.signal);

    assert.equal(details.action, "list_worktrees");
    assert.equal(details.repoRoot, repoRoot);
    assert.equal(details.worktrees[0].main, true);
    assert.equal(details.worktrees[0].current, true);
    assert.equal(details.worktrees[0].path, aliasPath);
    assert.equal(details.omitted, 0);
    assert.deepEqual(calls.map((call) => call.args), [
      ["rev-parse", "--show-toplevel"],
      ["worktree", "list", "--porcelain", "-z"],
    ]);
    assert.equal(calls.every((call) => call.options.cwd === repoRoot), true);
    assert.equal(calls.every((call) => call.options.signal === controller.signal), true);
    assert.equal(calls.every((call) => call.options.timeout === 5_000), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateWorktreePathInput rejects blank, relative, root, and control-character paths", () => {
  assert.throws(() => validateWorktreePathInput(42), /must be a string/u);
  assert.throws(() => validateWorktreePathInput(""), /required/u);
  assert.throws(() => validateWorktreePathInput("   "), /blank/u);
  assert.throws(() => validateWorktreePathInput("relative/worktree"), /absolute/u);
  assert.throws(() => validateWorktreePathInput("/"), /below a parent/u);
  for (const path of ["/tmp/bad\0path", "/tmp/bad\npath", "/tmp/bad\u009fpath", "/tmp/bad\u200bpath"]) {
    assert.throws(() => validateWorktreePathInput(path), /control characters/u);
  }
  assert.equal(validateWorktreePathInput("/tmp/parent/../worktree"), "/tmp/worktree");
});

test("validateWorktreeCreationPath accepts an external destination and uses read-only Git discovery", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-path-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  await mkdir(repoRoot);
  await mkdir(commonGitDir);

  try {
    const controller = new AbortController();
    const porcelain = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
    );
    const pi = makeWorktreeValidationPi(repoRoot, porcelain, commonGitDir);
    const requestedPath = join(tempRoot, "new-worktree");
    const canonicalRoot = await realpath(tempRoot);

    const details = await validateWorktreeCreationPath(pi, { cwd: repoRoot }, requestedPath, controller.signal);

    assert.deepEqual(details, {
      repoRoot,
      commonGitDir: await realpath(commonGitDir),
      canonicalPath: join(canonicalRoot, "new-worktree"),
    });
    assert.deepEqual(pi.calls.map((call) => call.args), [
      ["rev-parse", "--show-toplevel"],
      ["worktree", "list", "--porcelain", "-z"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]);
    assert.equal(pi.calls.every((call) => call.options.signal === controller.signal), true);
    assert.equal(pi.calls.every((call) => call.options.timeout === 5_000), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateWorktreeCreationPath rejects missing or non-directory parents and existing destinations", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-invalid-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const parentFile = join(tempRoot, "parent-file");
  const existingFile = join(tempRoot, "existing-file");
  const existingDirectory = join(tempRoot, "existing-directory");
  const existingSymlink = join(tempRoot, "existing-symlink");
  await mkdir(repoRoot);
  await mkdir(commonGitDir);
  await writeFile(parentFile, "not a directory\n", "utf8");
  await writeFile(existingFile, "already here\n", "utf8");
  await mkdir(existingDirectory);
  await symlink(repoRoot, existingSymlink, "dir");

  try {
    const noGitPi = {
      calls: [],
      async exec() {
        this.calls.push(true);
        throw new Error("Git must not run for an invalid filesystem destination");
      },
    };
    await assert.rejects(
      () => validateWorktreeCreationPath(noGitPi, { cwd: repoRoot }, join(tempRoot, "missing", "child")),
      /parent .* must exist as a directory/u,
    );
    await assert.rejects(
      () => validateWorktreeCreationPath(noGitPi, { cwd: repoRoot }, join(parentFile, "child")),
      /parent .* must be a directory/u,
    );
    for (const destination of [existingFile, existingDirectory, existingSymlink]) {
      await assert.rejects(
        () => validateWorktreeCreationPath(noGitPi, { cwd: repoRoot }, destination),
        /destination .* already exists/u,
      );
    }
    assert.equal(noGitPi.calls.length, 0);

    const secretParent = join(tempRoot, "ghp_parentsecret123", "child");
    await assert.rejects(
      () => validateWorktreeCreationPath(noGitPi, { cwd: repoRoot }, secretParent),
      (error) => error instanceof Error && /must exist/u.test(error.message) && !/parentsecret/u.test(error.message),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateWorktreeCreationPath rejects registered-worktree and common-Git-directory destinations", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-boundaries-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  await mkdir(repoRoot);
  await mkdir(commonGitDir);

  try {
    const porcelain = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
    );
    const nestedPi = makeWorktreeValidationPi(repoRoot, porcelain, commonGitDir);
    await assert.rejects(
      () => validateWorktreeCreationPath(nestedPi, { cwd: repoRoot }, join(repoRoot, "nested-worktree")),
      /inside a registered worktree/u,
    );

    const commonPi = makeWorktreeValidationPi(repoRoot, porcelain, commonGitDir);
    await assert.rejects(
      () => validateWorktreeCreationPath(commonPi, { cwd: repoRoot }, join(commonGitDir, "nested-worktree")),
      /inside the repository common Git directory/u,
    );
    assert.equal(
      [...nestedPi.calls, ...commonPi.calls].every((call) =>
        call.args[0] === "rev-parse" || call.args.join("\0") === "worktree\0list\0--porcelain\0-z"),
      true,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateWorktreeRemovalPath accepts only an exact canonical current-repository entry", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-path-"));
  const repoRoot = join(tempRoot, "repo");
  const linkedRoot = join(tempRoot, "linked");
  const linkedNested = join(linkedRoot, "nested");
  const foreignRoot = join(tempRoot, "foreign");
  const aliasPath = join(tempRoot, "linked-alias");
  const commonGitDir = join(tempRoot, "common-git");
  await mkdir(repoRoot);
  await mkdir(linkedRoot);
  await mkdir(linkedNested);
  await mkdir(foreignRoot);
  await mkdir(commonGitDir);
  await symlink(linkedRoot, aliasPath, "dir");

  try {
    const porcelain = [
      worktreePorcelainRecord(
        `worktree ${repoRoot}`,
        `HEAD ${"a".repeat(40)}`,
        "branch refs/heads/main",
      ),
      worktreePorcelainRecord(
        `worktree ${linkedRoot}`,
        `HEAD ${"b".repeat(40)}`,
        "branch refs/heads/feature/linked",
      ),
    ].join("");
    const acceptedPi = makeWorktreeValidationPi(repoRoot, porcelain, commonGitDir);

    const details = await validateWorktreeRemovalPath(acceptedPi, { cwd: repoRoot }, aliasPath);

    assert.equal(details.repoRoot, repoRoot);
    assert.equal(details.canonicalPath, await realpath(linkedRoot));
    assert.equal(details.worktree.path, linkedRoot);
    assert.equal(details.worktree.branch, "feature/linked");
    assert.equal(details.worktree.main, false);
    assert.equal(details.worktree.current, false);
    assert.deepEqual(acceptedPi.calls.map((call) => call.args), [
      ["rev-parse", "--show-toplevel"],
      ["worktree", "list", "--porcelain", "-z"],
    ]);

    for (const rejectedPath of [linkedNested, foreignRoot]) {
      const rejectedPi = makeWorktreeValidationPi(repoRoot, porcelain, commonGitDir);
      await assert.rejects(
        () => validateWorktreeRemovalPath(rejectedPi, { cwd: repoRoot }, rejectedPath),
        /exactly match a registered worktree/u,
      );
      assert.equal(rejectedPi.calls.filter((call) => call.args[0] === "worktree").length, 1);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createWorktree creates a new local branch from current HEAD and returns a verified ready handoff", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-new-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const destination = join(tempRoot, "feature-new");
  const sourceHead = "a".repeat(40);
  const branchName = "feature/new";
  await mkdir(repoRoot);
  await mkdir(commonGitDir);
  const canonicalRoot = await realpath(tempRoot);
  const canonicalDestination = join(canonicalRoot, "feature-new");

  try {
    const before = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${sourceHead}`,
      "branch refs/heads/main",
    );
    const after = before + worktreePorcelainRecord(
      `worktree ${canonicalDestination}`,
      `HEAD ${sourceHead}`,
      `branch refs/heads/${branchName}`,
    );
    const controller = new AbortController();
    const pi = makeWorktreeCreationPi({
      repoRoot,
      commonGitDir,
      destination: canonicalDestination,
      sourceBranch: "main",
      sourceHead,
      branchName,
      branchExists: false,
      inventories: [before, after],
    });

    const details = await createWorktree(
      pi,
      { cwd: repoRoot },
      destination,
      branchName,
      "new",
      controller.signal,
    );

    assert.equal(details.action, "create_worktree");
    assert.equal(details.repoRoot, repoRoot);
    assert.deepEqual(details.request, { worktreePath: destination, branchName, branchMode: "new" });
    assert.deepEqual(details.verified.before, {
      sourcePath: await realpath(repoRoot),
      sourceBranch: "main",
      sourceDetached: false,
      sourceHead,
      canonicalWorktreePath: canonicalDestination,
      branchExisted: false,
      destinationRegistered: false,
    });
    assert.equal(details.verified.after.worktreePresent, true);
    assert.deepEqual(details.verified.after.workingTree, {
      state: "clean",
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
    assert.deepEqual(details.handoff, {
      cwd: canonicalDestination,
      branch: branchName,
      head: sourceHead,
      ready: true,
      summary: `Worktree ready at ${canonicalDestination} on branch ${branchName} at ${sourceHead}.`,
    });
    assert.deepEqual(
      pi.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "add").map((call) => call.args),
      [["worktree", "add", "-b", branchName, canonicalDestination, "HEAD"]],
    );
    assert.equal(
      pi.calls.some((call) => call.args[0] === "status" && call.options.cwd === repoRoot),
      false,
      "source worktree dirtiness must not be inspected or rejected",
    );
    assert.equal(pi.calls.every((call) => call.options.signal === controller.signal), true);
    assert.equal(
      pi.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add").options.timeout,
      120_000,
    );
    assertNoUnsafeWorktreeCreationCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createWorktree can create a new branch from a detached but valid current HEAD", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-detached-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const destination = join(tempRoot, "feature-detached");
  const sourceHead = "a".repeat(40);
  const branchName = "feature/from-detached";
  await mkdir(repoRoot);
  await mkdir(commonGitDir);
  const canonicalDestination = join(await realpath(tempRoot), "feature-detached");

  try {
    const before = worktreePorcelainRecord(`worktree ${repoRoot}`, `HEAD ${sourceHead}`, "detached");
    const after = before + worktreePorcelainRecord(
      `worktree ${canonicalDestination}`,
      `HEAD ${sourceHead}`,
      `branch refs/heads/${branchName}`,
    );
    const pi = makeWorktreeCreationPi({
      repoRoot,
      commonGitDir,
      destination: canonicalDestination,
      sourceDetached: true,
      sourceHead,
      branchName,
      branchExists: false,
      inventories: [before, after],
    });

    const details = await createWorktree(pi, { cwd: repoRoot }, destination, branchName, "new");

    assert.equal(details.verified.before.sourceBranch, null);
    assert.equal(details.verified.before.sourceDetached, true);
    assert.equal(details.verified.before.sourceHead, sourceHead);
    assert.equal(details.handoff.ready, true);
    assert.deepEqual(
      pi.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "add").map((call) => call.args),
      [["worktree", "add", "-b", branchName, canonicalDestination, "HEAD"]],
    );
    assertNoUnsafeWorktreeCreationCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createWorktree checks out only an existing unoccupied local branch", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-existing-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const destination = join(tempRoot, "feature-existing");
  const sourceHead = "a".repeat(40);
  const branchHead = "b".repeat(40);
  const branchName = "feature/existing";
  await mkdir(repoRoot);
  await mkdir(commonGitDir);
  const canonicalRoot = await realpath(tempRoot);
  const canonicalDestination = join(canonicalRoot, "feature-existing");

  try {
    const before = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${sourceHead}`,
      "branch refs/heads/main",
    );
    const after = before + worktreePorcelainRecord(
      `worktree ${canonicalDestination}`,
      `HEAD ${branchHead}`,
      `branch refs/heads/${branchName}`,
    );
    const pi = makeWorktreeCreationPi({
      repoRoot,
      commonGitDir,
      destination: canonicalDestination,
      sourceBranch: "main",
      sourceHead,
      branchName,
      branchExists: true,
      branchHead,
      inventories: [before, after],
    });

    const details = await createWorktree(pi, { cwd: repoRoot }, destination, branchName, "existing");

    assert.equal(details.verified.before.branchExisted, true);
    assert.equal(details.verified.before.sourceHead, sourceHead);
    assert.equal(details.verified.after.worktree.branch, branchName);
    assert.equal(details.verified.after.worktree.head, branchHead);
    assert.equal(details.handoff.cwd, canonicalDestination);
    assert.equal(details.handoff.head, branchHead);
    assert.deepEqual(
      pi.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "add").map((call) => call.args),
      [["worktree", "add", canonicalDestination, branchName]],
    );
    assertNoUnsafeWorktreeCreationCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createWorktree rejects incompatible branch modes before git worktree add", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-branches-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const sourceHead = "a".repeat(40);
  await mkdir(repoRoot);
  await mkdir(commonGitDir);

  try {
    const occupiedPath = join(tempRoot, "occupied");
    const scenarios = [
      {
        branchMode: "new",
        branchName: "feature/already-exists",
        branchExists: true,
        expected: /already exists/u,
        inventory: worktreePorcelainRecord(
          `worktree ${repoRoot}`,
          `HEAD ${sourceHead}`,
          "branch refs/heads/main",
        ),
      },
      {
        branchMode: "existing",
        branchName: "feature/missing",
        branchExists: false,
        expected: /does not exist/u,
        inventory: worktreePorcelainRecord(
          `worktree ${repoRoot}`,
          `HEAD ${sourceHead}`,
          "branch refs/heads/main",
        ),
      },
      {
        branchMode: "existing",
        branchName: "feature/occupied",
        branchExists: true,
        expected: /already checked out/u,
        inventory: worktreePorcelainRecord(
          `worktree ${repoRoot}`,
          `HEAD ${sourceHead}`,
          "branch refs/heads/main",
        ) + worktreePorcelainRecord(
          `worktree ${occupiedPath}`,
          `HEAD ${"b".repeat(40)}`,
          "branch refs/heads/feature/occupied",
        ),
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const destination = join(tempRoot, `rejected-${index}`);
      const pi = makeWorktreeCreationPi({
        repoRoot,
        commonGitDir,
        destination,
        sourceBranch: "main",
        sourceHead,
        branchName: scenario.branchName,
        branchExists: scenario.branchExists,
        branchHead: "b".repeat(40),
        inventories: [scenario.inventory],
      });

      await assert.rejects(
        () => createWorktree(
          pi,
          { cwd: repoRoot },
          destination,
          scenario.branchName,
          scenario.branchMode,
        ),
        scenario.expected,
      );
      assert.equal(pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "add"), false);
      assertNoUnsafeWorktreeCreationCommands(pi.calls);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createWorktree requires a valid current HEAD before creating a new branch", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-head-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const destination = join(tempRoot, "invalid-head");
  const branchName = "feature/invalid-head";
  await mkdir(repoRoot);
  await mkdir(commonGitDir);

  try {
    const pi = makeWorktreeCreationPi({
      repoRoot,
      commonGitDir,
      destination,
      sourceBranch: "main",
      sourceHead: "a".repeat(40),
      sourceHeadResult: { code: 1, stderr: "fatal: Needed a single revision\n" },
      branchName,
      branchExists: false,
      inventories: [],
    });

    await assert.rejects(
      () => createWorktree(pi, { cwd: repoRoot }, destination, branchName, "new"),
      /Current HEAD must resolve to a valid commit/u,
    );
    assert.equal(pi.calls.some((call) => call.args[0] === "worktree"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createWorktree reports Git and verification failures without destructive cleanup", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-create-failure-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const sourceHead = "a".repeat(40);
  const branchName = "feature/failure";
  await mkdir(repoRoot);
  await mkdir(commonGitDir);

  try {
    const before = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${sourceHead}`,
      "branch refs/heads/main",
    );
    const cases = [
      {
        destination: join(tempRoot, "git-failure"),
        inventories: [before],
        addResult: {
          code: 1,
          stderr: `fatal: ghp_worktreefailuresecret123 ${"x".repeat(6_000)}\n`,
        },
      },
      {
        destination: join(tempRoot, "verification-failure"),
        inventories: [
          before,
          before + worktreePorcelainRecord(
            `worktree ${join(tempRoot, "verification-failure")}`,
            `HEAD ${"b".repeat(40)}`,
            `branch refs/heads/${branchName}`,
          ),
        ],
      },
    ];

    for (const failureCase of cases) {
      const pi = makeWorktreeCreationPi({
        repoRoot,
        commonGitDir,
        destination: failureCase.destination,
        sourceBranch: "main",
        sourceHead,
        branchName,
        branchExists: false,
        inventories: failureCase.inventories,
        addResult: failureCase.addResult,
      });

      await assert.rejects(
        () => createWorktree(pi, { cwd: repoRoot }, failureCase.destination, branchName, "new"),
        (error) => {
          assert.match(error.message, /repository and destination should be inspected/u);
          assert.match(error.message, /no automatic cleanup was attempted/u);
          assert.doesNotMatch(error.message, /worktreefailuresecret/u);
          assert.ok(error.message.length < 5_000);
          return true;
        },
      );
      assert.equal(
        pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove"),
        false,
      );
      assertNoUnsafeWorktreeCreationCommands(pi.calls);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeWorktree removes only a verified clean linked worktree and retains its branch", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-clean-"));
  const repoRoot = join(tempRoot, "repo");
  const linkedRoot = join(tempRoot, "linked");
  const aliasPath = join(tempRoot, "linked-alias");
  const head = "b".repeat(40);
  const branchName = "feature/linked";
  await mkdir(repoRoot);
  await mkdir(linkedRoot);
  await symlink(linkedRoot, aliasPath, "dir");
  const canonicalLinkedRoot = await realpath(linkedRoot);

  try {
    const mainRecord = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
    );
    const linkedRecord = worktreePorcelainRecord(
      `worktree ${linkedRoot}`,
      `HEAD ${head}`,
      `branch refs/heads/${branchName}`,
    );
    const controller = new AbortController();
    const pi = makeWorktreeRemovalPi({
      repoRoot,
      targetPath: canonicalLinkedRoot,
      branchName,
      head,
      inventories: [mainRecord + linkedRecord, mainRecord],
    });

    const details = await removeWorktree(pi, { cwd: repoRoot }, aliasPath, controller.signal);

    assert.equal(details.action, "remove_worktree");
    assert.equal(details.repoRoot, repoRoot);
    assert.deepEqual(details.request, { worktreePath: aliasPath });
    assert.equal(details.verified.before.worktree.path, canonicalLinkedRoot);
    assert.equal(details.verified.before.worktree.branch, branchName);
    assert.equal(details.verified.before.worktree.head, head);
    assert.deepEqual(details.verified.before.workingTree, {
      state: "clean",
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
    assert.deepEqual(details.verified.after, {
      worktreePresent: false,
      branchRetained: true,
      branch: branchName,
      head,
    });
    assert.deepEqual(details.handoff, {
      cwd: null,
      branch: branchName,
      head,
      ready: false,
      summary: `Worktree directory ${canonicalLinkedRoot} was removed; local branch ${branchName} was retained at ${head}.`,
    });
    assert.deepEqual(
      pi.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "remove").map((call) => call.args),
      [["worktree", "remove", canonicalLinkedRoot]],
    );
    assert.equal(
      pi.calls.filter((call) => call.args[0] === "rev-parse" && call.args[2]?.startsWith("refs/heads/")).length,
      2,
    );
    assert.equal(pi.calls.every((call) => call.options.signal === controller.signal), true);
    assert.equal(
      pi.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "remove").options.timeout,
      120_000,
    );
    assertNoUnsafeWorktreeRemovalCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeWorktree rejects main, current, detached, locked, prunable, missing, bare, and foreign targets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-rejections-"));
  const mainRoot = join(tempRoot, "main");
  const currentRoot = join(tempRoot, "current");
  const detachedRoot = join(tempRoot, "detached");
  const lockedRoot = join(tempRoot, "locked");
  const bareRoot = join(tempRoot, "bare");
  const foreignRoot = join(tempRoot, "foreign");
  const missingRoot = join(tempRoot, "missing");
  const prunableRoot = join(tempRoot, "prunable");
  for (const path of [mainRoot, currentRoot, detachedRoot, lockedRoot, bareRoot, foreignRoot]) {
    await mkdir(path);
  }
  const canonicalRoot = await realpath(tempRoot);
  const head = "a".repeat(40);
  const mainRecord = worktreePorcelainRecord(
    `worktree ${mainRoot}`,
    `HEAD ${head}`,
    "branch refs/heads/main",
  );
  const scenarios = [
    {
      name: "main",
      repoRoot: mainRoot,
      target: mainRoot,
      canonicalTarget: await realpath(mainRoot),
      inventory: mainRecord,
      expected: /main worktree cannot be removed/u,
    },
    {
      name: "current",
      repoRoot: currentRoot,
      target: currentRoot,
      canonicalTarget: await realpath(currentRoot),
      inventory: mainRecord + worktreePorcelainRecord(
        `worktree ${currentRoot}`,
        `HEAD ${"b".repeat(40)}`,
        "branch refs/heads/feature/current",
      ),
      expected: /current worktree cannot be removed/u,
    },
    {
      name: "detached",
      repoRoot: mainRoot,
      target: detachedRoot,
      canonicalTarget: await realpath(detachedRoot),
      inventory: mainRecord + worktreePorcelainRecord(
        `worktree ${detachedRoot}`,
        `HEAD ${"b".repeat(40)}`,
        "detached",
      ),
      expected: /detached worktree/u,
    },
    {
      name: "locked",
      repoRoot: mainRoot,
      target: lockedRoot,
      canonicalTarget: await realpath(lockedRoot),
      inventory: mainRecord + worktreePorcelainRecord(
        `worktree ${lockedRoot}`,
        `HEAD ${"b".repeat(40)}`,
        "branch refs/heads/feature/locked",
        "locked administrative reason",
      ),
      expected: /locked worktree/u,
    },
    {
      name: "prunable",
      repoRoot: mainRoot,
      target: prunableRoot,
      canonicalTarget: join(canonicalRoot, "prunable"),
      inventory: mainRecord + worktreePorcelainRecord(
        `worktree ${prunableRoot}`,
        `HEAD ${"b".repeat(40)}`,
        "branch refs/heads/feature/prunable",
        "prunable gitdir points to a missing location",
      ),
      expected: /prunable or missing/u,
    },
    {
      name: "missing",
      repoRoot: mainRoot,
      target: missingRoot,
      canonicalTarget: join(canonicalRoot, "missing"),
      inventory: mainRecord + worktreePorcelainRecord(
        `worktree ${missingRoot}`,
        `HEAD ${"b".repeat(40)}`,
        "branch refs/heads/feature/missing",
      ),
      expected: /is missing and cannot be removed/u,
    },
    {
      name: "bare",
      repoRoot: mainRoot,
      target: bareRoot,
      canonicalTarget: await realpath(bareRoot),
      inventory: mainRecord + worktreePorcelainRecord(`worktree ${bareRoot}`, "bare"),
      expected: /bare worktree entry/u,
    },
    {
      name: "foreign",
      repoRoot: mainRoot,
      target: foreignRoot,
      canonicalTarget: await realpath(foreignRoot),
      inventory: mainRecord,
      expected: /exactly match a registered worktree/u,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const pi = makeWorktreeRemovalPi({
        repoRoot: scenario.repoRoot,
        targetPath: scenario.canonicalTarget,
        inventories: [scenario.inventory],
      });
      await assert.rejects(
        () => removeWorktree(pi, { cwd: scenario.repoRoot }, scenario.target),
        scenario.expected,
        scenario.name,
      );
      assert.equal(pi.calls.some((call) => call.args[0] === "status"), false, scenario.name);
      assert.equal(
        pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove"),
        false,
        scenario.name,
      );
      assertNoUnsafeWorktreeRemovalCommands(pi.calls);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeWorktree rejects staged, unstaged, untracked, and unmerged target changes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-dirty-"));
  const repoRoot = join(tempRoot, "repo");
  const linkedRoot = join(tempRoot, "linked");
  const head = "b".repeat(40);
  const branchName = "feature/dirty";
  await mkdir(repoRoot);
  await mkdir(linkedRoot);
  const canonicalLinkedRoot = await realpath(linkedRoot);

  try {
    const inventory = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
    ) + worktreePorcelainRecord(
      `worktree ${linkedRoot}`,
      `HEAD ${head}`,
      `branch refs/heads/${branchName}`,
    );
    const pi = makeWorktreeRemovalPi({
      repoRoot,
      targetPath: canonicalLinkedRoot,
      branchName,
      head,
      inventories: [inventory],
      statusOutput: "M  staged.ts\0 M unstaged.ts\0?? untracked.ts\0UU conflicted.ts\0",
    });

    await assert.rejects(
      () => removeWorktree(pi, { cwd: repoRoot }, linkedRoot),
      /staged, unstaged, untracked, or unmerged changes/u,
    );
    assert.equal(pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove"), false);
    assert.equal(pi.calls.some((call) => call.args[0] === "rev-parse" && call.args[2]?.startsWith("refs/heads/")), false);
    assertNoUnsafeWorktreeRemovalCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeWorktree rejects ignored entries before removal without exposing their paths", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-ignored-"));
  const repoRoot = join(tempRoot, "repo");
  const linkedRoot = join(tempRoot, "linked");
  const head = "b".repeat(40);
  const branchName = "feature/ignored";
  await mkdir(repoRoot);
  await mkdir(linkedRoot);
  const canonicalLinkedRoot = await realpath(linkedRoot);

  try {
    const inventory = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
    ) + worktreePorcelainRecord(
      `worktree ${linkedRoot}`,
      `HEAD ${head}`,
      `branch refs/heads/${branchName}`,
    );
    const ignoredPath = "private-local-file.token";
    const pi = makeWorktreeRemovalPi({
      repoRoot,
      targetPath: canonicalLinkedRoot,
      branchName,
      head,
      inventories: [inventory],
      ignoredStatusOutput: `!! ${ignoredPath}\0`,
    });

    await assert.rejects(
      () => removeWorktree(pi, { cwd: repoRoot }, linkedRoot),
      (error) => {
        assert.match(error.message, /contains ignored files or directories/u);
        assert.match(error.message, /preserve them outside the checkout/u);
        assert.doesNotMatch(error.message, new RegExp(ignoredPath, "u"));
        return true;
      },
    );
    assert.deepEqual(
      pi.calls.filter((call) => call.args[0] === "status").map((call) => call.args),
      [detailedStatusArgs, ignoredWorktreeStatusArgs],
    );
    assert.equal(pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove"), false);
    assert.equal(pi.calls.some((call) => call.args[0] === "rev-parse" && call.args[2]?.startsWith("refs/heads/")), false);
    assertNoUnsafeWorktreeRemovalCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeWorktree bounds ignored-entry status output before removal", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-ignored-limit-"));
  const repoRoot = join(tempRoot, "repo");
  const linkedRoot = join(tempRoot, "linked");
  const head = "b".repeat(40);
  const branchName = "feature/ignored-limit";
  await mkdir(repoRoot);
  await mkdir(linkedRoot);
  const canonicalLinkedRoot = await realpath(linkedRoot);

  try {
    const inventory = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
    ) + worktreePorcelainRecord(
      `worktree ${linkedRoot}`,
      `HEAD ${head}`,
      `branch refs/heads/${branchName}`,
    );
    const pi = makeWorktreeRemovalPi({
      repoRoot,
      targetPath: canonicalLinkedRoot,
      branchName,
      head,
      inventories: [inventory],
      ignoredStatusOutput: `!! ${"x".repeat(128 * 1024)}\0`,
    });

    await assert.rejects(
      () => removeWorktree(pi, { cwd: repoRoot }, linkedRoot),
      /git status output exceeded the safety limit/u,
    );
    assert.equal(pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove"), false);
    assertNoUnsafeWorktreeRemovalCommands(pi.calls);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeWorktree fails closed when Git or postcondition verification is inconclusive", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-worktree-remove-failure-"));
  const repoRoot = join(tempRoot, "repo");
  const head = "b".repeat(40);
  const branchName = "feature/retained";
  await mkdir(repoRoot);
  const mainRecord = worktreePorcelainRecord(
    `worktree ${repoRoot}`,
    `HEAD ${"a".repeat(40)}`,
    "branch refs/heads/main",
  );
  const cases = [
    {
      name: "git failure",
      linkedRoot: join(tempRoot, "git-failure"),
      finalInventory: null,
      removeResult: {
        code: 1,
        stderr: `fatal: ghp_worktreeremovesecret123 ${"x".repeat(6_000)}\n`,
      },
    },
    {
      name: "still registered",
      linkedRoot: join(tempRoot, "still-registered"),
      finalInventory: "same",
    },
    {
      name: "branch moved",
      linkedRoot: join(tempRoot, "branch-moved"),
      finalInventory: mainRecord,
      branchHeads: [{ stdout: `${head}\n` }, { stdout: `${"c".repeat(40)}\n` }],
    },
  ];
  for (const failureCase of cases) await mkdir(failureCase.linkedRoot);

  try {
    for (const failureCase of cases) {
      const canonicalLinkedRoot = await realpath(failureCase.linkedRoot);
      const linkedRecord = worktreePorcelainRecord(
        `worktree ${failureCase.linkedRoot}`,
        `HEAD ${head}`,
        `branch refs/heads/${branchName}`,
      );
      const before = mainRecord + linkedRecord;
      const finalInventory = failureCase.finalInventory === "same"
        ? before
        : failureCase.finalInventory;
      const pi = makeWorktreeRemovalPi({
        repoRoot,
        targetPath: canonicalLinkedRoot,
        branchName,
        head,
        inventories: finalInventory === null ? [before] : [before, finalInventory],
        removeResult: failureCase.removeResult,
        branchHeads: failureCase.branchHeads,
      });

      await assert.rejects(
        () => removeWorktree(pi, { cwd: repoRoot }, failureCase.linkedRoot),
        (error) => {
          assert.match(error.message, /repository and target should be inspected/u, failureCase.name);
          assert.match(error.message, /no force or branch deletion was attempted/u, failureCase.name);
          assert.doesNotMatch(error.message, /worktreeremovesecret/u);
          assert.ok(error.message.length < 5_000);
          return true;
        },
      );
      assert.equal(
        pi.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "remove").length,
        1,
        failureCase.name,
      );
      assertNoUnsafeWorktreeRemovalCommands(pi.calls);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("getRecentCommits uses one bounded argv-style git log call and sanitizes subjects", async () => {
  const firstHash = "a".repeat(40);
  const secondHash = "b".repeat(40);
  const output =
    recentLogRecord(firstHash, "aaaaaaa", "2026-07-04", "initial commit") +
    recentLogRecord(secondHash, "bbbbbbb", "2026-07-05", "line\n\u001b[31m ghp_subjectsecret123");
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    [recentLogArgs.join("\0")]: { stdout: output },
  });

  const commits = await getRecentCommits(pi, ctx);

  assert.deepEqual(commits, [
    {
      hash: firstHash,
      shortHash: "aaaaaaa",
      date: "2026-07-04",
      subject: "initial commit",
    },
    {
      hash: secondHash,
      shortHash: "bbbbbbb",
      date: "2026-07-05",
      subject: "line\\u000a\\u001b[31m [REDACTED]",
    },
  ]);
  assert.deepEqual(
    pi.calls.map((call) => call.args),
    [["rev-parse", "--show-toplevel"], recentLogArgs],
  );
  assert.equal(pi.calls.filter((call) => call.args[0] === "log").length, 1);
  assert.equal(pi.calls[1].options.cwd, "/repo");
  assert.equal(pi.calls[1].options.timeout, 5_000);
});

test("parseRecentCommits returns at most five bounded control-free subjects", () => {
  const output = Array.from({ length: 6 }, (_, index) => {
    const digit = String(index + 1);
    return recentLogRecord(
      digit.repeat(40),
      digit.repeat(7),
      `2026-07-${String(index + 1).padStart(2, "0")}`,
      `${index === 0 ? "title\u2028github_pat_subjectsecret123-" : ""}${"x".repeat(600)}`,
    );
  }).join("");

  const commits = parseRecentCommits(output);

  assert.equal(commits.length, 5);
  for (const commit of commits) {
    assert.ok(commit.subject.length <= 512);
    assert.doesNotMatch(commit.subject, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  }
  assert.match(commits[0].subject, /\\u2028/u);
  assert.doesNotMatch(commits[0].subject, /subjectsecret/u);
});

test("getRecentCommits treats an unborn repository as a successful empty result", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    [recentLogArgs.join("\0")]: { code: 128, stderr: "fatal: your current branch has no commits yet\n" },
    ["rev-parse\0--verify\0HEAD"]: { code: 128, stderr: "fatal: Needed a single revision\n" },
  });

  assert.deepEqual(await getRecentCommits(pi, ctx), []);
  assert.deepEqual(
    pi.calls.map((call) => call.args),
    [["rev-parse", "--show-toplevel"], recentLogArgs, ["rev-parse", "--verify", "HEAD"]],
  );
});

test("getRecentCommits preserves real git log failures when HEAD exists", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    [recentLogArgs.join("\0")]: { code: 128, stderr: "fatal: corrupt object ghp_logsecret123\n" },
    ["rev-parse\0--verify\0HEAD"]: { stdout: "a".repeat(40) },
  });

  await assert.rejects(
    () => getRecentCommits(pi, ctx),
    (error) => error instanceof Error && /git log .* failed/u.test(error.message) && !/logsecret/u.test(error.message),
  );
});

test("inferPullRequestBaseBranch prefers a local origin HEAD and falls back to common local branches", async () => {
  const originPi = makePi({
    ["symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD"]: { stdout: "origin/trunk\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/trunk"]: { code: 0 },
  });
  assert.equal(await inferPullRequestBaseBranch(originPi, ctx, "feature/autofill"), "trunk");

  const fallbackPi = makePi({
    ["symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD"]: { stdout: "origin/stale-default\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/stale-default"]: { code: 1 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
  });
  assert.equal(await inferPullRequestBaseBranch(fallbackPi, ctx, "feature/autofill"), "main");

  const defaultPi = makePi({
    ["symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD"]: { stdout: "origin/main\n" },
  });
  await assert.rejects(
    () => inferPullRequestBaseBranch(defaultPi, ctx, "main"),
    /current branch is the origin default branch/i,
  );
});

test("getPullRequestCommitSubjects returns bounded redacted single-line subjects", async () => {
  const opaqueToken = "opaque-secret-value";
  const longSubject = `${"a".repeat(254)}😀trailing`;
  const pi = makePi({
    ["log\0--max-count=20\0--format=%s\0refs/heads/main..refs/heads/feature/autofill\0--"]: {
      stdout: `Add autofill\n${opaqueToken}\nline with control\u001b and separator\u2028value\n${longSubject}\n`,
    },
  });

  const subjects = await getPullRequestCommitSubjects(
    pi,
    ctx,
    "feature/autofill",
    "main",
    undefined,
    [opaqueToken],
  );
  assert.deepEqual(subjects.slice(0, 3), [
    "Add autofill",
    "[REDACTED]",
    "line with control and separator value",
  ]);
  assert.equal(subjects[3].length <= 256, true);
  assert.equal(subjects[3].endsWith("…"), true);
  assert.equal(subjects[3].isWellFormed(), true);
});

test("validateBranchName uses local checks and git check-ref-format", async () => {
  assert.throws(
    () => validateBranchNameInput(42),
    (error) => error instanceof TypeError && /Branch name must be a string/u.test(error.message),
  );
  assert.throws(() => validateBranchNameInput("bad\nname"), /control/i);
  assert.throws(() => validateBranchNameInput("bad name"), /whitespace/i);
  assert.throws(() => validateBranchNameInput("-bad"), /start/);

  const pi = makePi({
    ["check-ref-format\0--branch\0feature/good"]: { stdout: "feature/good\n" },
  });

  await validateBranchName(pi, ctx, "feature/good");
  assert.deepEqual(pi.calls[0].args, ["check-ref-format", "--branch", "feature/good"]);
});

test("createLocalBranch rejects existing branches before git switch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["check-ref-format\0--branch\0feature/existing"]: { stdout: "feature/existing\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/existing"]: { code: 0 },
  });

  await assert.rejects(() => createLocalBranch(pi, ctx, "feature/existing"), /already exists/);
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("createLocalBranch creates from current HEAD with git switch -c", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["check-ref-format\0--branch\0feature/new"]: { stdout: "feature/new\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/new"]: { code: 1 },
    ["switch\0-c\0feature/new"]: { stdout: "" },
  });

  const details = await createLocalBranch(pi, ctx, "feature/new");

  assert.deepEqual(details, { repoRoot: "/repo", previousBranch: "main", newBranch: "feature/new" });
  assert.deepEqual(pi.calls.at(-1).args, ["switch", "-c", "feature/new"]);
});

test("mutating branch helpers serialize repository-state windows for the same repository", async () => {
  const calls = [];
  const pi = {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      assert.equal(options.cwd, "/repo");
      calls.push({ command, args: [...args], options });
      await new Promise((resolve) => setImmediate(resolve));

      if (args.join("\0") === "rev-parse\0--show-toplevel") return result({ stdout: "/repo\n" });
      if (args.join("\0") === "symbolic-ref\0--quiet\0--short\0HEAD") return result({ stdout: "main\n" });
      if (args[0] === "check-ref-format") return result({ stdout: `${args[2]}\n` });
      if (args[0] === "show-ref") return result({ code: 1 });
      if (args[0] === "switch") return result();
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };

  await Promise.all([
    createLocalBranch(pi, ctx, "feature/one"),
    createLocalBranch(pi, ctx, "feature/two"),
  ]);

  const nonRootCommands = calls
    .map((call) => call.args)
    .filter((args) => args.join("\0") !== "rev-parse\0--show-toplevel");

  assert.deepEqual(nonRootCommands, [
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["check-ref-format", "--branch", "feature/one"],
    ["show-ref", "--verify", "--quiet", "refs/heads/feature/one"],
    ["switch", "-c", "feature/one"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["check-ref-format", "--branch", "feature/two"],
    ["show-ref", "--verify", "--quiet", "refs/heads/feature/two"],
    ["switch", "-c", "feature/two"],
  ]);
});

test("changeExistingLocalBranch switches from current branch with argv-style git switch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/foo"]: { stdout: "feature/foo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/foo"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: [{ stdout: "main\n" }, { stdout: "feature/foo\n" }],
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n" },
    ["switch\0feature/foo"]: { stdout: "" },
  });

  const details = await changeExistingLocalBranch(pi, ctx, "feature/foo");

  assert.deepEqual(details, {
    repoRoot: "/repo",
    previousBranch: "main",
    previousDetached: false,
    currentBranch: "feature/foo",
    hasChangesBeforeSwitch: false,
  });
  assert.deepEqual(
    pi.calls.filter((call) => call.args[0] === "switch").map((call) => call.args),
    [["switch", "feature/foo"]],
  );
  assertNoUnsafeBranchSwitchCommands(pi.calls);
});

test("changeExistingLocalBranch switches from detached HEAD when HEAD is valid", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0main"]: { stdout: "main\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: [
      { code: 1, stderr: "fatal: ref HEAD is not a symbolic ref\n" },
      { stdout: "main\n" },
    ],
    ["rev-parse\0--verify\0HEAD"]: { stdout: "abc123\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## HEAD (no branch)\n" },
    ["switch\0main"]: { stdout: "" },
  });

  const details = await changeExistingLocalBranch(pi, ctx, "main");

  assert.deepEqual(details, {
    repoRoot: "/repo",
    previousBranch: null,
    previousDetached: true,
    currentBranch: "main",
    hasChangesBeforeSwitch: false,
  });
  assert.deepEqual(pi.calls.filter((call) => call.args[0] === "switch").map((call) => call.args), [["switch", "main"]]);
  assertNoUnsafeBranchSwitchCommands(pi.calls);
});

test("changeExistingLocalBranch rejects invalid branch names before git switch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
  });

  await assert.rejects(() => changeExistingLocalBranch(pi, ctx, "bad name"), /whitespace/i);
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("changeExistingLocalBranch rejects missing local branches", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/missing"]: { stdout: "feature/missing\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/missing"]: { code: 1 },
  });

  await assert.rejects(() => changeExistingLocalBranch(pi, ctx, "feature/missing"), /does not exist/);
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("changeExistingLocalBranch rejects dirty worktrees before git switch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/foo"]: { stdout: "feature/foo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/foo"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n M src/a.ts\n" },
  });

  await assert.rejects(() => changeExistingLocalBranch(pi, ctx, "feature/foo"), /uncommitted changes/);
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("changeExistingLocalBranch rejects switching to the already-current branch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0main"]: { stdout: "main\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
  });

  await assert.rejects(() => changeExistingLocalBranch(pi, ctx, "main"), /Already on branch 'main'/);
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("formatGitFailure redacts credential-bearing command labels and git output", () => {
  const message = formatGitFailure(
    ["push", "https://user:ghp_labelsecret123@github.com/senad-d/branchme.git"],
    result({
      stderr:
        "fatal: could not read from https://user:ghp_stderrsecret123@github.com/senad-d/branchme.git; Authorization: Bearer ghp_bearersecret123; token=github_pat_keysecret123",
    }),
  );

  assert.doesNotMatch(message, /labelsecret|stderrsecret|bearersecret|keysecret|user:ghp_/u);
  assert.match(message, /\[REDACTED\]/u);
});

test("fetchCurrentBranch fetches the current branch's configured upstream remote", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["fetch\0--no-tags\0--no-recurse-submodules\0origin\0refs/heads/main:refs/remotes/origin/main"]: { stderr: "From github.com:senad-d/branchme\n" },
  });

  const details = await fetchCurrentBranch(pi, ctx);

  assert.deepEqual(details, {
    repoRoot: "/repo",
    currentBranch: "main",
    upstream: "origin/main",
    remote: "origin",
    remoteRef: "refs/heads/main",
    remoteTrackingRef: "refs/remotes/origin/main",
    refspec: "refs/heads/main:refs/remotes/origin/main",
    output: "From github.com:senad-d/branchme",
  });
  assert.deepEqual(pi.calls.at(-1).args, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  ]);
  assert.equal(pi.calls.at(-1).options.timeout, 120_000);
  assert.equal(pi.calls.some((call) => ["switch", "rebase", "merge", "push"].includes(call.args[0])), false);
});

test("fetchCurrentBranch rejects branches without configured upstreams", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
  });

  await assert.rejects(() => fetchCurrentBranch(pi, ctx), /no upstream is configured/i);
  assert.equal(pi.calls.some((call) => call.args[0] === "fetch"), false);
});

test("fetchCurrentBranch rejects upstream refs that do not match the configured remote", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "other/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
  });

  await assert.rejects(() => fetchCurrentBranch(pi, ctx), /upstream does not match its remote/i);
  assert.equal(pi.calls.some((call) => call.args[0] === "fetch"), false);
});

test("pullCurrentBranch fast-forwards the clean current branch from its configured upstream", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main [behind 1]\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["pull\0--ff-only\0--no-rebase\0--no-autostash\0origin\0refs/heads/main"]: { stdout: "Updating 1111111..2222222\nFast-forward\n" },
  });

  const details = await pullCurrentBranch(pi, ctx);

  assert.deepEqual(details, {
    repoRoot: "/repo",
    currentBranch: "main",
    upstream: "origin/main",
    remote: "origin",
    remoteRef: "refs/heads/main",
    output: "Updating 1111111..2222222\nFast-forward",
  });
  assert.deepEqual(pi.calls.at(-1).args, ["pull", "--ff-only", "--no-rebase", "--no-autostash", "origin", "refs/heads/main"]);
  assert.equal(pi.calls.at(-1).options.timeout, 120_000);
  assert.equal(pi.calls.at(-1).args.includes("--no-rebase"), true);
  assert.equal(pi.calls.at(-1).args.includes("--no-autostash"), true);
  assert.equal(pi.calls.some((call) => call.args.includes("--rebase") || call.args.includes("--force")), false);
});

test("pullCurrentBranch rejects dirty worktrees and branches without upstreams", async () => {
  const dirtyPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n M README.md\n" },
  });

  await assert.rejects(() => pullCurrentBranch(dirtyPi, ctx), /clean it before pulling/i);
  assert.equal(dirtyPi.calls.some((call) => call.args[0] === "pull"), false);

  const noUpstreamPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
  });

  await assert.rejects(() => pullCurrentBranch(noUpstreamPi, ctx), /no upstream is configured/i);
  assert.equal(noUpstreamPi.calls.some((call) => call.args[0] === "pull"), false);
});

test("pullCurrentBranch redacts credential-bearing git output in returned details", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["pull\0--ff-only\0--no-rebase\0--no-autostash\0origin\0refs/heads/main"]: {
      stdout: "pulled from https://user:ghp_pullsecret123@github.com/senad-d/branchme.git\n",
    },
  });

  const details = await pullCurrentBranch(pi, ctx);

  assert.doesNotMatch(details.output, /pullsecret|user:ghp_/u);
  assert.match(details.output, /\[REDACTED\]/u);
});

test("rebaseCurrentBranch rebases the clean current branch onto its configured upstream", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/current...origin/feature/current [ahead 2, behind 1]\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    ["rebase\0--no-autostash\0--no-update-refs\0origin/feature/current"]: { stderr: "Successfully rebased and updated refs/heads/feature/current.\n" },
  });

  const details = await rebaseCurrentBranch(pi, ctx);

  assert.deepEqual(details, {
    repoRoot: "/repo",
    currentBranch: "feature/current",
    upstream: "origin/feature/current",
    remote: "origin",
    remoteRef: "refs/heads/feature/current",
    output: "Successfully rebased and updated refs/heads/feature/current.",
  });
  assert.deepEqual(pi.calls.at(-1).args, ["rebase", "--no-autostash", "--no-update-refs", "origin/feature/current"]);
  assert.equal(pi.calls.at(-1).options.timeout, 120_000);
  assert.equal(pi.calls.at(-1).args.includes("--no-autostash"), true);
  assert.equal(pi.calls.at(-1).args.includes("--no-update-refs"), true);
  assert.equal(pi.calls.some((call) => ["stash", "merge", "push"].includes(call.args[0])), false);
});

test("rebaseCurrentBranch rejects dirty worktrees and branches without upstreams", async () => {
  const dirtyPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/current\n M README.md\n" },
  });

  await assert.rejects(() => rebaseCurrentBranch(dirtyPi, ctx), /clean it before rebasing/i);
  assert.equal(dirtyPi.calls.some((call) => call.args[0] === "rebase"), false);

  const noUpstreamPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
  });

  await assert.rejects(() => rebaseCurrentBranch(noUpstreamPi, ctx), /no upstream is configured/i);
  assert.equal(noUpstreamPi.calls.some((call) => call.args[0] === "rebase"), false);
});

test("rebaseCurrentBranch aborts and restores the branch after a failed rebase", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/current...origin/feature/current [ahead 1, behind 1]\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    ["rebase\0--no-autostash\0--no-update-refs\0origin/feature/current"]: { code: 1, stderr: "CONFLICT (content): merge conflict\n" },
    ["rebase\0--abort"]: { stdout: "" },
  });

  await assert.rejects(() => rebaseCurrentBranch(pi, ctx), /merge conflict.*aborted.*restored/is);
  assert.deepEqual(pi.calls.slice(-2).map((call) => call.args), [
    ["rebase", "--no-autostash", "--no-update-refs", "origin/feature/current"],
    ["rebase", "--abort"],
  ]);
  assert.equal(pi.calls.at(-1).options.signal, undefined);
});

test("pushCurrentBranch redacts credential-bearing git output in returned details", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    ["push\0origin\0HEAD:refs/heads/feature/current"]: {
      stdout:
        "pushed to https://user:ghp_pushsecret123@github.com/senad-d/branchme.git with Bearer ghp_bearersecret123 and token=github_pat_outputsecret123\n",
    },
  });

  const details = await pushCurrentBranch(pi, ctx);

  assert.doesNotMatch(details.output, /pushsecret|bearersecret|outputsecret|user:ghp_/u);
  assert.match(details.output, /\[REDACTED\]/u);
});

test("pushCurrentBranch fails clearly on detached HEAD", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { code: 1, stderr: "fatal: ref HEAD is not a symbolic ref\n" },
    ["rev-parse\0--verify\0HEAD"]: { stdout: "abc123\n" },
  });

  await assert.rejects(() => pushCurrentBranch(pi, ctx), /detached/i);
});

test("pushCurrentBranch uses an explicit remote and refspec when upstream exists", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    ["push\0origin\0HEAD:refs/heads/feature/current"]: { stdout: "Everything up-to-date\n" },
  });

  const details = await pushCurrentBranch(pi, ctx);

  assert.equal(details.mode, "push");
  assert.equal(details.remote, "origin");
  assert.equal(details.remoteRef, "refs/heads/feature/current");
  assert.equal(details.refspec, "HEAD:refs/heads/feature/current");
  assert.deepEqual(pi.calls.at(-1).args, ["push", "origin", "HEAD:refs/heads/feature/current"]);
  assert.equal(pi.calls.some((call) => call.args.length === 1 && call.args[0] === "push"), false);
});

test("pushCurrentBranch supports custom upstreams and branch names with slashes", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "upstream-remote/team/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "upstream-remote\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/team/feature/current\n" },
    ["push\0upstream-remote\0HEAD:refs/heads/team/feature/current"]: { stdout: "Everything up-to-date\n" },
  });

  const details = await pushCurrentBranch(pi, ctx);

  assert.equal(details.remote, "upstream-remote");
  assert.equal(details.remoteRef, "refs/heads/team/feature/current");
  assert.deepEqual(pi.calls.at(-1).args, ["push", "upstream-remote", "HEAD:refs/heads/team/feature/current"]);
});

test("pushCurrentBranch rejects incomplete or non-remote upstream configuration", async () => {
  const missingConfigPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { code: 1, stderr: "missing\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
  });

  await assert.rejects(() => pushCurrentBranch(missingConfigPi, ctx), /configuration is incomplete/i);
  assert.equal(missingConfigPi.calls.some((call) => call.args[0] === "push"), false);

  const localUpstreamPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "main\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: ".\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/main\n" },
  });

  await assert.rejects(() => pushCurrentBranch(localUpstreamPi, ctx), /local branch/i);
  assert.equal(localUpstreamPi.calls.some((call) => call.args[0] === "push"), false);
});

test("pushCurrentBranch rejects upstream remote names with whitespace or control characters", async () => {
  for (const remote of ["bad remote", "bad\tremote", "bad\nremote", `bad${String.fromCharCode(0)}remote`]) {
    const pi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
      ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
      ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
      ["config\0--get\0branch.feature/current.remote"]: { stdout: `${remote}\n` },
      ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    });

    await assert.rejects(() => pushCurrentBranch(pi, ctx), /whitespace or control/i);
    assert.equal(pi.calls.some((call) => call.args[0] === "push"), false);
  }
});

test("pushCurrentBranch publishes current branch when upstream is missing", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
    ["push\0--set-upstream\0origin\0feature/current"]: { stdout: "branch set up\n" },
  });

  const details = await pushCurrentBranch(pi, ctx);

  assert.equal(details.mode, "publish");
  assert.equal(details.remote, "origin");
  assert.equal(details.remoteRef, "refs/heads/feature/current");
  assert.equal(details.refspec, "feature/current");
  assert.deepEqual(pi.calls.at(-1).args, ["push", "--set-upstream", "origin", "feature/current"]);
});
