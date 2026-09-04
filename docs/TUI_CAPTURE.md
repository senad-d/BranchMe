# BranchMe TUI Capture

This file is a deterministic text capture of BranchMe user-facing TUI/help surfaces.
Use it as a visual baseline when improving layout, wording, spacing, or responsive behavior.
Trailing spaces are shown as `·` so formatting checks can keep the repository whitespace-clean.

Generated and verified by `test/tui-capture.test.mjs`.
Update intentionally with:

```text
UPDATE_TUI_CAPTURE=1 node --test test/tui-capture.test.mjs
```

## /branchme help

```text
# BranchMe

Current-repository Git workflow tools for Pi.

Commands only show info; BranchMe tools perform actions.

## Workflow

1. `branch_status` — inspect repo and branch state.
2. `change_branch` — switch to a clean existing local branch.
3. `fetch_branch` — fetch its configured upstream remote (or an explicit `remote`/`branch`) without changing local files.
4. `pull_branch` — fast-forward from upstream, or `rebase_branch` — rebase local commits onto upstream.
5. `create_branch` — create a new branch from the updated `HEAD`.
6. Commit outside BranchMe.
7. `push_branch` — push the current branch.
8. `pull_request` — open a PR after `push_branch` completes and GitHub sees the branches.

## Branch integration

- `integrate_branch` — integrate an exact local source into an exact local target; the clean control worktree must already have the target checked out.
- It never fetches or pushes; a conflict is automatically aborted after paths are captured and restoration is verified.
- BranchMe does not resolve semantic conflicts; handle them in a separate developer workflow.

## Branch retirement

- `remove_worktree` and `retire_branch` are separate: removal retains the branch; retirement later deletes only the exact local branch ref.
- `retire_branch` requires the exact local branch, its full expected `HEAD`, and an exact local target for ancestry verification.
- Any registered worktree occupancy rejects retirement; remove an occupying linked worktree separately first.
- Merged retirement uses `force: false`; unmerged retirement requires explicit authorization with `force: true` and may make commits unreachable.
- It never directly deletes a remote or remote-tracking branch.

## Worktree handoff

- `list_worktrees` — inspect the main and linked worktrees in the current repository.
- `create_worktree` — create a linked worktree and return a ready handoff with an absolute `handoff.cwd`.
- A separate orchestrator starts the next Pi session or subagent in `handoff.cwd`.
- `remove_worktree` — remove a verified clean linked worktree while retaining its local branch.
- BranchMe does not change cwd, start Pi, or copy `.env`; `remove_worktree` never removes its retained branch automatically.

## Requirements

- Run inside a Git repo with `git` available.
- For PRs: GitHub `origin` and `GITHUB_TOKEN` or `GH_TOKEN` (environment or `.env`).
- Optional: set `BRANCHME_PR_AUTOFILL=true` in the environment or `.env` to generate omitted PR fields.
- `fetch_branch` without `branch`, `pull_branch`, and `rebase_branch` require a configured upstream.
- `pull_branch` and `rebase_branch` require a clean working tree.
- `rebase_branch` rewrites local commits only when explicitly requested and auto-aborts on failure.
- BranchMe never stages, creates user-authored commits, or force-pushes.
```

## Panel: Tiny mode: clean branch with token

Width: 18

```text
BranchMe
branch: feature/c…
repo: senad-d/bra…
q quit
```

## Panel: Narrow mode: clean branch with token

Width: 40

```text
╭ BranchMe ──────────────────── Status ╮
│current repo only • informational     │
│ ↑↓ section • q quit • /branchme help │
├──────────────────────────────────────┤
│ STATUS                               │
│  Current branch:    feature/current  │
│  GitHub repository: senad-d/branchme │
│  GitHub token:      present          │
│                                      │
│                                      │
│                                      │
│                                      │
│                                      │
├──────────────────────────────────────┤
│ 1/4 • status • current repository on…│
╰──────────────────────────────────────╯
```

## Panel: Narrow mode: Lifecycle selected

Width: 40

```text
╭ BranchMe ───────────────── Lifecycle ╮
│current repo only • informational     │
│ ↑↓ section • q quit • /branchme help │
├──────────────────────────────────────┤
│ LIFECYCLE                            │
│  integrate_branch -> exact local sou…│
│  control target   -> checked out + c…│
│  conflict         -> automatic verif…│
│  semantic intent  -> separate develo…│
│  remove_worktree  -> separate; branc…│
│  retire_branch    -> leased local re…│
│  retirement guard -> unoccupied + ta…│
│  remote effects   -> never delete re…│
├──────────────────────────────────────┤
│ 3/4 • lifecycle • integrate → remove…│
╰──────────────────────────────────────╯
```

## Panel: Wide mode: Status selected

Width: 80

```text
╭ BranchMe ──────────────────────────────────────────────────────────── Status ╮
│ ↑↓ section • q quit • /branchme help                                         │
├─────────────────────┬────────────────────────────────────────────────────────┤
│▶  Status            │ STATUS                                                 │
│   Workflow          │  Current branch:    feature/current                    │
│   Lifecycle         │  GitHub repository: senad-d/branchme                   │
│   Worktrees         │  GitHub token:      present                            │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 1/4 • status • current repository only • tools perform actions               │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Wide mode: Workflow selected

Width: 80

```text
╭ BranchMe ────────────────────────────────────────────────────────── Workflow ╮
│ ↑↓ section • q quit • /branchme help                                         │
├─────────────────────┬────────────────────────────────────────────────────────┤
│   Status            │ WORKFLOW                                               │
│▶  Workflow          │  branch_status    -> inspect                           │
│   Lifecycle         │  change_branch    -> existing local                    │
│   Worktrees         │  fetch_branch     -> upstream remote                   │
│                     │  pull_branch      -> fast-forward                      │
│                     │  rebase_branch    -> onto upstream                     │
│                     │  create_branch    -> from HEAD                         │
│                     │  push_branch      -> current branch                    │
│                     │  pull_request     -> after push                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 2/4 • workflow • inspect → change → fetch/pull/rebase → create → push → PR   │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Wide mode: Lifecycle selected

Width: 80

```text
╭ BranchMe ───────────────────────────────────────────────────────── Lifecycle ╮
│ ↑↓ section • q quit • /branchme help                                         │
├─────────────────────┬────────────────────────────────────────────────────────┤
│   Status            │ LIFECYCLE                                              │
│   Workflow          │  integrate_branch -> exact local source -> target      │
│▶  Lifecycle         │  control target   -> checked out + clean               │
│   Worktrees         │  conflict         -> automatic verified abort          │
│                     │  semantic intent  -> separate developer workflow       │
│                     │  remove_worktree  -> separate; branch retained         │
│                     │  retire_branch    -> leased local ref deletion         │
│                     │  retirement guard -> unoccupied + target ancestry      │
│                     │  remote effects   -> never delete remote refs          │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 3/4 • lifecycle • integrate → remove worktree separately → retire local ref  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Wide mode: Worktrees selected

Width: 80

```text
╭ BranchMe ───────────────────────────────────────────────────────── Worktrees ╮
│ ↑↓ section • q quit • /branchme help                                         │
├─────────────────────┬────────────────────────────────────────────────────────┤
│   Status            │ WORKTREES                                              │
│   Workflow          │  list_worktrees   -> inspect inventory                 │
│   Lifecycle         │  create_worktree  -> ready handoff.cwd                 │
│▶  Worktrees         │  remove_worktree  -> clean linked; branch retained     │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 4/4 • worktrees • create → handoff cwd → next session • remove retains branch│
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Very wide terminal: panel width capped

Width: 112

```text
╭ BranchMe ──────────────────────────────────────────────────────────────────────────── Status ╮
│ ↑↓ section • q quit • /branchme help                                                         │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│▶  Status             │ STATUS                                                                │
│   Workflow           │  Current branch:    main                                              │
│   Lifecycle          │  GitHub repository: senad-d/BranchMe                                  │
│   Worktrees          │  GitHub token:      not set                                           │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
├──────────────────────┴───────────────────────────────────────────────────────────────────────┤
│ 1/4 • status • current repository only • tools perform actions                               │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Fallback values: detached HEAD without repository or token

Width: 50

```text
╭ BranchMe ────────────────────────────── Status ╮
│current repo only • informational               │
│ ↑↓ section • q quit • /branchme help           │
├────────────────────────────────────────────────┤
│ STATUS                                         │
│  Current branch:    detached HEAD              │
│  GitHub repository: not resolved               │
│  GitHub token:      not set                    │
│                                                │
│                                                │
│                                                │
│                                                │
│                                                │
├────────────────────────────────────────────────┤
│ 1/4 • warning • Unable to resolve a GitHub rep…│
╰────────────────────────────────────────────────╯
```

## Panel: Repository warning: boundary mismatch

Width: 80

```text
╭ BranchMe ──────────────────────────────────────────────────────────── Status ╮
│ ↑↓ section • q quit • /branchme help                                         │
├─────────────────────┬────────────────────────────────────────────────────────┤
│▶  Status            │ STATUS                                                 │
│   Workflow          │  Current branch:    main                               │
│   Lifecycle         │  GitHub repository: warning: Repository boundary misma…│
│   Worktrees         │  GitHub token:      present                            │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 1/4 • warning • Repository boundary mismatch: local origin resolves to senad…│
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Token warning: fallback error

Width: 72

```text
╭ BranchMe ──────────────────────────────────────────────────── Status ╮
│ ↑↓ section • q quit • /branchme help                                 │
├───────────────────┬──────────────────────────────────────────────────┤
│▶  Status          │ STATUS                                           │
│   Workflow        │  Current branch:    main                         │
│   Lifecycle       │  GitHub repository: senad-d/branchme             │
│   Worktrees       │  GitHub token:      warning: Unable to read .env…│
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│ 1/4 • warning • Unable to read .env file for GitHub token fallback: …│
╰──────────────────────────────────────────────────────────────────────╯
```

## Panel: Long values: truncation

Width: 72

```text
╭ BranchMe ──────────────────────────────────────────────────── Status ╮
│ ↑↓ section • q quit • /branchme help                                 │
├───────────────────┬──────────────────────────────────────────────────┤
│▶  Status          │ STATUS                                           │
│   Workflow        │  Current branch:    feature/super-long-branch-na…│
│   Lifecycle       │  GitHub repository: very-long-owner-name/very-lo…│
│   Worktrees       │  GitHub token:      present                      │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│ 1/4 • warning • This deliberately long status note is captured to de…│
╰──────────────────────────────────────────────────────────────────────╯
```
