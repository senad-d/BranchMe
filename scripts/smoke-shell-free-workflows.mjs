#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checked, fixture, git, testEnv } from "../test/helpers/git-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.BRANCHME_PI_BIN ?? join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const verifier = fileURLToPath(new URL("./smoke-shell-free-verifier.ts", import.meta.url));
if (/^(1|true|yes)$/iu.test(process.env.BRANCHME_SKIP_PI_SMOKE ?? "")) { console.log("Skipping shell-free workflow smoke by explicit configuration."); process.exit(0); }
await access(binary);
const cleanup = [];
function registerCleanup(fn) { cleanup.push(fn); }
async function prepare() {
  const f = await fixture({ after: registerCleanup });
  await checked(f.root, ["branch", "-m", "feature/smoke"]);
  await checked(f.root, ["remote", "add", "origin", "https://github.com/senad-d/branchme-smoke.git"]);
  await writeFile(join(f.root, "tracked.txt"), "initial\n"); await checked(f.root, ["add", "."]); await checked(f.root, ["commit", "-m", "tracked file"]);
  return f;
}
function runScenario(f, scenario, extra = {}) {
  const env = { ...testEnv, ...extra, CI: "1", TERM: "dumb", FORCE_COLOR: "0", NO_COLOR: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: join(f.temp, "agent"), PI_CODING_AGENT_SESSION_DIR: join(f.temp, "sessions"), BRANCHME_WORKFLOW_SCENARIO: scenario };
  const result = spawnSync(binary, ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "-e", root, "-e", verifier, "--provider", "branchme-workflow-smoke", "--model", "workflow", "--api-key", "smoke-key", "--print", "Execute only the explicitly authorized deterministic fixture workflow; never use Bash or another extension."], { cwd: f.root, env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 90000 });
  if (result.error || result.status !== 0 || !result.stdout.includes(`BRANCHME_SHELL_FREE:${scenario}:ok`)) throw new Error(`Shell-free ${scenario} smoke failed: ${result.error ?? ""}\n${(result.stdout + result.stderr).slice(-12000)}`);
}
try {
  const local = await prepare();
  await writeFile(join(local.root, "revertable.txt"), "inverse fixture\n"); await checked(local.root, ["add", "."]); await checked(local.root, ["commit", "-m", "revertable"]);
  const head = await checked(local.root, ["rev-parse", "HEAD"]);
  await checked(local.root, ["update-ref", "refs/remotes/origin/feature/smoke", head]);
  const linked = join(local.temp, "linked"); await checked(local.root, ["worktree", "add", "-b", "fixture-linked", linked]);
  await writeFile(join(local.root, "tracked.txt"), "working edit\n");
  runScenario(local, "local", { BRANCHME_WORKFLOW_LINKED: linked, BRANCHME_WORKFLOW_COMMIT: head });
  if (await checked(local.root, ["rev-parse", "HEAD"]) !== head || await checked(local.root, ["branch", "--show-current"]) !== "feature/smoke" || await checked(linked, ["branch", "--show-current"]) !== "coordinated-topic") throw new Error("Local smoke moved an unintended HEAD/branch");

  const conflict = await prepare();
  await checked(conflict.root, ["switch", "-c", "side"]); await writeFile(join(conflict.root, "tracked.txt"), "theirs\n"); await checked(conflict.root, ["commit", "-am", "theirs"]);
  await checked(conflict.root, ["switch", "feature/smoke"]); await writeFile(join(conflict.root, "tracked.txt"), "ours\n"); await checked(conflict.root, ["commit", "-am", "ours"]);
  if ((await git(conflict.root, ["merge", "side"])).code !== 1) throw new Error("Expected a fixture conflict");
  runScenario(conflict, "conflicts");

  const github = await prepare();
  runScenario(github, "github", { GITHUB_TOKEN: "smoke-fixture-token" });
  console.log("Shell-free Pi workflows passed: history/blob inspection, exact-path index/restore/revert, remote/upstream setup, cross-worktree bases, conflict versions, and mocked PR checks/edit/merge. Only scenario BranchMe tools were active; no Bash or live HTTP was available.");
} finally { for (const fn of cleanup.reverse()) await fn(); }
