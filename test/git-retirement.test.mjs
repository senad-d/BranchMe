import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareBranchRetirement,
  retireBranch,
} from "../src/git-retirement.ts";
import { GIT_RETIREMENT_MUTATION_TIMEOUT_MS } from "../src/constants.ts";
import {
  inspectDirectLocalBranchRef,
  inspectLocalBranchWorktreeOccupancy,
  parseWorktreePorcelain,
} from "../src/git.ts";

function result(overrides = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function worktreeRecord(path, head, branch, ...attributes) {
  return `${[
    `worktree ${path}`,
    `HEAD ${head}`,
    `branch refs/heads/${branch}`,
    ...attributes,
  ].join("\0")}\0\0`;
}

function exactRefListingKey(fullRef) {
  return [
    "for-each-ref",
    "--count=1",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)",
    fullRef,
  ].join("\0");
}

function exactRefListing(fullRef, objectId) {
  return `${fullRef}\0${objectId}\n`;
}

function makeStrictRefPi(routes) {
  const calls = [];
  return {
    calls,
    async exec(command, args, options) {
      assert.equal(command, "git");
      calls.push({ args: [...args], options });
      const route = routes[args.join("\0")];
      if (!route) throw new Error(`Unexpected git command: ${args.join(" ")}`);
      return result(route);
    },
  };
}

function makePreflightPi(options) {
  const calls = [];
  const retiringHead = options.retiringHead ?? "a".repeat(40);
  const retiringObjectId = options.retiringObjectId ?? retiringHead;
  const targetHead = options.targetHead ?? "b".repeat(40);
  const targetObjectId = options.targetObjectId ?? targetHead;
  const retiringRef = `refs/heads/${options.branchName}`;
  const targetRef = `refs/heads/${options.targetBranch}`;
  const porcelain = options.porcelain ?? worktreeRecord(options.worktreeRoot, targetHead, options.targetBranch);

  return {
    calls,
    async exec(command, args, execOptions) {
      assert.equal(command, "git");
      calls.push({ args: [...args], options: execOptions });
      const key = args.join("\0");
      if (key === "rev-parse\0--show-toplevel") {
        return result({ stdout: `${options.worktreeRoot}\n` });
      }
      if (key === "rev-parse\0--path-format=absolute\0--git-common-dir") {
        return result({ stdout: `${options.commonGitDirectory}\n` });
      }
      if (key === `check-ref-format\0--branch\0${options.branchName}`) {
        return result(options.retiringNameResult);
      }
      if (key === `check-ref-format\0--branch\0${options.targetBranch}`) {
        return result(options.targetNameResult);
      }
      if (key === exactRefListingKey(retiringRef)) {
        if (options.retiringMissing) return result();
        return result({
          stdout: exactRefListing(retiringRef, retiringObjectId),
          ...options.retiringListingResult,
        });
      }
      if (key === exactRefListingKey(targetRef)) {
        if (options.targetMissing) return result();
        return result({
          stdout: exactRefListing(targetRef, targetObjectId),
          ...options.targetListingResult,
        });
      }
      if (key === `symbolic-ref\0--quiet\0${retiringRef}`) {
        if (options.retiringSymbolic) return result({ stdout: `${targetRef}\n` });
        return result({ code: 1 });
      }
      if (key === `symbolic-ref\0--quiet\0${targetRef}`) {
        if (options.targetSymbolic) return result({ stdout: `${retiringRef}\n` });
        return result({ code: 1 });
      }
      if (key === `rev-parse\0--verify\0${retiringRef}^{commit}`) {
        return result({ stdout: `${retiringHead}\n` });
      }
      if (key === `rev-parse\0--verify\0${targetRef}^{commit}`) {
        return result({ stdout: `${targetHead}\n` });
      }
      if (key === "worktree\0list\0--porcelain\0-z") {
        return result({ stdout: porcelain });
      }
      if (key === `merge-base\0--is-ancestor\0${retiringHead}\0${targetHead}`) {
        return result({ code: options.ancestor === false ? 1 : 0 });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function makeRetirementPi(options) {
  const calls = [];
  const counters = {
    root: 0,
    common: 0,
    retiringRef: 0,
    targetRef: 0,
    retiringCommit: 0,
    targetCommit: 0,
    worktree: 0,
    ancestry: 0,
  };
  const retiringHead = options.retiringHead ?? "a".repeat(40);
  const targetHead = options.targetHead ?? "b".repeat(40);
  const immediateRetiringHead = options.immediateRetiringHead ?? retiringHead;
  const immediateTargetHead = options.immediateTargetHead ?? targetHead;
  const retiringRef = `refs/heads/${options.branchName}`;
  const targetRef = `refs/heads/${options.targetBranch}`;
  let mutationAttempted = false;
  let deletionObserved = false;

  return {
    calls,
    counters,
    async exec(command, args, execOptions) {
      assert.equal(command, "git");
      calls.push({ args: [...args], options: execOptions });
      const key = args.join("\0");
      if (key === "rev-parse\0--show-toplevel") {
        counters.root += 1;
        const root = counters.root >= 6 && options.postWorktreeRoot
          ? options.postWorktreeRoot
          : options.worktreeRoot;
        return result({ stdout: `${root}\n` });
      }
      if (key === "rev-parse\0--path-format=absolute\0--git-common-dir") {
        counters.common += 1;
        const commonDirectory = counters.common >= 3 && options.postCommonGitDirectory
          ? options.postCommonGitDirectory
          : options.commonGitDirectory;
        return result({ stdout: `${commonDirectory}\n` });
      }
      if (key === `check-ref-format\0--branch\0${options.branchName}` ||
          key === `check-ref-format\0--branch\0${options.targetBranch}`) {
        return result();
      }
      if (key === exactRefListingKey(retiringRef)) {
        counters.retiringRef += 1;
        if (counters.retiringRef >= 3 && options.postRetiringInspectionResult) {
          return result(options.postRetiringInspectionResult);
        }
        let head = counters.retiringRef === 1 ? retiringHead : immediateRetiringHead;
        if (counters.retiringRef >= 3) {
          head = hasOwn(options, "postRetiringHead")
            ? options.postRetiringHead
            : deletionObserved ? null : immediateRetiringHead;
        }
        return head === null ? result() : result({ stdout: exactRefListing(retiringRef, head) });
      }
      if (key === exactRefListingKey(targetRef)) {
        counters.targetRef += 1;
        let head = counters.targetRef === 1 ? targetHead : immediateTargetHead;
        if (counters.targetRef >= 3) {
          head = hasOwn(options, "postTargetHead")
            ? options.postTargetHead
            : immediateTargetHead;
        }
        return head === null ? result() : result({ stdout: exactRefListing(targetRef, head) });
      }
      if (key === `symbolic-ref\0--quiet\0${retiringRef}` ||
          key === `symbolic-ref\0--quiet\0${targetRef}`) {
        return result({ code: 1 });
      }
      if (key === `rev-parse\0--verify\0${retiringRef}^{commit}`) {
        counters.retiringCommit += 1;
        const head = counters.retiringCommit === 1
          ? retiringHead
          : counters.retiringCommit === 2
            ? immediateRetiringHead
            : options.postRetiringHead ?? immediateRetiringHead;
        return result({ stdout: `${head}\n` });
      }
      if (key === `rev-parse\0--verify\0${targetRef}^{commit}`) {
        counters.targetCommit += 1;
        const head = counters.targetCommit === 1
          ? targetHead
          : counters.targetCommit === 2
            ? immediateTargetHead
            : options.postTargetHead ?? immediateTargetHead;
        return result({ stdout: `${head}\n` });
      }
      if (key === "worktree\0list\0--porcelain\0-z") {
        counters.worktree += 1;
        const porcelain = counters.worktree === 1
          ? options.preflightPorcelain
          : counters.worktree === 2
            ? options.immediatePorcelain
            : options.postPorcelain;
        return result({
          stdout: porcelain ?? worktreeRecord(
            options.worktreeRoot,
            immediateTargetHead,
            options.targetBranch,
          ),
        });
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        counters.ancestry += 1;
        const isAncestor = counters.ancestry === 1
          ? options.ancestor !== false
          : options.immediateAncestor !== false;
        return result({ code: isAncestor ? 0 : 1 });
      }
      if (key === `update-ref\0--no-deref\0-d\0${retiringRef}\0${retiringHead}`) {
        mutationAttempted = true;
        if (options.updateThrows) {
          deletionObserved = options.deletedDespiteMutationInterruption === true;
          throw options.updateThrows;
        }
        const updateResult = result(options.updateResult);
        deletionObserved = updateResult.code === 0;
        return updateResult;
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
    get mutationAttempted() {
      return mutationAttempted;
    },
  };
}

async function makePreflightFixture(overrides = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-retirement-"));
  const worktreeRoot = join(tempRoot, "worktree");
  const commonGitDirectory = join(tempRoot, "common-git");
  await mkdir(worktreeRoot);
  await mkdir(commonGitDirectory);
  return {
    tempRoot,
    options: {
      worktreeRoot: await realpath(worktreeRoot),
      commonGitDirectory: await realpath(commonGitDirectory),
      branchName: "feature/retire",
      targetBranch: "main",
      ...overrides,
    },
  };
}

function requestFor(options, overrides = {}) {
  return {
    branchName: options.branchName,
    expectedHead: (options.retiringHead ?? "a".repeat(40)).toUpperCase(),
    targetBranch: options.targetBranch,
    force: false,
    ...overrides,
  };
}

test("worktree occupancy inspects complete bounded inventory beyond the public display limit", async () => {
  const head = "1".repeat(40);
  const records = [];
  for (let index = 0; index < 104; index += 1) {
    records.push(worktreeRecord(`/worktrees/${index}`, head, `branch-${index}`));
  }
  records.push(worktreeRecord("/missing/retiring-worktree", head, "feature/retire", "locked reason", "prunable gone"));
  const porcelain = records.join("");
  const signal = new AbortController().signal;
  const pi = makeStrictRefPi({
    "rev-parse\0--show-toplevel": { stdout: "/worktrees/0\n" },
    "worktree\0list\0--porcelain\0-z": { stdout: porcelain },
  });

  const publicView = parseWorktreePorcelain(porcelain);
  assert.equal(publicView.worktrees.length, 100);
  assert.equal(publicView.omitted, 5);
  assert.equal(publicView.worktrees.some((entry) => entry.branch === "feature/retire"), false);

  const occupancy = await inspectLocalBranchWorktreeOccupancy(
    pi,
    { cwd: "/worktrees/0" },
    "feature/retire",
    signal,
  );
  assert.deepEqual(occupancy, {
    branchName: "feature/retire",
    completeInventoryInspected: true,
    occupied: true,
    matchingWorktreeCount: 1,
  });
  assert.ok(pi.calls.every((call) => call.options.signal === signal));
});

test("worktree occupancy treats main, current, linked, locked, prunable, and missing registrations alike", async () => {
  const head = "2".repeat(40);
  const porcelain = [
    worktreeRecord("/main", head, "feature/retire"),
    worktreeRecord("/current-linked", head, "feature/retire"),
    worktreeRecord("/linked", head, "feature/retire"),
    worktreeRecord("/locked", head, "feature/retire", "locked maintenance"),
    worktreeRecord("/missing/prunable", head, "feature/retire", "prunable gitdir missing"),
  ].join("");
  const pi = makeStrictRefPi({
    "rev-parse\0--show-toplevel": { stdout: "/current-linked\n" },
    "worktree\0list\0--porcelain\0-z": { stdout: porcelain },
  });

  const occupancy = await inspectLocalBranchWorktreeOccupancy(
    pi,
    { cwd: "/current-linked" },
    "feature/retire",
  );
  assert.equal(occupancy.occupied, true);
  assert.equal(occupancy.matchingWorktreeCount, 5);
});

test("strict direct-ref inspection distinguishes exact present and absent refs", async () => {
  const head = "3".repeat(40);
  const fullRef = "refs/heads/feature/retire";
  const signal = new AbortController().signal;
  const presentPi = makeStrictRefPi({
    [exactRefListingKey(fullRef)]: { stdout: exactRefListing(fullRef, head) },
    [`symbolic-ref\0--quiet\0${fullRef}`]: { code: 1 },
  });
  assert.deepEqual(
    await inspectDirectLocalBranchRef(presentPi, { cwd: "/repo" }, "feature/retire", signal),
    { status: "present", branchName: "feature/retire", fullRef, objectId: head },
  );
  assert.ok(presentPi.calls.every((call) => call.options.signal === signal));

  const absentPi = makeStrictRefPi({
    [exactRefListingKey(fullRef)]: {},
    [`symbolic-ref\0--quiet\0${fullRef}`]: { code: 1 },
  });
  assert.deepEqual(
    await inspectDirectLocalBranchRef(absentPi, { cwd: "/repo" }, "feature/retire"),
    { status: "absent", branchName: "feature/retire", fullRef },
  );
  assert.equal(absentPi.calls.length, 2);

  const prefixOnlyPi = makeStrictRefPi({
    [exactRefListingKey(fullRef)]: {
      stdout: exactRefListing(`${fullRef}/child`, head),
    },
    [`symbolic-ref\0--quiet\0${fullRef}`]: { code: 1 },
  });
  assert.deepEqual(
    await inspectDirectLocalBranchRef(prefixOnlyPi, { cwd: "/repo" }, "feature/retire"),
    { status: "absent", branchName: "feature/retire", fullRef },
  );
});

test("strict direct-ref inspection rejects aliases, symbolic refs, and unexpected results", async () => {
  const head = "4".repeat(40);
  const fullRef = "refs/heads/feature/retire";
  const listingKey = exactRefListingKey(fullRef);
  const symbolicRefKey = `symbolic-ref\0--quiet\0${fullRef}`;
  const cases = [
    {
      routes: { [listingKey]: { stdout: `${fullRef}\0short\n` } },
      expected: /malformed full object identity/iu,
    },
    {
      routes: { [listingKey]: { stdout: `${fullRef}\n` } },
      expected: /malformed exact-ref listing/iu,
    },
    {
      routes: {
        [listingKey]: { stdout: exactRefListing("refs/heads/feature/RETIRE", head) },
      },
      expected: /different ref identity/iu,
    },
    {
      routes: { [listingKey]: { code: 2, stderr: "fatal: bad repository\n" } },
      expected: /bad repository/iu,
    },
    {
      routes: { [listingKey]: { code: 1, killed: true } },
      expected: /killed/iu,
    },
    {
      routes: {
        [listingKey]: { stdout: exactRefListing(fullRef, head) },
        [symbolicRefKey]: { stdout: "refs/heads/main\n" },
      },
      expected: /is symbolic/iu,
    },
    {
      routes: {
        [listingKey]: {},
        [symbolicRefKey]: { stdout: "refs/heads/missing-target\n" },
      },
      expected: /is symbolic/iu,
    },
    {
      routes: {
        [listingKey]: { stdout: exactRefListing(fullRef, head) },
        [symbolicRefKey]: { code: 2, stderr: "fatal: cannot inspect\n" },
      },
      expected: /cannot inspect/iu,
    },
  ];

  for (const scenario of cases) {
    const pi = makeStrictRefPi(scenario.routes);
    await assert.rejects(
      () => inspectDirectLocalBranchRef(pi, { cwd: "/repo" }, "feature/retire"),
      scenario.expected,
    );
  }
});

test("prepareBranchRetirement returns bounded read-only merged preflight state for a dirty unrelated worktree", async () => {
  const fixture = await makePreflightFixture();
  try {
    await writeFile(join(fixture.options.worktreeRoot, "untracked.txt"), "dirty but unrelated\n");
    const pi = makePreflightPi(fixture.options);
    const signal = new AbortController().signal;
    const prepared = await prepareBranchRetirement(
      pi,
      { cwd: fixture.options.worktreeRoot },
      requestFor(fixture.options),
      signal,
    );

    assert.deepEqual(prepared, {
      worktreeRoot: fixture.options.worktreeRoot,
      canonicalCommonGitDirectory: fixture.options.commonGitDirectory,
      request: {
        branchName: fixture.options.branchName,
        expectedHead: "a".repeat(40),
        targetBranch: fixture.options.targetBranch,
        force: false,
      },
      retiring: {
        branchName: fixture.options.branchName,
        fullRef: `refs/heads/${fixture.options.branchName}`,
        head: "a".repeat(40),
      },
      target: {
        branchName: fixture.options.targetBranch,
        fullRef: `refs/heads/${fixture.options.targetBranch}`,
        head: "b".repeat(40),
      },
      worktreeOccupancy: {
        branchName: fixture.options.branchName,
        completeInventoryInspected: true,
        occupied: false,
        matchingWorktreeCount: 0,
      },
      retiringIsAncestorOfTarget: true,
      mode: "merged",
    });
    assert.ok(pi.calls.every((call) => call.options.signal === signal));
    const forbiddenCommands = new Set([
      "update-ref", "branch", "fetch", "pull", "push", "switch", "checkout", "reset", "merge", "rebase",
      "worktree add", "worktree remove", "worktree prune",
    ]);
    assert.equal(
      pi.calls.some((call) => forbiddenCommands.has(call.args.slice(0, 2).join(" ")) || forbiddenCommands.has(call.args[0])),
      false,
    );
    assert.equal(pi.calls.some((call) => call.args[0] === "status"), false);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("prepareBranchRetirement validates runtime requests before Git inspection", async () => {
  const pi = {
    calls: [],
    async exec(command, args, options) {
      this.calls.push({ command, args, options });
      throw new Error("Git must not be called");
    },
  };
  const head = "a".repeat(40);
  const invalidRequests = [
    null,
    { branchName: "feature", expectedHead: head, targetBranch: "main", force: false, extra: true },
    { branchName: 7, expectedHead: head, targetBranch: "main", force: false },
    { branchName: "refs/heads/feature", expectedHead: head, targetBranch: "main", force: false },
    { branchName: "feature", expectedHead: "a".repeat(41), targetBranch: "main", force: false },
    { branchName: "feature", expectedHead: head, targetBranch: "feature", force: false },
    { branchName: "feature", expectedHead: head, targetBranch: "main", force: "false" },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(() => prepareBranchRetirement(pi, { cwd: "/repo" }, request));
  }
  assert.equal(pi.calls.length, 0);
});

test("prepareBranchRetirement rejects missing, symbolic, mismatched, occupied, and unauthorized unmerged branches", async () => {
  const fixture = await makePreflightFixture();
  const occupied = worktreeRecord(
    fixture.options.worktreeRoot,
    "a".repeat(40),
    fixture.options.branchName,
    "locked maintenance",
    "prunable missing",
  );
  const cases = [
    { options: { retiringMissing: true }, expected: /does not exist/iu },
    { options: { retiringSymbolic: true }, expected: /is symbolic/iu },
    { options: { retiringObjectId: "c".repeat(40) }, expected: /not a direct ref/iu },
    { request: { expectedHead: "c".repeat(40) }, expected: /expected HEAD/iu },
    { options: { porcelain: occupied }, expected: /occupied/iu },
    { options: { ancestor: false }, expected: /force must be true/iu },
  ];

  try {
    for (const scenario of cases) {
      const options = { ...fixture.options, ...scenario.options };
      const pi = makePreflightPi(options);
      await assert.rejects(
        () => prepareBranchRetirement(
          pi,
          { cwd: fixture.options.worktreeRoot },
          requestFor(options, scenario.request),
        ),
        scenario.expected,
      );
      assert.equal(pi.calls.some((call) => call.args[0] === "update-ref"), false);
    }
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("force true bypasses only negative ancestry and reports forced-unmerged mode", async () => {
  const fixture = await makePreflightFixture({ ancestor: false });
  try {
    const forcedPi = makePreflightPi(fixture.options);
    const prepared = await prepareBranchRetirement(
      forcedPi,
      { cwd: fixture.options.worktreeRoot },
      requestFor(fixture.options, { force: true }),
    );
    assert.equal(prepared.retiringIsAncestorOfTarget, false);
    assert.equal(prepared.mode, "forced_unmerged");

    const occupiedOptions = {
      ...fixture.options,
      porcelain: worktreeRecord(
        fixture.options.worktreeRoot,
        "a".repeat(40),
        fixture.options.branchName,
      ),
    };
    await assert.rejects(
      () => prepareBranchRetirement(
        makePreflightPi(occupiedOptions),
        { cwd: fixture.options.worktreeRoot },
        requestFor(occupiedOptions, { force: true }),
      ),
      /occupied/iu,
    );
    await assert.rejects(
      () => prepareBranchRetirement(
        makePreflightPi({ ...fixture.options, retiringMissing: true }),
        { cwd: fixture.options.worktreeRoot },
        requestFor(fixture.options, { force: true }),
      ),
      /does not exist/iu,
    );
    await assert.rejects(
      () => prepareBranchRetirement(
        makePreflightPi(fixture.options),
        { cwd: fixture.options.worktreeRoot },
        requestFor(fixture.options, { expectedHead: "c".repeat(40), force: true }),
      ),
      /expected HEAD/iu,
    );
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch leases the exact local ref and returns verified merged details", async () => {
  const fixture = await makePreflightFixture();
  try {
    const pi = makeRetirementPi(fixture.options);
    const signal = new AbortController().signal;
    const details = await retireBranch(
      pi,
      { cwd: fixture.options.worktreeRoot },
      requestFor(fixture.options),
      signal,
    );
    const updateIndex = pi.calls.findIndex((call) => call.args[0] === "update-ref");
    assert.notEqual(updateIndex, -1);
    assert.deepEqual(pi.calls[updateIndex].args, [
      "update-ref",
      "--no-deref",
      "-d",
      `refs/heads/${fixture.options.branchName}`,
      "a".repeat(40),
    ]);
    assert.equal(pi.calls[updateIndex].options.timeout, GIT_RETIREMENT_MUTATION_TIMEOUT_MS);
    assert.equal(pi.calls[updateIndex].options.signal, signal);
    assert.ok(pi.calls.slice(0, updateIndex + 1).every((call) => call.options.signal === signal));
    assert.ok(pi.calls.slice(updateIndex + 1).every((call) => call.options.signal === undefined));

    assert.equal(details.action, "retire_branch");
    assert.equal(details.status, "retired");
    assert.equal(details.mode, "merged");
    assert.equal(details.verified.refs.before.retiring.head, "a".repeat(40));
    assert.equal(details.verified.refs.before.target.head, "b".repeat(40));
    assert.equal(details.verified.refs.after.retiring.absent, true);
    assert.equal(details.verified.refs.after.target.head, "b".repeat(40));
    assert.equal(details.verified.refs.after.targetHeadPreserved, true);
    assert.equal(details.verified.worktreeOccupancy.after.occupied, false);
    assert.deepEqual(details.verified.mutation, {
      exactLocalRefDeletionAttempted: true,
      localBranchAbsentAfterDeletion: true,
      directRemoteDeletionAttempted: false,
      remoteTrackingRefDeletionAttempted: false,
    });

    const forbidden = new Set([
      "branch", "fetch", "pull", "push", "reset", "switch", "checkout", "stash", "merge", "rebase",
    ]);
    assert.equal(pi.calls.some((call) => forbidden.has(call.args[0])), false);
    assert.equal(
      pi.calls.some((call) => call.args.some((argument) => argument.startsWith("refs/remotes/"))),
      false,
    );
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch classifies an explicitly authorized unmerged retirement", async () => {
  const fixture = await makePreflightFixture({ ancestor: false });
  try {
    const pi = makeRetirementPi(fixture.options);
    const details = await retireBranch(
      pi,
      { cwd: fixture.options.worktreeRoot },
      requestFor(fixture.options, { force: true }),
    );
    assert.equal(details.mode, "forced_unmerged");
    assert.equal(details.verified.ancestry.retiringIsAncestorOfTarget, false);
    assert.equal(pi.mutationAttempted, true);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch rejects changed immediate refs after refreshing ancestry and before mutation", async () => {
  const fixture = await makePreflightFixture({
    immediateRetiringHead: "c".repeat(40),
    immediateTargetHead: "d".repeat(40),
  });
  try {
    const pi = makeRetirementPi(fixture.options);
    await assert.rejects(
      () => retireBranch(
        pi,
        { cwd: fixture.options.worktreeRoot },
        requestFor(fixture.options),
      ),
      /preconditions changed.*retiring local ref moved.*target local ref moved.*ancestry.*No local ref was deleted/iu,
    );
    assert.equal(pi.counters.ancestry, 2);
    assert.equal(pi.mutationAttempted, false);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch rejects immediate worktree occupancy before mutation", async () => {
  const fixture = await makePreflightFixture();
  try {
    const pi = makeRetirementPi({
      ...fixture.options,
      immediatePorcelain: worktreeRecord(
        fixture.options.worktreeRoot,
        "a".repeat(40),
        fixture.options.branchName,
      ),
    });
    await assert.rejects(
      () => retireBranch(
        pi,
        { cwd: fixture.options.worktreeRoot },
        requestFor(fixture.options),
      ),
      /occupied/iu,
    );
    assert.equal(pi.mutationAttempted, false);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch classifies safe command failure and expected-lease concurrency", async (t) => {
  const fixture = await makePreflightFixture();
  try {
    await t.test("branch remains at captured commit", async () => {
      const secret = `ghp_${"s".repeat(40)}`;
      const pi = makeRetirementPi({
        ...fixture.options,
        updateResult: {
          code: 128,
          stderr: `fatal: ${secret} ${"diagnostic ".repeat(700)}`,
        },
      });
      await assert.rejects(
        () => retireBranch(
          pi,
          { cwd: fixture.options.worktreeRoot },
          requestFor(fixture.options),
        ),
        (error) => {
          assert.match(error.message, /failed safely/iu);
          assert.match(error.message, /captured HEAD/iu);
          assert.match(error.message, /truncated/iu);
          assert.doesNotMatch(error.message, new RegExp(secret, "u"));
          assert.ok(error.message.length <= 4_000);
          return true;
        },
      );
    });

    await t.test("branch moves before leased deletion completes", async () => {
      const movedHead = "c".repeat(40);
      const pi = makeRetirementPi({
        ...fixture.options,
        updateResult: { code: 1, stderr: "cannot lock ref\n" },
        postRetiringHead: movedHead,
      });
      await assert.rejects(
        () => retireBranch(
          pi,
          { cwd: fixture.options.worktreeRoot },
          requestFor(fixture.options),
        ),
        /moved to c{40}.*expected-old-value lease protected/iu,
      );
    });
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch accepts verified absence after interrupted command reporting", async () => {
  const fixture = await makePreflightFixture();
  try {
    const signal = new AbortController().signal;
    const pi = makeRetirementPi({
      ...fixture.options,
      updateThrows: new Error("caller interrupted command completion"),
      deletedDespiteMutationInterruption: true,
    });
    const details = await retireBranch(
      pi,
      { cwd: fixture.options.worktreeRoot },
      requestFor(fixture.options),
      signal,
    );
    const updateIndex = pi.calls.findIndex((call) => call.args[0] === "update-ref");
    assert.equal(details.status, "retired");
    assert.equal(details.verified.refs.after.retiring.absent, true);
    assert.ok(pi.calls.slice(updateIndex + 1).every((call) => call.options.signal === undefined));
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("retireBranch reports uncertain postconditions with manual inspection guidance", async (t) => {
  const fixture = await makePreflightFixture();
  const alternateRoot = join(fixture.tempRoot, "alternate-worktree");
  await mkdir(alternateRoot);
  const scenarios = [
    {
      name: "target moved",
      options: { postTargetHead: "c".repeat(40) },
      expected: /target local ref moved/iu,
    },
    {
      name: "target missing",
      options: { postTargetHead: null },
      expected: /target local ref is missing/iu,
    },
    {
      name: "retired name became occupied",
      options: {
        postPorcelain: worktreeRecord(
          fixture.options.worktreeRoot,
          "a".repeat(40),
          fixture.options.branchName,
        ),
      },
      expected: /registered worktree names the missing retiring branch/iu,
    },
    {
      name: "repository identity changed",
      options: { postWorktreeRoot: await realpath(alternateRoot) },
      expected: /repository identity changed/iu,
    },
    {
      name: "successful command report contradicted by a present ref",
      options: { postRetiringHead: "a".repeat(40) },
      expected: /reported successful deletion.*still present/iu,
    },
    {
      name: "strict ref inspection failed",
      options: {
        postRetiringInspectionResult: {
          code: 2,
          stderr: "fatal: repository inspection failed\n",
        },
      },
      expected: /repository inspection failed/iu,
    },
  ];

  try {
    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        const pi = makeRetirementPi({ ...fixture.options, ...scenario.options });
        await assert.rejects(
          () => retireBranch(
            pi,
            { cwd: fixture.options.worktreeRoot },
            requestFor(fixture.options),
          ),
          (error) => {
            assert.match(error.message, /postconditions are uncertain/iu);
            assert.match(error.message, /may have completed/iu);
            assert.match(error.message, /manually inspect/iu);
            assert.match(error.message, /Do not recreate, reset/iu);
            assert.match(error.message, scenario.expected);
            return true;
          },
        );
        assert.equal(
          pi.calls.some((call) => ["reset", "switch", "checkout", "merge", "rebase"].includes(call.args[0])),
          false,
        );
        assert.equal(pi.calls.filter((call) => call.args[0] === "update-ref").length, 1);
      });
    }
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});
