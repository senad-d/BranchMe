# Project Definition Brief

Approved on 2026-06-30.

## 1. Bootstrap

- Template source: `/Users/senad/Documents/Code/Moj_git/pi-tmp`
- Target directory: `/Users/senad/Documents/Code/Moj_git/pi-branchme`
- Copy status: copied; target only had `.git/` and `.pi/`, both preserved/excluded.

## 2. Project identity

- Package name: `@senad-d/branchme`
- Display name: `BranchMe`
- Exported extension function: `branchMeExtension`
- Repository URL: `https://github.com/senad-d/branchme`
- One-sentence pitch: Minimal Pi tools for creating the current-repo branch, publishing it, and opening a GitHub pull request.

## 3. Users and use cases

- Primary users: Pi users and CI/GitHub Actions workflows.
- Primary use cases:
  - Check current git branch/repo status.
  - Create and checkout a new branch from current `HEAD`.
  - Push/publish the current branch to `origin`.
  - Create a PR in the current GitHub repo via REST API.
- Non-goals:
  - No commit, staging, diff, or message generation behavior.
  - No GitHub CLI dependency.
  - No cross-repository PR creation.
  - No labels, reviewers, projects, or issue linking in v1.

## 4. Pi integration surface

| Surface | Name | Purpose | Notes |
| --- | --- | --- | --- |
| Command | `/branchme` | Simple TUI config/status/help panel | No git/GitHub mutations |
| Command | `/branchme help` | Workflow notes | No actions |
| Tool | `branch_status` | Read current repo/branch/upstream/dirty/push state | Read-only |
| Tool | `create_branch` | Create + checkout new branch from current `HEAD` | Required `branchName`; fail if exists/invalid |
| Tool | `push_branch` | Push current branch; publish with upstream if needed | No commits/staging |
| Tool | `pull_request` | Create PR via GitHub REST API | Required `headBranch`, `baseBranch`, `title`, `body`, `draft`; repo inferred from current checkout |
| Event | `session_start/session_shutdown` | Optional status footer cleanup | No long-lived resources |
| UI | TUI panel | Compact BranchMe workflow/config view | No persisted config assumed |
| Resource | none | No skills/prompts/themes planned | Keep package minimal |

## 5. Architecture

- Planned files:
  - `src/extension.ts`
  - `src/constants.ts`
  - `src/commands/branchme-command.ts`
  - `src/tools/branchme-tools.ts`
  - `src/git.ts`
  - `src/github.ts`
  - `src/types.ts`
- Module boundaries:
  - Extension entrypoint only registers command/tools/events.
  - Git helper owns `pi.exec("git", args)` calls and branch/repo validation.
  - GitHub helper owns env token lookup and REST request.
  - Tools expose precise TypeBox schemas and structured details.
- Dependencies:
  - Pi core packages as peer deps with `"*"`.
  - Add `@earendil-works/pi-tui` only if the TUI imports components.
  - No Octokit; use Node 22 `fetch`.

## 6. Config, state, and persistence

- Config source: none for v1; `/branchme` displays runtime status and workflow notes.
- Session state: none; tool results include useful `details`.
- Files written: none by extension code, except normal git metadata changes from branch checkout/push.
- Cleanup behavior: clear any footer/status key on `session_shutdown` if used.

## 7. Security and privacy

- Shell execution: only `git` via argv-style `pi.exec`, not shell strings.
- File access/mutation: no working-tree file edits; git metadata changes only.
- Network access: `pull_request` calls `https://api.github.com/repos/{owner}/{repo}/pulls`.
- Credentials/secrets: `GITHUB_TOKEN` / `GH_TOKEN` process env only; never log token.
- Telemetry/retention: none.
- User confirmations: no extra confirmation by default, to support automation; tools rely on explicit arguments.

## 8. Documentation and packaging

- README changes: describe pending implementation, workflow, tools, CI env usage.
- SECURITY changes: document git mutation, GitHub API, token behavior.
- CHANGELOG changes: rename initial unreleased entry to BranchMe.
- package.json changes: set package identity/URLs/keywords/peer deps.
- npm/git distribution plan: npm package `@senad-d/branchme`, repo `senad-d/branchme`.

## 9. Validation plan

- Typecheck: `npm run typecheck`
- Tests: prep-level metadata/spec checks now; implementation tests later.
- Package dry-run: `npm run check:pack`
- Full validation: `npm run validate`
- Isolated Pi smoke test: `pi --no-extensions -e .`

## 10. Open questions and assumptions

- Questions:
  - None blocking.
- Assumptions:
  - `/branchme` has no persisted config in v1.
  - `push_branch` uses `origin` when current branch has no upstream.
  - `pull_request` infers owner/repo from current GitHub checkout or `GITHUB_REPOSITORY`, but never accepts owner/repo as tool input.
- Decisions:
  - No commit functionality.
  - Tools perform all actions; slash commands are help/config only.
  - PR tool requires all PR fields explicitly.
