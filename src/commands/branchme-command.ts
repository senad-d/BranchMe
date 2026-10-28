import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BRANCHME_COMMAND_NAME, EXTENSION_DISPLAY_NAME } from "../constants.ts";
import { getBranchStatus } from "../git.ts";
import { redactSecrets, repositoryLabel, resolveGitHubRepository, resolveGitHubToken } from "../github.ts";
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
    "Git repository initialization and current-repository workflow tools for Pi.",
    "",
    "Commands only show info; BranchMe tools perform actions.",
    "",
    "## Workflow",
    "",
    "0. `init_repository` — initialize the current directory when it is not already inside a Git repository.",
    "1. `branch_status` — inspect repo and branch state.",
    "2. `change_branch` — switch to a clean existing local branch.",
    "3. `fetch_branch` — fetch its configured upstream remote (or an explicit `remote`/`branch`) without changing local files.",
    "4. `pull_branch` — fast-forward from upstream, or `rebase_branch` — rebase local commits onto upstream.",
    "5. `create_branch` — create a new branch from the updated `HEAD`.",
    "6. `commit_changes` — create a local Conventional Commit.",
    "7. `push_branch` — push the current branch.",
    "8. `pull_request` — open a PR after `push_branch` completes and GitHub sees the branches.",
    "",
    "## Discovery and PR lifecycle",
    "",
    "- `git_status` — enumerate staged/unstaged/untracked/conflicted paths across bounded pages; repeat filters/worktreePath with next as after until complete. Stale continuation requires a restart; reuse only reusablePath paths. Explicit filters request bounded file fingerprints, never content.",
    "- `git_diff` — read unstaged (default), staged, or ref-range diffs; supports merge-base comparisons, literal root-relative paths, and patch/stat/name-status output. Redacted display is capped at 1,000 lines / 32 KiB; never stages or writes files/refs. Requires Git with `--no-lazy-fetch` support.",
    "- `git_log` / `git_show` — inspect older commits and historical blobs without checkout; history continuation pins commits and merge comparisons need an explicit parent.",
    "- `git_conflicts` — read available base/ours/theirs index stages without resolving; missing stages are normal, and ours/theirs depend on the operation.",
    "- `list_remotes` / `add_remote` / `set_upstream` — inspect remote destinations, add an unused credential-free remote, or configure branch tracking with expected configuration fingerprints; no hidden fetch.",
    "- `stage_changes` / `unstage_changes` — exact approved paths and fresh HEAD/index expectations; preserve working files and never commit.",
    "- `commit_changes` — `action: \"gather\"` returns read-only commit context; `action: \"commit\"` commits an explicit or drafted subject, `paths` limits the commit, and it never pushes.",
    "- `restore_paths` — preview first, then apply only with explicit discard authorization and fresh per-file fingerprints; protects untracked files and logical index entries.",
    "- `revert_changes` — prepare one non-merge commit inverse without committing; conflicts attempt verified abort/restoration, successful owned operation state is quit without discarding the inverse.",
    "- `list_branches` — discover local/cached remote refs, upstream counts, and occupancy; optional `kind` and Git glob `patterns` filter before limits.",
    "- `fetch_remote` — refresh all branch refs for one configured remote (default origin); optional `prune: true` deletes only its stale cached branch refs. Wait before `list_branches`.",
    "- Issue discovery: `fetch_remote({ remote: \"origin\", prune: true })`, then `list_branches({ kind: \"remote-tracking\", patterns: [\"origin/feat/23\", \"origin/feat/23-*\"] })`.",
    "- `fetch_remote` preserves local branches, tags, files, and upstream settings; requires the files ref backend and refuses unsafe symbolic destinations.",
    "- `track_branch` — fetch an existing remote branch and verify a new clean local tracking checkout.",
    "- `update_from_base` — fetch and merge an explicit base into the current clean feature, preserving published history and upstream; a conflict is aborted unless `keepConflicts: true` leaves it in progress.",
    "- `conclude_merge` — `action: \"conclude\"` commits the kept merge once every conflict marker is removed; `action: \"abort\"` restores the branch.",
    "- `pull_request_checks` — inspect all run/status states and available host readiness for an exact head; partial/unknown/pending/no-check states never imply approval.",
    "- `edit_pull_request` — change explicit title/body/draft fields of an open PR, preserving omitted fields.",
    "- `merge_pull_request` — explicitly authorized ready host merge with expected-head lease and selected method; no bypass, cleanup, or remote branch deletion.",
    "- `pull_request_status` — inspect a PR by number, or the latest PR for a head branch; not a CI/review verdict.",
    "- `pull_request_feedback` — read a PR's unresolved review comments and failing checks with log tails.",
    "- `reply_pull_request_feedback` — reply to a PR review thread (optionally resolving it) or post a PR comment.",
    "- `pull_request_files` — list a PR's changed files and current labels.",
    "- `label_pull_request` — add existing repository labels to a PR.",
    "- `pull_request` — reuses an exact matching open PR without changing its title, body, or draft state.",
    "- `land_branch` — after host merge, clean up from the primary checkout; use `pullRequestNumber` for squash/rebase evidence.",
    "",
    "## Branch integration",
    "",
    "- `integrate_branch` — integrate an exact local source into an exact local target; the clean control worktree must already have the target checked out.",
    "- It never fetches or pushes; a conflict is automatically aborted after paths are captured and restoration is verified, unless `keepConflicts: true` leaves it in progress for `conclude_merge`.",
    "- BranchMe does not resolve semantic conflicts; handle them in a separate developer workflow.",
    "",
    "## Branch retirement",
    "",
    "- `remove_worktree` and `retire_branch` are separate: removal retains the branch; retirement later deletes only the exact local branch ref.",
    "- `retire_branch` requires the exact local branch, its full expected `HEAD`, and an exact local target for ancestry verification.",
    "- Any registered worktree occupancy rejects retirement; remove an occupying linked worktree separately first.",
    "- Merged retirement uses `force: false`; unmerged retirement requires explicit authorization with `force: true` and may make commits unreachable.",
    "- It never directly deletes a remote or remote-tracking branch.",
    "",
    "## Worktree handoff",
    "",
    "- `list_worktrees` — inspect the main and linked worktrees in the current repository.",
    "- `create_worktree` — create a linked worktree and return a ready handoff with an absolute `handoff.cwd`.",
    "- A separate orchestrator starts the next Pi session or subagent in `handoff.cwd`.",
    "- `remove_worktree` — remove a verified clean linked worktree while retaining its local branch; `deleteIgnored: true` explicitly deletes ignored residue.",
    "- BranchMe does not change cwd, start Pi, or copy `.env`; `remove_worktree` never removes its retained branch automatically.",
    "",
    "## Requirements",
    "",
    "- Keep `git` available. Existing-repository tools run inside a Git repo; `init_repository` targets only the exact current non-repository directory.",
    "- For PRs: GitHub `origin` and `GITHUB_TOKEN` or `GH_TOKEN` (environment or `.env`).",
    "- Optional: set `BRANCHME_PR_AUTOFILL=true` in the environment or `.env` to generate omitted PR fields.",
    "- `fetch_branch` without `branch`, `pull_branch`, and default `rebase_branch` require a configured upstream; explicit rebase baseRef does not.",
    "- `create_branch` and `rebase_branch` accept captured baseRef values; fetch separately and prefer update_from_base for published features.",
    "- Branch-dependent tools accept a verified same-repository worktreePath without changing Pi's cwd; mutating tool calls are serialized across worktrees in this process.",
    "- `pull_branch` and `rebase_branch` require a clean working tree.",
    "- `rebase_branch` rewrites local commits only when explicitly requested and auto-aborts on failure.",
    "- BranchMe never force-pushes. Ordinary commits happen only through `commit_changes`. Guarded index/restore/revert tools and the existing Git-generated merge commits remain explicit actions.",
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

function safeWarningText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function repositoryWarningFromError(error: unknown): string | null {
  const message = safeWarningText(error);
  if (/Unable to resolve a GitHub repository from origin or GITHUB_REPOSITORY/iu.test(message)) return null;
  if (/Not a git repository/iu.test(message)) return null;
  return message;
}

function tokenWarningFromError(error: unknown): string | null {
  const message = safeWarningText(error);
  if (/GitHub token is required\. Set GITHUB_TOKEN or GH_TOKEN/iu.test(message)) return null;
  return message;
}

function hasPanelWarning(data: BranchMePanelData): boolean {
  return Boolean(data.statusNote || data.repositoryWarning || data.tokenWarning);
}

function summaryRepository(data: BranchMePanelData): string {
  return data.repositoryWarning ? `warning: ${data.repositoryWarning}` : data.githubRepository ?? "not resolved";
}

function summaryToken(data: BranchMePanelData): string {
  if (data.tokenWarning) return `warning: ${data.tokenWarning}`;
  if (data.tokenSource) return `present (${data.tokenSource})`;
  return "not set";
}

function summaryStatusWarning(data: BranchMePanelData): string {
  return data.statusNote ? `; warning: ${data.statusNote}` : "";
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
    data.statusNote = safeWarningText(error);
  }

  if (!data.statusNote) {
    try {
      const repository = await resolveGitHubRepository(pi, ctx, ctx.signal);
      data.githubRepository = repositoryLabel(repository);
    } catch (error) {
      data.githubRepository = null;
      data.repositoryWarning = repositoryWarningFromError(error) ?? undefined;
    }
  }

  try {
    data.tokenSource = (await resolveGitHubToken(process.env, { cwd: tokenLookupCwd, signal: ctx.signal })).source;
  } catch (error) {
    data.tokenSource = null;
    data.tokenWarning = tokenWarningFromError(error) ?? undefined;
  }

  return data;
}

async function showPanel(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionCommandContext): Promise<void> {
  const data = await collectPanelData(pi, ctx);

  if (ctx.mode !== "tui") {
    const branch = data.detached ? "detached HEAD" : data.currentBranch ?? "unknown";
    emitCommandMessage(
      ctx,
      `${EXTENSION_DISPLAY_NAME}: branch ${branch}; GitHub repository ${summaryRepository(data)}; token ${summaryToken(data)}${summaryStatusWarning(data)}.`,
      hasPanelWarning(data) ? "warning" : "info",
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
