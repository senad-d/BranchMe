import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { gitSubcommand, resolveGitExecutable, TOKEN_CREDENTIAL_HELPER, withGitTransport } from "../src/git-transport.ts";


function isolatedEnv(extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["GH_TOKEN", "GITHUB_TOKEN"].includes(key)));
  return { ...base, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

test("gitSubcommand skips leading -c and -C options", () => {
  assert.equal(gitSubcommand(["-c", "a.b=c", "-C", "/repo", "fetch", "origin"]), "fetch");
  assert.equal(gitSubcommand(["status"]), "status");
  assert.equal(gitSubcommand([]), undefined);
});

test("non-network git commands go to Pi's exec unchanged", async () => {
  const calls = [];
  const pi = { async exec(command, args) { calls.push([command, ...args]); return { stdout: "", stderr: "", code: 0, killed: false }; } };
  await withGitTransport(pi, isolatedEnv()).exec("git", ["-C", "/repo", "status"], { cwd: "/repo" });
  assert.deepEqual(calls, [["git", "-C", "/repo", "status"]]);
});

test("a network command that needs credentials fails at once instead of waiting on a terminal prompt", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": "Basic realm=\"test\"" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "branchme-transport-")));
  t.after(() => { server.close(); return rm(cwd, { recursive: true, force: true }); });
  const pi = { exec() { throw new Error("network commands must not use Pi's exec"); } };
  const url = `http://127.0.0.1:${server.address().port}/owner/repo.git`;
  const result = await withGitTransport(pi, isolatedEnv()).exec("git", ["ls-remote", url], { cwd, timeout: 20_000 });
  assert.equal(result.killed, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /terminal prompts disabled/u);
});

const networkPi = { exec() { throw new Error("network commands must not use Pi's exec"); } };

async function temporaryCwd(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "branchme-transport-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("network Git uses an absolute system executable, not a repository-controlled PATH", async (t) => {
  const cwd = await temporaryCwd(t);
  await writeFile(join(cwd, "git"), "#!/bin/sh\nprintf 'untrusted executable'\n");
  await chmod(join(cwd, "git"), 0o755);
  assert.ok(isAbsolute(await resolveGitExecutable()));
  const result = await withGitTransport(networkPi, isolatedEnv({ PATH: cwd })).exec("git", ["ls-remote", "--get-url", "https://example.com/repo.git"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "https://example.com/repo.git");
});

test("network Git accepts process and .env tokens without putting them in command output", async (t) => {
  const cwd = await temporaryCwd(t);
  await writeFile(join(cwd, ".env"), "GH_TOKEN=ghp_transportFixture\n");
  for (const extra of [{}, { GITHUB_TOKEN: "ghp_transportProcess" }, { GH_TOKEN: "ghp_transportFallback" }]) {
    const result = await withGitTransport(networkPi, isolatedEnv(extra)).exec("git", ["ls-remote", "--get-url", "https://github.com/owner/repo.git"], { cwd });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "https://github.com/owner/repo.git");
    assert.doesNotMatch(result.stdout + result.stderr, /ghp_transport/u);
  }
});

test("a pre-aborted network call does not spawn Git", async (t) => {
  const cwd = await temporaryCwd(t);
  const controller = new AbortController();
  controller.abort();
  const result = await withGitTransport(networkPi, isolatedEnv()).exec("git", ["ls-remote", "--get-url", "https://example.com/repo.git"], { cwd, signal: controller.signal });
  assert.deepEqual(result, { stdout: "", stderr: "", code: 1, killed: true });
});

test("network Git preserves timeout and caller cancellation", { timeout: 15_000 }, async (t) => {
  const cwd = await temporaryCwd(t);
  const server = createServer((_request, response) => {
    setTimeout(() => { response.writeHead(500); response.end(); }, 300);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/owner/repo.git`;
  const transport = withGitTransport(networkPi, isolatedEnv());
  const timedOut = await transport.exec("git", ["ls-remote", url], { cwd, timeout: 50 });
  assert.equal(timedOut.killed, true);
  const controller = new AbortController();
  const pending = transport.exec("git", ["ls-remote", url], { cwd, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    assert.equal((await pending).killed, true);
  } finally {
    clearTimeout(timer);
  }
});

function credentialFill(host, env) {
  return new Promise((resolve, reject) => {
    const args = ["-c", `credential.https://github.com.helper=${TOKEN_CREDENTIAL_HELPER}`, "credential", "fill"];
    const child = execFile("git", args, { env, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });
}

test("the token credential helper answers github.com from the child environment only", async () => {
  const env = isolatedEnv({ GIT_TERMINAL_PROMPT: "0", BRANCHME_GIT_TOKEN: "ghp_transportTest" });
  const stdout = await credentialFill("github.com", env);
  assert.match(stdout, /^username=x-access-token$/mu);
  assert.match(stdout, /^password=ghp_transportTest$/mu);
  await assert.rejects(credentialFill("example.com", env));
});
