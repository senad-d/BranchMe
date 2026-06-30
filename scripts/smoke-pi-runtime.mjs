#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const localPiBinary = fileURLToPath(
  new URL(process.platform === "win32" ? "../node_modules/.bin/pi.cmd" : "../node_modules/.bin/pi", import.meta.url),
);
const maxCapturedChars = 64 * 1024;
const smokeTimeoutMs = 20_000;

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

function runPiSmoke(piBinary, tempRoot, smokeCwd) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(
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

    child.stdin.end("/branchme help\n/quit\n");
  });
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
  await mkdir(smokeCwd);

  const result = await runPiSmoke(piBinary, tempRoot, smokeCwd);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const cleanedOutput = stripTerminalControls(combinedOutput);

  if (result.timedOut) {
    throw new Error(`Pi runtime smoke timed out after ${smokeTimeoutMs}ms. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  if (result.code !== 0) {
    throw new Error(
      `Pi runtime smoke failed with exit code ${result.code ?? "null"}${result.signal ? ` and signal ${result.signal}` : ""}. Output:\n${summarizeOutput(combinedOutput)}`,
    );
  }

  const sawBranchMeHelp = /BranchMe/u.test(cleanedOutput) && /branch_status/u.test(cleanedOutput);
  const sawBranchMeStatus = /BranchMe:\s+branch/u.test(cleanedOutput);
  if (!sawBranchMeHelp && !sawBranchMeStatus) {
    throw new Error(`Pi runtime smoke did not observe BranchMe command output. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  if (/token present|GITHUB_TOKEN|GH_TOKEN|ghp_|github_pat_/iu.test(cleanedOutput)) {
    throw new Error(`Pi runtime smoke unexpectedly observed credential-related output. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  console.log("Pi runtime smoke passed: loaded BranchMe with pi --no-extensions -e <package> and observed non-mutating command output.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
