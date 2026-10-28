import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { CONVENTIONAL_COMMIT_TYPES } from "../src/constants.ts";
import {
  assertNoUnsafeCommitFiles,
  CommitError,
  createCommit,
  extractCommitMessage,
  findUnsafeCommitFiles,
  validateCommitMessage,
} from "../src/git-commit.ts";

const execFileAsync = promisify(execFile);

function createExecutor(calls = []) {
  return {
    async exec(command, args, options = {}) {
      calls.push({ command, args });
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

async function withTempRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "commit-commit-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "commit@example.invalid"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Commit Test"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "# Fixture\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "chore: initial fixture"], { cwd: dir });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}


test("extractCommitMessage strips simple model wrappers", () => {
  assert.equal(extractCommitMessage("Commit message: feat: add commit helper"), "feat: add commit helper");
  assert.equal(extractCommitMessage("Final answer: fix: handle errors"), "fix: handle errors");
  assert.equal(extractCommitMessage("```\nfix: handle errors\n```"), "fix: handle errors");
  assert.equal(extractCommitMessage("```\r\nfix: handle CRLF fences\r\n```"), "fix: handle CRLF fences");
  assert.equal(extractCommitMessage('"docs: update README"'), "docs: update README");
});

test("extractCommitMessage extracts first valid Conventional Commit line", () => {
  assert.equal(
    extractCommitMessage("Here is the commit message:\n\n- feat(cli): add commit drafting\n\nNo extra explanation needed."),
    "feat(cli): add commit drafting",
  );
  assert.equal(extractCommitMessage("I would use:\nfix: handle empty model drafts"), "fix: handle empty model drafts");
});

test("extractCommitMessage does not strip mismatched quotes", () => {
  assert.equal(extractCommitMessage('"docs: update README\''), '"docs: update README\'');
});

test("validateCommitMessage rejects empty messages", () => {
  const result = validateCommitMessage("   ");

  assert.equal(result.ok, false);
  assert.match(result.error, /empty/);
});

test("validateCommitMessage accepts valid subject-only Conventional Commits", () => {
  const result = validateCommitMessage("feat(cli): add commit drafting");

  assert.equal(result.ok, true);
  assert.equal(result.subject, "feat(cli): add commit drafting");
  assert.equal(result.body, "");
});

test("validateCommitMessage accepts every configured Conventional Commit type", () => {
  for (const type of CONVENTIONAL_COMMIT_TYPES) {
    const result = validateCommitMessage(`${type}: verify configured type`);

    assert.equal(result.ok, true, `${type} should validate`);
    assert.equal(result.subject, `${type}: verify configured type`);
  }
});

test("validateCommitMessage normalizes verbose model output to the subject only", () => {
  const result = validateCommitMessage("fix: handle git failures\n\nReport hook errors clearly.");

  assert.equal(result.ok, true);
  assert.equal(result.subject, "fix: handle git failures");
  assert.equal(result.body, "");
  assert.equal(result.message, "fix: handle git failures");
});

test("validateCommitMessage rejects malformed subjects", () => {
  const result = validateCommitMessage("update the docs");

  assert.equal(result.ok, false);
  assert.match(result.error, /Lightweight Conventional Commit/);
});

test("validateCommitMessage rejects summaries ending with a period", () => {
  const result = validateCommitMessage("fix(api): handle expired tokens.");

  assert.equal(result.ok, false);
  assert.match(result.error, /must not end with a period/);
});

test("validateCommitMessage keeps breaking-change markers only in the subject", () => {
  const result = validateCommitMessage("feat(api)!: change token contract\n\nBREAKING CHANGE: refresh tokens are now opaque.");

  assert.equal(result.ok, true);
  assert.equal(result.subject, "feat(api)!: change token contract");
  assert.equal(result.body, "");
  assert.equal(result.message, "feat(api)!: change token contract");
});

test("findUnsafeCommitFiles blocks known secret paths, unreadable files, and high-confidence secret content", () => {
  const unsafe = findUnsafeCommitFiles([
    { path: ".env", status: "??", scope: "unstaged", sensitive: true, generated: false, binary: false },
    { path: ".env.example", status: "??", scope: "unstaged", sensitive: false, generated: false, binary: false },
    { path: ".aws/credentials", status: "D", scope: "unstaged", sensitive: true, generated: false, binary: false },
    { path: "src/index.ts", status: "M", scope: "unstaged", sensitive: false, generated: false, binary: false },
    { path: "src/example.ts", status: "M", scope: "unstaged", sensitive: true, generated: false, binary: false },
    {
      path: "src/leaked-key.ts",
      status: "M",
      scope: "unstaged",
      sensitive: true,
      generated: false,
      binary: false,
      secretContent: true,
    },
    {
      path: "unreadable.txt",
      status: "M",
      scope: "unstaged",
      sensitive: false,
      generated: false,
      binary: false,
      unreadable: true,
    },
  ]);

  assert.deepEqual(unsafe.map((file) => file.path), [".env", "src/leaked-key.ts", "unreadable.txt"]);
  assert.throws(
    () => assertNoUnsafeCommitFiles(unsafe),
    (error) => error instanceof CommitError && error.code === "unsafe-sensitive-files",
  );
});

test("assertNoUnsafeCommitFiles escapes control characters in reported paths", () => {
  assert.throws(
    () =>
      assertNoUnsafeCommitFiles([
        {
          path: "secret\nfile\tname",
          status: "M",
          scope: "unstaged",
          sensitive: true,
          generated: false,
          binary: false,
          secretContent: true,
        },
      ]),
    (error) => error instanceof CommitError && /secret\\nfile\\tname/.test(error.message),
  );
});

test("createCommit stages gathered changes and creates a commit", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const result = await createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module" });
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: dir });

    assert.match(result.commitHash, /^[0-9a-f]{7,}$/);
    assert.equal(result.subject, "feat: add feature module");
    assert.equal(stdout.trim(), "feat: add feature module");
    const calledArgs = calls.map((call) => call.args.join(" "));
    assert.ok(calledArgs.some((args) => args.startsWith("add -A -- ") && args.includes("feature.ts")));
    assert.ok(calledArgs.includes("status --porcelain=v1"));
    assert.ok(calledArgs.includes("commit -m feat: add feature module"));
  });
});

test("createCommit allows .env.* files without high-confidence secrets", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, ".env.example"), "GITHUB_TOKEN=\n# GH_TOKEN=\n", "utf8");

    await createCommit(createExecutor(), { cwd: dir, message: "docs: add env example" });
    const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });

    assert.match(stdout, /^\.env\.example$/m);
  });
});

test("createCommit rejects high-confidence tokens in .env.* files before staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, ".env.local"), `OPENAI_API_KEY=${syntheticKey}\n`, "utf8");

    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "chore: add local env" }),
      (error) => error instanceof CommitError && error.code === "unsafe-sensitive-files",
    );

    assert.equal(calls.some((call) => call.args[0] === "add"), false);
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(stdout, /\?\? \.env\.local/);
  });
});

test("createCommit stages gathered paths without adding late unscanned files", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const baseExecutor = createExecutor(calls);
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const executor = {
      async exec(command, args, options = {}) {
        if (args[0] === "add") {
          await writeFile(join(dir, ".env"), "TOKEN=late-secret\n", "utf8");
        }
        return baseExecutor.exec(command, args, options);
      },
    };

    await createCommit(executor, { cwd: dir, message: "feat: add feature module" });
    const { stdout: committedFiles } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1", "-uall"], { cwd: dir });

    assert.match(committedFiles, /feature\.ts/);
    assert.doesNotMatch(committedFiles, /\.env/);
    assert.match(status, /\?\? \.env/);
    assert.ok(calls.some((call) => call.args[0] === "add" && call.args.includes("feature.ts") && !call.args.includes(".env")));
  });
});

test("createCommit with paths commits only the listed paths", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(join(dir, "notes.md"), "# Notes\n", "utf8");

    await createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module", paths: ["feature.ts"] });
    const { stdout: committedFiles } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(committedFiles, /feature\.ts/);
    assert.doesNotMatch(committedFiles, /notes\.md/);
    assert.match(status, /\?\? notes\.md/);
    assert.ok(calls.some((call) => call.args[0] === "add" && call.args.includes("feature.ts") && !call.args.includes("notes.md")));
  });
});

test("createCommit with paths stages listed deletions and renames like unscoped commits", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "old-name.txt"), "rename fixture\n", "utf8");
    await writeFile(join(dir, "obsolete.txt"), "obsolete fixture\n", "utf8");
    await execFileAsync("git", ["add", "old-name.txt", "obsolete.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "chore: add scoped fixtures"], { cwd: dir });
    await execFileAsync("git", ["mv", "old-name.txt", "new-name.txt"], { cwd: dir });
    await rm(join(dir, "obsolete.txt"));
    await writeFile(join(dir, "notes.md"), "# Notes\n", "utf8");

    await createCommit(createExecutor(), {
      cwd: dir,
      message: "chore: apply scoped rename and deletion",
      paths: ["new-name.txt", "obsolete.txt"],
    });
    const { stdout: committedFiles } = await execFileAsync("git", ["show", "--name-status", "--format=", "HEAD"], { cwd: dir });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(committedFiles, /R\d+\s+old-name\.txt\s+new-name\.txt/);
    assert.match(committedFiles, /D\s+obsolete\.txt/);
    assert.doesNotMatch(committedFiles, /notes\.md/);
    assert.match(status, /\?\? notes\.md/);
  });
});

test("createCommit with paths refuses empty and unmatched path lists before staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module", paths: [] }),
      (error) => error instanceof CommitError && error.code === "invalid-paths",
    );
    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module", paths: ["feature.ts", "missing.ts"] }),
      (error) => error instanceof CommitError && error.code === "paths-not-changed" && /missing\.ts/.test(error.message),
    );

    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(status, /\?\? feature\.ts/);
  });
});

test("createCommit with paths refuses staged changes outside the listed paths", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(join(dir, "staged.ts"), "export const staged = true;\n", "utf8");
    await execFileAsync("git", ["add", "staged.ts"], { cwd: dir });

    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module", paths: ["feature.ts"] }),
      (error) => error instanceof CommitError && error.code === "unlisted-staged-changes" && /staged\.ts/.test(error.message),
    );

    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(status, /A  staged\.ts/);
    assert.match(status, /\?\? feature\.ts/);
  });
});

test("createCommit stages rename sources and destinations", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "old-name.txt"), "rename fixture\n", "utf8");
    await execFileAsync("git", ["add", "old-name.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "chore: add rename fixture"], { cwd: dir });
    await execFileAsync("git", ["mv", "old-name.txt", "new-name.txt"], { cwd: dir });

    await createCommit(createExecutor(), { cwd: dir, message: "chore: rename fixture file" });
    const { stdout } = await execFileAsync("git", ["show", "--name-status", "--format=", "HEAD"], { cwd: dir });

    assert.match(stdout, /R\d+\s+old-name\.txt\s+new-name\.txt/);
  });
});

test("createCommit stages tracked file deletions", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "obsolete.txt"), "obsolete fixture\n", "utf8");
    await execFileAsync("git", ["add", "obsolete.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "chore: add obsolete fixture"], { cwd: dir });
    await rm(join(dir, "obsolete.txt"));

    await createCommit(createExecutor(), { cwd: dir, message: "chore: remove obsolete fixture" });
    const { stdout } = await execFileAsync("git", ["show", "--name-status", "--format=", "HEAD"], { cwd: dir });

    assert.match(stdout, /D\s+obsolete\.txt/);
  });
});

test("createCommit commits only the Conventional Commit subject line", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const result = await createCommit(createExecutor(), {
      cwd: dir,
      message: "feat: add feature module\n\nThis body should not be committed.",
    });
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%B"], { cwd: dir });

    assert.equal(result.subject, "feat: add feature module");
    assert.equal(result.body, "");
    assert.equal(stdout.trim(), "feat: add feature module");
  });
});

test("createCommit reports no-change failures clearly", async () => {
  await withTempRepo(async (dir) => {
    await assert.rejects(
      () => createCommit(createExecutor(), { cwd: dir, message: "chore: try empty commit" }),
      (error) => error instanceof CommitError && error.code === "no-changes",
    );
  });
});

test("createCommit rechecks unsafe file content before staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    const { stdout: expectedStatus } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch", "-uall"], {
      cwd: dir,
    });
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, "feature.ts"), `export const key = "${syntheticKey}";\n`, "utf8");

    await assert.rejects(
      () =>
        createCommit(createExecutor(calls), {
          cwd: dir,
          message: "feat: add feature module",
          expectedStatusPorcelain: expectedStatus.trim(),
        }),
      (error) => error instanceof CommitError && error.code === "unsafe-sensitive-files",
    );

    assert.equal(calls.some((call) => call.args[0] === "add"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(status, /\?\? feature\.ts/);
  });
});

test("createCommit rejects oversized high-confidence secret content before staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, "large-leaked-key.ts"), `${"a".repeat(140_000)}\n${syntheticKey}\n`, "utf8");

    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module" }),
      (error) => error instanceof CommitError && error.code === "unsafe-sensitive-files",
    );

    assert.equal(calls.some((call) => call.args[0] === "add"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(status, /\?\? large-leaked-key\.ts/);
  });
});

test("createCommit rejects generated high-confidence secret content before staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "bundle.js"), `export const key = "${syntheticKey}";\n`, "utf8");

    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module" }),
      (error) => error instanceof CommitError && error.code === "unsafe-sensitive-files",
    );

    assert.equal(calls.some((call) => call.args[0] === "add"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1", "-uall"], { cwd: dir });
    assert.match(status, /\?\? dist\/bundle\.js/);
  });
});

test("createCommit rejects renamed high-confidence secret content before staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const syntheticKey = `sk-${"AbCdEfGhIjKlMnOpQrStUvWxYz012345"}`;
    await writeFile(join(dir, ".env"), `TOKEN=${syntheticKey}\n`, "utf8");
    await execFileAsync("git", ["add", ".env"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "chore: add env fixture"], { cwd: dir });
    await execFileAsync("git", ["mv", ".env", "app-config.txt"], { cwd: dir });

    await assert.rejects(
      () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module" }),
      (error) => error instanceof CommitError && error.code === "unsafe-sensitive-files",
    );

    assert.equal(calls.some((call) => call.args[0] === "add"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(status, /R  \.env -> app-config\.txt/);
  });
});

test("createCommit rejects unreadable changed files before staging", { skip: process.platform === "win32" }, async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const unreadablePath = join(dir, "unreadable.txt");
    await writeFile(unreadablePath, "content that cannot be scanned\n", "utf8");
    await chmod(unreadablePath, 0o000);

    try {
      await assert.rejects(
        () => createCommit(createExecutor(calls), { cwd: dir, message: "feat: add unreadable fixture" }),
        (error) =>
          error instanceof CommitError &&
          error.code === "unsafe-sensitive-files" &&
          /unreadable changed files/.test(error.message),
      );

      assert.equal(calls.some((call) => call.args[0] === "add"), false);
      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
      assert.match(status, /\?\? unreadable\.txt/);
    } finally {
      await chmod(unreadablePath, 0o600).catch(() => {});
    }
  });
});

test("createCommit aborts before staging when git status changed after context gathering", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const { stdout: expectedStatus } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch", "-uall"], {
      cwd: dir,
    });
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    await assert.rejects(
      () =>
        createCommit(createExecutor(calls), {
          cwd: dir,
          message: "feat: add feature module",
          expectedStatusPorcelain: expectedStatus.trim(),
        }),
      (error) => error instanceof CommitError && error.code === "working-tree-changed",
    );

    assert.equal(calls.some((call) => call.args[0] === "add"), false);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.match(status, /\?\? feature\.ts/);
  });
});

test("createCommit reports git hook failures clearly", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook failed >&2\nexit 1\n", "utf8");
    await chmod(join(dir, ".git", "hooks", "pre-commit"), 0o755);
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    await assert.rejects(
      () => createCommit(createExecutor(), { cwd: dir, message: "feat: add feature module" }),
      (error) => error instanceof CommitError && error.code === "git-commit-failed" && /hook failed/.test(error.stderr),
    );
  });
});

test("source does not contain git push", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/git-commit.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /git push|\["push"\]/);
});

test("createCommit waits for another process's index.lock and fails with the lock named once the wait ends", { timeout: 30_000 }, async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const lockPath = join(dir, ".git", "index.lock");
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(lockPath, "", "utf8");
    const released = new Promise((resolve) => setTimeout(resolve, 700)).then(() => rm(lockPath));

    await createCommit(createExecutor(calls), { cwd: dir, message: "feat: add feature module" });
    await released;

    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: dir });
    assert.equal(stdout.trim(), "feat: add feature module");
    assert.ok(calls.filter((call) => call.args[0] === "add").length > 1, "the stage must have retried");

    await writeFile(join(dir, "other.ts"), "export const other = true;\n", "utf8");
    await writeFile(lockPath, "", "utf8");
    await assert.rejects(
      () => createCommit(createExecutor(), { cwd: dir, message: "feat: add other module" }),
      /index\.lock': File exists[\s\S]*The lock was still held after waiting 10 s\./u,
    );
    await access(lockPath);
  });
});
