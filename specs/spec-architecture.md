# Plan: BranchMe Architecture

## Task Description

Define the architecture for BranchMe, a minimal TypeScript Pi extension package that will later provide git branch workflow tools for the current repository only.

## Objective

Create a clear implementation blueprint for a later session without implementing runtime behavior during preparation.

## Problem Statement

Pi users and CI workflows need a small, automation-friendly extension that can create a branch, publish the current branch, and create a GitHub pull request without also handling commits. Commit creation already belongs to CommitMe, so BranchMe must stay narrowly focused.

## Solution Approach

BranchMe will expose a help/config slash command and four custom tools. The slash command is informational only. All git and GitHub mutations happen through explicit tool calls with precise schemas and current-repository boundary checks.

## Approved Project Definition

- Package: `@senad-d/branchme`
- Display name: `BranchMe`
- Exported extension function: `branchMeExtension`
- Repository: `https://github.com/senad-d/branchme`
- Template source: `/Users/senad/Documents/Code/Moj_git/pi-tmp`
- Target directory: `/Users/senad/Documents/Code/Moj_git/pi-branchme`
- Pitch: Minimal Pi tools for creating the current-repo branch, publishing it, and opening a GitHub pull request.

## Architecture Overview

```text
src/
├── extension.ts                  # small extension entry point
├── constants.ts                  # names, timeouts, status key, GitHub API constants
├── types.ts                      # serializable details and domain result types
├── commands/
│   └── branchme-command.ts       # /branchme and /branchme help, informational only
├── tools/
│   └── branchme-tools.ts         # registers branch_status/create_branch/push_branch/pull_request
├── git.ts                        # git command helpers and current-repo validation
├── github.ts                     # token resolution, repository resolution, PR REST call
└── ui/
    └── branchme-panel.ts         # simple TUI panel component, if custom UI is needed
```

`src/extension.ts` must stay small. It should import feature registration functions and call them only. It must not start long-lived processes, file watchers, timers, sockets, or background jobs.

## Pi Integration Surface

| Surface | Name | Purpose | Runtime boundary |
| --- | --- | --- | --- |
| Command | `/branchme` | Show a simple TUI status/config/help panel | Informational only; no git/GitHub actions |
| Command | `/branchme help` | Show markdown workflow notes | Informational only |
| Tool | `branch_status` | Inspect current repository, branch, upstream, and dirty/ahead/behind state | Read-only git commands |
| Tool | `create_branch` | Create and checkout a new branch from current `HEAD` | Mutates git branch/HEAD only |
| Tool | `push_branch` | Push current branch, publishing upstream to `origin` if missing | Mutates remote refs only; never commits |
| Tool | `pull_request` | Create a GitHub PR for the current repository | Network call to GitHub REST API |
| Event | `session_start`/`session_shutdown` | Optional status footer setup/cleanup | No long-lived resources |

## Tool Contracts

### `branch_status`

- Parameters: strict empty object.
- Behavior:
  - Verify `ctx.cwd` is inside a git working tree.
  - Resolve repository root.
  - Resolve current branch or detached HEAD state.
  - Resolve upstream branch when present.
  - Report dirty status and ahead/behind counts when upstream exists.
  - Resolve GitHub repository identity from current repo metadata when possible.
- Result details should include at least:
  - `repoRoot`
  - `currentBranch`
  - `detached`
  - `upstream`
  - `hasChanges`
  - `ahead`
  - `behind`
  - `githubRepository` when resolved

### `create_branch`

- Parameters: strict object with required `branchName`.
- Branch source: current `HEAD` only. No `baseRef` parameter.
- Validation:
  - `branchName` is non-empty, one line, no NUL/control characters.
  - `git check-ref-format --branch <branchName>` passes.
  - Branch does not already exist locally.
  - Repository is not in detached/invalid state when checkout would be unsafe.
- Behavior:
  - Run `git switch -c <branchName>` or equivalent argv-style git command.
  - Return new branch and previous branch in details.
- Non-behavior:
  - Never commits, stages, pushes, rebases, or edits files.

### `push_branch`

- Parameters: strict empty object.
- Branch target: current branch only. No `branchName` parameter.
- Behavior:
  - Fail on detached HEAD.
  - Detect upstream for current branch.
  - If upstream exists, run `git push`.
  - If upstream is missing, run `git push --set-upstream origin <currentBranch>`.
  - Return current branch, upstream, publish mode, and git output summary.
- Non-behavior:
  - Never commits or stages changes.
  - Never pushes a branch other than the current branch.

### `pull_request`

- Parameters: strict object with required fields:
  - `headBranch`: branch containing changes.
  - `baseBranch`: target branch.
  - `title`: non-empty PR title.
  - `body`: PR body string; may be empty only if intentionally passed as `""`.
  - `draft`: boolean; required so automation chooses deliberately.
- Repository boundary:
  - The tool must infer owner/repo from the current repository only.
  - It must not accept owner/repo parameters.
  - If `GITHUB_REPOSITORY` and local git remote both exist and disagree, fail closed.
- Auth:
  - Read `GITHUB_TOKEN` first or `GH_TOKEN` as fallback from process env only.
  - Do not read `.env` in v1 unless explicitly added in a future spec.
  - Never include token values in output, errors, or details.
- Behavior:
  - Optionally validate `headBranch` equals the current branch to avoid accidental PRs from another branch.
  - POST to `https://api.github.com/repos/{owner}/{repo}/pulls`.
  - Request body: `{ title, head: headBranch, base: baseBranch, body, draft }`.
  - Return PR number, URL, state, head, base, and draft flag.

## Git Command Strategy

- Use `pi.exec("git", args, { cwd: ctx.cwd, signal, timeout })` only.
- Never build shell command strings for git operations.
- Use argument arrays for branch names and refs.
- Prefer deterministic commands:
  - `git rev-parse --show-toplevel`
  - `git symbolic-ref --short HEAD`
  - `git status --porcelain=v1 --branch`
  - `git rev-parse --abbrev-ref --symbolic-full-name @{u}`
  - `git rev-list --left-right --count HEAD...@{u}`
  - `git check-ref-format --branch <branchName>`
  - `git switch -c <branchName>`
  - `git push` or `git push --set-upstream origin <branch>`

## GitHub Repository Resolution

Preferred order:

1. Resolve local `origin` URL using git config or `git remote get-url origin`.
2. Read `GITHUB_REPOSITORY` from process env as CI-compatible fallback.
3. If both exist and are valid but disagree, throw a boundary error.
4. Support only GitHub HTTPS and SSH origin forms:
   - `https://github.com/owner/repo.git`
   - `git@github.com:owner/repo.git`
   - `ssh://git@github.com/owner/repo.git`

The tool must never accept owner/repo input because the extension is scoped to the current repository.

## Config, State, and Persistence

- No persisted config in v1.
- `/branchme` may display runtime status such as token presence, current branch, and repository identity.
- Branch-sensitive state should live in tool result `details` when needed.
- Reconstruct any future branch-sensitive state from current branch on `session_start`.
- Do not call `pi.appendEntry()` unless a future implementation introduces real session state.

## TUI Panel

- `/branchme` opens a basic TUI panel in TUI mode.
- `/branchme help`, `/branchme --help`, and `/branchme -h` show help text.
- In non-TUI modes, `/branchme` should fall back to a concise markdown/help message or notification.
- The panel should be small and practical:
  - current branch
  - GitHub repository if detected
  - token presence without token value
  - planned tool workflow notes
  - key hint to close
- Do not add action buttons in v1. Tools perform actions.

## Security Boundaries

- BranchMe runs with the user's local permissions because Pi extensions are not sandboxed.
- Git mutations are limited to branch creation, checkout, and push.
- Working-tree file edits are out of scope.
- Network access is limited to GitHub REST PR creation.
- Tokens come from process environment only.
- Error formatting must redact token-like values.
- Tool outputs must be bounded and should truncate unexpected large git/GitHub responses.

## Package Boundaries

- Keep Pi packages in `peerDependencies` with `"*"`.
- Use `dependencies` only for non-Pi runtime libraries. None are required in v1.
- `devDependencies` may include TypeScript and local test dependencies.
- Use Node 22 built-in `fetch`; do not add Octokit for v1.

## Validation Strategy

Later implementation should add tests for:

- Tool registration and prompt metadata.
- Strict TypeBox schemas with `additionalProperties: false`.
- Branch name validation and unsafe branch names.
- Current-branch-only push behavior.
- Repository boundary validation, including env/remote mismatch.
- GitHub PR request construction without exposing tokens.
- `/branchme help` parsing.

Validation commands:

```bash
npm run typecheck
npm run test
npm run check:pack
npm run validate
pi --no-extensions -e .
```

## Acceptance Criteria

- The later implementation keeps `src/extension.ts` small and delegates to feature modules.
- The slash command remains informational only.
- All four tools have precise schemas, descriptions, `promptSnippet`, and tool-specific `promptGuidelines` that name the tool explicitly.
- No feature creates commits or stages files.
- PR creation cannot target a repository supplied by tool arguments.
- GitHub token values are never surfaced in content, details, or thrown errors.
