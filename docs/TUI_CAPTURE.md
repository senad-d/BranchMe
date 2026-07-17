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

Current-repository branch workflow tools for Pi.

Commands only show info; BranchMe tools perform actions.

## Workflow

1. `branch_status` — inspect repo and branch state.
2. `change_branch` — switch to a clean existing local branch.
3. `fetch_branch` — fetch its configured upstream remote without changing local files.
4. `pull_branch` — fast-forward from upstream, or `rebase_branch` — rebase local commits onto upstream.
5. `create_branch` — create a new branch from the updated `HEAD`.
6. Commit outside BranchMe.
7. `push_branch` — push the current branch.
8. `pull_request` — open a PR after `push_branch` completes and GitHub sees the branches.

## Requirements

- Run inside a Git repo with `git` available.
- For PRs: GitHub `origin` and `GITHUB_TOKEN` or `GH_TOKEN` (environment or `.env`).
- `fetch_branch`, `pull_branch`, and `rebase_branch` require a configured upstream.
- `pull_branch` and `rebase_branch` require a clean working tree.
- `rebase_branch` rewrites local commits only when explicitly requested and auto-aborts on failure.
- BranchMe never stages, creates user-authored commits, force-pushes, or creates merge commits.
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
│ 1/2 • status • current repository on…│
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
│                     │  GitHub repository: senad-d/branchme                   │
│                     │  GitHub token:      present                            │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 1/2 • status • current repository only • tools perform actions               │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Wide mode: Workflow selected

Width: 80

```text
╭ BranchMe ────────────────────────────────────────────────────────── Workflow ╮
│ ↑↓ section • q quit • /branchme help                                         │
├─────────────────────┬────────────────────────────────────────────────────────┤
│   Status            │ WORKFLOW                                               │
│▶  Workflow          │  branch_status  -> inspect                             │
│                     │  change_branch  -> existing local                      │
│                     │  fetch_branch   -> upstream remote                     │
│                     │  pull_branch    -> fast-forward                        │
│                     │  rebase_branch  -> onto upstream                       │
│                     │  create_branch  -> from HEAD                           │
│                     │  push_branch    -> current branch                      │
│                     │  pull_request   -> after push                          │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 2/2 • workflow • inspect → change → fetch/pull/rebase → create → push → PR   │
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
│                      │  GitHub repository: senad-d/BranchMe                                  │
│                      │  GitHub token:      not set                                           │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
├──────────────────────┴───────────────────────────────────────────────────────────────────────┤
│ 1/2 • status • current repository only • tools perform actions                               │
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
│ 1/2 • warning • Unable to resolve a GitHub rep…│
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
│                     │  GitHub repository: warning: Repository boundary misma…│
│                     │  GitHub token:      present                            │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 1/2 • warning • Repository boundary mismatch: local origin resolves to senad…│
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
│                   │  GitHub repository: senad-d/branchme             │
│                   │  GitHub token:      warning: Unable to read .env…│
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│ 1/2 • warning • Unable to read .env file for GitHub token fallback: …│
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
│                   │  GitHub repository: very-long-owner-name/very-lo…│
│                   │  GitHub token:      present                      │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│ 1/2 • warning • This deliberately long status note is captured to de…│
╰──────────────────────────────────────────────────────────────────────╯
```
