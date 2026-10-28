import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  gatherGitContext,
  gatherProjectContext,
  isKnownSecretPath,
  looksHighConfidenceSecretContent,
  parseNameStatusZ,
  parseStatusPorcelainZ,
} from "../src/git-commit-context.ts";

const execFileAsync = promisify(execFile);
const BEARER_TOKEN_FIXTURE = ["abc.DEF_123~+/=", "ghiJKLmnop"].join("");
const PRIVATE_KEY_HEADER_FIXTURE = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "commit-context-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createExecutor(calls = []) {
  return {
    async exec(command, args, options = {}) {
      calls.push({ command, args, options });
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
        });
        return { stdout, stderr, code: 0, killed: false };
      } catch (error) {
        return {
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
          code: typeof error.code === "number" ? error.code : 1,
          killed: Boolean(error.killed),
        };
      }
    },
  };
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(dir) {
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "commit@example.invalid"]);
  await git(dir, ["config", "user.name", "Commit Test"]);
  await writeFile(join(dir, "README.md"), "# Fixture\n", "utf8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "chore: initial fixture"]);
}

test("gatherGitContext resolves the repository root with BranchMe Git helpers", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, "nested"));
    const calls = [];
    const context = await gatherGitContext(createExecutor(calls), { cwd: join(dir, "nested") });

    assert.equal(context.repositoryRoot, await realpath(dir));
    assert.deepEqual(calls[0].args, ["rev-parse", "--show-toplevel"]);
    assert.equal(calls[0].options.timeout, 30_000);
  });
});

test("gatherGitContext returns a clear non-git error outside repositories", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => gatherGitContext(createExecutor(), { cwd: dir }), /Not a git repository/);
  });
});

test("gatherGitContext labels a detached HEAD with its short commit", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await git(dir, ["checkout", "--detach"]);
    const context = await gatherGitContext(createExecutor(), { cwd: dir });

    assert.equal(context.isDetachedHead, true);
    assert.match(context.branch, /^HEAD:[0-9a-f]{7,}$/);
  });
});

test("isKnownSecretPath allows dotenv variant files by path", () => {
  assert.equal(isKnownSecretPath(".env"), true);
  assert.equal(isKnownSecretPath(".envrc"), true);
  assert.equal(isKnownSecretPath(".env.example"), false);
  assert.equal(isKnownSecretPath("config/.env.local"), false);
  assert.equal(isKnownSecretPath("config/.env.production"), false);
});

test("parseNameStatusZ handles renamed paths with spaces", () => {
  const files = parseNameStatusZ("R100\0.env\0new name.txt\0", "staged");

  assert.equal(files.length, 1);
  assert.equal(files[0].path, "new name.txt");
  assert.equal(files[0].status, "R100");
  assert.equal(files[0].scope, "staged");
  assert.deepEqual(files[0].relatedPaths, [".env"]);
  assert.equal(files[0].sensitive, true);
});

test("parseStatusPorcelainZ handles untracked paths with spaces", () => {
  const files = parseStatusPorcelainZ("?? space file.txt\0");

  assert.equal(files.length, 1);
  assert.equal(files[0].path, "space file.txt");
  assert.equal(files[0].status, "??");
  assert.equal(files[0].scope, "unstaged");
});

test("parseStatusPorcelainZ handles staged-only records", () => {
  const files = parseStatusPorcelainZ("A  staged.txt\0");

  assert.deepEqual(files.map((file) => `${file.scope}:${file.status}:${file.path}`), ["staged:A:staged.txt"]);
});

test("parseStatusPorcelainZ handles unstaged-only records", () => {
  const files = parseStatusPorcelainZ(" M unstaged.txt\0");

  assert.deepEqual(files.map((file) => `${file.scope}:${file.status}:${file.path}`), ["unstaged:M:unstaged.txt"]);
});

test("parseStatusPorcelainZ handles staged plus unstaged records", () => {
  const files = parseStatusPorcelainZ("MM changed.txt\0");

  assert.deepEqual(files.map((file) => `${file.scope}:${file.status}:${file.path}`), ["staged:M:changed.txt", "unstaged:M:changed.txt"]);
});

test("parseStatusPorcelainZ handles rename records", () => {
  const files = parseStatusPorcelainZ("R  new-name.txt\0old-name.txt\0");

  assert.deepEqual(files.map((file) => `${file.scope}:${file.status}:${file.path}:${file.relatedPaths?.join(",")}`), [
    "staged:R:new-name.txt:old-name.txt",
  ]);
});

test("parseStatusPorcelainZ handles copy records", () => {
  const files = parseStatusPorcelainZ("C  copy-name.txt\0source-name.txt\0");

  assert.deepEqual(files.map((file) => `${file.scope}:${file.status}:${file.path}:${file.relatedPaths?.join(",")}`), [
    "staged:C:copy-name.txt:source-name.txt",
  ]);
});

test("looksHighConfidenceSecretContent covers token families and ignores placeholders", () => {
  const samples = [
    `bearer: Authorization: Bearer ${BEARER_TOKEN_FIXTURE}`,
    `aws: AKIA${"A".repeat(16)}`,
    `github: ghp_${"A".repeat(36)}`,
    `github fine-grained: github_pat_${"A".repeat(20)}`,
    `gitlab: glpat-${"A".repeat(20)}`,
    `openai: sk-${"A".repeat(24)}`,
    `anthropic: sk-ant-${"A".repeat(24)}`,
    `slack: xoxb-${"1".repeat(20)}`,
    `jwt: eyJ${"A".repeat(10)}.${"B".repeat(10)}.${"C".repeat(10)}`,
    PRIVATE_KEY_HEADER_FIXTURE,
  ];

  assert.ok(samples.every((sample) => looksHighConfidenceSecretContent(sample)));
  assert.equal(looksHighConfidenceSecretContent(`github: ghp_${"example".padEnd(36, "x")}`), false);
});

test("context scanner tests avoid literal high-confidence secret fixtures", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");

  assert.equal(looksHighConfidenceSecretContent(source), false);
});

test("gatherGitContext captures staged-only changes", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "src.ts"), "export const value = 1;\n", "utf8");
    await git(dir, ["add", "src.ts"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });

    assert.equal(context.hasChanges, true);
    assert.ok(context.statusPorcelain.includes("A  src.ts"));
    assert.ok(context.changedFiles.some((file) => file.scope === "staged" && file.path === "src.ts"));
    assert.match(context.staged.stat, /src\.ts/);
    assert.match(context.staged.excerpt, /export const value/);
  });
});

test("gatherGitContext disables external diff and textconv commands", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "src.ts"), "export const value = 1;\n", "utf8");
    await git(dir, ["add", "src.ts"]);

    const calls = [];
    await gatherGitContext(createExecutor(calls), { cwd: dir });
    const diffCalls = calls.filter((call) => call.args[0] === "diff");

    assert.ok(diffCalls.length > 0);
    assert.ok(diffCalls.every((call) => call.args.includes("--no-ext-diff")));
    assert.ok(diffCalls.every((call) => call.args.includes("--no-textconv")));
  });
});

test("gatherGitContext captures unstaged-only changes", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await appendFile(join(dir, "README.md"), "\nMore details.\n", "utf8");

    const context = await gatherGitContext(createExecutor(), { cwd: dir });

    assert.equal(context.hasChanges, true);
    assert.ok(context.changedFiles.some((file) => file.scope === "unstaged" && file.path === "README.md"));
    assert.match(context.unstaged.stat, /README\.md/);
    assert.match(context.unstaged.excerpt, /More details/);
  });
});

test("gatherGitContext captures mixed staged and unstaged changes", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "feature.ts"), "export const feature = true;\n", "utf8");
    await git(dir, ["add", "src/feature.ts"]);
    await appendFile(join(dir, "README.md"), "\nUsage notes.\n", "utf8");

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const keys = context.changedFiles.map((file) => `${file.scope}:${file.path}`).sort();

    assert.ok(keys.includes("staged:src/feature.ts"));
    assert.ok(keys.includes("unstaged:README.md"));
    assert.match(context.staged.stat, /feature\.ts/);
    assert.match(context.unstaged.stat, /README\.md/);
  });
});

test("gatherGitContext captures untracked paths with spaces", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "space file.txt"), "space path content\n", "utf8");

    const context = await gatherGitContext(createExecutor(), { cwd: dir });

    assert.ok(context.changedFiles.some((file) => file.scope === "unstaged" && file.path === "space file.txt"));
    assert.ok(context.project.changedFileSnippets.some((entry) => entry.path === "space file.txt"));
  });
});

test("gatherGitContext expands untracked directories before sensitivity filtering", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, "config"));
    await writeFile(join(dir, "config", ".env"), "TOKEN=nested-secret\n", "utf8");
    await writeFile(join(dir, "config", "public.txt"), "public context\n", "utf8");

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.statusPorcelain.includes("config/.env"));
    assert.ok(context.changedFiles.some((file) => file.path === "config/.env" && file.sensitive));
    assert.ok(context.changedFiles.some((file) => file.path === "config/public.txt" && !file.sensitive));
    assert.ok(context.project.skipped.some((entry) => entry.path === "config/.env" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, /nested-secret/);
  });
});

test("gatherGitContext bounds large diff excerpts", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "big.txt"), `${Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")}\n`, "utf8");
    await git(dir, ["add", "big.txt"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir, diffMaxLines: 5, diffMaxBytes: 1_000 });

    assert.equal(context.staged.truncation.truncated, true);
    assert.match(context.staged.excerpt, /\[Truncated staged diff:/);
  });
});

test("gatherGitContext includes project metadata deterministically", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2), "utf8");
    await writeFile(join(dir, "feature.js"), "export const feature = true;\n", "utf8");
    await git(dir, ["add", "feature.js"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const metadataPaths = context.project.metadata.map((entry) => entry.path);

    assert.deepEqual(metadataPaths.slice(0, 2), ["package.json", "README.md"]);
    assert.match(context.project.metadata[0].content, /"name": "fixture"/);
  });
});

test("gatherProjectContext preserves candidate order, limits, skips, and duplicate safety flags", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), '{"name":"fixture"}\n');
    await writeFile(join(dir, "README.md"), "# Fixture\n");
    await writeFile(join(dir, "a.ts"), "export const a = true;\n");
    await writeFile(join(dir, "b.ts"), "export const b = true;\n");
    const files = parseStatusPorcelainZ("?? b.ts\0?? a.ts\0?? a.ts\0?? c.ts\0?? d.ts\0?? e.ts\0");
    files[2].unreadable = true;
    files[3].generated = true;
    files[4].sensitive = true;
    const options = { projectContextFileLimit: 4 };

    const project = await gatherProjectContext(dir, files, options);
    assert.deepEqual(project.metadata.map((entry) => entry.path), ["package.json", "README.md"]);
    assert.deepEqual(project.changedFileSnippets.map((entry) => entry.path), ["b.ts"]);
    assert.deepEqual(project.skipped, [
      { path: "a.ts", reason: "unreadable" },
      { path: "c.ts", reason: "generated" },
      { path: "d.ts", reason: "sensitive" },
    ]);
    assert.deepEqual(await gatherProjectContext(dir, files, options), project);
    const empty = await gatherProjectContext(dir, files, { projectContextFileLimit: 0 });
    assert.deepEqual(empty, { root: dir, metadata: [], changedFileSnippets: [], skipped: [] });
  });
});

test("gatherGitContext scans multiple batches and flags every scope without exposing secrets", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    const paths = Array.from({ length: 18 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`);
    await Promise.all(paths.map((path, index) => writeFile(join(dir, path), [7, 8, 17].includes(index)
      ? `export const key = "${syntheticKey}";\n`
      : "export const safe = true;\n")));
    await git(dir, ["add", "--", ...paths]);
    await appendFile(join(dir, paths[8]), "export const extra = true;\n");

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const flagged = context.changedFiles.filter((file) => file.secretContent);
    assert.deepEqual(flagged.map((file) => `${file.scope}:${file.path}`).sort(), [
      "staged:file-07.ts", "staged:file-08.ts", "staged:file-17.ts", "unstaged:file-08.ts",
    ]);
    assert.ok(flagged.every((file) => file.sensitive));
    assert.doesNotMatch(JSON.stringify(context), new RegExp(syntheticKey));
    assert.deepEqual(context, await gatherGitContext(createExecutor(), { cwd: dir }));
  });
});

test("gatherGitContext skips generated changed files for snippets", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "bundle.js"), "generated output\n", "utf8");
    await git(dir, ["add", "dist/bundle.js"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });

    assert.ok(context.changedFiles.some((file) => file.path === "dist/bundle.js" && file.generated));
    assert.ok(context.project.skipped.some((entry) => entry.path === "dist/bundle.js" && entry.reason === "generated"));
    assert.doesNotMatch(context.staged.excerpt, /generated output/);
  });
});

test("gatherGitContext scans generated changed files for high-confidence secrets", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, "dist"));
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, "dist", "bundle.js"), `export const key = "${syntheticKey}";\n`, "utf8");
    await git(dir, ["add", "dist/bundle.js"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === "dist/bundle.js");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.generated, true);
    assert.equal(file?.sensitive, true);
    assert.equal(file?.secretContent, true);
    assert.ok(context.project.skipped.some((entry) => entry.path === "dist/bundle.js" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, new RegExp(syntheticKey));
  });
});

test("gatherGitContext scans binary-looking changed files for high-confidence secrets", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, "snapshot.png"), `not really png ${syntheticKey}\n`, "utf8");
    await git(dir, ["add", "snapshot.png"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === "snapshot.png");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.binary, true);
    assert.equal(file?.sensitive, true);
    assert.equal(file?.secretContent, true);
    assert.ok(context.project.skipped.some((entry) => entry.path === "snapshot.png" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, new RegExp(syntheticKey));
  });
});

test("gatherGitContext propagates abort signals before content sensitivity scans", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await git(dir, ["add", "feature.ts"]);

    const controller = new AbortController();
    controller.abort(new Error("stop scanning"));

    await assert.rejects(() => gatherGitContext(createExecutor(), { cwd: dir, signal: controller.signal }), /stop scanning/);
  });
});

test("gatherGitContext filters sensitive changed file contents", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, ".env"), "TOKEN=super-secret\n", "utf8");
    await git(dir, ["add", ".env"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.changedFiles.some((file) => file.path === ".env" && file.sensitive));
    assert.ok(context.project.skipped.some((entry) => entry.path === ".env" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, /super-secret/);
  });
});

test("gatherGitContext treats .envrc files as sensitive", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, ".envrc"), "export TOKEN=envrc-secret\n", "utf8");
    await git(dir, ["add", ".envrc"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.changedFiles.some((file) => file.path === ".envrc" && file.sensitive));
    assert.ok(context.project.skipped.some((entry) => entry.path === ".envrc" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, /envrc-secret/);
  });
});

test("gatherGitContext allows .env.* files by path while redacting secret-like assignments", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, ".env.example"), "GITHUB_TOKEN=\nPASSWORD=not-real\nSAFE_FLAG=true\n", "utf8");
    await git(dir, ["add", ".env.example"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === ".env.example");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.sensitive, false);
    assert.ok(context.project.changedFileSnippets.some((entry) => entry.path === ".env.example"));
    assert.match(combinedContext, /SAFE_FLAG=true/);
    assert.match(combinedContext, /\[redacted sensitive line\]/);
    assert.doesNotMatch(combinedContext, /not-real/);
  });
});

test("gatherGitContext redacts broad token assignments in ordinary source without marking the file sensitive", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(
      join(dir, "fixture.ts"),
      "export const fixture = \"TOKEN=not-real\";\nexport const stillVisible = true;\n",
      "utf8",
    );
    await git(dir, ["add", "fixture.ts"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === "fixture.ts");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.sensitive, false);
    assert.match(combinedContext, /\[redacted sensitive line\]/);
    assert.match(combinedContext, /stillVisible/);
    assert.doesNotMatch(combinedContext, /not-real/);
  });
});

test("gatherGitContext marks high-confidence secret content without exposing it", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, "leaked-key.ts"), `export const key = "${syntheticKey}";\n`, "utf8");
    await git(dir, ["add", "leaked-key.ts"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === "leaked-key.ts");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.sensitive, true);
    assert.equal(file?.secretContent, true);
    assert.ok(context.project.skipped.some((entry) => entry.path === "leaked-key.ts" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, new RegExp(syntheticKey));
  });
});

test("gatherGitContext marks oversized high-confidence secret content without exposing it", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, "large-leaked-key.ts"), `${"a".repeat(140_000)}\n${syntheticKey}\n`, "utf8");
    await git(dir, ["add", "large-leaked-key.ts"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === "large-leaked-key.ts");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.sensitive, true);
    assert.equal(file?.secretContent, true);
    assert.ok(context.project.skipped.some((entry) => entry.path === "large-leaked-key.ts" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, new RegExp(syntheticKey));
  });
});

test("gatherGitContext treats token-bearing npm config as sensitive", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=npm-secret\n", "utf8");
    await git(dir, ["add", ".npmrc"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.changedFiles.some((file) => file.path === ".npmrc" && file.sensitive));
    assert.ok(context.project.skipped.some((entry) => entry.path === ".npmrc" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, /npm-secret/);
  });
});

test("gatherGitContext treats kubeconfig files as sensitive", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, ".kube"));
    await writeFile(join(dir, ".kube", "config"), "users:\n- token: kube-secret\n", "utf8");
    await git(dir, ["add", ".kube/config"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.changedFiles.some((file) => file.path === ".kube/config" && file.sensitive));
    assert.ok(context.project.skipped.some((entry) => entry.path === ".kube/config" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, /kube-secret/);
  });
});

test("gatherGitContext redacts renamed token-looking content through new paths", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, ".env"), "TOKEN=old-secret\n", "utf8");
    await git(dir, ["add", ".env"]);
    await git(dir, ["commit", "-m", "chore: add env fixture"]);
    await git(dir, ["mv", ".env", "app-config.txt"]);
    await writeFile(join(dir, "app-config.txt"), "TOKEN=renamed-secret\n", "utf8");
    await git(dir, ["add", "app-config.txt"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.changedFiles.some((file) => file.path === "app-config.txt"));
    assert.match(combinedContext, /\[redacted sensitive line\]/);
    assert.doesNotMatch(combinedContext, /renamed-secret/);
  });
});

test("gatherGitContext marks renamed high-confidence secret content through new paths", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, ".env"), `TOKEN=${syntheticKey}\n`, "utf8");
    await git(dir, ["add", ".env"]);
    await git(dir, ["commit", "-m", "chore: add env fixture"]);
    await git(dir, ["mv", ".env", "app-config.txt"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const file = context.changedFiles.find((entry) => entry.path === "app-config.txt");
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.equal(file?.sensitive, true);
    assert.equal(file?.secretContent, true);
    assert.ok(context.project.skipped.some((entry) => entry.path === "app-config.txt" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, new RegExp(syntheticKey));
  });
});

test("gatherGitContext reports unreadable changed files without failing context gathering", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const unreadablePath = join(dir, "unreadable.txt");
    await writeFile(unreadablePath, "ordinary content\n", "utf8");
    await chmod(unreadablePath, 0o000);

    try {
      const context = await gatherGitContext(createExecutor(), { cwd: dir });

      const unreadableFile = context.changedFiles.find((file) => file.path === "unreadable.txt");
      assert.equal(unreadableFile?.unreadable, true);
      assert.ok(context.project.skipped.some((entry) => entry.path === "unreadable.txt" && entry.reason === "unreadable"));
    } finally {
      await chmod(unreadablePath, 0o600).catch(() => {});
    }
  });
});

test("gatherGitContext skips ordinary symlink targets instead of reading their contents", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "target.txt"), "UNRELATED_TARGET_CONTENT_SHOULD_NOT_LEAK\n", "utf8");
    await git(dir, ["add", "target.txt"]);
    await git(dir, ["commit", "-m", "chore: add symlink target fixture"]);

    try {
      await symlink("target.txt", join(dir, "linked-file.txt"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && ["EINVAL", "EPERM"].includes(error.code)) {
        return;
      }
      throw error;
    }
    await git(dir, ["add", "linked-file.txt"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    assert.ok(context.changedFiles.some((file) => file.path === "linked-file.txt"));
    assert.ok(context.project.skipped.some((entry) => entry.path === "linked-file.txt" && entry.reason === "symlink"));
    assert.doesNotMatch(combinedContext, /UNRELATED_TARGET_CONTENT_SHOULD_NOT_LEAK/);
  });
});

test("gatherGitContext does not read symlinked changed files outside the repository", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const outsideDir = await mkdtemp(join(tmpdir(), "commit-outside-"));
    try {
      const outsideFile = join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "TOP_SECRET_VALUE\n", "utf8");
      try {
        await symlink(outsideFile, join(dir, "linked-file.txt"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EINVAL", "EPERM"].includes(error.code)) {
          return;
        }
        throw error;
      }
      await git(dir, ["add", "linked-file.txt"]);

      const context = await gatherGitContext(createExecutor(), { cwd: dir });
      const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

      assert.ok(context.changedFiles.some((file) => file.path === "linked-file.txt"));
      assert.ok(
        context.project.skipped.some((entry) => entry.path === "linked-file.txt" && entry.reason === "outside-repository"),
      );
      assert.doesNotMatch(combinedContext, /TOP_SECRET_VALUE/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("gatherGitContext does not read changed paths through symlinked directories outside the repository", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const outsideDir = await mkdtemp(join(tmpdir(), "commit-outside-"));
    try {
      await mkdir(join(dir, "linked-dir"));
      await writeFile(join(dir, "linked-dir", "secret.txt"), "safe tracked fixture\n", "utf8");
      await git(dir, ["add", "linked-dir/secret.txt"]);
      await git(dir, ["commit", "-m", "chore: add tracked fixture"]);
      await rm(join(dir, "linked-dir"), { recursive: true, force: true });
      await writeFile(join(outsideDir, "secret.txt"), "TOP_SECRET_VALUE\n", "utf8");

      try {
        await symlink(outsideDir, join(dir, "linked-dir"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EINVAL", "EPERM"].includes(error.code)) {
          return;
        }
        throw error;
      }

      const context = await gatherGitContext(createExecutor(), { cwd: dir });
      const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

      assert.ok(context.changedFiles.some((file) => file.path === "linked-dir"));
      assert.ok(context.project.skipped.some((entry) => entry.path === "linked-dir" && entry.reason === "outside-repository"));
      assert.doesNotMatch(combinedContext, /TOP_SECRET_VALUE/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("gatherGitContext does not read symlinked changed files that target sensitive repository files", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, ".env"), "DATABASE_URL=postgres://top-secret-db\n", "utf8");
    await git(dir, ["add", ".env"]);
    await git(dir, ["commit", "-m", "chore: add local secret fixture"]);

    try {
      await symlink(".env", join(dir, "linked-file.txt"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && ["EINVAL", "EPERM"].includes(error.code)) {
        return;
      }
      throw error;
    }
    await git(dir, ["add", "linked-file.txt"]);

    const context = await gatherGitContext(createExecutor(), { cwd: dir });
    const combinedContext = JSON.stringify(context.project) + context.staged.excerpt + context.unstaged.excerpt;

    const linkedFile = context.changedFiles.find((file) => file.path === "linked-file.txt");
    assert.equal(linkedFile?.sensitive, true);
    assert.equal(linkedFile?.secretContent, true);
    assert.ok(context.project.skipped.some((entry) => entry.path === "linked-file.txt" && entry.reason === "sensitive"));
    assert.doesNotMatch(combinedContext, /top-secret-db/);
  });
});
