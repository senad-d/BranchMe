import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatUnsupportedBranchMeArgument,
  getBranchMeHelpText,
  parseBranchMeArgs,
  registerBranchMeCommand,
} from "../src/commands/branchme-command.ts";
import { BranchMePanel, renderBranchMePanelLines } from "../src/ui/branchme-panel.ts";

function result(overrides = {}) {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function makePi(routes = {}) {
  const commands = [];
  const calls = [];
  return {
    commands,
    calls,
    registerCommand(name, options) {
      commands.push({ name, options });
    },
    async exec(command, args, options) {
      assert.equal(command, "git");
      calls.push({ command, args: [...args], options });
      const route = routes[args.join("\0")];
      if (!route) throw new Error(`Unexpected git command: ${args.join(" ")}`);
      return result(route);
    },
  };
}

function makeContext(overrides = {}) {
  const notifications = [];
  const customCalls = [];
  const renderRequests = [];
  const context = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      async custom(factory) {
        const component = factory(
          { requestRender: () => renderRequests.push("render") },
          { fg: (_role, value) => value, bold: (value) => value },
          {},
          (value) => customCalls.push({ done: value }),
        );
        customCalls.push({ component });
        return undefined;
      },
    },
    notifications,
    customCalls,
    renderRequests,
  };
  return { ...context, ...overrides, ui: { ...context.ui, ...overrides.ui } };
}

async function withCapturedConsoleLog(fn) {
  const original = console.log;
  const logs = [];
  console.log = (message = "") => {
    logs.push(String(message));
  };
  try {
    await fn(logs);
  } finally {
    console.log = original;
  }
}

function branchStatusRoutes(repoRoot) {
  return {
    ["rev-parse\0--show-toplevel"]: { stdout: `${repoRoot}\n` },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main\n" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { stdout: "0\t0\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  };
}

async function withGitHubTokenEnvironment(env, fn) {
  const previous = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  };

  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  if (env.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = env.GITHUB_TOKEN;
  if (env.GH_TOKEN !== undefined) process.env.GH_TOKEN = env.GH_TOKEN;
  if (env.GITHUB_REPOSITORY !== undefined) process.env.GITHUB_REPOSITORY = env.GITHUB_REPOSITORY;

  try {
    await fn();
  } finally {
    if (previous.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous.GITHUB_TOKEN;

    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;

    if (previous.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY;
  }
}

test("parseBranchMeArgs recognizes help aliases and unsupported arguments", () => {
  assert.equal(parseBranchMeArgs(""), "panel");
  assert.equal(parseBranchMeArgs("  "), "panel");
  assert.equal(parseBranchMeArgs("help"), "help");
  assert.equal(parseBranchMeArgs("help\n/quit"), "help");
  assert.equal(parseBranchMeArgs("--help"), "help");
  assert.equal(parseBranchMeArgs("-h"), "help");
  assert.equal(parseBranchMeArgs("hlep"), "unsupported");
  assert.equal(formatUnsupportedBranchMeArgument('bad "arg"'), 'Unknown /branchme argument "bad \\"arg\\"". Use /branchme help.');
});

test("/branchme help returns concise workflow and requirements through UI modes", async () => {
  const pi = makePi();
  registerBranchMeCommand(pi);
  const ctx = makeContext({ mode: "rpc", hasUI: true });

  await withCapturedConsoleLog(async (logs) => {
    await pi.commands[0].options.handler("--help", ctx);
    assert.deepEqual(logs, []);
  });

  assert.match(ctx.notifications[0].message, /## Workflow/);
  assert.match(ctx.notifications[0].message, /## Requirements/);
  assert.match(ctx.notifications[0].message, /branch_status/);
  assert.match(ctx.notifications[0].message, /change_branch/);
  assert.match(ctx.notifications[0].message, /create_branch/);
  assert.match(ctx.notifications[0].message, /push_branch/);
  assert.match(ctx.notifications[0].message, /pull_request/);
  assert.doesNotMatch(ctx.notifications[0].message, /\| Tool \|/);
  assert.equal(pi.calls.length, 0);
  assert.equal(getBranchMeHelpText().includes("Commands only show info"), true);
});

test("/branchme help writes only in print mode when no UI is available", async () => {
  const pi = makePi();
  registerBranchMeCommand(pi);

  await withCapturedConsoleLog(async (logs) => {
    await pi.commands[0].options.handler("help", makeContext({ mode: "print", hasUI: false }));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /## Workflow/);
  });

  await withCapturedConsoleLog(async (logs) => {
    await pi.commands[0].options.handler("help", makeContext({ mode: "json", hasUI: false }));
    assert.deepEqual(logs, []);
  });
});

test("/branchme unsupported arguments return mode-safe guidance without opening the panel", async () => {
  for (const mode of ["tui", "rpc"]) {
    const pi = makePi();
    registerBranchMeCommand(pi);
    const ctx = makeContext({ mode, hasUI: true });

    await withCapturedConsoleLog(async (logs) => {
      await pi.commands[0].options.handler("hlep", ctx);
      assert.deepEqual(logs, []);
    });

    assert.deepEqual(ctx.notifications, [{ message: 'Unknown /branchme argument "hlep". Use /branchme help.', level: "warning" }]);
    assert.equal(ctx.customCalls.length, 0);
    assert.equal(pi.calls.length, 0);
  }

  const printPi = makePi();
  registerBranchMeCommand(printPi);
  await withCapturedConsoleLog(async (logs) => {
    await printPi.commands[0].options.handler("status", makeContext({ mode: "print", hasUI: false }));
    assert.deepEqual(logs, ['Unknown /branchme argument "status". Use /branchme help.']);
  });
  assert.equal(printPi.calls.length, 0);

  const jsonPi = makePi();
  registerBranchMeCommand(jsonPi);
  await withCapturedConsoleLog(async (logs) => {
    await jsonPi.commands[0].options.handler("status", makeContext({ mode: "json", hasUI: false }));
    assert.deepEqual(logs, []);
  });
  assert.equal(jsonPi.calls.length, 0);
});

test("/branchme fallback uses read-only git status and no mutation commands", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main\n" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { stdout: "0\t0\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeCommand(pi);
  const ctx = makeContext({ mode: "rpc", hasUI: true });

  await withCapturedConsoleLog(async (logs) => {
    await pi.commands[0].options.handler("", ctx);
    assert.deepEqual(logs, []);
  });

  assert.match(ctx.notifications[0].message, /BranchMe/);
  assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
});

test("/branchme opens custom panel only in TUI mode", async () => {
  const pi = makePi({
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { stdout: "origin/main\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main...origin/main\n" },
    ["rev-list\0--left-right\0--count\0HEAD...@{u}"]: { stdout: "0\t0\n" },
    ["remote\0get-url\0origin"]: { stdout: "https://github.com/senad-d/branchme.git\n" },
  });
  registerBranchMeCommand(pi);
  const ctx = makeContext({ mode: "tui", hasUI: true });

  await pi.commands[0].options.handler("", ctx);

  assert.equal(ctx.notifications.length, 0);
  assert.equal(ctx.customCalls.length, 1);
  assert.equal(typeof ctx.customCalls[0].component.render, "function");
  assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
});

test("/branchme print mode writes fallback text and JSON mode stays stdout-silent", async () => {
  const routes = {
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n" },
    ["remote\0get-url\0origin"]: { code: 1, stderr: "missing\n" },
  };

  const printPi = makePi(routes);
  registerBranchMeCommand(printPi);
  await withCapturedConsoleLog(async (logs) => {
    await printPi.commands[0].options.handler("", makeContext({ mode: "print", hasUI: false }));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /BranchMe/);
  });

  const jsonPi = makePi(routes);
  registerBranchMeCommand(jsonPi);
  await withCapturedConsoleLog(async (logs) => {
    await jsonPi.commands[0].options.handler("", makeContext({ mode: "json", hasUI: false }));
    assert.deepEqual(logs, []);
  });
});

test("/branchme keeps absent repository and token as plain fallback values", async () => {
  const routes = {
    ["rev-parse\0--show-toplevel"]: { stdout: "/repo\n" },
    ["symbolic-ref\0--quiet\0--short\0HEAD"]: { stdout: "main\n" },
    ["rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}"]: { code: 1, stderr: "no upstream\n" },
    ["status\0--porcelain=v1\0--branch"]: { stdout: "## main\n" },
    ["remote\0get-url\0origin"]: { code: 1, stderr: "missing\n" },
  };

  await withGitHubTokenEnvironment({}, async () => {
    const pi = makePi(routes);
    registerBranchMeCommand(pi);

    await withCapturedConsoleLog(async (logs) => {
      await pi.commands[0].options.handler("", makeContext({ mode: "print", hasUI: false }));
      assert.equal(logs.length, 1);
      assert.match(logs[0], /GitHub repository not resolved/);
      assert.match(logs[0], /token not set/);
      assert.doesNotMatch(logs[0], /warning:/i);
    });
  });
});

test("/branchme surfaces repository mismatch warnings in RPC and TUI output", async () => {
  await withGitHubTokenEnvironment({ GITHUB_REPOSITORY: "other/repo", GITHUB_TOKEN: "ghp_secret123" }, async () => {
    const rpcPi = makePi(branchStatusRoutes("/repo"));
    registerBranchMeCommand(rpcPi);
    const rpcCtx = makeContext({ mode: "rpc", hasUI: true });

    await rpcPi.commands[0].options.handler("", rpcCtx);

    assert.equal(rpcCtx.notifications[0].level, "warning");
    assert.match(rpcCtx.notifications[0].message, /GitHub repository warning: Repository boundary mismatch/i);
    assert.match(rpcCtx.notifications[0].message, /senad-d\/branchme/);
    assert.match(rpcCtx.notifications[0].message, /other\/repo/);
    assert.doesNotMatch(rpcCtx.notifications[0].message, /secret123|ghp_/u);

    const tuiPi = makePi(branchStatusRoutes("/repo"));
    registerBranchMeCommand(tuiPi);
    const tuiCtx = makeContext({ mode: "tui", hasUI: true });

    await tuiPi.commands[0].options.handler("", tuiCtx);

    const rendered = tuiCtx.customCalls[0].component.render(80).join("\n");
    assert.match(rendered, /Repository boundary mismatch/i);
    assert.doesNotMatch(rendered, /secret123|ghp_/u);
  });
});

test("/branchme surfaces token fallback errors as print-safe warnings", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "branchme-command-token-warning-"));
  try {
    await mkdir(join(repoRoot, ".env"));
    await withGitHubTokenEnvironment({}, async () => {
      const pi = makePi(branchStatusRoutes(repoRoot));
      registerBranchMeCommand(pi);

      await withCapturedConsoleLog(async (logs) => {
        await pi.commands[0].options.handler("", makeContext({ cwd: repoRoot, mode: "print", hasUI: false }));
        assert.equal(logs.length, 1);
        assert.match(logs[0], /token warning: Unable to read \.env file for GitHub token fallback/i);
        assert.match(logs[0], /regular file/i);
        assert.doesNotMatch(logs[0], /token present|ghp_|secret/u);
      });
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("/branchme does not read local token files outside verified git roots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "branchme-command-nongit-"));
  try {
    await writeFile(join(cwd, ".env"), "GITHUB_TOKEN=ghp_filetoken_from_wrong_directory\n", "utf8");
    await withGitHubTokenEnvironment({}, async () => {
      const pi = makePi({
        ["rev-parse\0--show-toplevel"]: { code: 128, stderr: "fatal: not a git repository\n" },
      });
      registerBranchMeCommand(pi);

      await withCapturedConsoleLog(async (logs) => {
        await pi.commands[0].options.handler("", makeContext({ cwd, mode: "print", hasUI: false }));
        assert.equal(logs.length, 1);
        assert.match(logs[0], /token not set/);
        assert.doesNotMatch(logs[0], /token present|\.env/);
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/branchme reports process token presence outside git roots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "branchme-command-envtoken-"));
  try {
    await writeFile(join(cwd, ".env"), "GH_TOKEN=ghp_filetoken_from_wrong_directory\n", "utf8");
    await withGitHubTokenEnvironment({ GITHUB_TOKEN: "ghp_process_token" }, async () => {
      const pi = makePi({
        ["rev-parse\0--show-toplevel"]: { code: 128, stderr: "fatal: not a git repository\n" },
      });
      registerBranchMeCommand(pi);

      await withCapturedConsoleLog(async (logs) => {
        await pi.commands[0].options.handler("", makeContext({ cwd, mode: "print", hasUI: false }));
        assert.equal(logs.length, 1);
        assert.match(logs[0], /token present \(GITHUB_TOKEN\)/);
        assert.doesNotMatch(logs[0], /\.env/);
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/branchme reads token fallback from verified git roots only", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "branchme-command-repo-"));
  const subdir = join(repoRoot, "nested");
  try {
    await mkdir(subdir);
    await writeFile(join(repoRoot, ".env"), "GH_TOKEN=ghp_verified_repo_root\n", "utf8");
    await writeFile(join(subdir, ".env"), "GITHUB_TOKEN=ghp_unverified_subdir\n", "utf8");

    await withGitHubTokenEnvironment({}, async () => {
      for (const cwd of [repoRoot, subdir]) {
        const pi = makePi(branchStatusRoutes(repoRoot));
        registerBranchMeCommand(pi);

        await withCapturedConsoleLog(async (logs) => {
          await pi.commands[0].options.handler("", makeContext({ cwd, mode: "print", hasUI: false }));
          assert.equal(logs.length, 1);
          assert.match(logs[0], /token present \(GH_TOKEN \(\.env\)\)/);
          assert.doesNotMatch(logs[0], /GITHUB_TOKEN \(\.env\)/);
        });
      }
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("BranchMe panel renderer clips every line to terminal width", () => {
  const data = {
    currentBranch: "feature/current",
    detached: false,
    githubRepository: "senad-d/branchme",
    tokenSource: "GITHUB_TOKEN",
  };

  for (const width of [12, 24, 50, 80, 112]) {
    const lines = renderBranchMePanelLines(data, width);
    assert.ok(lines.length > 0);
    assert.ok(lines.length <= 14, `panel exceeded maximum height at width ${width}: ${lines.length} lines`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeded width ${width}: ${lines.join("\n")}`);
  }
});

test("BranchMe panel renderer respects visible width for Unicode and ANSI themed text", () => {
  const data = {
    currentBranch: "feature/修复-🚀-very-long-branch-name",
    detached: false,
    githubRepository: "senad-d/分支管理器",
    tokenSource: "GITHUB_TOKEN",
  };
  const theme = {
    fg(_role, value) {
      return `\u001b[36m${value}\u001b[39m`;
    },
    bold(value) {
      return `\u001b[1m${value}\u001b[22m`;
    },
  };

  for (const width of [16, 24, 40, 80]) {
    const lines = renderBranchMePanelLines(data, width, theme);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `visible width exceeded ${width}: ${lines.join("\n")}`);
  }
});

test("BranchMe panel handles navigation keys through Pi key matching", () => {
  const renders = [];
  let closed = 0;
  const panel = new BranchMePanel(
    { currentBranch: "main", detached: false, githubRepository: "senad-d/branchme", tokenSource: null },
    undefined,
    () => {
      closed += 1;
    },
    () => renders.push(panel.render(80).join("\n")),
  );

  assert.match(panel.render(80).join("\n"), /STATUS/);
  panel.handleInput("\u001b[B");
  assert.match(panel.render(80).join("\n"), /WORKFLOW/);
  panel.handleInput("\u001b[A");
  assert.match(panel.render(80).join("\n"), /STATUS/);
  panel.handleInput("\t");
  assert.match(panel.render(80).join("\n"), /WORKFLOW/);
  panel.handleInput("\r");

  assert.equal(renders.length, 3);
  assert.equal(closed, 1);
});

test("BranchMe wide panel shows only the selected right-side section", () => {
  const data = {
    currentBranch: "main",
    detached: false,
    githubRepository: "senad-d/BranchMe",
    tokenSource: null,
  };

  const visibleText = renderBranchMePanelLines(data, 80, undefined, "workflow").join("\n");

  assert.match(visibleText, /WORKFLOW/);
  assert.match(visibleText, /▶  Workflow/);
  assert.match(visibleText, /branch_status\s+-> inspect/);
  assert.doesNotMatch(visibleText, /1 branch_status/);
  assert.doesNotMatch(visibleText, /STATUS/);
  assert.doesNotMatch(visibleText, /SAFETY/);
  assert.equal(visibleText.split("\n").length <= 14, true);
});

test("BranchMe panel renderer does not leak ANSI escape bodies into visible text", () => {
  const data = {
    currentBranch: "main",
    detached: false,
    githubRepository: "senad-d/BranchMe",
    tokenSource: null,
  };
  const theme = {
    fg(_role, value) {
      return `\u001b[38;2;54;249;246m${value}\u001b[39m`;
    },
    bold(value) {
      return `\u001b[1m${value}\u001b[22m`;
    },
  };

  const visibleText = renderBranchMePanelLines(data, 112, theme).map(stripAnsi).join("\n");

  assert.doesNotMatch(visibleText, /\[[0-9;]+m/);
  assert.match(visibleText, /STATUS/);
  assert.match(visibleText, /Workflow/);
  assert.doesNotMatch(visibleText, /Safety/);
  assert.doesNotMatch(visibleText, /WORKFLOW\s*\n/);
});
