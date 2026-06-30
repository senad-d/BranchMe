import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerBranchMeCommand, getBranchMeHelpText, parseBranchMeArgs } from "../src/commands/branchme-command.ts";
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

test("parseBranchMeArgs recognizes help aliases", () => {
  assert.equal(parseBranchMeArgs(""), "panel");
  assert.equal(parseBranchMeArgs("help"), "help");
  assert.equal(parseBranchMeArgs("--help"), "help");
  assert.equal(parseBranchMeArgs("-h"), "help");
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
