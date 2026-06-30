import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BRANCHME_COMMAND_NAME, EXTENSION_DISPLAY_NAME } from "../constants.ts";
import { getBranchStatus } from "../git.ts";
import { repositoryLabel, resolveGitHubRepository, resolveGitHubToken } from "../github.ts";
import { BranchMePanel, type BranchMePanelData } from "../ui/branchme-panel.ts";

export type BranchMeCommandMode = "panel" | "help";

export function parseBranchMeArgs(args: string): BranchMeCommandMode {
  const normalized = args.trim().toLowerCase();
  if (normalized === "help" || normalized === "--help" || normalized === "-h") return "help";
  return "panel";
}

export function getBranchMeHelpText(): string {
  return [
    "# BranchMe",
    "",
    "BranchMe adds current-repository branch workflow tools to Pi.",
    "",
    "## Workflow",
    "",
    "1. Use `branch_status` to inspect the current repository and branch state.",
    "2. Use `create_branch` with an explicit `branchName` to create and checkout a branch from current `HEAD`.",
    "3. Create commits outside BranchMe.",
    "4. Use `push_branch` to push the current branch, publishing it to `origin` when no upstream exists.",
    "5. Use `pull_request` with explicit PR fields to open a GitHub pull request in the current repository.",
    "",
    "BranchMe slash commands are informational only; they never create branches, push, commit, or open pull requests.",
  ].join("\n");
}

function notifyOrLog(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  console.log(message);
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

  try {
    const status = await getBranchStatus(pi, ctx, ctx.signal);
    data.currentBranch = status.currentBranch;
    data.detached = status.detached;
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
    data.tokenSource = resolveGitHubToken().source;
  } catch {
    data.tokenSource = null;
  }

  return data;
}

async function showPanel(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionCommandContext): Promise<void> {
  const data = await collectPanelData(pi, ctx);

  if (ctx.mode !== "tui") {
    const branch = data.detached ? "detached HEAD" : data.currentBranch ?? "unknown";
    notifyOrLog(
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
        notifyOrLog(ctx, getBranchMeHelpText(), "info");
        return;
      }

      await showPanel(pi, ctx);
    },
  });
}
