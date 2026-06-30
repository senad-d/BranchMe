#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const maxCapturedChars = 64 * 1024;
const commandTimeoutMs = 180_000;
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

function packageInstallPath(installRoot, packageName) {
  const parts = packageName.split("/");
  if (packageName.startsWith("@") && parts.length !== 2) {
    throw new Error(`Unsupported scoped package name: ${packageName}`);
  }

  return join(installRoot, "node_modules", ...parts);
}

function isolatedEnvironment(tempRoot) {
  const env = { ...process.env };
  for (const name of ["BRANCHME_SKIP_PI_SMOKE", "GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    delete env[name];
  }

  return {
    ...env,
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: join(tempRoot, "npm-cache"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_USERCONFIG: join(tempRoot, "empty-npmrc"),
    TERM: "dumb",
  };
}

function smokeEnvironment(tempRoot) {
  return {
    ...isolatedEnvironment(tempRoot),
    PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(tempRoot, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

function runCaptured(command, args, options) {
  const label = options.label ?? `${command} ${args.join(" ")}`;
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
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
      reject(new Error(`${label} could not start: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${timeoutMs}ms. Output:\n${summarizeOutput(`${stdout}\n${stderr}`)}`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `${label} failed with exit code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}. Output:\n${summarizeOutput(`${stdout}\n${stderr}`)}`,
          ),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function packArtifact(tempRoot, env) {
  const packDir = join(tempRoot, "pack");
  await mkdir(packDir);

  const result = await runCaptured(npmCommand, ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    env,
    label: "npm pack packed-artifact smoke",
  });

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `npm pack packed-artifact smoke returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${summarizeOutput(result.stdout)}`,
    );
  }

  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack?.filename || !Array.isArray(pack.files)) {
    throw new Error("npm pack packed-artifact smoke returned unexpected JSON without filename/files metadata.");
  }

  const tarballPath = isAbsolute(pack.filename) ? pack.filename : join(packDir, pack.filename);
  await access(tarballPath);
  return tarballPath;
}

async function installArtifact(tempRoot, tarballPath, env) {
  const installRoot = join(tempRoot, "install");
  await mkdir(installRoot);
  await writeFile(join(installRoot, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2) + "\n");

  await runCaptured(npmCommand, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installRoot,
    env,
    label: "npm install packed BranchMe artifact",
    timeoutMs: commandTimeoutMs,
  });

  return installRoot;
}

async function findInstalledPiBinary(installRoot) {
  const names = process.platform === "win32" ? ["pi.cmd", "pi"] : ["pi"];
  for (const name of names) {
    const candidate = join(installRoot, "node_modules", ".bin", name);
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Installed-package smoke could not find a pi binary in the temporary production install. Ensure peer dependencies install correctly before publishing.",
  );
}

function runPiSmoke(piBinary, tempRoot, smokeCwd, extensionPath) {
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
        extensionPath,
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
  console.log("Skipping installed-package Pi smoke test because BRANCHME_SKIP_PI_SMOKE is set.");
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), "branchme-pi-packed-smoke-"));
try {
  await writeFile(join(tempRoot, "empty-npmrc"), "", "utf8");
  const env = isolatedEnvironment(tempRoot);
  const tarballPath = await packArtifact(tempRoot, env);
  const installRoot = await installArtifact(tempRoot, tarballPath, env);
  const extensionPath = packageInstallPath(installRoot, pkg.name);
  const smokeCwd = join(tempRoot, "workspace");

  await access(join(extensionPath, "package.json"));
  await access(join(extensionPath, ".env.example"));
  await mkdir(smokeCwd);

  const piBinary = await findInstalledPiBinary(installRoot);
  const result = await runPiSmoke(piBinary, tempRoot, smokeCwd, extensionPath);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const cleanedOutput = stripTerminalControls(combinedOutput);

  if (result.timedOut) {
    throw new Error(`Installed-package Pi smoke timed out after ${smokeTimeoutMs}ms. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  if (result.code !== 0) {
    throw new Error(
      `Installed-package Pi smoke failed with exit code ${result.code ?? "null"}${result.signal ? ` and signal ${result.signal}` : ""}. Output:\n${summarizeOutput(combinedOutput)}`,
    );
  }

  const sawBranchMeHelp = /BranchMe/u.test(cleanedOutput) && /branch_status/u.test(cleanedOutput);
  const sawBranchMeStatus = /BranchMe:\s+branch/u.test(cleanedOutput);
  if (!sawBranchMeHelp && !sawBranchMeStatus) {
    throw new Error(`Installed-package Pi smoke did not observe BranchMe command output. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  if (/token present|Authorization:\s*Bearer|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/iu.test(cleanedOutput)) {
    throw new Error(`Installed-package Pi smoke unexpectedly observed credential value output. Output:\n${summarizeOutput(combinedOutput)}`);
  }

  console.log(
    `Installed-package Pi smoke passed: packed ${pkg.name}, installed it into a temporary production workspace, and loaded BranchMe with pi --no-extensions -e <installed package>.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
