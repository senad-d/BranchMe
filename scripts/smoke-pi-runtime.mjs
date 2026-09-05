#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const localPiBinary = fileURLToPath(
  new URL(process.platform === "win32" ? "../node_modules/.bin/pi.cmd" : "../node_modules/.bin/pi", import.meta.url),
);
const maxCapturedChars = 64 * 1024;
const smokeTimeoutMs = 20_000;
const runtimeVerifierCommandName = "branchmeverify";
const runtimeVerifierMarker = "BRANCHME_RUNTIME_VERIFY:";
const expectedBranchMeTools = [
  {
    name: "branch_status",
    properties: ["ancestry"],
    required: [],
    objects: {
      ancestry: {
        properties: ["sourceBranch", "targetBranch"],
        required: ["sourceBranch", "targetBranch"],
      },
    },
  },
  { name: "change_branch", properties: ["branchName"], required: ["branchName"] },
  { name: "create_branch", properties: ["branchName"], required: ["branchName"] },
  { name: "fetch_branch", properties: ["branch", "remote"], required: [] },
  { name: "pull_branch", properties: [], required: [] },
  { name: "rebase_branch", properties: [], required: [] },
  { name: "push_branch", properties: [], required: [] },
  { name: "pull_request", properties: ["baseBranch", "body", "draft", "headBranch", "title"], required: [] },
  { name: "integrate_branch", properties: ["sourceBranch", "targetBranch"], required: ["sourceBranch", "targetBranch"] },
  {
    name: "retire_branch",
    properties: ["branchName", "expectedHead", "force", "targetBranch"],
    required: ["branchName", "expectedHead", "targetBranch", "force"],
  },
  {
    name: "land_branch",
    properties: ["remote", "sourceBranch", "targetBranch", "worktreePath"],
    required: ["sourceBranch", "targetBranch"],
  },
  { name: "list_worktrees", properties: [], required: [] },
  {
    name: "create_worktree",
    properties: ["baseRef", "branchMode", "branchName", "worktreePath"],
    required: ["worktreePath", "branchName", "branchMode"],
    enums: { branchMode: ["new", "existing"] },
  },
  { name: "remove_worktree", properties: ["worktreePath"], required: ["worktreePath"] },
];

function isTruthy(value) {
  return /^(?:1|true|yes)$/iu.test(value ?? "");
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(command) {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function findPiBinary() {
  if (process.env.BRANCHME_PI_BIN) return process.env.BRANCHME_PI_BIN;
  if (await isExecutable(localPiBinary)) return localPiBinary;
  return (await findOnPath(process.platform === "win32" ? "pi.cmd" : "pi")) ?? (await findOnPath("pi"));
}

function appendLimited(current, chunk) {
  if (current.length >= maxCapturedChars) return current;
  const next = `${current}${chunk}`;
  return next.length <= maxCapturedChars ? next : next.slice(0, maxCapturedChars);
}

function stripTerminalControls(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function summarizeOutput(value) {
  const cleaned = stripTerminalControls(value).trim();
  if (cleaned.length <= 4_000) return cleaned;
  return `${cleaned.slice(0, 4_000)}… [truncated]`;
}

function runtimeVerifierSource() {
  return `const expectedTools = ${JSON.stringify(expectedBranchMeTools, null, 2)};
const commandName = ${JSON.stringify(runtimeVerifierCommandName)};
const marker = ${JSON.stringify(runtimeVerifierMarker)};

function sortedStrings(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

function stringListEquals(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function schemaSummary(schema) {
  const properties = schema?.properties && typeof schema.properties === "object" ? sortedStrings(Object.keys(schema.properties)) : [];
  const required = Array.isArray(schema?.required) ? [...schema.required] : [];
  return {
    strict: schema?.additionalProperties === false,
    properties,
    required,
  };
}

function schemaEnumValues(schema, propertyName) {
  const values = schema?.properties?.[propertyName]?.enum;
  return Array.isArray(values) ? [...values] : [];
}

function verifyObjectSchema(schema, propertyName, expected) {
  const summary = schemaSummary(schema?.properties?.[propertyName]);
  const failures = [];
  if (!summary.strict) failures.push(propertyName + " object does not set additionalProperties: false");
  if (!stringListEquals(summary.properties, sortedStrings(expected.properties))) {
    failures.push(propertyName + " object properties were " + (summary.properties.join(",") || "<none>"));
  }
  if (!stringListEquals(summary.required, expected.required)) {
    failures.push(propertyName + " object required fields were " + (summary.required.join(",") || "<none>"));
  }
  return { ...summary, failures };
}

function hasExtensionSourceMetadata(sourceInfo) {
  return Boolean(
    sourceInfo &&
    typeof sourceInfo.path === "string" &&
    typeof sourceInfo.source === "string" &&
    typeof sourceInfo.scope === "string" &&
    typeof sourceInfo.origin === "string" &&
    sourceInfo.source !== "builtin" &&
    sourceInfo.source !== "sdk"
  );
}

function verifyTool(tool, expected, activeTools, toolSnippets) {
  const failures = [];
  const schema = schemaSummary(tool.parameters);
  const guidelines = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : [];
  const sourceInfo = tool.sourceInfo ?? null;
  const sourceMetadataValid = hasExtensionSourceMetadata(sourceInfo);
  const active = activeTools.has(expected.name);
  const descriptionMentionsName = typeof tool.description === "string" && tool.description.includes(expected.name);
  const promptSnippet = toolSnippets[expected.name];
  const promptSnippetMentionsName = typeof promptSnippet === "string" && promptSnippet.includes(expected.name);

  if (!active) failures.push(expected.name + " is registered but not active");
  if (!schema.strict) failures.push(expected.name + " schema does not set additionalProperties: false");
  if (!stringListEquals(schema.properties, sortedStrings(expected.properties))) {
    failures.push(expected.name + " schema properties were " + (schema.properties.join(",") || "<none>"));
  }
  if (!stringListEquals(schema.required, expected.required)) {
    failures.push(expected.name + " schema required fields were " + (schema.required.join(",") || "<none>"));
  }
  for (const [propertyName, expectedValues] of Object.entries(expected.enums ?? {})) {
    const actualValues = schemaEnumValues(tool.parameters, propertyName);
    if (!stringListEquals(actualValues, expectedValues)) {
      failures.push(expected.name + " schema enum " + propertyName + " was " + (actualValues.join(",") || "<none>"));
    }
  }
  const objects = {};
  for (const [propertyName, expectedObject] of Object.entries(expected.objects ?? {})) {
    const verification = verifyObjectSchema(tool.parameters, propertyName, expectedObject);
    objects[propertyName] = verification;
    failures.push(...verification.failures.map((failure) => expected.name + " " + failure));
  }
  if (!descriptionMentionsName) failures.push(expected.name + " description does not name the tool");
  if (!promptSnippetMentionsName) failures.push(expected.name + " prompt snippet is missing or does not name the tool");
  if (guidelines.length === 0) failures.push(expected.name + " has no prompt guidelines");
  if (!guidelines.every((guideline) => typeof guideline === "string" && guideline.includes(expected.name))) {
    failures.push(expected.name + " prompt guidelines do not consistently name the tool");
  }
  if (!sourceMetadataValid) {
    failures.push(expected.name + " extension source metadata is missing or invalid");
  }

  return {
    name: expected.name,
    active,
    strictSchema: schema.strict,
    properties: schema.properties,
    required: schema.required,
    objects,
    promptGuidelines: guidelines.length,
    descriptionMentionsName,
    promptSnippetMentionsName,
    sourceMetadataValid,
    source: sourceInfo?.source ?? null,
    scope: sourceInfo?.scope ?? null,
    origin: sourceInfo?.origin ?? null,
    failures,
  };
}

export default function branchMeRuntimeVerifier(pi) {
  pi.registerCommand(commandName, {
    description: "Verify BranchMe tool metadata through Pi's real extension runtime.",
    handler: async (_args, ctx) => {
      const allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
      const activeTools = new Set(typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []);
      const promptOptions = typeof ctx.getSystemPromptOptions === "function" ? ctx.getSystemPromptOptions() : {};
      const toolSnippets = promptOptions.toolSnippets && typeof promptOptions.toolSnippets === "object"
        ? promptOptions.toolSnippets
        : {};
      const byName = new Map(allTools.map((tool) => [tool.name, tool]));
      const failures = [];
      const tools = [];

      if (expectedTools.length !== 14) failures.push("runtime verifier did not expect exactly fourteen BranchMe tools");
      for (const forbiddenName of ["continue_merge", "abort_merge"]) {
        if (byName.has(forbiddenName) || activeTools.has(forbiddenName)) {
          failures.push(forbiddenName + " must not be registered or active");
        }
      }

      for (const expected of expectedTools) {
        const matching = allTools.filter((tool) => tool.name === expected.name);
        if (matching.length !== 1) {
          failures.push(expected.name + " appeared " + matching.length + " times in pi.getAllTools()");
        }
        const tool = byName.get(expected.name);
        if (!tool) {
          tools.push({ name: expected.name, missing: true });
          continue;
        }

        const verification = verifyTool(tool, expected, activeTools, toolSnippets);
        tools.push(verification);
        failures.push(...verification.failures);
      }

      const expectedNames = sortedStrings(expectedTools.map((tool) => tool.name));
      const branchMeSourcePath = byName.get("branch_status")?.sourceInfo?.path;
      if (typeof branchMeSourcePath !== "string") {
        failures.push("Unable to identify BranchMe extension source path");
      } else {
        const sourceToolNames = sortedStrings(
          allTools.filter((tool) => tool.sourceInfo?.path === branchMeSourcePath).map((tool) => tool.name),
        );
        if (!stringListEquals(sourceToolNames, expectedNames)) {
          failures.push("BranchMe extension source registered unexpected tools: " + (sourceToolNames.join(",") || "<none>"));
        }
      }

      process.stdout.write(marker + JSON.stringify({ ok: failures.length === 0, tools, failures }) + "\\n");
    },
  });
}
`;
}

function parseRuntimeVerification(output) {
  const match = output.match(/BRANCHME_RUNTIME_VERIFY:(\{[^\n]*\})/u);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Pi runtime smoke emitted invalid BranchMe tool verification JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertRuntimeVerification(output) {
  const verification = parseRuntimeVerification(output);
  if (!verification) {
    throw new Error(`Pi runtime smoke did not observe BranchMe tool verification output. Output:\n${summarizeOutput(output)}`);
  }

  if (!verification.ok) {
    const failures = Array.isArray(verification.failures) ? verification.failures.join("; ") : "unknown verification failure";
    throw new Error(`Pi runtime BranchMe tool verification failed: ${failures}. Output:\n${summarizeOutput(output)}`);
  }

  const verifiedNames = Array.isArray(verification.tools) ? verification.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)) : [];
  const expectedNames = expectedBranchMeTools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
  if (verifiedNames.join("\0") !== expectedNames.join("\0")) {
    throw new Error(`Pi runtime BranchMe tool verification returned unexpected tools: ${verifiedNames.join(", ") || "<none>"}.`);
  }
}

function smokeEnvironment(tempRoot) {
  const env = { ...process.env };
  delete env.BRANCHME_SKIP_PI_SMOKE;
  delete env.GH_TOKEN;
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_TOKEN;

  return {
    ...env,
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(tempRoot, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TERM: "dumb",
  };
}

function runPiSmoke(piBinary, tempRoot, smokeCwd, input, verifierPath) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const extensionArgs = verifierPath ? ["-e", repoRoot, "-e", verifierPath] : ["-e", repoRoot];
    const child = spawn(
      piBinary,
      [
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        ...extensionArgs,
      ],
      {
        cwd: smokeCwd,
        env: smokeEnvironment(tempRoot),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, smokeTimeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    child.stdin.end(input);
  });
}

function assertPiSmokeSucceeded(result, label, output) {
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${smokeTimeoutMs}ms. Output:\n${summarizeOutput(output)}`);
  }

  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.code ?? "null"}${result.signal ? ` and signal ${result.signal}` : ""}. Output:\n${summarizeOutput(output)}`,
    );
  }
}

if (isTruthy(process.env.BRANCHME_SKIP_PI_SMOKE)) {
  console.log("Skipping Pi runtime smoke test because BRANCHME_SKIP_PI_SMOKE is set.");
  process.exit(0);
}

const piBinary = await findPiBinary();
if (!piBinary) {
  console.log("Skipping Pi runtime smoke test because the pi binary is unavailable.");
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), "branchme-pi-smoke-"));
try {
  const smokeCwd = join(tempRoot, "workspace");
  const verifierPath = join(tempRoot, "branchme-runtime-verifier.ts");
  await mkdir(smokeCwd);
  await writeFile(verifierPath, runtimeVerifierSource(), "utf8");

  const verifierResult = await runPiSmoke(piBinary, tempRoot, smokeCwd, `/${runtimeVerifierCommandName} verify\n`, verifierPath);
  const verifierOutput = `${verifierResult.stdout}\n${verifierResult.stderr}`;
  const cleanedVerifierOutput = stripTerminalControls(verifierOutput);
  assertPiSmokeSucceeded(verifierResult, "Pi runtime tool verification smoke", verifierOutput);
  assertRuntimeVerification(cleanedVerifierOutput);

  const commandResult = await runPiSmoke(piBinary, tempRoot, smokeCwd, "/branchme help\n");
  const commandOutput = `${commandResult.stdout}\n${commandResult.stderr}`;
  const cleanedCommandOutput = stripTerminalControls(commandOutput);
  assertPiSmokeSucceeded(commandResult, "Pi runtime command smoke", commandOutput);

  const sawBranchMeHelp = /BranchMe/u.test(cleanedCommandOutput) && /branch_status/u.test(cleanedCommandOutput);
  const sawBranchMeStatus = /BranchMe:\s+branch/u.test(cleanedCommandOutput);
  if (!sawBranchMeHelp && !sawBranchMeStatus) {
    throw new Error(`Pi runtime smoke did not observe BranchMe command output. Output:\n${summarizeOutput(commandOutput)}`);
  }

  const combinedOutput = `${verifierOutput}\n${commandOutput}`;
  const cleanedOutput = stripTerminalControls(combinedOutput);
  if (/token present|Authorization:\s*Bearer|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/iu.test(cleanedOutput)) {
    throw new Error(`Pi runtime smoke unexpectedly observed credential value output. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  console.log(
    "Pi runtime smoke passed: loaded BranchMe with pi --no-extensions -e <package>, verified the complete BranchMe tool set and prompt metadata through Pi runtime APIs, and observed non-mutating command output.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
