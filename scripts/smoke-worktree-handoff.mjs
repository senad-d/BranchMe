#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { branchMeExtension } from "../src/extension.ts";
import {
  BRANCHME_TOOL_NAMES,
  CREATE_WORKTREE_TOOL_NAME,
  LIST_WORKTREES_TOOL_NAME,
  REMOVE_WORKTREE_TOOL_NAME,
} from "../src/constants.ts";

const execFileAsync = promisify(execFile);
const smokeTimeoutMs = 30_000;
const maxBuffer = 1024 * 1024;
const sessionMarker = "BRANCHME_HANDOFF_SESSION:";
const resultMarker = "BRANCHME_WORKTREE_HANDOFF_SMOKE:";
let networkAttempts = 0;

function denyNetwork() {
  networkAttempts += 1;
  throw new Error("The isolated worktree handoff smoke forbids network requests.");
}

function isPathWithin(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isolatedEnvironment(temporaryRoot) {
  const env = {
    BRANCHME_PR_AUTOFILL: "false",
    CI: "1",
    FORCE_COLOR: "0",
    GIT_AUTHOR_EMAIL: "branchme-smoke@example.invalid",
    GIT_AUTHOR_NAME: "BranchMe Handoff Smoke",
    GIT_COMMITTER_EMAIL: "branchme-smoke@example.invalid",
    GIT_COMMITTER_NAME: "BranchMe Handoff Smoke",
    GIT_CONFIG_GLOBAL: join(temporaryRoot, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: temporaryRoot,
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  };

  for (const name of ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

async function execResult(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer,
      signal: options.signal,
      timeout: options.timeout ?? smokeTimeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  } catch (error) {
    return {
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : error instanceof Error ? error.message : String(error),
      code: typeof error?.code === "number" ? error.code : 1,
      killed: Boolean(error?.killed),
    };
  }
}

async function runGit(cwd, args, env) {
  const result = await execResult("git", args, { cwd, env });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

class IsolatedPiHost {
  constructor(temporaryRoot, env) {
    this.temporaryRoot = temporaryRoot;
    this.env = env;
    this.tools = new Map();
    this.commands = new Map();
    this.events = [];
  }

  on(name, handler) {
    this.events.push({ name, handler });
  }

  registerCommand(name, options) {
    this.commands.set(name, options);
  }

  registerTool(tool) {
    this.tools.set(tool.name, tool);
  }

  async exec(command, args, options) {
    assert.equal(command, "git");
    assert.ok(Array.isArray(args), "Git commands must use argv arrays.");
    assert.equal(typeof options?.cwd, "string");
    assert.equal(
      isPathWithin(this.temporaryRoot, options.cwd),
      true,
      `Git cwd escaped the isolated temporary root: ${options.cwd}`,
    );
    return execResult(command, args, { ...options, env: this.env });
  }

  tool(name) {
    const tool = this.tools.get(name);
    assert.ok(tool, `Expected ${name} to be registered.`);
    return tool;
  }
}

async function initializeFixture(temporaryRoot, env) {
  const repoRoot = join(temporaryRoot, "source");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "--initial-branch=main"], env);
  await writeFile(join(repoRoot, "tracked.txt"), "isolated handoff smoke\n", "utf8");
  await runGit(repoRoot, ["add", "tracked.txt"], env);
  await runGit(repoRoot, ["commit", "-m", "Initialize isolated handoff smoke"], env);
  return repoRoot;
}

function handoffSessionSource() {
  return `import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const result = {
  cwd: process.cwd(),
  branch: git(["branch", "--show-current"]),
  head: git(["rev-parse", "HEAD"]),
  remotes: git(["remote"]),
};
if (result.cwd !== process.env.BRANCHME_EXPECTED_CWD) throw new Error("handoff cwd mismatch");
if (result.branch !== process.env.BRANCHME_EXPECTED_BRANCH) throw new Error("handoff branch mismatch");
if (result.head !== process.env.BRANCHME_EXPECTED_HEAD) throw new Error("handoff HEAD mismatch");
if (result.remotes !== "") throw new Error("isolated fixture unexpectedly has a remote");
process.stdout.write(${JSON.stringify(sessionMarker)} + JSON.stringify(result) + "\\n");
`;
}

async function runHandoffSession(handoff, baseEnv) {
  const env = {
    ...baseEnv,
    BRANCHME_EXPECTED_BRANCH: handoff.branch,
    BRANCHME_EXPECTED_CWD: handoff.cwd,
    BRANCHME_EXPECTED_HEAD: handoff.head,
  };
  const result = await execResult(process.execPath, ["--input-type=module", "--eval", handoffSessionSource()], {
    cwd: handoff.cwd,
    env,
  });
  if (result.code !== 0) throw new Error(`Isolated handoff session failed: ${result.stderr || result.stdout}`);

  const match = result.stdout.match(/BRANCHME_HANDOFF_SESSION:(\{[^\n]+\})/u);
  if (!match) throw new Error("Isolated handoff session did not emit structured verification.");
  return JSON.parse(match[1]);
}

async function executeTool(tool, toolCallId, params, repoRoot) {
  const controller = new AbortController();
  return tool.execute(toolCallId, params, controller.signal, undefined, { cwd: repoRoot });
}

async function main() {
  const rawTemporaryRoot = await mkdtemp(join(tmpdir(), "branchme-handoff-smoke-"));
  const temporaryRoot = await realpath(rawTemporaryRoot);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = denyNetwork;

  try {
    await writeFile(join(temporaryRoot, "empty-gitconfig"), "", "utf8");
    const env = isolatedEnvironment(temporaryRoot);
    const repoRoot = await initializeFixture(temporaryRoot, env);
    const worktreePath = join(temporaryRoot, "handoff-worktree");
    const branchName = "feature/isolated-handoff-smoke";
    const sourceHead = await runGit(repoRoot, ["rev-parse", "HEAD"], env);
    const pi = new IsolatedPiHost(temporaryRoot, env);
    branchMeExtension(pi);

    assert.deepEqual([...pi.tools.keys()].sort(), [...BRANCHME_TOOL_NAMES].sort());
    const createTool = pi.tool(CREATE_WORKTREE_TOOL_NAME);
    const listTool = pi.tool(LIST_WORKTREES_TOOL_NAME);
    const removeTool = pi.tool(REMOVE_WORKTREE_TOOL_NAME);
    const created = await executeTool(
      createTool,
      "isolated-create-worktree",
      { worktreePath, branchName, branchMode: "new" },
      repoRoot,
    );

    assert.equal(created.details.action, CREATE_WORKTREE_TOOL_NAME);
    assert.equal(created.details.handoff.ready, true);
    assert.equal(isAbsolute(created.details.handoff.cwd), true);
    assert.equal(created.details.handoff.cwd, await realpath(worktreePath));
    assert.equal(created.details.handoff.branch, branchName);
    assert.equal(created.details.handoff.head, sourceHead);

    const handoffSession = await runHandoffSession(created.details.handoff, env);
    assert.deepEqual(handoffSession, {
      cwd: created.details.handoff.cwd,
      branch: branchName,
      head: sourceHead,
      remotes: "",
    });

    const listed = await executeTool(listTool, "isolated-list-worktrees", {}, repoRoot);
    assert.equal(listed.details.worktrees.some((worktree) => worktree.path === created.details.handoff.cwd), true);

    const removed = await executeTool(
      removeTool,
      "isolated-remove-worktree",
      { worktreePath: created.details.handoff.cwd },
      repoRoot,
    );
    assert.equal(removed.details.handoff.ready, false);
    assert.equal(removed.details.handoff.cwd, null);
    assert.equal(removed.details.handoff.branch, branchName);
    assert.equal(removed.details.handoff.head, sourceHead);
    assert.equal(removed.details.verified.after.branchRetained, true);
    await assert.rejects(access(worktreePath), { code: "ENOENT" });
    assert.equal(await runGit(repoRoot, ["rev-parse", `refs/heads/${branchName}`], env), sourceHead);
    assert.equal(networkAttempts, 0);

    process.stdout.write(
      `${resultMarker}${JSON.stringify({
        ok: true,
        absoluteCwd: true,
        branch: branchName,
        head: sourceHead,
        separateSessionVerified: true,
        branchRetained: true,
        networkRequests: networkAttempts,
        credentialSource: "isolated-empty-environment",
      })}\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
