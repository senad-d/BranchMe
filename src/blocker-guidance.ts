/**
 * Every BranchMe tool error reaches the agent as text. Known blockers get two extra
 * lines: why the call was blocked and the next call that resolves it, so an agent
 * without a shell can recover instead of stopping at the first refusal.
 */

interface BlockerRule {
  pattern: RegExp;
  why: string;
  resolve: string;
}

// First match wins: specific Git and GitHub causes before generic ones.
const BLOCKER_RULES: readonly BlockerRule[] = [
  {
    pattern: /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or (password|token)|The requested URL returned error: 40[13]|Permission to \S+ denied/iu,
    why: "the remote rejected the request or received no credentials.",
    resolve: "set GITHUB_TOKEN or GH_TOKEN (process environment or the repository .env) to a token with read and write access to this repository's contents, or configure a git credential helper, then retry the same call once.",
  },
  {
    pattern: /Could not resolve host|Failed to connect|Connection (timed out|refused)|unable to access/iu,
    why: "the remote host could not be reached.",
    resolve: "retry once; if it fails again, report the remote as unreachable and stop.",
  },
  {
    pattern: /\(killed\)|was killed or timed out/iu,
    why: "git did not finish within the time limit (slow or unreachable network).",
    resolve: "retry the same call once; if it times out again, report the remote as unreachable and stop.",
  },
  {
    pattern: /\[rejected\]|non-fast-forward|\(fetch first\)|Updates were rejected/iu,
    why: "the remote branch has commits the local branch does not.",
    resolve: "fetch_branch, then pull_branch (or rebase_branch when history rewriting is authorized), then push_branch again; never force-push without explicit authorization.",
  },
  {
    pattern: /Not possible to fast-forward|diverg/iu,
    why: "the local and remote branches have diverged; pull_branch only fast-forwards.",
    resolve: "rebase_branch when history rewriting is authorized, or update_from_base to merge the base; otherwise report the divergence.",
  },
  {
    pattern: /couldn't find remote ref/iu,
    why: "the remote has no branch of that name (a new or empty repository, or a wrong name).",
    resolve: "fetch_remote, then list_branches to see the remote branches; push_branch publishes the current branch and creates it on the remote.",
  },
  {
    pattern: /would be overwritten by (checkout|merge)|untracked working tree files would be/iu,
    why: "local files collide with files on the other branch.",
    resolve: "the files git names must be committed, moved, or removed by the step that owns them; then retry.",
  },
  {
    pattern: /Tracked files have uncommitted changes/iu,
    why: "the named tracked files have uncommitted changes.",
    resolve: "commit them with commitme when they are approved for this step, or hand them to the step that owns them; then retry. Untracked files are never the blocker.",
  },
  {
    pattern: /has staged, unstaged, untracked, or unmerged changes/iu,
    why: "the selected worktree has uncommitted changes, including possible untracked files.",
    resolve: "commit approved changes with commitme or preserve them outside the worktree, then retry. remove_worktree with discardChanges: true requires explicit authorization to discard them; land_branch never discards uncommitted changes.",
  },
  {
    pattern: /occupied by \d+ registered worktree|already checked out in a worktree|occupies multiple worktrees|became occupied/iu,
    why: "the branch is checked out in a worktree.",
    resolve: "change_branch that checkout to another branch, or remove a linked worktree with remove_worktree, then retry. land_branch switches the primary checkout itself when it has no tracked changes.",
  },
  {
    pattern: /Target checkout has tracked changes/iu,
    why: "the target branch's checkout has tracked changes, so it was not updated.",
    resolve: "commit or hand off those changes, then pull_branch in that checkout.",
  },
  {
    pattern: /in-progress Git operation|must be completed or aborted|merge is in progress/iu,
    why: "a merge, rebase, or cherry-pick is in progress.",
    resolve: "finish or abort a merge with conclude_merge; any other operation needs a person, so report it.",
  },
  {
    pattern: /HEAD is detached|while HEAD is detached/iu,
    why: "HEAD is not on a branch.",
    resolve: "change_branch to a local branch, then retry.",
  },
  {
    pattern: /no upstream is configured/iu,
    why: "the current branch has no upstream.",
    resolve: "push_branch publishes the branch and sets its upstream; track_branch sets one for an existing remote branch.",
  },
  {
    pattern: /GitHub token is required/iu,
    why: "no GitHub token was found.",
    resolve: "set GITHUB_TOKEN or GH_TOKEN in the process environment or the repository .env, then retry.",
  },
  {
    pattern: /HTTP 401/iu,
    why: "GitHub rejected the token.",
    resolve: "replace GITHUB_TOKEN or GH_TOKEN with a valid token, then retry.",
  },
  {
    pattern: /HTTP 40[34]/iu,
    why: "the token cannot see or change this repository (GitHub answers 404 for a private repository it cannot see).",
    resolve: "use a token with access to this repository (contents and pull requests), then retry.",
  },
  {
    pattern: /Already on branch/iu,
    why: "the checkout is already on that branch.",
    resolve: "nothing to do; continue with the next step.",
  },
  {
    pattern: /Local branch .* already exists/iu,
    why: "a local branch with that name exists.",
    resolve: "change_branch to use it, or pick another name.",
  },
  {
    pattern: /Local branch .* does not exist|local branch '.*' does not exist|Local target branch (does not exist|is absent)/iu,
    why: "no local branch has that name.",
    resolve: "list_branches to check names (fetch_remote first for remote branches); track_branch creates a local branch from a remote one.",
  },
  {
    pattern: /moved after|changed while|moved concurrently|changed during/iu,
    why: "repository state changed while the call ran.",
    resolve: "refresh with branch_status or list_branches and retry once with the new values.",
  },
];

/** "Blocked: ...\nResolve: ..." for a known blocker in `message`, otherwise null. */
export function blockerGuidance(message: string): string | null {
  const rule = BLOCKER_RULES.find((candidate) => candidate.pattern.test(message));
  return rule ? `Blocked: ${rule.why}\nResolve: ${rule.resolve}` : null;
}

function guidedError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const guidance = blockerGuidance(error.message);
  if (!guidance || error.message.includes("\nResolve: ")) return error;
  return new Error(`${error.message}\n${guidance}`, { cause: error });
}

async function executeWithGuidance<TArgs extends unknown[], TResult>(
  execute: (...args: TArgs) => Promise<TResult>,
  signalIndex: number,
  ...args: TArgs
): Promise<TResult> {
  try {
    return await execute(...args);
  } catch (error) {
    const signal = args[signalIndex] as AbortSignal | undefined;
    if (signal?.aborted) throw error;
    throw guidedError(error);
  }
}

/** Wraps a Pi tool so known blockers in its errors carry Blocked/Resolve lines. */
export function withBlockerGuidance<TTool extends { execute: (...args: never[]) => Promise<unknown> }>(tool: TTool): TTool {
  // Pi calls execute(toolCallId, params, signal, onUpdate, ctx).
  const execute = tool.execute as unknown as (...args: unknown[]) => Promise<unknown>;
  return { ...tool, execute: executeWithGuidance.bind(undefined, execute, 2) as unknown as TTool["execute"] };
}
