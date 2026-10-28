# Plan: Merge CommitMe into BranchMe

## Task Description

Move all CommitMe functionality from `pi-commitme` into BranchMe so one extension provides branch, worktree, pull request, and commit workflows. CommitMe behavior stays the same. The CommitMe tool is renamed and its prose compacted to match BranchMe tools.

### 1. Copy CommitMe sources

- [x] Copy CommitMe `src/` modules into `src/commitme/` without its extension entry point.

#### Why
BranchMe already exports `runGit`, `GitRunOptions`, `EXTENSION_DISPLAY_NAME`, and lock constants, and has its own `types.ts` and `constants.ts`. A separate folder avoids name clashes without rewriting CommitMe internals.

#### How
Copy `commands/`, `git/`, `model/`, `prompt/`, `tools/`, `utils/`, `workflows/`, `constants.ts`, `types.ts`, and `commitme-details.ts`. Keep relative imports unchanged.

#### Where
`src/commitme/`

#### Acceptance criteria
- `src/commitme/` contains all CommitMe modules except `extension.ts`.
- `npm run typecheck` passes.

### 2. Rename and compact the commit tool

- [x] Rename the `commitme` tool to `commit_changes` and rewrite its description, snippet, and guidelines in BranchMe style.

#### Why
The current tool prose is long and the name does not match BranchMe tool naming.

#### How
Add `COMMIT_CHANGES_TOOL_NAME` to BranchMe constants and `BRANCHME_TOOL_NAMES`. Use it in the CommitMe tool. Keep parameters and behavior unchanged. Each guideline names `commit_changes`.

#### Where
`src/constants.ts`, `src/commitme/constants.ts`, `src/commitme/tools/commitme-tool.ts`

#### Acceptance criteria
- Tool name is `commit_changes`, description is one compact sentence, guidelines each include `commit_changes`.
- `gather` and `commit` actions, `message`, `steeringPrompt`, `paths`, `confirm`, and `worktreePath` behave as before.

### 3. Register CommitMe in BranchMe

- [x] Register `commit_changes` through `registerBranchMeTools` and `/commitme` from the extension entry point.

#### Why
Registering through BranchMe applies the repository mutation queue and blocker guidance to commits, so commits cannot race other BranchMe mutations.

#### How
Call the CommitMe tool factory inside `registerBranchMeTools`. Call `registerCommitMeCommand` in `src/extension.ts`.

#### Where
`src/tools/branchme-tools.ts`, `src/extension.ts`

#### Acceptance criteria
- BranchMe registers `commit_changes` and `/commitme`.
- Tool prose budget test passes.

### 4. Move CommitMe tests

- [x] Move CommitMe tests into `test/` with updated imports and tool name.

#### Why
Full functionality must stay verified after the move.

#### How
Copy test files and fixtures with a `commitme-` prefix where names clash. Update import paths and tool name. Drop CommitMe package metadata assertions.

#### Where
`test/`

#### Acceptance criteria
- All moved tests pass under `npm test`.

### 5. Update package metadata and docs

- [x] Update `package.json`, package content checks, README, and CHANGELOG.

#### Why
The package must ship the new modules and describe commit support.

#### How
Raise Pi devDependency floors to `^1.3.0`, add commit keywords, list CommitMe files in `scripts/check-package-contents.mjs`, document `commit_changes` and `/commitme`.

#### Where
`package.json`, `scripts/check-package-contents.mjs`, `README.md`, `CHANGELOG.md`

#### Acceptance criteria
- `npm run validate` passes.

### 6. Serialize `/commitme` with tool mutations

- [x] Run the `/commitme` commit flow inside the tool mutation coordinator.

Superseded by task 10: `/commitme` was removed, so only `commit_changes` uses the coordinator.

#### Why
`commit_changes` already shares the coordinator. `/commitme` bypassed it and could race another mutation started in the same process.

#### How
Export a coordinator helper from `src/tools/worktree-routing.ts` and wrap the command's draft-and-commit flow with it after waiting for idle.

#### Where
`src/tools/worktree-routing.ts`, `src/commands/commitme-command.ts`

#### Acceptance criteria
- `/commitme` and BranchMe mutation tools use the same coordinator queue.
- A test proves a queued `/commitme` waits for a running coordinated mutation.

### 7. Flatten CommitMe into BranchMe modules

- [x] Remove `src/commitme/` and place its modules in BranchMe's flat layout.

#### Why
CommitMe must be part of BranchMe, not a nested package.

#### How
Move files to `src/commands/commitme-command.ts`, `src/tools/commit-tools.ts`, `src/git-commit.ts`, `src/git-commit-context.ts`, `src/commit-draft.ts`, `src/commit-prompt.ts`, `src/commit-workflow.ts` (flow, unsafe-file approval, details), and `src/truncation.ts` (truncation and display paths). Merge constants into `src/constants.ts` and types into `src/types.ts`, dropping duplicates. Register the tool with `registerCommitTools` like other tool groups.

#### Where
`src/`

#### Acceptance criteria
- `src/commitme/` no longer exists.
- No duplicated constant or type remains.
- `npm run typecheck` passes.

### 8. Use BranchMe Git infrastructure

- [x] Replace CommitMe's Git runner, repository, branch, and worktree helpers with BranchMe's.

#### Why
CommitMe duplicated `runGit`, lock retry, timeouts, root and branch detection, its executor types, and worktree validation.

#### How
Use `runGit`, `getGitRoot`, and `getCurrentBranch` from `src/git.ts`, `Pick<ExtensionAPI, "exec">` and `GitExecResult`, and BranchMe worktree routing for `commit_changes`. Delete `GitCommandError`, CommitMe lock retry, executor types, and the custom `worktreePath` resolver.

#### Where
`src/git-commit.ts`, `src/git-commit-context.ts`, `src/tools/commit-tools.ts`, `src/tools/worktree-routing.ts`

#### Acceptance criteria
- Commit code calls only BranchMe Git helpers.
- `commit_changes` `worktreePath` uses `resolveRepositoryWorktreeCwd`.
- Git failures are redacted by BranchMe formatting.

### 9. Update tests and docs for the new layout

- [x] Update tests, package checks, and structure docs.

#### Why
Tests and docs must match the new modules and error messages.

#### How
Fix test imports, drop tests for removed duplicate helpers, update `docs/STRUCTURE.md` and `scripts/check-package-contents.mjs`.

#### Where
`test/`, `docs/STRUCTURE.md`, `scripts/check-package-contents.mjs`

#### Acceptance criteria
- `npm run validate` passes.

### 10. Keep only the commit tool

- [x] Remove `/commitme` and CommitMe naming so BranchMe only gains the `commit_changes` tool.

#### Why
BranchMe needs the CommitMe tool with the same behavior. The command, its help, and its TUI output are not needed, and nothing should present CommitMe as a separate extension.

#### How
Delete the command, its parser, help, types, constants, and command-only tests and fixture. Rename CommitMe identifiers and user-facing strings to `commit_changes` or BranchMe. Rename commit test files after their modules. Remove `/commitme` from help text, docs, and package keywords.

#### Where
`src/`, `test/`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/`, `scripts/`, `package.json`

#### Acceptance criteria
- BranchMe registers only `/branchme` and the tool set including `commit_changes`.
- No `CommitMe` or `/commitme` reference remains in source, tests, scripts, or active docs.
- `commit_changes` tool tests pass unchanged in behavior.
- `npm run validate` passes.
