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
2. `change_branch` / `create_branch` — switch to an existing clean branch or create one from `HEAD`.
3. Commit outside BranchMe.
4. `push_branch` — push the current branch.
5. `pull_request` — open a PR in the current GitHub repo.

## Requirements

- Run inside a Git repo with `git` available.
- For PRs: GitHub `origin` and `GITHUB_TOKEN` or `GH_TOKEN` (environment or `.env`).
- BranchMe never stages or commits.
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
│                     │  create_branch  -> from HEAD                           │
│                     │  push_branch    -> current branch                      │
│                     │  pull_request   -> current repo PR                     │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ 2/2 • workflow • inspect → change/create → push → PR                         │
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
├────────────────────────────────────────────────┤
│ 1/2 • warning • Unable to resolve a GitHub rep…│
╰────────────────────────────────────────────────╯
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
├───────────────────┴──────────────────────────────────────────────────┤
│ 1/2 • warning • This deliberately long status note is captured to de…│
╰──────────────────────────────────────────────────────────────────────╯
```
