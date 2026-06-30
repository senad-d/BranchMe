# Plan: Add `change_branch` Tool

> Historical note (updated 2026-06-30): this future implementation blueprint has been implemented. Current `change_branch` behavior is documented in `README.md`, `SECURITY.md`, and `docs/STRUCTURE.md`; completed task checkboxes remain historical evidence.

## Task Description

Add a new BranchMe tool named `change_branch` that switches the current repository checkout to an existing local branch. This plan is a future implementation blueprint only; do not implement runtime behavior while creating this spec.

## Objective

BranchMe will support changing branches safely from Pi through an explicit tool call while preserving the current-repository boundary and avoiding commits, staging, pushing, stashing, force checkout, or arbitrary file edits.

## Problem Statement

BranchMe can inspect status, create a new branch, push the current branch, and open a pull request, but it cannot switch to an already existing branch. Users currently need to run manual git commands outside BranchMe to move between local branches, which breaks the otherwise tool-driven branch workflow.

## Solution Approach

Introduce `change_branch` as a strict, current-repository-only tool with one required input: `branchName`. The tool should validate the target branch name, require that the target exists as a local branch, ensure branch switching is safe, and run `git switch <branchName>` with argv-style `pi.exec("git", args)`.

Recommended safety boundary for v1:

- Switch only to an existing local branch (`refs/heads/<branchName>`).
- Reject detached/invalid repository states only when previous branch details cannot be determined safely; allow switching out of detached HEAD if `HEAD` is valid and details record `previousBranch: null` plus `previousDetached: true`.
- Reject dirty working trees before switching to avoid carrying uncommitted changes across branches. Do not add `force`, `stash`, or `discard` options in v1.
- Never create branches, stage files, commit, push, stash, merge, rebase, reset, or force checkout.

## Relevant Files

- `src/constants.ts` - Add `CHANGE_BRANCH_TOOL_NAME` and include it in `BRANCHME_TOOL_NAMES`.
- `src/types.ts` - Add serializable `ChangeBranchDetails` with repository root, previous branch/detached state, target branch, and clean-worktree preflight status.
- `src/git.ts` - Add git helper(s) for existing local branch checks, clean worktree preflight, and safe branch switching with `git switch <branchName>`.
- `src/tools/branchme-tools.ts` - Add strict schema, prompt metadata, registration, execution, and result formatting for `change_branch`.
- `src/ui/branchme-panel.ts` - Update workflow/safety text only if the panel lists tools; keep `/branchme` informational.
- `docs/TUI_CAPTURE.md` and `test/tui-capture.test.mjs` - Refresh/update captures if UI text changes.
- `README.md` - Document `change_branch` usage, schema, safety behavior, and workflow placement.
- `SECURITY.md` - Document branch checkout/working-tree implications and no-force/no-stash behavior.
- `CHANGELOG.md` - Record the added tool.
- `docs/STRUCTURE.md` - Update tool list and tests if necessary.
- `test/git.test.mjs` - Add mocked `pi.exec` tests for branch switching helper paths.
- `test/tools.test.mjs` - Add tool registration, schema, prompt metadata, and execution tests.
- `test/preparation.test.mjs` - Update documentation/source expectations if tool counts or public docs are asserted.

## Implementation Phases

### Phase 1: Tool Contract and Git Helper Design

Define the `change_branch` contract, details type, constants, and helper behavior. Keep all git calls argv-style and current-repository scoped.

### Phase 2: Core Implementation

Add helper functions and register the new tool. Use existing validation patterns from `create_branch`, but require the branch to already exist locally and run `git switch <branchName>` instead of `git switch -c <branchName>`.

### Phase 3: Tests, Documentation, and Capture Updates

Add mocked tests for helper and tool behavior, update public documentation, refresh TUI captures only if user-facing panel/help text changes, and run full validation.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the `change_branch` contract

- Add `CHANGE_BRANCH_TOOL_NAME = "change_branch"` to `src/constants.ts`.
- Include `CHANGE_BRANCH_TOOL_NAME` in `BRANCHME_TOOL_NAMES`.
- Add a strict TypeBox schema in `src/tools/branchme-tools.ts`:
  - Required: `branchName: string`.
  - `additionalProperties: false`.
  - No `baseRef`, `force`, `stash`, `discard`, `create`, `owner`, `repo`, or path parameters.
- Add prompt metadata that explicitly names `change_branch` in the description, `promptSnippet`, and every `promptGuidelines` entry.

### 2. Add serializable result details

- Add `ChangeBranchDetails` to `src/types.ts` with at least:
  - `repoRoot: string`
  - `previousBranch: string | null`
  - `previousDetached: boolean`
  - `currentBranch: string`
  - `hasChangesBeforeSwitch: false`
- Keep details token-free and safe to store in the Pi session.

### 3. Add git helper foundation for branch switching

- Reuse `getGitRoot`, `getCurrentBranch`, `validateBranchName`, `localBranchExists`, and `hasWorkingTreeChanges` where possible.
- Add an exported helper such as `changeExistingLocalBranch(pi, ctx, branchName, signal)`.
- Helper behavior:
  - Resolve git root from `ctx.cwd`.
  - Validate `branchName` with local checks and `git check-ref-format --branch <branchName>`.
  - Require `refs/heads/<branchName>` to exist locally.
  - Reject switching if target branch is already the current branch with a clear non-mutating message or successful no-op details. Prefer no-op success only if details clearly state no switch occurred; otherwise throw a concise error.
  - Reject dirty working trees using `git status --porcelain=v1 --branch` before `git switch`.
  - Run `git switch <branchName>` with argv array only.
  - Verify the current branch after switching and return details.
- Do not use shell strings.
- Do not call `git checkout`, `git switch --force`, `git stash`, `git reset`, `git merge`, `git rebase`, `git add`, `git commit`, or `git push`.

### 4. Register the `change_branch` tool

- Register `change_branch` in `registerBranchMeTools` alongside the existing tools.
- Tool execution should call the git helper and return compact content such as:
  - `Changed branch from main to feature/foo.`
  - `Changed branch from detached HEAD to main.`
- Tool must throw concise errors for invalid branch names, missing local branches, dirty worktrees, non-git repositories, and failed `git switch`.
- Keep output bounded and structured details safe.

### 5. Update extension registration tests

- Update fake-Pi registration tests to expect exactly five BranchMe tools:
  - `branch_status`
  - `create_branch`
  - `change_branch`
  - `push_branch`
  - `pull_request`
- Assert no template tool names remain.
- Assert `change_branch` has strict schema, prompt snippet, and non-empty prompt guidelines that explicitly name `change_branch`.

### 6. Add git helper tests

- Add tests with mocked `pi.exec` for:
  - Successful switch from `main` to `feature/foo`.
  - Successful switch out of detached HEAD to an existing local branch, if allowed by implementation.
  - Invalid branch name.
  - Missing local branch.
  - Dirty working tree rejection.
  - Already-current branch behavior.
  - `git switch <branchName>` command construction using argv arrays.
- Ensure tests verify no commit/stage/push/stash/reset/force commands are issued.

### 7. Add tool execution tests

- Add tests in `test/tools.test.mjs` for:
  - Schema requiring only `branchName` and rejecting additional properties.
  - Successful details/content shape.
  - Error path for dirty working tree.
  - Error path for missing branch.
  - Prompt metadata explicitly naming `change_branch`.

### 8. Update documentation and UI text

- Update `README.md` tool table and workflow to include `change_branch` after `branch_status` and before `create_branch` where appropriate.
- Clarify that `change_branch` switches only to existing local branches and rejects dirty worktrees in v1.
- Update `SECURITY.md` to document that branch switching can update working-tree files as part of normal git checkout semantics, but BranchMe does not force, stash, stage, commit, or push.
- Update `CHANGELOG.md` and `docs/STRUCTURE.md`.
- If `/branchme` panel workflow/safety text changes, update `test/tui-capture.test.mjs` and regenerate `docs/TUI_CAPTURE.md` intentionally.

### 9. Validate in isolation

- Run all validation commands.
- Run an isolated Pi smoke test with `pi --no-extensions -e .`.
- Document any smoke-test findings if behavior or TUI copy changes.

## Testing Strategy

Use mocked `pi.exec` for all git behavior. Tests should assert both command outputs and command construction so branch names are always passed as argv elements. Avoid real repositories and real branch switching in unit tests.

Important edge cases:

- Non-git directory.
- Detached HEAD.
- Invalid branch name with whitespace/control characters or leading `-`.
- Branch name rejected by `git check-ref-format --branch`.
- Target branch missing locally.
- Target branch equals current branch.
- Dirty worktree before switch.
- `git switch` failure due to checkout conflicts or missing refs.

## Acceptance Criteria

- `change_branch` is registered as a fifth BranchMe tool.
- `change_branch` schema requires only `branchName` and rejects additional properties.
- `change_branch` has description, `promptSnippet`, and `promptGuidelines` that explicitly name `change_branch`.
- `change_branch` switches only to existing local branches in the current repository.
- `change_branch` validates branch names with local checks and `git check-ref-format --branch`.
- `change_branch` rejects dirty working trees before switching.
- `change_branch` never creates branches, force-switches, stashes, stages, commits, pushes, merges, rebases, resets, or edits files directly.
- All git commands use `pi.exec("git", args, options)` with argv arrays.
- Tests cover normal and failure paths with mocked `pi.exec`.
- README, SECURITY, CHANGELOG, and structure docs accurately describe the new tool.
- `npm run validate` passes.

## Validation Commands

Execute these commands to validate the task is complete:

```bash
npm run typecheck
npm run test
npm run check:pack
npm run validate
npm run format:check
pi --no-extensions -e .
```

## Notes

- This spec intentionally does not implement the tool.
- Prefer a conservative v1. Do not add `force`, `stash`, `allowDirty`, or remote-branch checkout behavior unless a future spec explicitly expands the contract.
- If users need to switch to a remote branch, they should first create a local tracking branch outside this v1 tool or through a separately specified future tool.
