import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const testEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_REPOSITORY"].includes(key))),
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Workflow Test", GIT_COMMITTER_NAME: "Workflow Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid",
};
export async function git(cwd, args, options = {}) {
  try {
    const { input, ...execOptions } = options;
    const pending = exec("git", args, { cwd, env: testEnv, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...execOptions });
    if (input !== undefined) pending.child.stdin.end(input);
    return { ...await pending, code: 0, killed: false };
  }
  catch (error) {
    if (error.name === "AbortError") throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, code: error.code ?? 1, killed: Boolean(error.killed) };
  }
}
export async function checked(cwd, args) { const result = await git(cwd, args); assert.equal(result.code, 0, result.stderr); return result.stdout.trimEnd(); }
export async function fixture(t, unborn = false) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "branchme-workflows-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  await mkdir(root);
  await checked(root, ["init", "-b", "main"]);
  await checked(root, ["config", "commit.gpgsign", "false"]);
  if (!unborn) { await writeFile(join(root, "file.txt"), "initial\n"); await checked(root, ["add", "."]); await checked(root, ["commit", "-m", "initial"]); }
  const calls = [];
  const pi = { async exec(command, args, options) { assert.equal(command, "git"); calls.push({ args, cwd: options.cwd }); return git(options.cwd, args, { signal: options.signal, timeout: options.timeout }); } };
  return { temp, root, pi, calls };
}
export async function state(root) {
  return { head: await checked(root, ["rev-parse", "HEAD"]), index: await readFile(join(root, ".git", "index")), config: await readFile(join(root, ".git", "config")), file: await readFile(join(root, "file.txt")), refs: await checked(root, ["show-ref"]) };
}
