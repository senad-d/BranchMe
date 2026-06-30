import assert from "node:assert/strict";
import test from "node:test";
import {
  changeExistingLocalBranch,
  createLocalBranch,
  formatGitFailure,
  getBranchStatus,
  pushCurrentBranch,
  validateBranchName,
  validateBranchNameInput,
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

test("validateBranchName uses local checks and git check-ref-format", async () => {
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
