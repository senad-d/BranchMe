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

BranchMe adds current-repository branch workflow tools to Pi.

## Workflow

1. Use `branch_status` to inspect the current repository and branch state.
2. Use `create_branch` with an explicit `branchName` to create and checkout a branch from current `HEAD`.
3. Create commits outside BranchMe.
4. Use `push_branch` to push the current branch, publishing it to `origin` when no upstream exists.
5. Use `pull_request` with explicit PR fields to open a GitHub pull request in the current repository.

BranchMe slash commands are informational only; they never create branches, push, commit, or open pull requests.
```

## Panel: Tiny mode: clean branch with token

Width: 18

```text
BranchMe··········
feature/current···
senad-d/branchme··
q quit············
```

## Panel: Narrow mode: clean branch with token

Width: 40

```text
╭ BranchMe ──────────────────── Status ╮
│↑↓ status • tools: branch_status → cr…│
│q quit • Esc close • /branchme help f…│
├──────────────────────────────────────┤
│▶ Current branch feature/current      │
│GitHub repository …nad-d/branchme     │
│GitHub token …(GITHUB_TOKEN)          │
├──────────────────────────────────────┤
│1/3 • Tools perform actions; /branchm…│
╰──────────────────────────────────────╯
```

## Panel: Wide mode: clean branch with token

Width: 80

```text
╭ BranchMe ──────────────────────────────────────────────────────────── Status ╮
│↑↓ status • tools: branch_status → create_branch → push_branch → pull_request │
│q quit • Esc close • /branchme help for workflow notes                        │
├──────────────────────────────────────────────────────────────────────────────┤
│▶ Current branch feature/current                                              │
│GitHub repository senad-d/branchme                                            │
│GitHub token present (GITHUB_TOKEN)                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│1/3 • Tools perform actions; /branchme is informational only.                 │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Fallback values: detached HEAD without repository or token

Width: 50

```text
╭ BranchMe ────────────────────────────── Status ╮
│↑↓ status • tools: branch_status → create_branc…│
│q quit • Esc close • /branchme help for workflo…│
├────────────────────────────────────────────────┤
│▶ Current branch detached HEAD                  │
│GitHub repository not resolved                  │
│GitHub token not set                            │
├────────────────────────────────────────────────┤
│1/3 • Unable to resolve a GitHub repository fro…│
╰────────────────────────────────────────────────╯
```

## Panel: Long values: truncation and tail preservation

Width: 72

```text
╭ BranchMe ──────────────────────────────────────────────────── Status ╮
│↑↓ status • tools: branch_status → create_branch → push_branch → pull…│
│q quit • Esc close • /branchme help for workflow notes                │
├──────────────────────────────────────────────────────────────────────┤
│▶ Current branch feature/super-long-branch-name-for-layout-regression…│
│GitHub repository …epository-name-for-branchme                        │
│GitHub token present (GITHUB_TOKEN)                                   │
├──────────────────────────────────────────────────────────────────────┤
│1/3 • This deliberately long status note is captured to detect wrappi…│
╰──────────────────────────────────────────────────────────────────────╯
```
