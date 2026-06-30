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
│↑↓ section • q quit • /branchme help  │
├──────────────────────────────────────┤
│STATUS                                │
│Current branch feature/current        │
│GitHub repository …nad-d/branchme     │
│GitHub token present                  │
│                                      │
│                                      │
│                                      │
├──────────────────────────────────────┤
│1/3 • status • current repository onl…│
╰──────────────────────────────────────╯
```

## Panel: Wide mode: Status selected

Width: 80

```text
╭ BranchMe ──────────────────────────────────────────────────────────── Status ╮
│↑↓ section • q quit • /branchme help                                          │
├─────────────────────┬────────────────────────────────────────────────────────┤
│▶  Status            │STATUS                                                  │
│   Workflow          │Current branch feature/current                          │
│   Safety            │GitHub repository senad-d/branchme                      │
│                     │GitHub token present                                    │
│                     │                                                        │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│1/3 • status • current repository only • tools perform actions                │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Wide mode: Workflow selected

Width: 80

```text
╭ BranchMe ────────────────────────────────────────────────────────── Workflow ╮
│↑↓ section • q quit • /branchme help                                          │
├─────────────────────┬────────────────────────────────────────────────────────┤
│   Status            │WORKFLOW                                                │
│▶  Workflow          │1 branch_status inspect                                 │
│   Safety            │2 create_branch from HEAD                               │
│                     │3 push_branch current branch                            │
│                     │4 pull_request current repo PR                          │
│                     │                                                        │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│2/3 • workflow • inspect → branch → push → PR                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Wide mode: Safety selected

Width: 80

```text
╭ BranchMe ──────────────────────────────────────────────────────────── Safety ╮
│↑↓ section • q quit • /branchme help                                          │
├─────────────────────┬────────────────────────────────────────────────────────┤
│   Status            │SAFETY                                                  │
│   Workflow          │Commits never                                           │
│▶  Safety            │Staging never                                           │
│                     │File edits never                                        │
│                     │Repository current only                                 │
│                     │Token source env only                                   │
│                     │                                                        │
├─────────────────────┴────────────────────────────────────────────────────────┤
│3/3 • safety • no commits/staging/file edits                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Very wide terminal: panel width capped

Width: 112

```text
╭ BranchMe ──────────────────────────────────────────────────────────────────────────── Status ╮
│↑↓ section • q quit • /branchme help                                                          │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│▶  Status             │STATUS                                                                 │
│   Workflow           │Current branch main                                                    │
│   Safety             │GitHub repository senad-d/BranchMe                                     │
│                      │GitHub token not set                                                   │
│                      │                                                                       │
│                      │                                                                       │
│                      │                                                                       │
├──────────────────────┴───────────────────────────────────────────────────────────────────────┤
│1/3 • status • current repository only • tools perform actions                                │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Panel: Fallback values: detached HEAD without repository or token

Width: 50

```text
╭ BranchMe ────────────────────────────── Status ╮
│current repo only • informational               │
│↑↓ section • q quit • /branchme help            │
├────────────────────────────────────────────────┤
│STATUS                                          │
│Current branch detached HEAD                    │
│GitHub repository not resolved                  │
│GitHub token not set                            │
│                                                │
│                                                │
│                                                │
├────────────────────────────────────────────────┤
│1/3 • warning • Unable to resolve a GitHub repo…│
╰────────────────────────────────────────────────╯
```

## Panel: Long values: truncation and tail preservation

Width: 72

```text
╭ BranchMe ──────────────────────────────────────────────────── Status ╮
│↑↓ section • q quit • /branchme help                                  │
├───────────────────┬──────────────────────────────────────────────────┤
│▶  Status          │STATUS                                            │
│   Workflow        │Current branch …t-regression-capture              │
│   Safety          │GitHub repository …ry-name-for-branchme           │
│                   │GitHub token present                              │
│                   │                                                  │
│                   │                                                  │
│                   │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│1/3 • warning • This deliberately long status note is captured to det…│
╰──────────────────────────────────────────────────────────────────────╯
```
