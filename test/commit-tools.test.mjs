import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createCommitChangesTool } from "../src/tools/commit-tools.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

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

function routedCommitTool(executor) {
  const tools = [];
  registerBranchMeTools({ registerTool: (tool) => tools.push(tool), exec: executor.exec.bind(executor) });
  return tools.find((tool) => tool.name === "commit_changes");
}

async function withTempRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "commit-tool-"));
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

test("createCommitChangesTool defines the commit_changes tool", () => {
  const tool = createCommitChangesTool(createExecutor());

  assert.equal(tool.name, "commit_changes");
  assert.equal(tool.label, "Commit Changes");
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.description, /Conventional Commit/);
  assert.ok(tool.promptGuidelines.every((guideline) => guideline.includes("commit_changes")));
  assert.match(JSON.stringify(tool.parameters), /gather/);
  assert.match(JSON.stringify(tool.parameters), /commit/);
  assert.match(JSON.stringify(tool.parameters), /steeringPrompt/);
  assert.match(JSON.stringify(tool.parameters), /paths/);
});

test("commit_changes gathers compact context with structured details", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await execFileAsync("git", ["add", "feature.ts"], { cwd: dir });

    const tool = createCommitChangesTool(createExecutor());
    const result = await tool.execute("tool-call", { action: "gather" }, undefined, undefined, { cwd: dir });
    const text = result.content[0].text;

    assert.match(text, /commit_changes gathered local git context/);
    assert.match(text, /Return only one Lightweight Conventional Commit subject line/);
    assert.match(text, /feature\.ts/);
    assert.equal(result.details.action, "gather");
    assert.match(result.details.statusPorcelain, /feature\.ts/);
    assert.equal(result.details.hasChanges, true);
    assert.ok(result.details.changedFiles.some((file) => file.path === "feature.ts"));
    assert.ok(Array.isArray(result.details.truncation));
  });
});

test("commit_changes includes steering prompt in gathered context", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const tool = createCommitChangesTool(createExecutor());
    const result = await tool.execute(
      "tool-call",
      { action: "gather", steeringPrompt: "focus on tool steering support" },
      undefined,
      undefined,
      { cwd: dir },
    );

    assert.match(result.content[0].text, /User steering prompt:/);
    assert.match(result.content[0].text, /focus on tool steering support/);
    assert.equal(result.details.steeringPrompt, "focus on tool steering support");
  });
});

test("commit_changes sizes gather prompts for the active model", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const tool = createCommitChangesTool(createExecutor());
    const result = await tool.execute(
      "tool-call",
      { action: "gather" },
      undefined,
      undefined,
      { cwd: dir, model: { contextWindow: 6_000, maxTokens: 1_024 } },
    );

    assert.equal(result.details.prompt.budgetProfile, "compact");
  });
});

test("commit_changes defaults to gather when action is omitted", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const tool = createCommitChangesTool(createExecutor());
    const result = await tool.execute("tool-call", {}, undefined, undefined, { cwd: dir });

    assert.equal(result.details.action, "gather");
    assert.match(result.content[0].text, /feature\.ts/);
  });
});

test("commit_changes commit action cancels before mutation when confirmation is denied", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls));
    const result = await tool.execute(
      "tool-call",
      { action: "commit", message: "feat: add feature module", confirm: true },
      undefined,
      undefined,
      { cwd: dir, hasUI: true, ui: { confirm: async () => false } },
    );
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(result.content[0].text, /cancelled/);
    assert.equal(result.details.action, "commit");
    assert.match(stdout, /\?\? feature\.ts/);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes commit action creates a commit with an explicit message", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const tool = createCommitChangesTool(createExecutor());
    const result = await tool.execute(
      "tool-call",
      { action: "commit", message: "feat: add feature module", steeringPrompt: "ignored because message is final" },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: dir });

    assert.match(result.content[0].text, /Committed/);
    assert.equal(result.terminate, undefined);
    assert.equal(result.details.action, "commit");
    assert.equal(result.details.steeringPrompt, undefined);
    assert.equal(result.details.committed.subject, "feat: add feature module");
    assert.equal(stdout.trim(), "feat: add feature module");
  });
});

test("commit_changes commits repo-relative paths when Pi runs in a subdirectory", async () => {
  await withTempRepo(async (dir) => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(join(dir, "other.ts"), "export const other = true;\n", "utf8");
    const tool = createCommitChangesTool(createExecutor());

    const result = await tool.execute(
      "tool-call",
      { action: "commit", message: "feat: add feature module", paths: ["feature.ts"] },
      undefined,
      undefined,
      { cwd: join(dir, "sub"), hasUI: false },
    );
    const { stdout: files } = await execFileAsync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: dir });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(result.content[0].text, /Committed/);
    assert.equal(files.trim(), "feature.ts");
    assert.match(status, /\?\? other\.ts/);
  });
});

test("commit_changes commit action with paths commits only the listed paths", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(join(dir, "notes.md"), "# Notes\n", "utf8");

    const tool = createCommitChangesTool(createExecutor());
    const result = await tool.execute(
      "tool-call",
      { action: "commit", message: "feat: add feature module", paths: ["feature.ts"] },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );
    const { stdout: committedFiles } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(result.content[0].text, /Committed/);
    assert.match(committedFiles, /feature\.ts/);
    assert.doesNotMatch(committedFiles, /notes\.md/);
    assert.match(status, /\?\? notes\.md/);
  });
});

test("commit_changes message-less commit with paths commits only the listed paths despite steering text", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(join(dir, "notes.md"), "# Notes\n", "utf8");

    const tool = createCommitChangesTool(createExecutor(), {
      draftCommitMessage: async () => "feat: add feature module",
    });
    const result = await tool.execute(
      "tool-call",
      { action: "commit", steeringPrompt: "Approved exact paths only: feature.ts. Do not include notes.md.", paths: ["feature.ts"] },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );
    const { stdout: committedFiles } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(result.content[0].text, /Committed/);
    assert.match(committedFiles, /feature\.ts/);
    assert.doesNotMatch(committedFiles, /notes\.md/);
    assert.match(status, /\?\? notes\.md/);
  });
});

test("commit_changes message-less commit with unmatched paths fails before drafting or staging", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async () => {
        throw new Error("drafting should not run when listed paths have no changes");
      },
    });
    await assert.rejects(
      () => tool.execute("tool-call", { action: "commit", paths: ["missing.ts"] }, undefined, undefined, { cwd: dir, hasUI: false }),
      /listed paths have no changes/,
    );
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(status, /\?\? feature\.ts/);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes message-less commit creates a commit without terminating the agent loop", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async (prompt) => {
        assert.match(prompt, /feature\.ts/);
        return "feat: add feature module";
      },
    });
    const result = await tool.execute("tool-call", { action: "commit" }, undefined, undefined, { cwd: dir, hasUI: false });
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: dir });

    assert.equal(result.content[0].text, `Committed ${result.details.committed.commitHash}: feat: add feature module`);
    assert.doesNotMatch(result.content[0].text, /REPOSITORY CONTEXT|Return only one Lightweight/);
    assert.equal(result.terminate, undefined);
    assert.equal(result.details.action, "commit");
    assert.equal(result.details.committed.subject, "feat: add feature module");
    assert.deepEqual(result.details.draft, []);
    assert.equal(stdout.trim(), "feat: add feature module");
    assert.ok(calls.some((call) => call.args[0] === "add"));
  });
});

test("commit_changes message-less commit includes steering and draft diagnostics in details", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const attempts = [
      {
        attempt: 1,
        purpose: "draft",
        maxTokens: 64,
        response: {
          stopReason: "stop",
          contentTypeCounts: { text: 1 },
          contentTypes: ["text"],
          textCharacterCount: 24,
          usableTextCharacterCount: 24,
          empty: false,
          thinkingOnly: false,
          lengthStopped: false,
        },
      },
    ];
    const tool = createCommitChangesTool(createExecutor(), {
      draftCommitMessage: async (prompt) => {
        assert.match(prompt, /User steering prompt:/);
        assert.match(prompt, /prefer command parity wording/);
        return { message: "feat: add commit tool parity", attempts };
      },
    });
    const result = await tool.execute(
      "tool-call",
      { action: "commit", steeringPrompt: "prefer command parity wording" },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );

    assert.match(result.content[0].text, /Committed/);
    assert.equal(result.terminate, undefined);
    assert.equal(result.details.steeringPrompt, "prefer command parity wording");
    assert.equal(result.details.prompt.truncationCount >= 0, true);
    assert.deepEqual(result.details.draft, attempts);
  });
});

test("commit_changes message-less commit returns no-changes without drafting or staging", async () => {
  await withTempRepo(async (dir) => {
    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async () => {
        throw new Error("drafting should not run when there are no changes");
      },
    });
    const result = await tool.execute("tool-call", { action: "commit" }, undefined, undefined, { cwd: dir, hasUI: false });

    assert.equal(result.content[0].text, "No staged or unstaged git changes found; no commit was created.");
    assert.equal(result.terminate, undefined);
    assert.equal(result.details.action, "commit");
    assert.equal(result.details.hasChanges, false);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes message-less commit asks confirmation after drafting the exact subject", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const confirmations = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async () => "feat: add feature module",
    });
    const result = await tool.execute(
      "tool-call",
      { action: "commit", confirm: true },
      undefined,
      undefined,
      {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async (title, body) => {
            confirmations.push({ title, body });
            return false;
          },
        },
      },
    );
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.equal(result.content[0].text, "Commit cancelled; no git mutation was performed.");
    assert.equal(result.terminate, undefined);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].body, /feat: add feature module/);
    assert.match(stdout, /\?\? feature\.ts/);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes message-less commit rejects invalid drafts before staging", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), { draftCommitMessage: async () => "update feature module" });
    await assert.rejects(
      () => tool.execute("tool-call", { action: "commit" }, undefined, undefined, { cwd: dir, hasUI: false }),
      /invalid commit message draft.*Nothing was staged or committed/i,
    );
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(stdout, /\?\? feature\.ts/);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes message-less commit fails without an active model before staging", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls));
    await assert.rejects(
      () => tool.execute("tool-call", { action: "commit" }, undefined, undefined, { cwd: dir, hasUI: false, model: undefined }),
      /No active Pi model/,
    );

    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes message-less commit fails fast when confirmation is unavailable", async () => {
  const calls = [];
  const tool = createCommitChangesTool({
    async exec(command, args) {
      calls.push({ command, args });
      throw new Error("git should not run when message-less confirmation is unavailable");
    },
  });

  await assert.rejects(
    () => tool.execute("tool-call", { action: "commit", confirm: true }, undefined, undefined, { cwd: "/tmp", hasUI: false }),
    /confirm=true requires a UI-capable Pi mode/,
  );
  assert.equal(calls.length, 0);
});

test("commit_changes message-less commit aborts before staging when status changes after drafting", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, "feature.ts"), "export const feature = true;\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async () => {
        await writeFile(join(dir, "late.ts"), "export const late = true;\n", "utf8");
        return "feat: add feature module";
      },
    });
    await assert.rejects(
      () => tool.execute("tool-call", { action: "commit" }, undefined, undefined, { cwd: dir, hasUI: false }),
      /Git status changed since commit context was gathered/,
    );
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(stdout, /\?\? feature\.ts/);
    assert.match(stdout, /\?\? late\.ts/);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes commit action refuses sensitive changed files", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, ".env"), "TOKEN=do-not-commit\n", "utf8");

    const tool = createCommitChangesTool(createExecutor());
    await assert.rejects(
      () =>
        tool.execute(
          "tool-call",
          { action: "commit", message: "feat: add feature module" },
          undefined,
          undefined,
          { cwd: dir, hasUI: false },
        ),
      /known secret files or high-confidence secret tokens/,
    );
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(stdout, /\?\? \.env/);
  });
});

test("commit_changes message-less commit refuses sensitive files before drafting", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, ".env"), "TOKEN=do-not-commit\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async () => {
        throw new Error("drafting should not run for sensitive files");
      },
    });
    await assert.rejects(
      () => tool.execute("tool-call", { action: "commit" }, undefined, undefined, { cwd: dir, hasUI: false }),
      /known secret files or high-confidence secret tokens/,
    );
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

    assert.match(stdout, /\?\? \.env/);
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes blocked commit leaves the agent loop active", async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, ".env"), "TOKEN=do-not-commit\n", "utf8");

    const calls = [];
    const tool = createCommitChangesTool(createExecutor(calls), {
      draftCommitMessage: async () => "chore: add environment fixture",
    });
    const result = await tool.execute(
      "tool-call",
      { action: "commit" },
      undefined,
      undefined,
      { cwd: dir, hasUI: true, ui: { confirm: async () => false } },
    );

    assert.equal(result.content[0].text, "Commit blocked because potentially unsafe files were not approved.");
    assert.equal(result.terminate, undefined);
    assert.equal(result.details.action, "commit");
    assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
  });
});

test("commit_changes commit action refuses unreadable changed files", { skip: process.platform === "win32" }, async () => {
  await withTempRepo(async (dir) => {
    const unreadablePath = join(dir, "unreadable.txt");
    await writeFile(unreadablePath, "content that cannot be scanned\n", "utf8");
    await chmod(unreadablePath, 0o000);

    try {
      const calls = [];
      const tool = createCommitChangesTool(createExecutor(calls));
      await assert.rejects(
        () =>
          tool.execute(
            "tool-call",
            { action: "commit", message: "feat: add unreadable fixture" },
            undefined,
            undefined,
            { cwd: dir, hasUI: false },
          ),
        /unreadable changed files/,
      );
      const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

      assert.match(stdout, /\?\? unreadable\.txt/);
      assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
    } finally {
      await chmod(unreadablePath, 0o600).catch(() => {});
    }
  });
});

test("commit_changes commit action treats whitespace messages as invalid explicit input before reading git", async () => {
  const calls = [];
  const tool = createCommitChangesTool(
    {
      async exec(command, args) {
        calls.push({ command, args });
        throw new Error("git should not run with an empty explicit commit subject");
      },
    },
    {
      draftCommitMessage: async () => {
        throw new Error("drafting should not run for whitespace explicit messages");
      },
    },
  );

  await assert.rejects(
    () => tool.execute("tool-call", { action: "commit", message: "   " }, undefined, undefined, { cwd: "/tmp", hasUI: false }),
    /requires a final one-line Lightweight Conventional Commit subject/,
  );
  assert.equal(calls.length, 0);
});

test("commit_changes commit action rejects invalid messages before reading git", async () => {
  const calls = [];
  const tool = createCommitChangesTool({
    async exec(command, args) {
      calls.push({ command, args });
      throw new Error("git should not run with an invalid commit subject");
    },
  });

  await assert.rejects(
    () =>
      tool.execute(
        "tool-call",
        { action: "commit", message: "update the docs" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false },
      ),
    /invalid Lightweight Conventional Commit subject/,
  );
  assert.equal(calls.length, 0);
});

test("commit_changes commit action fails fast when confirmation is unavailable", async () => {
  const calls = [];
  const tool = createCommitChangesTool({
    async exec(command, args) {
      calls.push({ command, args });
      throw new Error("git should not run when confirmation is unavailable");
    },
  });

  await assert.rejects(
    () =>
      tool.execute(
        "tool-call",
        { action: "commit", message: "feat: add feature module", confirm: true },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false },
      ),
    /confirm=true requires a UI-capable Pi mode/,
  );
  assert.equal(calls.length, 0);
});

test("commit_changes gathers and commits in a linked worktree named by worktreePath", async () => {
  await withTempRepo(async (dir) => {
    const worktree = `${dir}-linked`;
    try {
      await execFileAsync("git", ["worktree", "add", "-b", "linked-branch", worktree], { cwd: dir });
      await writeFile(join(worktree, "feature.ts"), "export const feature = true;\n", "utf8");
      const { stdout: primaryHeadBefore } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });

      const tool = routedCommitTool(createExecutor());
      const gathered = await tool.execute("tool-call", { action: "gather", worktreePath: worktree }, undefined, undefined, { cwd: dir });
      const committed = await tool.execute(
        "tool-call",
        { action: "commit", message: "feat: add feature module", paths: ["feature.ts"], worktreePath: worktree },
        undefined,
        undefined,
        { cwd: dir, hasUI: false },
      );
      const { stdout: linkedSubject } = await execFileAsync("git", ["log", "-1", "--pretty=%s", "linked-branch"], { cwd: dir });
      const { stdout: primaryHeadAfter } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
      const { stdout: primaryStatus } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });

      assert.match(gathered.content[0].text, /feature\.ts/);
      assert.equal(gathered.details.branch, "linked-branch");
      assert.match(committed.content[0].text, /Committed/);
      assert.equal(committed.details.branch, "linked-branch");
      assert.match(committed.details.repositoryRoot, /-linked$/);
      assert.equal(linkedSubject.trim(), "feat: add feature module");
      assert.equal(primaryHeadAfter, primaryHeadBefore);
      assert.equal(primaryStatus, "");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

test("commit_changes refuses a relative, missing, subdirectory or other-repository worktreePath before staging", async () => {
  await withTempRepo(async (dir) => {
    await withTempRepo(async (otherDir) => {
      await writeFile(join(otherDir, "feature.ts"), "export const feature = true;\n", "utf8");
      const calls = [];
      const tool = routedCommitTool(createExecutor(calls));
      const commit = (worktreePath) =>
        tool.execute("tool-call", { action: "commit", message: "feat: add feature module", worktreePath }, undefined, undefined, { cwd: dir, hasUI: false });

      await assert.rejects(() => commit("relative/worktree"), /must be an absolute path/);
      await assert.rejects(() => commit(otherDir), /must exactly match a registered worktree/);
      await assert.rejects(() => commit(join(dir, "missing")), /must exactly match a registered worktree/);
      await mkdir(join(dir, "sub"));
      await assert.rejects(() => commit(join(dir, "sub")), /must exactly match a registered worktree/);
      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: otherDir });

      assert.match(status, /\?\? feature\.ts/);
      assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "commit"), false);
    });
  });
});
