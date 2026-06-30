import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getBranchMeHelpText } from "../src/commands/branchme-command.ts";
import { renderBranchMePanelLines } from "../src/ui/branchme-panel.ts";

const capturePath = new URL("../docs/TUI_CAPTURE.md", import.meta.url);

const panelCases = [
  {
    title: "Tiny mode: clean branch with token",
    width: 18,
    data: {
      currentBranch: "feature/current",
      detached: false,
      githubRepository: "senad-d/branchme",
      tokenSource: "GITHUB_TOKEN",
    },
  },
  {
    title: "Narrow mode: clean branch with token",
    width: 40,
    data: {
      currentBranch: "feature/current",
      detached: false,
      githubRepository: "senad-d/branchme",
      tokenSource: "GITHUB_TOKEN",
    },
  },
  {
    title: "Wide mode: Status selected",
    width: 80,
    selectedSection: "status",
    data: {
      currentBranch: "feature/current",
      detached: false,
      githubRepository: "senad-d/branchme",
      tokenSource: "GITHUB_TOKEN",
    },
  },
  {
    title: "Wide mode: Workflow selected",
    width: 80,
    selectedSection: "workflow",
    data: {
      currentBranch: "feature/current",
      detached: false,
      githubRepository: "senad-d/branchme",
      tokenSource: "GITHUB_TOKEN",
    },
  },
  {
    title: "Wide mode: Safety selected",
    width: 80,
    selectedSection: "safety",
    data: {
      currentBranch: "feature/current",
      detached: false,
      githubRepository: "senad-d/branchme",
      tokenSource: "GITHUB_TOKEN",
    },
  },
  {
    title: "Very wide terminal: panel width capped",
    width: 112,
    data: {
      currentBranch: "main",
      detached: false,
      githubRepository: "senad-d/BranchMe",
      tokenSource: null,
    },
  },
  {
    title: "Fallback values: detached HEAD without repository or token",
    width: 50,
    data: {
      currentBranch: null,
      detached: true,
      githubRepository: null,
      tokenSource: null,
      statusNote: "Unable to resolve a GitHub repository from origin or GITHUB_REPOSITORY.",
    },
  },
  {
    title: "Long values: truncation and tail preservation",
    width: 72,
    data: {
      currentBranch: "feature/super-long-branch-name-for-layout-regression-capture",
      detached: false,
      githubRepository: "very-long-owner-name/very-long-repository-name-for-branchme",
      tokenSource: "GITHUB_TOKEN",
      statusNote: "This deliberately long status note is captured to detect wrapping, clipping, and footer regressions.",
    },
  },
];

function visualizeTrailingSpaces(value) {
  return value.replace(/ +$/u, (spaces) => "·".repeat(spaces.length));
}

function fenced(value) {
  return ["```text", value, "```"].join("\n");
}

function renderCapture() {
  const lines = [
    "# BranchMe TUI Capture",
    "",
    "This file is a deterministic text capture of BranchMe user-facing TUI/help surfaces.",
    "Use it as a visual baseline when improving layout, wording, spacing, or responsive behavior.",
    "Trailing spaces are shown as `·` so formatting checks can keep the repository whitespace-clean.",
    "",
    "Generated and verified by `test/tui-capture.test.mjs`.",
    "Update intentionally with:",
    "",
    fenced("UPDATE_TUI_CAPTURE=1 node --test test/tui-capture.test.mjs"),
    "",
    "## /branchme help",
    "",
    fenced(getBranchMeHelpText()),
  ];

  for (const panelCase of panelCases) {
    const renderedLines = renderBranchMePanelLines(panelCase.data, panelCase.width, undefined, panelCase.selectedSection);
    assert.ok(
      renderedLines.every((line) => line.length <= panelCase.width),
      `${panelCase.title} exceeded width ${panelCase.width}`,
    );
    assert.ok(renderedLines.length <= 14, `${panelCase.title} exceeded maximum height`);

    lines.push(
      "",
      `## Panel: ${panelCase.title}`,
      "",
      `Width: ${panelCase.width}`,
      "",
      fenced(renderedLines.map(visualizeTrailingSpaces).join("\n")),
    );
  }

  return `${lines.join("\n")}\n`;
}

test("BranchMe TUI capture text is up to date", async () => {
  const nextCapture = renderCapture();

  if (process.env.UPDATE_TUI_CAPTURE === "1") {
    await mkdir(dirname(fileURLToPath(capturePath)), { recursive: true });
    await writeFile(capturePath, nextCapture, "utf8");
  }

  const currentCapture = await readFile(capturePath, "utf8");
  assert.equal(
    currentCapture,
    nextCapture,
    "docs/TUI_CAPTURE.md is stale. Run UPDATE_TUI_CAPTURE=1 node --test test/tui-capture.test.mjs to refresh it intentionally.",
  );
});
