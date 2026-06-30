import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
} from "../src/constants.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const LOCAL_HEAD_SHA = "a".repeat(40);
const REMOTE_BASE_SHA = "b".repeat(40);
const STALE_REMOTE_HEAD_SHA = "c".repeat(40);

function result(overrides = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
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
  return {
    tools,
    commands,
    calls,
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

test("branchMeExtension registers exactly the BranchMe command and five prompt-ready tools", () => {
  const pi = makePi();
  branchMeExtension(pi);

  assert.deepEqual(
    pi.commands.map((command) => command.name),
    [BRANCHME_COMMAND_NAME],
  );
  assert.equal(pi.tools.length, 5);
  assert.deepEqual(
    pi.tools.map((tool) => tool.name).sort(),
    [...BRANCHME_TOOL_NAMES].sort(),
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

  assert.equal(pi.commands.some((command) => /template/i.test(command.name)), false);
  assert.equal(pi.tools.some((tool) => /template|greet|hello/i.test(tool.name)), false);
});

test("branch_status has strict schema, prompt metadata, and read-only details", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main\n" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { stdout: "0\t0\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeTools(pi, { env: {} });
  const tool = toolByName(pi, BRANCH_STATUS_TOOL_NAME);

  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.promptSnippet, /branch/i);
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(BRANCH_STATUS_TOOL_NAME)));

  const output = await tool.execute("call-1", {}, undefined, undefined, ctx);

  assert.equal(output.details.repoRoot, "/repo");
  assert.equal(output.details.currentBranch, "main");
  assert.equal(output.details.detached, false);
  assert.equal(output.details.upstream, "origin/main");
  assert.equal(output.details.hasChanges, false);
  assert.equal(output.details.ahead, 0);
  assert.equal(output.details.behind, 0);
  assert.deepEqual(output.details.githubRepository, { owner: "senad-d", repo: "branchme" });
  assert.match(output.content[0].text, /BranchMe status/);

  const mutatingCommands = pi.calls.filter((call) => ["switch", "push", "commit", "add"].includes(call.args[0]));
  assert.deepEqual(mutatingCommands, []);
});

test("branch_status reports partial status warnings when ahead/behind is unavailable", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "feature/stale\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/feature/stale\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## feature/stale...origin/feature/stale\n" },
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
  assert.match(output.content[0].text, /warning:/);
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

test("pull_request has required strict schema and rejects repository parameters", () => {
  const pi = makePi();
  registerBranchMeTools(pi);
  const tool = toolByName(pi, PULL_REQUEST_TOOL_NAME);

  assert.deepEqual(tool.parameters.required, ["headBranch", "baseBranch", "title", "body", "draft"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal("owner" in tool.parameters.properties, false);
  assert.equal("repo" in tool.parameters.properties, false);
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes(PULL_REQUEST_TOOL_NAME)));
  assert.ok(tool.promptGuidelines.some((guideline) => /push_branch.*completed/i.test(guideline)));
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
