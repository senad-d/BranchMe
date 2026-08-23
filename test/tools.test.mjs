import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { branchMeExtension } from "../src/extension.ts";
import {
  BRANCHME_TOOL_NAMES,
  BRANCHME_COMMAND_NAME,
  BRANCH_STATUS_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  CREATE_WORKTREE_TOOL_NAME,
  FETCH_BRANCH_TOOL_NAME,
  GIT_CONTEXT_SUMMARY_LIMIT_CHARS,
  GIT_WORKTREE_SUMMARY_LIMIT_CHARS,
  LIST_WORKTREES_TOOL_NAME,
  PULL_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
  REBASE_BRANCH_TOOL_NAME,
  REMOVE_WORKTREE_TOOL_NAME,
} from "../src/constants.ts";
import { formatListWorktrees, registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const LOCAL_HEAD_SHA = "a".repeat(40);
const REMOTE_BASE_SHA = "b".repeat(40);
const STALE_REMOTE_HEAD_SHA = "c".repeat(40);
const EXPECTED_BRANCHME_TOOL_NAMES = [
  BRANCH_STATUS_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  CREATE_WORKTREE_TOOL_NAME,
  FETCH_BRANCH_TOOL_NAME,
  LIST_WORKTREES_TOOL_NAME,
  PULL_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
  REBASE_BRANCH_TOOL_NAME,
  REMOVE_WORKTREE_TOOL_NAME,
];

function result(overrides = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function abortLikeError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function branchPayload(sha = LOCAL_HEAD_SHA) {
  return { name: "branch", commit: { sha } };
}

function pullRequestPayload(overrides = {}) {
  return {
    number: 7,
    html_url: "https://github.com/senad-d/branchme/pull/7",
    state: "open",
    draft: false,
    head: { ref: "feature/current" },
    base: { ref: "main" },
    ...overrides,
  };
}

function makePi(routes = {}) {
  const tools = [];
  const commands = [];
  const calls = [];
  const events = [];
  return {
    tools,
    commands,
    calls,
    events,
    on(name, handler) {
      events.push({ name, handler });
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      commands.push({ name, options });
    },
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      calls.push({ command, args: [...args], options });
      const key = args.join("\0");
      const route = routes[key];
      if (!route && args[0] === "check-ref-format" && args[1] === "--branch") return result({ stdout: `${args[2]}\n` });
      if (!route) throw new Error(`Unexpected git command: ${args.join(" ")}`);
      if (Array.isArray(route)) {
        const next = route.shift();
        if (!next) throw new Error(`No remaining result for git command: ${args.join(" ")}`);
        return result(next);
      }
      return result(route);
    },
  };
}

function toolByName(pi, name) {
  const tool = pi.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected tool ${name} to be registered`);
  return tool;
}

const ctx = { cwd: "/repo", signal: undefined };
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

test("branchMeExtension registers exactly the BranchMe command and prompt-ready tool set", () => {
  const pi = makePi();
  branchMeExtension(pi);

  assert.deepEqual(
    pi.commands.map((command) => command.name),
    [BRANCHME_COMMAND_NAME],
  );
  assert.deepEqual([...BRANCHME_TOOL_NAMES].sort(), [...EXPECTED_BRANCHME_TOOL_NAMES].sort());
  assert.equal(pi.tools.length, EXPECTED_BRANCHME_TOOL_NAMES.length);
  assert.equal(new Set(pi.tools.map((tool) => tool.name)).size, EXPECTED_BRANCHME_TOOL_NAMES.length);
  assert.deepEqual(
    pi.tools.map((tool) => tool.name).sort(),
    [...EXPECTED_BRANCHME_TOOL_NAMES].sort(),
  );

  for (const tool of pi.tools) {
    assert.equal(typeof tool.description, "string", `${tool.name} description missing`);
    assert.ok(tool.description.includes(tool.name), `${tool.name} description must name the tool explicitly`);
    assert.equal(typeof tool.promptSnippet, "string", `${tool.name} promptSnippet missing`);
    assert.ok(tool.promptSnippet.length > 0, `${tool.name} promptSnippet empty`);
    assert.ok(tool.promptSnippet.includes(tool.name), `${tool.name} promptSnippet must name the tool explicitly`);
    assert.ok(Array.isArray(tool.promptGuidelines), `${tool.name} promptGuidelines missing`);
    assert.ok(tool.promptGuidelines.length > 0, `${tool.name} promptGuidelines empty`);
    assert.ok(
      tool.promptGuidelines.every((guideline) => guideline.includes(tool.name)),
      `${tool.name} promptGuidelines must name the tool explicitly`,
    );
  }

  assert.deepEqual(pi.events.map((event) => event.name), ["before_agent_start"]);
  assert.equal(typeof pi.events[0].handler, "function");
  assert.equal(pi.commands.some((command) => /template/i.test(command.name)), false);
  assert.equal(pi.tools.some((tool) => /template|greet|hello/i.test(tool.name)), false);
});

test("worktree tools expose strict schemas and named handoff-oriented prompt guidance", () => {
  const pi = makePi();
  registerBranchMeTools(pi);
  const listTool = toolByName(pi, LIST_WORKTREES_TOOL_NAME);
  const createTool = toolByName(pi, CREATE_WORKTREE_TOOL_NAME);
  const removeTool = toolByName(pi, REMOVE_WORKTREE_TOOL_NAME);

  assert.deepEqual(listTool.parameters.properties, {});
  assert.equal(listTool.parameters.required, undefined);
  assert.equal(listTool.parameters.additionalProperties, false);

  assert.deepEqual(createTool.parameters.required, ["worktreePath", "branchName", "branchMode"]);
  assert.deepEqual(Object.keys(createTool.parameters.properties), ["worktreePath", "branchName", "branchMode"]);
  assert.deepEqual(createTool.parameters.properties.branchMode.enum, ["new", "existing"]);
  assert.equal(createTool.parameters.additionalProperties, false);

  assert.deepEqual(removeTool.parameters.required, ["worktreePath"]);
  assert.deepEqual(Object.keys(removeTool.parameters.properties), ["worktreePath"]);
  assert.equal(removeTool.parameters.additionalProperties, false);

  const unsupported = ["force", "baseRef", "remote", "detach", "orphan", "move", "prune", "repair", "lock", "unlock"];
  for (const field of unsupported) {
    assert.equal(field in listTool.parameters.properties, false);
    assert.equal(field in createTool.parameters.properties, false);
    assert.equal(field in removeTool.parameters.properties, false);
  }

  for (const tool of [listTool, createTool, removeTool]) {
    assert.ok(tool.description.includes(tool.name));
    assert.ok(tool.promptSnippet.includes(tool.name));
    assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(tool.name)));
  }
  assert.match(createTool.promptGuidelines.join(" "), /explicitly requests.*exact absolute worktreePath/i);
  assert.match(createTool.promptGuidelines.join(" "), /never infer a filesystem path silently/i);
  assert.match(createTool.promptGuidelines.join(" "), /Do not batch.*wait.*handoff\.cwd/i);
  assert.match(removeTool.promptGuidelines.join(" "), /explicitly requests.*exact absolute worktreePath/i);
  assert.match(removeTool.promptGuidelines.join(" "), /never infer a filesystem path silently/i);
  assert.match(removeTool.promptGuidelines.join(" "), /Do not batch.*non-ready handoff/i);
});

test("list_worktrees returns structured details and a compact bounded inventory", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-tool-list-worktrees-"));
  const repoRoot = join(tempRoot, "repo");
  const detachedRoot = join(tempRoot, "detached");
  const lockedRoot = join(tempRoot, "locked");
  const prunableRoot = join(tempRoot, "prunable");
  await mkdir(repoRoot);
  await mkdir(detachedRoot);
  await mkdir(lockedRoot);

  try {
    const porcelain = [
      worktreePorcelainRecord(
        `worktree ${repoRoot}`,
        `HEAD ${"a".repeat(40)}`,
        "branch refs/heads/main",
      ),
      worktreePorcelainRecord(`worktree ${detachedRoot}`, `HEAD ${"b".repeat(40)}`, "detached"),
      worktreePorcelainRecord(
        `worktree ${lockedRoot}`,
        `HEAD ${"c".repeat(40)}`,
        "branch refs/heads/feature/locked",
        "locked administrative reason",
      ),
      worktreePorcelainRecord(
        `worktree ${prunableRoot}`,
        `HEAD ${"d".repeat(40)}`,
        "branch refs/heads/feature/prunable",
        "prunable gitdir points to a missing location",
      ),
    ].join("");
    const pi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: `${repoRoot}\n` },
      ["worktree\0list\0--porcelain\0-z"]: { stdout: porcelain },
    });
    registerBranchMeTools(pi);
    const tool = toolByName(pi, LIST_WORKTREES_TOOL_NAME);
    const controller = new AbortController();

    const output = await tool.execute("call-list-worktrees", {}, controller.signal, undefined, { ...ctx, cwd: repoRoot });

    assert.equal(output.details.action, LIST_WORKTREES_TOOL_NAME);
    assert.equal(output.details.worktrees.length, 4);
    assert.equal(output.details.worktrees[0].current, true);
    assert.match(output.content[0].text, new RegExp(`- ${repoRoot} \\| branch main \\| HEAD a{12} \\| main,current`, "u"));
    assert.match(output.content[0].text, /detached.*HEAD b{12}/u);
    assert.match(output.content[0].text, /feature\/locked.*HEAD c{12}.*locked/u);
    assert.match(output.content[0].text, /feature\/prunable.*HEAD d{12}.*prunable/u);
    assert.ok(output.content[0].text.length <= GIT_WORKTREE_SUMMARY_LIMIT_CHARS);
    assert.ok(pi.calls.every((call) => call.options.signal === controller.signal));
    assert.equal(pi.calls.some((call) => call.args[0] === "worktree" && call.args[1] !== "list"), false);

    const bounded = formatListWorktrees({
      ...output.details,
      worktrees: Array.from({ length: 100 }, (_, index) => ({
        ...output.details.worktrees[0],
        path: `/${"x".repeat(700)}-${index}`,
        main: index === 0,
        current: index === 0,
      })),
      omitted: 2,
    });
    assert.ok(bounded.length <= GIT_WORKTREE_SUMMARY_LIMIT_CHARS);
    assert.match(bounded, /worktree entries omitted/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("create_worktree and remove_worktree return verified mutation summaries and full handoff details", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "branchme-tool-worktree-mutations-"));
  const repoRoot = join(tempRoot, "repo");
  const commonGitDir = join(tempRoot, "common-git");
  const createDestination = join(tempRoot, "created");
  const removeTarget = join(tempRoot, "remove-target");
  const createBranch = "feature/created";
  const removeBranch = "feature/retained";
  const sourceHead = "a".repeat(40);
  const removeHead = "b".repeat(40);
  await mkdir(repoRoot);
  await mkdir(commonGitDir);
  await mkdir(removeTarget);
  const canonicalRoot = await realpath(tempRoot);
  const canonicalCreateDestination = join(canonicalRoot, "created");
  const canonicalRemoveTarget = await realpath(removeTarget);

  try {
    const mainRecord = worktreePorcelainRecord(
      `worktree ${repoRoot}`,
      `HEAD ${sourceHead}`,
      "branch refs/heads/main",
    );
    const createdRecord = worktreePorcelainRecord(
      `worktree ${canonicalCreateDestination}`,
      `HEAD ${sourceHead}`,
      `branch refs/heads/${createBranch}`,
    );
    const createController = new AbortController();
    const createPi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: `${repoRoot}\n` },
      ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
      ["rev-parse\0--verify\0HEAD^{commit}"]: { stdout: `${sourceHead}\n` },
      ["worktree\0list\0--porcelain\0-z"]: [
        { stdout: mainRecord },
        { stdout: mainRecord + createdRecord },
      ],
      ["rev-parse\0--path-format=absolute\0--git-common-dir"]: { stdout: `${commonGitDir}\n` },
      [`show-ref\0--verify\0--quiet\0refs/heads/${createBranch}`]: { code: 1 },
      [`worktree\0add\0-b\0${createBranch}\0${canonicalCreateDestination}\0HEAD`]: { stdout: "Preparing worktree\n" },
      [detailedStatusArgs.join("\0")]: { stdout: "" },
    });
    registerBranchMeTools(createPi);
    const createTool = toolByName(createPi, CREATE_WORKTREE_TOOL_NAME);

    const created = await createTool.execute(
      "call-create-worktree",
      { worktreePath: createDestination, branchName: createBranch, branchMode: "new" },
      createController.signal,
      undefined,
      { ...ctx, cwd: repoRoot },
    );

    assert.equal(created.details.handoff.ready, true);
    assert.equal(created.details.handoff.cwd, canonicalCreateDestination);
    assert.equal(created.details.handoff.branch, createBranch);
    assert.equal(created.details.handoff.head, sourceHead);
    assert.match(created.content[0].text, /^Created linked worktree/u);
    assert.match(created.content[0].text, /Verified its canonical path, local branch, HEAD .* clean working tree, and ready handoff\.$/u);
    assert.ok(createPi.calls.every((call) => call.options.signal === createController.signal));

    const removeRecord = worktreePorcelainRecord(
      `worktree ${removeTarget}`,
      `HEAD ${removeHead}`,
      `branch refs/heads/${removeBranch}`,
    );
    const removeController = new AbortController();
    const removePi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: `${repoRoot}\n` },
      ["worktree\0list\0--porcelain\0-z"]: [
        { stdout: mainRecord + removeRecord },
        { stdout: mainRecord },
      ],
      [detailedStatusArgs.join("\0")]: { stdout: "" },
      [ignoredWorktreeStatusArgs.join("\0")]: { stdout: "" },
      [`rev-parse\0--verify\0refs/heads/${removeBranch}^{commit}`]: [
        { stdout: `${removeHead}\n` },
        { stdout: `${removeHead}\n` },
      ],
      [`worktree\0remove\0${canonicalRemoveTarget}`]: { stdout: "" },
    });
    registerBranchMeTools(removePi);
    const removeTool = toolByName(removePi, REMOVE_WORKTREE_TOOL_NAME);

    const removed = await removeTool.execute(
      "call-remove-worktree",
      { worktreePath: removeTarget },
      removeController.signal,
      undefined,
      { ...ctx, cwd: repoRoot },
    );

    assert.equal(removed.details.handoff.cwd, null);
    assert.equal(removed.details.handoff.ready, false);
    assert.equal(removed.details.verified.after.branchRetained, true);
    assert.equal(removed.details.verified.after.head, removeHead);
    assert.match(removed.content[0].text, /^Removed linked worktree directory/u);
    assert.match(removed.content[0].text, /Verified it is no longer registered and retained local branch/u);
    assert.match(removed.content[0].text, /removed cwd is not ready for handoff\.$/u);
    assert.ok(removePi.calls.every((call) => call.options.signal === removeController.signal));
    assert.deepEqual(
      removePi.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "remove").map((call) => call.args),
      [["worktree", "remove", canonicalRemoveTarget]],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("branch_status has strict schema, refresh guidance, and shared current Git context", async () => {
  const hash = "1234567890abcdef1234567890abcdef12345678";
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    [detailedStatusArgs.join("\0")]: { stdout: " M src/context.ts\0?? notes.txt\0" },
    [recentLogArgs.join("\0")]: {
      stdout: recentLogRecord(hash, "1234567", "2026-07-04", "Add explicit refresh"),
    },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { stdout: "0\t0\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: {} });
  const tool = toolByName(pi, BRANCH_STATUS_TOOL_NAME);

  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.promptSnippet, /refresh/i);
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(BRANCH_STATUS_TOOL_NAME)));
  assert.match(tool.promptGuidelines.join(" "), /automatic Git context/i);
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /before change_branch|before create_branch|before push_branch|before pull_request/i);

  const output = await tool.execute("call-1", {}, undefined, undefined, ctx);

  assert.equal(output.details.repoRoot, "/repo");
  assert.equal(output.details.currentBranch, "main");
  assert.equal(output.details.detached, false);
  assert.equal(output.details.upstream, "origin/main");
  assert.equal(output.details.hasChanges, true);
  assert.equal(output.details.ahead, 0);
  assert.equal(output.details.behind, 0);
  assert.equal(output.details.pullRequestAutofill, false);
  assert.deepEqual(output.details.githubRepository, { owner: "senad-d", repo: "branchme" });
  assert.deepEqual(output.details.workingTree, { state: "dirty", staged: 0, unstaged: 1, untracked: 1 });
  assert.deepEqual(output.details.unstagedChanges.entries, [
    { status: " M", path: "src/context.ts" },
    { status: "??", path: "notes.txt" },
  ]);
  assert.equal(output.details.relatedPullRequest.status, "unavailable");
  assert.deepEqual(output.details.recentCommits, [
    { hash, shortHash: "1234567", date: "2026-07-04", subject: "Add explicit refresh" },
  ]);
  assert.match(output.content[0].text, /^## Current Git Context/mu);
  for (const field of ["Branch", "Working tree", "Unstaged changes", "Related PR", "Recent commits"]) {
    assert.match(output.content[0].text, new RegExp(`- ${field}:`, "u"));
  }
  assert.match(output.content[0].text, /explicit current-state refresh/u);

  const mutatingCommands = pi.calls.filter((call) => ["switch", "push", "commit", "add"].includes(call.args[0]));
  assert.deepEqual(mutatingCommands, []);
});

test("branch_status recollects fresh state through bounded read-only Git and GitHub requests", async () => {
  const firstHash = "1".repeat(40);
  const secondHash = "2".repeat(40);
  const requests = [];
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: [
      { stdout: "main\n" },
      { stdout: "main\n" },
      { stdout: "feature/refresh\n" },
      { stdout: "feature/refresh\n" },
    ],
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: [
      { code: 1 },
      { code: 1 },
    ],
    [detailedStatusArgs.join("\0")]: [
      { stdout: "" },
      { stdout: " M src/refreshed.ts\0?? refreshed.txt\0" },
    ],
    [recentLogArgs.join("\0")]: [
      { stdout: recentLogRecord(firstHash, "1111111", "2026-07-04", "Before refresh") },
      { stdout: recentLogRecord(secondHash, "2222222", "2026-07-05", "After refresh") },
    ],
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const refreshed = url.includes("feature%2Frefresh");
    const branch = refreshed ? "feature/refresh" : "main";
    return jsonResponse([
      {
        number: refreshed ? 2 : 1,
        html_url: `https://github.com/senad-d/branchme/pull/${refreshed ? 2 : 1}`,
        title: refreshed ? "Refreshed PR" : "Initial PR",
        state: "open",
        draft: false,
        head: { ref: branch, repo: { full_name: "senad-d/branchme" } },
        base: { ref: "main" },
      },
    ]);
  };
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_refreshsecret123" }, fetchImpl });
  const tool = toolByName(pi, BRANCH_STATUS_TOOL_NAME);

  const first = await tool.execute("call-status-before", {}, undefined, undefined, ctx);
  const second = await tool.execute("call-status-after", {}, undefined, undefined, ctx);

  assert.equal(first.details.currentBranch, "main");
  assert.deepEqual(first.details.workingTree, { state: "clean", staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(first.details.relatedPullRequest.pullRequest.number, 1);
  assert.equal(first.details.recentCommits[0].subject, "Before refresh");
  assert.equal(second.details.currentBranch, "feature/refresh");
  assert.deepEqual(second.details.workingTree, { state: "dirty", staged: 0, unstaged: 1, untracked: 1 });
  assert.equal(second.details.relatedPullRequest.pullRequest.number, 2);
  assert.equal(second.details.recentCommits[0].subject, "After refresh");
  assert.doesNotMatch(second.content[0].text, /Before refresh|Initial PR/u);
  assert.ok(second.content[0].text.length <= GIT_CONTEXT_SUMMARY_LIMIT_CHARS);

  assert.deepEqual(
    requests.map(({ url, init }) => ({ url, method: init.method, body: init.body })),
    [
      {
        url: "https://api.github.com/repos/senad-d/branchme/pulls?state=open&head=senad-d%3Amain&per_page=1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.github.com/repos/senad-d/branchme/pulls?state=open&head=senad-d%3Afeature%2Frefresh&per_page=1",
        method: "GET",
        body: undefined,
      },
    ],
  );
  assert.ok(requests.every(({ init }) => init.headers.Authorization === "Bearer ghp_refreshsecret123"));
  assert.deepEqual(
    [...new Set(pi.calls.map((call) => call.args[0]))].sort(),
    ["log", "remote", "rev-parse", "status", "symbolic-ref"],
  );
});

test("branch_status reports partial status warnings when ahead/behind is unavailable", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/stale\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/stale\n" },
    [detailedStatusArgs.join("\0")]: { stdout: "" },
    [recentLogArgs.join("\0")]: { stdout: "" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { code: 128, stderr: "fatal: upstream is gone\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: {} });
  const tool = toolByName(pi, BRANCH_STATUS_TOOL_NAME);

  const output = await tool.execute("call-status-warning", {}, undefined, undefined, ctx);

  assert.equal(output.details.currentBranch, "feature/stale");
  assert.equal(output.details.hasChanges, false);
  assert.equal(output.details.ahead, null);
  assert.equal(output.details.behind, null);
  assert.match(output.details.warnings[0], /ahead\/behind unavailable/i);
  assert.match(output.content[0].text, /feature\/stale/);
  assert.match(output.content[0].text, /clean/);
  assert.match(output.content[0].text, /ahead\/behind unavailable/);
  assert.doesNotMatch(output.content[0].text, /fatal: upstream is gone/u);
});

test("branch_status keeps explicit caller cancellation observable", async () => {
  const pi = makePi();
  registerBranchMeTools(pi, { env: {} });
  const tool = toolByName(pi, BRANCH_STATUS_TOOL_NAME);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => tool.execute("call-status-abort", {}, controller.signal, undefined, ctx),
    /cancelled/i,
  );
  assert.deepEqual(pi.calls, []);
});

test("create_branch schema accepts only branchName and constructs git switch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["check-ref-format\0--branch\0feature/tool"]: { stdout: "feature/tool\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/tool"]: { code: 1 },
    ["switch\0-c\0feature/tool"]: { stdout: "" },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, CREATE_BRANCH_TOOL_NAME);

  assert.deepEqual(tool.parameters.required, ["branchName"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["branchName"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(CREATE_BRANCH_TOOL_NAME)));

  const output = await tool.execute("call-2", { branchName: "feature/tool" }, undefined, undefined, ctx);

  assert.deepEqual(output.details, { repoRoot: "/repo", previousBranch: "main", newBranch: "feature/tool" });
  assert.deepEqual(pi.calls.at(-1).args, ["switch", "-c", "feature/tool"]);
  assert.equal(pi.calls.some((call) => ["commit", "add", "push"].includes(call.args[0])), false);
});

test("change_branch schema switches existing local branches and reports safe details", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/tool"]: { stdout: "feature/tool\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/tool"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: [{ stdout: "main\n" }, { stdout: "feature/tool\n" }],
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n" },
    ["switch\0feature/tool"]: { stdout: "" },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, CHANGE_BRANCH_TOOL_NAME);

  assert.deepEqual(tool.parameters.required, ["branchName"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["branchName"]);
  assert.equal(tool.parameters.additionalProperties, false);
  for (const unsupported of ["baseRef", "force", "stash", "discard", "create", "owner", "repo", "path"]) {
    assert.equal(unsupported in tool.parameters.properties, false);
  }
  assert.ok(tool.description.includes(CHANGE_BRANCH_TOOL_NAME));
  assert.ok(tool.promptSnippet.includes(CHANGE_BRANCH_TOOL_NAME));
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(CHANGE_BRANCH_TOOL_NAME)));

  const output = await tool.execute("call-change", { branchName: "feature/tool" }, undefined, undefined, ctx);

  assert.deepEqual(output.details, {
    repoRoot: "/repo",
    previousBranch: "main",
    previousDetached: false,
    currentBranch: "feature/tool",
    hasChangesBeforeSwitch: false,
  });
  assert.equal(output.content[0].text, "Changed branch from main to feature/tool.");
  assert.deepEqual(pi.calls.filter((call) => call.args[0] === "switch").map((call) => call.args), [["switch", "feature/tool"]]);
  assert.equal(
    pi.calls.some((call) => ["checkout", "stash", "reset", "merge", "rebase", "add", "commit", "push"].includes(call.args[0])),
    false,
  );
});

test("change_branch rejects dirty worktrees before switching", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/tool"]: { stdout: "feature/tool\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/tool"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n M src/a.ts\n" },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, CHANGE_BRANCH_TOOL_NAME);

  await assert.rejects(
    () => tool.execute("call-change-dirty", { branchName: "feature/tool" }, undefined, undefined, ctx),
    /uncommitted changes/,
  );
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("change_branch rejects missing local branches", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/missing"]: { stdout: "feature/missing\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/missing"]: { code: 1 },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, CHANGE_BRANCH_TOOL_NAME);

  await assert.rejects(
    () => tool.execute("call-change-missing", { branchName: "feature/missing" }, undefined, undefined, ctx),
    /does not exist/,
  );
  assert.equal(pi.calls.some((call) => call.args[0] === "switch"), false);
});

test("fetch_branch has a strict empty schema and fetches the configured upstream remote", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["fetch\0--no-tags\0--no-recurse-submodules\0origin\0refs/heads/main:refs/remotes/origin/main"]: { stderr: "Fetched origin\n" },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, FETCH_BRANCH_TOOL_NAME);

  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.description.includes(FETCH_BRANCH_TOOL_NAME));
  assert.ok(tool.promptSnippet.includes(FETCH_BRANCH_TOOL_NAME));
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(FETCH_BRANCH_TOOL_NAME)));

  const output = await tool.execute("call-fetch", {}, undefined, undefined, ctx);

  assert.deepEqual(output.details, {
    repoRoot: "/repo",
    currentBranch: "main",
    upstream: "origin/main",
    remote: "origin",
    remoteRef: "refs/heads/main",
    remoteTrackingRef: "refs/remotes/origin/main",
    refspec: "refs/heads/main:refs/remotes/origin/main",
    output: "Fetched origin",
  });
  assert.equal(output.content[0].text, "Fetched configured upstream remote origin for current branch main.");
  assert.deepEqual(pi.calls.at(-1).args, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  ]);
  assert.equal(pi.calls.some((call) => ["switch", "rebase", "merge", "push"].includes(call.args[0])), false);
});

test("pull_branch has a strict empty schema and fast-forwards the clean current branch", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main [behind 1]\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["pull\0--ff-only\0--no-rebase\0--no-autostash\0origin\0refs/heads/main"]: { stdout: "Fast-forward\n" },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, PULL_BRANCH_TOOL_NAME);

  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.description.includes(PULL_BRANCH_TOOL_NAME));
  assert.ok(tool.promptSnippet.includes(PULL_BRANCH_TOOL_NAME));
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(PULL_BRANCH_TOOL_NAME)));

  const output = await tool.execute("call-pull", {}, undefined, undefined, ctx);

  assert.deepEqual(output.details, {
    repoRoot: "/repo",
    currentBranch: "main",
    upstream: "origin/main",
    remote: "origin",
    remoteRef: "refs/heads/main",
    output: "Fast-forward",
  });
  assert.equal(output.content[0].text, "Pulled current branch main with fast-forward-only semantics.");
  assert.deepEqual(pi.calls.at(-1).args, ["pull", "--ff-only", "--no-rebase", "--no-autostash", "origin", "refs/heads/main"]);
  assert.equal(pi.calls.some((call) => ["rebase", "stash", "add", "commit", "push"].includes(call.args[0])), false);
});

test("rebase_branch has a strict empty schema and rebases the clean current branch onto upstream", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/current...origin/feature/current [ahead 1, behind 1]\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    ["rebase\0--no-autostash\0--no-update-refs\0origin/feature/current"]: { stderr: "Successfully rebased\n" },
  });
  registerBranchMeTools(pi);
  const tool = toolByName(pi, REBASE_BRANCH_TOOL_NAME);

  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.description.includes(REBASE_BRANCH_TOOL_NAME));
  assert.ok(tool.promptSnippet.includes(REBASE_BRANCH_TOOL_NAME));
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(REBASE_BRANCH_TOOL_NAME)));
  assert.match(tool.promptGuidelines.join(" "), /explicitly requests rebasing|rewrites local commit history/i);

  const output = await tool.execute("call-rebase", {}, undefined, undefined, ctx);

  assert.deepEqual(output.details, {
    repoRoot: "/repo",
    currentBranch: "feature/current",
    upstream: "origin/feature/current",
    remote: "origin",
    remoteRef: "refs/heads/feature/current",
    output: "Successfully rebased",
  });
  assert.equal(output.content[0].text, "Rebased current branch feature/current onto origin/feature/current.");
  assert.deepEqual(pi.calls.at(-1).args, ["rebase", "--no-autostash", "--no-update-refs", "origin/feature/current"]);
  assert.equal(pi.calls.some((call) => ["stash", "merge", "push"].includes(call.args[0])), false);
});

test("rebase_branch aborts failed rebases before returning an error", async () => {
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
  registerBranchMeTools(pi);
  const tool = toolByName(pi, REBASE_BRANCH_TOOL_NAME);

  await assert.rejects(() => tool.execute("call-rebase-conflict", {}, undefined, undefined, ctx), /aborted.*restored/is);
  assert.deepEqual(pi.calls.at(-1).args, ["rebase", "--abort"]);
});

test("push_branch pushes current branch with and without upstream", async () => {
  const upstreamPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/current\n" },
    ["config\0--get\0branch.feature/current.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/current.merge"]: { stdout: "refs/heads/feature/current\n" },
    ["push\0origin\0HEAD:refs/heads/feature/current"]: {
      stdout: "ok https://user:ghp_toolsecret123@github.com/senad-d/branchme.git token=github_pat_toolsecret123\n",
    },
  });
  registerBranchMeTools(upstreamPi);
  const upstreamTool = toolByName(upstreamPi, PUSH_BRANCH_TOOL_NAME);

  assert.deepEqual(upstreamTool.parameters.properties, {});
  assert.equal(upstreamTool.parameters.additionalProperties, false);
  assert.ok(upstreamTool.promptGuidelines.every((guideline) => guideline.includes(PUSH_BRANCH_TOOL_NAME)));

  const upstreamOutput = await upstreamTool.execute("call-3", {}, undefined, undefined, ctx);
  assert.equal(upstreamOutput.details.mode, "push");
  assert.equal(upstreamOutput.details.remote, "origin");
  assert.equal(upstreamOutput.details.remoteRef, "refs/heads/feature/current");
  assert.deepEqual(upstreamPi.calls.at(-1).args, ["push", "origin", "HEAD:refs/heads/feature/current"]);
  assert.equal(upstreamPi.calls.some((call) => call.args.length === 1 && call.args[0] === "push"), false);
  assert.doesNotMatch(JSON.stringify(upstreamOutput), /toolsecret|user:ghp_/u);

  const publishPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/current\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
    ["push\0--set-upstream\0origin\0feature/current"]: { stdout: "published\n" },
  });
  registerBranchMeTools(publishPi);
  const publishTool = toolByName(publishPi, PUSH_BRANCH_TOOL_NAME);

  const publishOutput = await publishTool.execute("call-4", {}, undefined, undefined, ctx);
  assert.equal(publishOutput.details.mode, "publish");
  assert.deepEqual(publishPi.calls.at(-1).args, ["push", "--set-upstream", "origin", "feature/current"]);
  assert.equal(publishPi.calls.some((call) => ["commit", "add"].includes(call.args[0])), false);
});

test("public BranchMe tools propagate abort signals to git and fetch calls", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const gitToolCases = [
    {
      name: CREATE_BRANCH_TOOL_NAME,
      params: { branchName: "feature/signal-create" },
      routes: {
        ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
        ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
        ["check-ref-format\0--branch\0feature/signal-create"]: { stdout: "feature/signal-create\n" },
        ["show-ref\0--verify\0--quiet\0refs/heads/feature/signal-create"]: { code: 1 },
        ["switch\0-c\0feature/signal-create"]: { stdout: "" },
      },
    },
    {
      name: CHANGE_BRANCH_TOOL_NAME,
      params: { branchName: "feature/signal-change" },
      routes: {
        ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
        ["check-ref-format\0--branch\0feature/signal-change"]: { stdout: "feature/signal-change\n" },
        ["show-ref\0--verify\0--quiet\0refs/heads/feature/signal-change"]: { code: 0 },
        ["symbolic-ref\0--quiet\0--short\0HEAD"]: [{ stdout: "main\n" }, { stdout: "feature/signal-change\n" }],
        ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n" },
        ["switch\0feature/signal-change"]: { stdout: "" },
      },
    },
    {
      name: FETCH_BRANCH_TOOL_NAME,
      params: {},
      routes: {
        ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
        ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
        ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
        ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
        ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
        ["fetch\0--no-tags\0--no-recurse-submodules\0origin\0refs/heads/main:refs/remotes/origin/main"]: { stdout: "Already up to date.\n" },
      },
    },
    {
      name: PULL_BRANCH_TOOL_NAME,
      params: {},
      routes: {
        ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
        ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
        ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main\n" },
        ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
        ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
        ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
        ["pull\0--ff-only\0--no-rebase\0--no-autostash\0origin\0refs/heads/main"]: { stdout: "Already up to date.\n" },
      },
    },
    {
      name: REBASE_BRANCH_TOOL_NAME,
      params: {},
      routes: {
        ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
        ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/signal-rebase\n" },
        ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/signal-rebase...origin/feature/signal-rebase\n" },
        ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/signal-rebase\n" },
        ["config\0--get\0branch.feature/signal-rebase.remote"]: { stdout: "origin\n" },
        ["config\0--get\0branch.feature/signal-rebase.merge"]: { stdout: "refs/heads/feature/signal-rebase\n" },
        ["rebase\0--no-autostash\0--no-update-refs\0origin/feature/signal-rebase"]: { stdout: "Current branch is up to date.\n" },
      },
    },
    {
      name: PUSH_BRANCH_TOOL_NAME,
      params: {},
      routes: {
        ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
        ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/signal-push\n" },
        ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/signal-push\n" },
        ["config\0--get\0branch.feature/signal-push.remote"]: { stdout: "origin\n" },
        ["config\0--get\0branch.feature/signal-push.merge"]: { stdout: "refs/heads/feature/signal-push\n" },
        ["push\0origin\0HEAD:refs/heads/feature/signal-push"]: { stdout: "Everything up-to-date\n" },
      },
    },
  ];

  for (const gitToolCase of gitToolCases) {
    const pi = makePi(gitToolCase.routes);
    registerBranchMeTools(pi);
    const tool = toolByName(pi, gitToolCase.name);

    await tool.execute(`call-${gitToolCase.name}-signal`, gitToolCase.params, signal, undefined, ctx);

    assert.ok(pi.calls.length > 0, `${gitToolCase.name} should execute git commands`);
    assert.ok(
      pi.calls.every((call) => call.options.signal === signal),
      `${gitToolCase.name} should pass the provided AbortSignal to every git command`,
    );
  }

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET") return jsonResponse(branchPayload(url.endsWith("/branches/feature%2Fsignal-pr") ? LOCAL_HEAD_SHA : REMOTE_BASE_SHA));
    return jsonResponse(pullRequestPayload({ head: { ref: "feature/signal-pr" } }), 201);
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/signal-pr"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["rev-parse\0--verify\0refs/heads/feature/signal-pr^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const pullRequestTool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await pullRequestTool.execute(
    "call-pr-signal",
    { headBranch: "feature/signal-pr", baseBranch: "main", title: "Title", body: "Body", draft: false },
    signal,
    undefined,
    ctx,
  );

  assert.ok(pi.calls.every((call) => call.options.signal === signal));
  assert.deepEqual(
    requests.map((request) => request.init.signal),
    [signal, signal, signal],
  );
});

test("public BranchMe tools fail on killed status, switch, fetch, pull, rebase, and push operations", async () => {
  const statusPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/timeout"]: { stdout: "feature/timeout\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/timeout"]: { code: 0 },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { code: 0, killed: true, stderr: "operation timed out\n" },
  });
  registerBranchMeTools(statusPi);
  const statusTool = toolByName(statusPi, CHANGE_BRANCH_TOOL_NAME);

  await assert.rejects(
    () => statusTool.execute("call-change-timeout", { branchName: "feature/timeout" }, undefined, undefined, ctx),
    /git status .*failed \(killed\).*timed out/i,
  );
  assert.equal(statusPi.calls.some((call) => call.args[0] === "switch"), false);

  const switchPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["check-ref-format\0--branch\0feature/timeout"]: { stdout: "feature/timeout\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/timeout"]: { code: 1 },
    ["switch\0-c\0feature/timeout"]: { code: 0, killed: true, stderr: "operation timed out\n" },
  });
  registerBranchMeTools(switchPi);
  const switchTool = toolByName(switchPi, CREATE_BRANCH_TOOL_NAME);

  await assert.rejects(
    () => switchTool.execute("call-create-timeout", { branchName: "feature/timeout" }, undefined, undefined, ctx),
    /git switch -c feature\/timeout failed \(killed\).*timed out/i,
  );

  const fetchPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["fetch\0--no-tags\0--no-recurse-submodules\0origin\0refs/heads/main:refs/remotes/origin/main"]: { code: 0, killed: true, stderr: "operation timed out\n" },
  });
  registerBranchMeTools(fetchPi);
  const fetchTool = toolByName(fetchPi, FETCH_BRANCH_TOOL_NAME);

  await assert.rejects(() => fetchTool.execute("call-fetch-timeout", {}, undefined, undefined, ctx), /git fetch .*failed \(killed\).*timed out/i);

  const pullPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main [behind 1]\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["config\0--get\0branch.main.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.main.merge"]: { stdout: "refs/heads/main\n" },
    ["pull\0--ff-only\0--no-rebase\0--no-autostash\0origin\0refs/heads/main"]: { code: 0, killed: true, stderr: "operation timed out\n" },
  });
  registerBranchMeTools(pullPi);
  const pullTool = toolByName(pullPi, PULL_BRANCH_TOOL_NAME);

  await assert.rejects(() => pullTool.execute("call-pull-timeout", {}, undefined, undefined, ctx), /git pull .*failed \(killed\).*timed out/i);

  const rebasePi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/timeout\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/timeout...origin/feature/timeout\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/timeout\n" },
    ["config\0--get\0branch.feature/timeout.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/timeout.merge"]: { stdout: "refs/heads/feature/timeout\n" },
    ["rebase\0--no-autostash\0--no-update-refs\0origin/feature/timeout"]: { code: 0, killed: true, stderr: "operation timed out\n" },
    ["rebase\0--abort"]: { stdout: "" },
  });
  registerBranchMeTools(rebasePi);
  const rebaseTool = toolByName(rebasePi, REBASE_BRANCH_TOOL_NAME);

  await assert.rejects(
    () => rebaseTool.execute("call-rebase-timeout", {}, undefined, undefined, ctx),
    /git rebase .*failed \(killed\).*timed out.*aborted.*restored/is,
  );

  const pushPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/timeout\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/timeout\n" },
    ["config\0--get\0branch.feature/timeout.remote"]: { stdout: "origin\n" },
    ["config\0--get\0branch.feature/timeout.merge"]: { stdout: "refs/heads/feature/timeout\n" },
    ["push\0origin\0HEAD:refs/heads/feature/timeout"]: { code: 0, killed: true, stderr: "operation timed out\n" },
  });
  registerBranchMeTools(pushPi);
  const pushTool = toolByName(pushPi, PUSH_BRANCH_TOOL_NAME);

  await assert.rejects(() => pushTool.execute("call-push-timeout", {}, undefined, undefined, ctx), /git push .*failed \(killed\).*timed out/i);
});

test("pull_request stops after abort-like GitHub fetch failures", async () => {
  const scenarios = [
    { name: "head preflight", failAt: 1, expectedMethods: ["GET"] },
    { name: "base preflight", failAt: 2, expectedMethods: ["GET", "GET"] },
    { name: "pull request creation", failAt: 3, expectedMethods: ["GET", "GET", "POST"] },
  ];

  for (const scenario of scenarios) {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      if (requests.length === scenario.failAt) throw abortLikeError();
      if (init.method === "GET") return jsonResponse(branchPayload(url.endsWith("/branches/feature%2Fabort") ? LOCAL_HEAD_SHA : REMOTE_BASE_SHA));
      return jsonResponse(pullRequestPayload({ head: { ref: "feature/abort" } }), 201);
    };
    const pi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
      ["show-ref\0--verify\0--quiet\0refs/heads/feature/abort"]: { code: 0 },
      ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
      ["rev-parse\0--verify\0refs/heads/feature/abort^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
      ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
    });
    registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
    const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

    await assert.rejects(
      () =>
        tool.execute(
          `call-pr-abort-${scenario.failAt}`,
          { headBranch: "feature/abort", baseBranch: "main", title: "Title", body: "Body", draft: false },
          undefined,
          undefined,
          ctx,
        ),
      /abort/i,
      scenario.name,
    );

    assert.deepEqual(
      requests.map((request) => request.init.method),
      scenario.expectedMethods,
      scenario.name,
    );
    if (scenario.failAt < 3) {
      assert.equal(requests.some((request) => request.init.method === "POST"), false, scenario.name);
    }
    if (scenario.failAt === 1) {
      assert.equal(pi.calls.some((call) => call.args.join("\0") === "rev-parse\0--verify\0refs/heads/feature/abort^{commit}"), false);
    }
  }
});

test("pull_request has an optional-field strict schema and rejects repository parameters", () => {
  const pi = makePi();
  registerBranchMeTools(pi);
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  assert.equal(tool.parameters.required, undefined);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal("owner" in tool.parameters.properties, false);
  assert.equal("repo" in tool.parameters.properties, false);
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(PULL_REQUEST_TOOL_NAME)));
  assert.ok(tool.promptGuidelines.some((guideline) => /push_branch.*completed/i.test(guideline)));
});

test("pull_request rejects omitted fields when PR autofill is disabled", async () => {
  let called = false;
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
  });
  registerBranchMeTools(pi, {
    env: { GITHUB_TOKEN: "ghp_secret123" },
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not be called");
    },
  });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () => tool.execute("call-pr-autofill-disabled", {}, undefined, undefined, ctx),
    /Missing pull_request fields.*BRANCHME_PR_AUTOFILL=true/i,
  );
  assert.equal(called, false);
  assert.deepEqual(pi.calls.map((call) => call.args), [["rev-parse", "--show-toplevel"]]);
});

test("pull_request autofills omitted fields when enabled without copying the active token", async () => {
  const opaqueToken = "opaque-secret-value";
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET") return jsonResponse(branchPayload());
    return jsonResponse(
      pullRequestPayload({
        head: { ref: "feature/autofill" },
      }),
      201,
    );
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/autofill\n" },
    ["symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD"]: { stdout: "origin/main\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/autofill"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["log\0--max-count=20\0--format=%s\0refs/heads/main..refs/heads/feature/autofill\0--"]: {
      stdout: `Add PR field autofill\nDocument autofill configuration\n${opaqueToken}\nNotify @org/team <details>\n`,
    },
    ["rev-parse\0--verify\0refs/heads/feature/autofill^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, {
    env: { BRANCHME_PR_AUTOFILL: "true", GITHUB_TOKEN: opaqueToken },
    fetchImpl,
  });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  const output = await tool.execute("call-pr-autofill", {}, undefined, undefined, ctx);

  assert.deepEqual(output.details.autofilledFields, ["headBranch", "baseBranch", "title", "body", "draft"]);
  assert.match(output.content[0].text, /Autofilled fields: headBranch, baseBranch, title, body, draft/u);
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), {
    title: "Add PR field autofill",
    head: "feature/autofill",
    base: "main",
    body: [
      "## Summary",
      "",
      "- Add PR field autofill",
      "- Document autofill configuration",
      "- \\[REDACTED\\]",
      "- Notify \\@org\\/team \\<details\\>",
      "",
      "_Generated by BranchMe from commit subjects._",
    ].join("\n"),
    draft: false,
  });
  assert.doesNotMatch(requests.at(-1).init.body, /opaque-secret-value|@org\/team|<details>/u);
});

test("pull_request rejects identical head and base branches before GitHub work", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" } });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-pr-identical-branches",
        { headBranch: "main", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /headBranch and baseBranch must be different/i,
  );
  assert.deepEqual(pi.calls.map((call) => call.args), [["rev-parse", "--show-toplevel"]]);
});

test("pull_request rejects cross-repository and unsafe branch refs before creating a request", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-pr-invalid",
        { headBranch: "other-owner:feature/current", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /owner-prefixed|cross-repository|:/i,
  );

  assert.equal(called, false);
  assert.equal(pi.calls.some((call) => call.args[0] === "remote"), false);
});

test("pull_request rejects Git-invalid branch refs before repository, token, existence, or fetch work", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["check-ref-format\0--branch\0feature/.hidden"]: { code: 1, stderr: "fatal: invalid branch name\n" },
  });
  registerBranchMeTools(pi, { env: {}, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-pr-dot-component",
        { headBranch: "feature/.hidden", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /headBranch is not a valid local branch name/i,
  );

  assert.equal(called, false);
  assert.equal(pi.calls.some((call) => call.args[0] === "show-ref"), false);
  assert.equal(pi.calls.some((call) => call.args[0] === "remote"), false);
});

test("pull_request rejects full refs before repository, token, existence, or fetch work", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
  });
  registerBranchMeTools(pi, { env: {}, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-pr-full-ref",
        { headBranch: "refs/heads/feature/current", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /must be a branch name, not a full ref path/i,
  );

  assert.equal(called, false);
  assert.equal(pi.calls.some((call) => call.args[0] === "check-ref-format"), false);
  assert.equal(pi.calls.some((call) => call.args[0] === "remote"), false);
});

test("pull_request rejects missing local branch refs before repository, token, or fetch work", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };

  const missingHeadPi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/missing"]: { code: 1 },
  });
  registerBranchMeTools(missingHeadPi, { env: {}, fetchImpl });
  const missingHeadTool = toolByName(missingHeadPi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      missingHeadTool.execute(
        "call-pr-missing-head",
        { headBranch: "feature/missing", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /headBranch local branch 'feature\/missing' does not exist/i,
  );
  assert.equal(missingHeadPi.calls.some((call) => call.args[0] === "remote"), false);

  const missingBasePi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/current"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/release/v1"]: { code: 1 },
  });
  registerBranchMeTools(missingBasePi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const missingBaseTool = toolByName(missingBasePi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      missingBaseTool.execute(
        "call-pr-missing-base",
        { headBranch: "feature/current", baseBranch: "release/v1", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /baseBranch local branch 'release\/v1' does not exist/i,
  );
  assert.equal(missingBasePi.calls.some((call) => call.args[0] === "remote"), false);
  assert.equal(called, false);
});

test("pull_request rejects GitHub-invisible branches before creating a pull request", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ message: "Not Found" }, 404);
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/unpublished"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-pr-unpublished",
        { headBranch: "feature/unpublished", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /Run push_branch and wait for it to complete before calling pull_request/i,
  );

  assert.deepEqual(requests.map((request) => [request.init.method, request.url]), [
    ["GET", "https://api.github.com/repos/senad-d/branchme/branches/feature%2Funpublished"],
  ]);
});

test("pull_request rejects a GitHub-visible head branch that does not match the local commit", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/branches/feature%2Fstale")) return jsonResponse(branchPayload(STALE_REMOTE_HEAD_SHA));
    if (init.method === "GET") return jsonResponse(branchPayload(REMOTE_BASE_SHA));
    throw new Error("pull request POST should not run when headBranch is stale");
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/stale"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
    ["rev-parse\0--verify\0refs/heads/feature/stale^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-pr-stale",
        { headBranch: "feature/stale", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    /points to .* but GitHub has .*Run push_branch and wait/i,
  );

  assert.deepEqual(requests.map((request) => [request.init.method, request.url]), [
    ["GET", "https://api.github.com/repos/senad-d/branchme/branches/feature%2Fstale"],
  ]);
  assert.equal(requests.some((request) => request.init.method === "POST"), false);
});

test("pull_request queues behind an in-flight push_branch for the same repository", async () => {
  const events = [];
  const pushStarted = deferred();
  const releasePush = deferred();
  const pi = {
    tools: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      assert.equal(options.cwd, "/repo");
      const key = args.join("\0");
      events.push(`git:${key}`);

      if (key === "rev-parse\0--show-toplevel") return result({ stdout: "/repo\n" });
      if (key === "symbolic-ref\0--quiet\0--short\0HEAD") return result({ stdout: "feature/current\n" });
      if (key === "rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}") return result({ code: 1, stderr: "no upstream\n" });
      if (key === "push\0--set-upstream\0origin\0feature/current") {
        events.push("push:start");
        pushStarted.resolve();
        await releasePush.promise;
        events.push("push:end");
        return result({ stdout: "published\n" });
      }
      if (key === "show-ref\0--verify\0--quiet\0refs/heads/feature/current") return result({ code: 0 });
      if (key === "show-ref\0--verify\0--quiet\0refs/heads/main") return result({ code: 0 });
      if (key === "rev-parse\0--verify\0refs/heads/feature/current^{commit}") return result({ stdout: `${LOCAL_HEAD_SHA}\n` });
      if (key === "remote\0get-url\0origin") return result({ stdout: "https://github.com/senad-d/branchme.git\n" });
      if (args[0] === "check-ref-format" && args[1] === "--branch") return result({ stdout: `${args[2]}\n` });
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };
  const fetchImpl = async (url, init) => {
    events.push(`fetch:${init.method}:${url}`);
    if (init.method === "GET") return jsonResponse(branchPayload());
    return jsonResponse(pullRequestPayload(), 201);
  };
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const pushTool = toolByName(pi, PUSH_BRANCH_TOOL_NAME);
  const pullRequestTool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  const pushPromise = pushTool.execute("call-push-race", {}, undefined, undefined, ctx);
  await pushStarted.promise;

  const pullRequestPromise = pullRequestTool.execute(
    "call-pr-race",
    { headBranch: "feature/current", baseBranch: "main", title: "Title", body: "Body", draft: false },
    undefined,
    undefined,
    ctx,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.startsWith("fetch:")), false);

  releasePush.resolve();
  const [pushOutput, pullRequestOutput] = await Promise.all([pushPromise, pullRequestPromise]);

  assert.equal(pushOutput.details.mode, "publish");
  assert.equal(pullRequestOutput.details.number, 7);
  assert.ok(events.findIndex((event) => event === "push:end") < events.findIndex((event) => event.startsWith("fetch:")));
});

test("same-batch pull_request before push_branch fails early with retry guidance", async () => {
  const events = [];
  const branchCheckStarted = deferred();
  const releaseBranchCheck = deferred();
  const pi = {
    tools: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
    async exec(command, args, options) {
      assert.equal(command, "git");
      assert.ok(Array.isArray(args));
      assert.equal(options.cwd, "/repo");
      const key = args.join("\0");
      events.push(`git:${key}`);

      if (key === "rev-parse\0--show-toplevel") return result({ stdout: "/repo\n" });
      if (key === "show-ref\0--verify\0--quiet\0refs/heads/feature/current") return result({ code: 0 });
      if (key === "show-ref\0--verify\0--quiet\0refs/heads/main") return result({ code: 0 });
      if (key === "remote\0get-url\0origin") return result({ stdout: "https://github.com/senad-d/branchme.git\n" });
      if (key === "symbolic-ref\0--quiet\0--short\0HEAD") return result({ stdout: "feature/current\n" });
      if (key === "rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}") return result({ code: 1, stderr: "no upstream\n" });
      if (key === "push\0--set-upstream\0origin\0feature/current") return result({ stdout: "published\n" });
      if (args[0] === "check-ref-format" && args[1] === "--branch") return result({ stdout: `${args[2]}\n` });
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
  };
  const fetchImpl = async (url, init) => {
    events.push(`fetch:${init.method}:${url}`);
    if (url.endsWith("/branches/feature%2Fcurrent")) {
      branchCheckStarted.resolve();
      await releaseBranchCheck.promise;
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (init.method === "GET") return jsonResponse(branchPayload());
    throw new Error("pull request POST should not run before branch preflight succeeds");
  };
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const pullRequestTool = toolByName(pi, PULL_REQUEST_TOOL_NAME);
  const pushTool = toolByName(pi, PUSH_BRANCH_TOOL_NAME);

  const pullRequestPromise = pullRequestTool
    .execute(
      "call-pr-first",
      { headBranch: "feature/current", baseBranch: "main", title: "Title", body: "Body", draft: false },
      undefined,
      undefined,
      ctx,
    )
    .then(
      () => null,
      (error) => error,
    );
  await branchCheckStarted.promise;

  const pushPromise = pushTool.execute("call-push-second", {}, undefined, undefined, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event === "git:push\0--set-upstream\0origin\0feature/current"), false);

  releaseBranchCheck.resolve();
  const error = await pullRequestPromise;
  assert.ok(error instanceof Error);
  assert.match(error.message, /Run push_branch and wait for it to complete before calling pull_request/i);

  const pushOutput = await pushPromise;
  assert.equal(pushOutput.details.mode, "publish");
  assert.equal(events.some((event) => event.startsWith("fetch:POST")), false);
});

test("pull_request creates a PR in the resolved current repository without leaking token details", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET") return jsonResponse(branchPayload());
    return jsonResponse(pullRequestPayload(), 201);
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/current"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["rev-parse\0--verify\0refs/heads/feature/current^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
    ["remote\0get-url\0origin"]: { stdout: "git@github.com:senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  const output = await tool.execute(
    "call-5",
    { headBranch: "feature/current", baseBranch: "main", title: "Title", body: "Body", draft: false },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(output.details, {
    repository: { owner: "senad-d", repo: "branchme" },
    number: 7,
    url: "https://github.com/senad-d/branchme/pull/7",
    state: "open",
    head: "feature/current",
    base: "main",
    draft: false,
  });
  assert.deepEqual(
    requests.map((request) => [request.init.method, request.url]),
    [
      ["GET", "https://api.github.com/repos/senad-d/branchme/branches/feature%2Fcurrent"],
      ["GET", "https://api.github.com/repos/senad-d/branchme/branches/main"],
      ["POST", "https://api.github.com/repos/senad-d/branchme/pulls"],
    ],
  );
  assert.equal(requests[2].init.headers.Authorization, "Bearer ghp_secret123");
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    title: "Title",
    head: "feature/current",
    base: "main",
    body: "Body",
    draft: false,
  });
  assert.doesNotMatch(JSON.stringify(output), /secret123/);
});

test("pull_request can use a local .env token fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "branchme-tool-env-"));
  try {
    await writeFile(join(cwd, ".env"), "GH_TOKEN=ghp_filetoken123\n", "utf8");

    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") return jsonResponse(branchPayload());
      return jsonResponse(
        pullRequestPayload({
          number: 8,
          html_url: "https://github.com/senad-d/branchme/pull/8",
          head: { ref: "feature/env" },
        }),
        201,
      );
    };
    const pi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: `${cwd}\n` },
      ["show-ref\0--verify\0--quiet\0refs/heads/feature/env"]: { code: 0 },
      ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
      ["rev-parse\0--verify\0refs/heads/feature/env^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
      ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
    });
    registerBranchMeTools(pi, { env: {}, fetchImpl });
    const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

    const output = await tool.execute(
      "call-env",
      { headBranch: "feature/env", baseBranch: "main", title: "Title", body: "Body", draft: false },
      undefined,
      undefined,
      { ...ctx, cwd },
    );

    assert.equal(requests[0].init.headers.Authorization, "Bearer ghp_filetoken123");
    assert.doesNotMatch(JSON.stringify(output), /filetoken123/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pull_request resolves .env token fallback from the verified git root", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchme-tool-root-env-"));
  try {
    const subdir = join(root, "nested");
    await mkdir(subdir);
    await writeFile(join(root, ".env"), "GH_TOKEN=ghp_roottoken123\n", "utf8");

    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") return jsonResponse(branchPayload());
      return jsonResponse(
        pullRequestPayload({
          number: 9,
          html_url: "https://github.com/senad-d/branchme/pull/9",
          head: { ref: "feature/root-env" },
        }),
        201,
      );
    };
    const pi = makePi({
      ["rev-parse\0--show-toplevel"]: { stdout: `${root}\n` },
      ["show-ref\0--verify\0--quiet\0refs/heads/feature/root-env"]: { code: 0 },
      ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
      ["rev-parse\0--verify\0refs/heads/feature/root-env^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
      ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
    });
    registerBranchMeTools(pi, { env: {}, fetchImpl });
    const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

    await tool.execute(
      "call-root-env",
      { headBranch: "feature/root-env", baseBranch: "main", title: "Title", body: "Body", draft: false },
      undefined,
      undefined,
      { ...ctx, cwd: subdir },
    );

    assert.equal(requests[0].init.headers.Authorization, "Bearer ghp_roottoken123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pull_request redacts GitHub API errors", async () => {
  const fetchImpl = async (_url, init) => {
    if (init.method === "GET") return jsonResponse(branchPayload());
    return jsonResponse({ message: "bad token ghp_secret123" }, 401);
  };
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["show-ref\0--verify\0--quiet\0refs/heads/feature/current"]: { code: 0 },
    ["show-ref\0--verify\0--quiet\0refs/heads/main"]: { code: 0 },
    ["rev-parse\0--verify\0refs/heads/feature/current^{commit}"]: { stdout: `${LOCAL_HEAD_SHA}\n` },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: { GITHUB_TOKEN: "ghp_secret123" }, fetchImpl });
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  await assert.rejects(
    () =>
      tool.execute(
        "call-6",
        { headBranch: "feature/current", baseBranch: "main", title: "Title", body: "", draft: false },
        undefined,
        undefined,
        ctx,
      ),
    (error) => error instanceof Error && /HTTP 401/.test(error.message) && !/secret123/.test(error.message),
  );
});
