import assert from "node:assert/strict";
import test from "node:test";
import { registerBranchMeCommand, getBranchMeHelpText, parseBranchMeArgs } from "../src/commands/branchme-command.ts";
import { renderBranchMePanelLines } from "../src/ui/branchme-panel.ts";

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
  return {
    cwd: "/repo",
    mode: "print",
    hasUI: true,
    signal: undefined,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    notifications,
    ...overrides,
  };
}

test("parseBranchMeArgs recognizes help aliases", () => {
  assert.equal(parseBranchMeArgs(""), "panel");
  assert.equal(parseBranchMeArgs("help"), "help");
  assert.equal(parseBranchMeArgs("--help"), "help");
  assert.equal(parseBranchMeArgs("-h"), "help");
});

test("/branchme help returns concise workflow notes", async () => {
  const pi = makePi();
  registerBranchMeCommand(pi);
  const ctx = makeContext();

  await pi.commands[0].options.handler("--help", ctx);

  assert.match(ctx.notifications[0].message, /branch_status/);
  assert.match(ctx.notifications[0].message, /create_branch/);
  assert.match(ctx.notifications[0].message, /push_branch/);
  assert.match(ctx.notifications[0].message, /pull_request/);
  assert.equal(pi.calls.length, 0);
  assert.equal(getBranchMeHelpText().includes("informational only"), true);
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
  const ctx = makeContext({ mode: "print" });

  await pi.commands[0].options.handler("", ctx);

  assert.match(ctx.notifications[0].message, /BranchMe/);
  assert.equal(pi.calls.some((call) => ["switch", "push", "commit", "add"].includes(call.args[0])), false);
});

test("BranchMe panel renderer clips every line to terminal width", () => {
  const data = {
    currentBranch: "feature/current",
    detached: false,
    githubRepository: "senad-d/branchme",
    tokenSource: "GITHUB_TOKEN",
  };

  for (const width of [12, 24, 50, 80]) {
    const lines = renderBranchMePanelLines(data, width);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.length <= width), `line exceeded width ${width}: ${lines.join("\n")}`);
  }
});
