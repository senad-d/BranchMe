import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BRANCHME_COMMAND_NAME, EXTENSION_DISPLAY_NAME } from "../constants.ts";
import { getBranchStatus } from "../git.ts";
import { repositoryLabel, resolveGitHubRepository, resolveGitHubToken } from "../github.ts";
import { BranchMePanel, type BranchMePanelData } from "../ui/branchme-panel.ts";

export type BranchMeCommandMode = "panel" | "help" | "unsupported";

function firstBranchMeArgumentLine(args: string): string {
  return args.split(/\r?\n/u, 1)[0] ?? "";
}

export function parseBranchMeArgs(args: string): BranchMeCommandMode {
  const normalized = firstBranchMeArgumentLine(args).trim().toLowerCase();
  if (!normalized) return "panel";
  if (normalized === "help" || normalized === "--help" || normalized === "-h") return "help";
  return "unsupported";
}

export function formatUnsupportedBranchMeArgument(args: string): string {
  return `Unknown /branchme argument ${JSON.stringify(firstBranchMeArgumentLine(args).trim())}. Use /branchme help.`;
}

export function getBranchMeHelpText(): string {
  return [
    "# BranchMe",
    "",
    "Current-repository branch workflow tools for Pi.",
    "",
    "Commands only show info; BranchMe tools perform actions.",
    "",
    "## Workflow",
    "",
    "1. `branch_status` — inspect repo and branch state.",
    "2. `change_branch` / `create_branch` — switch to an existing clean branch or create one from `HEAD`.",
    "3. Commit outside BranchMe.",
    "4. `push_branch` — push the current branch.",
    "5. `pull_request` — open a PR after `push_branch` completes and GitHub sees the branches.",
    "",
    "## Requirements",
    "",
    "- Run inside a Git repo with `git` available.",
    "- For PRs: GitHub `origin` and `GITHUB_TOKEN` or `GH_TOKEN` (environment or `.env`).",
    "- BranchMe never stages or commits.",
  ].join("\n");
}

function emitCommandMessage(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  if (ctx.mode === "print") {
    console.log(message);
  }
}

async function collectPanelData(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: ExtensionCommandContext,
): Promise<BranchMePanelData> {
  const data: BranchMePanelData = {
    currentBranch: null,
    detached: false,
    githubRepository: null,
    tokenSource: null,
  };

  let tokenLookupCwd: string | undefined;
  try {
    const status = await getBranchStatus(pi, ctx, ctx.signal);
    data.currentBranch = status.currentBranch;
    data.detached = status.detached;
    tokenLookupCwd = status.repoRoot;
  } catch (error) {
    data.statusNote = error instanceof Error ? error.message : String(error);
  }

  try {
    const repository = await resolveGitHubRepository(pi, ctx, ctx.signal);
    data.githubRepository = repositoryLabel(repository);
  } catch {
    data.githubRepository = null;
  }

  try {
    data.tokenSource = (await resolveGitHubToken(process.env, { cwd: tokenLookupCwd, signal: ctx.signal })).source;
  } catch {
    data.tokenSource = null;
  }

  return data;
}

async function showPanel(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionCommandContext): Promise<void> {
  const data = await collectPanelData(pi, ctx);

  if (ctx.mode !== "tui") {
    const branch = data.detached ? "detached HEAD" : data.currentBranch ?? "unknown";
    emitCommandMessage(
      ctx,
      `${EXTENSION_DISPLAY_NAME}: branch ${branch}; GitHub repository ${data.githubRepository ?? "not resolved"}; token ${data.tokenSource ? `present (${data.tokenSource})` : "not set"}.`,
      data.statusNote ? "warning" : "info",
    );
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new BranchMePanel(data, theme, () => done(undefined), () => tui.requestRender()));
}

export function registerBranchMeCommand(pi: Pick<ExtensionAPI, "registerCommand" | "exec">): void {
  pi.registerCommand(BRANCHME_COMMAND_NAME, {
    description: "Show BranchMe status and help",
    handler: async (args, ctx) => {
      const mode = parseBranchMeArgs(args);
      if (mode === "help") {
        emitCommandMessage(ctx, getBranchMeHelpText(), "info");
        return;
      }
      if (mode === "unsupported") {
        emitCommandMessage(ctx, formatUnsupportedBranchMeArgument(args), "warning");
        return;
      }

      await showPanel(pi, ctx);
    },
  });
}
