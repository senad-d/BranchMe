#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const localPiBinary = fileURLToPath(
  new URL(process.platform === "win32" ? "../node_modules/.bin/pi.cmd" : "../node_modules/.bin/pi", import.meta.url),
);
const piAiModuleUrl = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
  import.meta.url,
).href;
const smokeTimeoutMs = 30_000;
const maxBuffer = 1024 * 1024;

function isTruthy(value) {
  return /^(?:1|true|yes)$/iu.test(value ?? "");
}

function findPiBinary() {
  if (process.env.BRANCHME_PI_BIN) return process.env.BRANCHME_PI_BIN;
  try {
    accessSync(localPiBinary);
    return localPiBinary;
  } catch {
    return null;
  }
}

function isolatedEnvironment(tempRoot, scenario) {
  const env = { ...process.env };
  for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_TOKEN"]) delete env[name];

  return {
    ...env,
    BRANCHME_SMOKE_SCENARIO: scenario,
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: join(tempRoot, `agent-${scenario}`),
    PI_CODING_AGENT_SESSION_DIR: join(tempRoot, `sessions-${scenario}`),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TERM: "dumb",
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer,
    timeout: options.timeout ?? smokeTimeoutMs,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${options.label ?? command} failed with exit code ${result.status ?? "null"}.\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }

  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function initializeGitFixture(workspace) {
  mkdirSync(workspace);
  run("git", ["init", "-b", "feature/smoke"], { cwd: workspace, label: "git fixture init" });
  run("git", ["config", "user.name", "BranchMe Smoke"], { cwd: workspace });
  run("git", ["config", "user.email", "branchme-smoke@example.invalid"], { cwd: workspace });
  writeFileSync(join(workspace, "tracked.txt"), "initial\n", "utf8");
  run("git", ["add", "tracked.txt"], { cwd: workspace });
  run("git", ["commit", "-m", "Initial smoke commit"], { cwd: workspace });
  run("git", ["remote", "add", "origin", "https://github.com/senad-d/branchme-smoke.git"], { cwd: workspace });
  writeFileSync(join(workspace, "dirty.txt"), "dirty\n", "utf8");
}

function verifierSource() {
  return `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from ${JSON.stringify(piAiModuleUrl)};

const expectedTools = ["branch_status", "change_branch", "create_branch", "pull_branch", "pull_request", "push_branch"];
let fetchCalls = 0;
let refreshMutationCreated = false;
let toolCalls = 0;

globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("BranchMe Git-context smoke forbids network requests");
};

function assistantMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function textStream(model, text) {
  const stream = createAssistantMessageEventStream();
  const output = assistantMessage(model);
  output.content.push({ type: "text", text });
  stream.push({ type: "start", partial: output });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
  return stream;
}

function toolCallStream(model) {
  const stream = createAssistantMessageEventStream();
  const output = assistantMessage(model);
  const toolCall = { type: "toolCall", id: "branchme-smoke-refresh", name: "branch_status", arguments: {} };
  output.content.push(toolCall);
  output.stopReason = "toolUse";
  stream.push({ type: "start", partial: output });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: output });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end();
  return stream;
}

function fail(model, message) {
  return textStream(model, "BRANCHME_GIT_CONTEXT_SMOKE:" + JSON.stringify({ ok: false, message }));
}

function verifyTools(context) {
  const available = new Set((context.tools ?? []).map((tool) => tool.name));
  return expectedTools.every((name) => available.has(name)) && !available.has("git_context");
}

function toolResultText(context) {
  const result = [...context.messages].reverse().find(
    (message) => message.role === "toolResult" && message.toolName === "branch_status",
  );
  if (!result) return null;
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\\n");
}

function streamSmokeModel(model, context) {
  const scenario = process.env.BRANCHME_SMOKE_SCENARIO;
  const systemPrompt = context.systemPrompt ?? "";
  if (!verifyTools(context)) return fail(model, "unexpected BranchMe tool registration");
  if (fetchCalls !== 0) return fail(model, "a network request was attempted");

  if (scenario === "no-tool") {
    if (!systemPrompt.includes("## Automatic Git Context")) return fail(model, "automatic context heading missing");
    if (!systemPrompt.includes('- Branch: "feature/smoke"')) return fail(model, "current branch missing");
    if (!systemPrompt.includes("- Working tree: dirty")) return fail(model, "dirty working tree missing");
    if (!systemPrompt.includes('- Related PR: unavailable ("GitHub authentication is unavailable.")')) {
      return fail(model, "missing-credential PR status missing");
    }
    if (!systemPrompt.includes("Initial smoke commit")) return fail(model, "recent commit missing");
    if (toolCalls !== 0) return fail(model, "no-tool scenario invoked a tool");
    return textStream(
      model,
      'BRANCHME_GIT_CONTEXT_SMOKE:{"ok":true,"scenario":"no-tool"} Branch feature/smoke has a dirty working tree.',
    );
  }

  if (scenario === "refresh") {
    const result = toolResultText(context);
    if (!result) return toolCallStream(model);
    if (!result.includes("## Current Git Context")) return fail(model, "explicit refresh heading missing");
    if (!result.includes("smoke-refresh.txt")) return fail(model, "explicit refresh did not observe the local change");
    if (toolCalls !== 1) return fail(model, "refresh scenario did not invoke branch_status exactly once");
    return textStream(model, 'BRANCHME_GIT_CONTEXT_SMOKE:{"ok":true,"scenario":"refresh"}');
  }

  if (scenario === "non-git") {
    if (!systemPrompt.includes("Git context: unavailable (current directory is not a Git repository).")) {
      return fail(model, "non-Git context fallback missing");
    }
    if (toolCalls !== 0) return fail(model, "non-Git scenario invoked a tool");
    return textStream(model, 'BRANCHME_GIT_CONTEXT_SMOKE:{"ok":true,"scenario":"non-git"}');
  }

  return fail(model, "unknown smoke scenario");
}

export default function branchMeGitContextVerifier(pi) {
  pi.on("before_agent_start", async (_event, ctx) => {
    if (process.env.BRANCHME_SMOKE_SCENARIO !== "refresh" || refreshMutationCreated) return;
    await writeFile(join(ctx.cwd, "smoke-refresh.txt"), "created after automatic snapshot\\n", "utf8");
    refreshMutationCreated = true;
  });
  pi.on("tool_execution_start", () => {
    toolCalls += 1;
  });
  pi.registerProvider("branchme-smoke", {
    name: "BranchMe Smoke",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "smoke-key",
    api: "branchme-smoke-api",
    models: [{
      id: "git-context",
      name: "Git Context Smoke",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_024,
    }],
    streamSimple: streamSmokeModel,
  });
}
`;
}

function runScenario(piBinary, tempRoot, verifierPath, workspace, scenario, prompt) {
  const output = run(
    piBinary,
    [
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-extensions",
      "-e",
      repoRoot,
      "-e",
      verifierPath,
      "--provider",
      "branchme-smoke",
      "--model",
      "git-context",
      "--api-key",
      "smoke-key",
      "--print",
      prompt,
    ],
    { cwd: workspace, env: isolatedEnvironment(tempRoot, scenario), label: `Pi ${scenario} Git-context smoke` },
  );

  const marker = `BRANCHME_GIT_CONTEXT_SMOKE:{"ok":true,"scenario":"${scenario}"}`;
  if (!output.includes(marker)) throw new Error(`Pi ${scenario} Git-context smoke did not emit its success marker.\n${output}`);
}

if (isTruthy(process.env.BRANCHME_SKIP_PI_SMOKE)) {
  console.log("Skipping Pi Git-context smoke test because BRANCHME_SKIP_PI_SMOKE is set.");
  process.exit(0);
}

const piBinary = findPiBinary();
if (!piBinary) {
  console.log("Skipping Pi Git-context smoke test because the local pi binary is unavailable.");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "branchme-pi-git-context-smoke-"));
try {
  const gitWorkspace = join(tempRoot, "git-workspace");
  const nonGitWorkspace = join(tempRoot, "non-git-workspace");
  const verifierPath = join(tempRoot, "branchme-git-context-verifier.ts");
  initializeGitFixture(gitWorkspace);
  mkdirSync(nonGitWorkspace);
  writeFileSync(verifierPath, verifierSource(), "utf8");

  runScenario(piBinary, tempRoot, verifierPath, gitWorkspace, "no-tool", "Report the current branch and working-tree state without calling a tool.");
  runScenario(piBinary, tempRoot, verifierPath, gitWorkspace, "refresh", "Use branch_status to refresh after the local change.");
  runScenario(piBinary, tempRoot, verifierPath, nonGitWorkspace, "non-git", "Report whether Git context is available without calling a tool.");

  console.log(
    "Pi Git-context smoke passed: automatic no-tool context, one branch_status refresh after a local change, credential-free PR lookup, and non-Git startup all passed without network access.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
