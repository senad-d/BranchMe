# Plan: BranchMe Implementation Tasks

## Task Description

Task checklist for a later, separate implementation session for BranchMe.

## Objective

Implement BranchMe one task at a time after preparation is complete. Keep all checkboxes unchecked until the implementation session performs and validates the work.

## Important Boundary

This file is a future implementation plan. During preparation, do not complete any checkbox and do not implement runtime behavior.

### 1. Apply source module layout

- [ ] Replace template source modules with BranchMe modules and keep `src/extension.ts` as a small registration entry point.

Create the planned module layout from the architecture spec: constants, types, command registration, tool registration, git helpers, GitHub helpers, and optional UI panel. Remove template example behavior rather than keeping demo command/tool registrations.

#### Acceptance criteria

- `src/extension.ts` exports `branchMeExtension(pi)` and only calls BranchMe registration functions.
- No template command or template tool remains registered.
- The source tree contains clear module boundaries matching `spec-architecture.md`.
- `npm run typecheck` passes.

### 2. Implement git helper foundation

- [ ] Implement current-repository git helpers using argv-style `pi.exec("git", args)` calls.

Add helpers for git root detection, current branch detection, upstream detection, dirty status, ahead/behind count, branch validation, branch creation, and current-branch push/publish behavior.

#### Acceptance criteria

- All git commands use argv arrays, not shell strings.
- Branch validation uses `git check-ref-format --branch` plus local input checks.
- Helpers fail clearly on non-git repositories and detached HEAD where relevant.
- Unit tests cover normal and failure paths with mocked `pi.exec`.

### 3. Implement `branch_status`

- [ ] Register the read-only `branch_status` tool with a strict empty schema and structured details.

The tool should summarize current repository, branch, upstream, dirty status, ahead/behind status, and resolved GitHub repository if available.

#### Acceptance criteria

- Tool schema rejects additional properties.
- Tool has description, `promptSnippet`, and `promptGuidelines` that explicitly name `branch_status`.
- Tool never mutates git state or files.
- Tool returns compact text plus safe structured details.
- Tests verify read-only command usage and details shape.

### 4. Implement `create_branch`

- [ ] Register `create_branch` to create and checkout a new branch from current `HEAD` only.

Use required `branchName` input. Validate the name, reject existing local branches, and run the minimal git switch command.

#### Acceptance criteria

- Tool schema requires only `branchName` and rejects additional properties.
- Tool has description, `promptSnippet`, and `promptGuidelines` that explicitly name `create_branch`.
- Tool never accepts or infers `baseRef`.
- Tool never commits, stages, pushes, or edits files.
- Tests cover invalid branch names, existing branches, and successful command construction.

### 5. Implement `push_branch`

- [ ] Register `push_branch` to push the current branch and publish it to `origin` when no upstream exists.

The tool should inspect current branch/upstream and then run either `git push` or `git push --set-upstream origin <currentBranch>`.

#### Acceptance criteria

- Tool schema is a strict empty object.
- Tool has description, `promptSnippet`, and `promptGuidelines` that explicitly name `push_branch`.
- Tool fails on detached HEAD.
- Tool pushes only the current branch.
- Tool never commits, stages, or edits files.
- Tests cover upstream and no-upstream command paths.

### 6. Implement GitHub repository and token helpers

- [ ] Implement current-repository GitHub resolution, env-token resolution, fetch wrapper, and redacted error handling.

Resolve owner/repo from local `origin` and/or `GITHUB_REPOSITORY`. Fail closed when both exist and disagree. Read `GITHUB_TOKEN` or `GH_TOKEN` from process env only.

#### Acceptance criteria

- GitHub repository parsing supports HTTPS, SSH, and `GITHUB_REPOSITORY` formats.
- Owner/repo are never accepted from tool parameters.
- Env/local repository mismatch throws a boundary error.
- Token resolution never reads `.env`.
- Error messages redact token values and token-like request data.
- Tests cover parsing, mismatch, missing token, and redaction.

### 7. Implement `pull_request`

- [ ] Register `pull_request` to create a GitHub PR in the current repository with all PR inputs required.

Use GitHub REST `POST /repos/{owner}/{repo}/pulls` with required `headBranch`, `baseBranch`, `title`, `body`, and `draft`. Validate response shape before returning success.

#### Acceptance criteria

- Tool schema requires `headBranch`, `baseBranch`, `title`, `body`, and `draft`.
- Tool schema rejects owner/repo fields and additional properties.
- Tool has description, `promptSnippet`, and `promptGuidelines` that explicitly name `pull_request`.
- Tool uses `GITHUB_TOKEN` or `GH_TOKEN` only.
- Tool creates PRs only for the resolved current repository.
- Tests verify request URL, headers without exposed token, body shape, response parsing, and API error handling.

### 8. Implement `/branchme` and `/branchme help`

- [ ] Implement the BranchMe slash command as an informational TUI/help surface only.

`/branchme` should show a simple status/config panel in TUI mode and a safe fallback in non-TUI modes. `/branchme help`, `/branchme --help`, and `/branchme -h` should show concise workflow notes.

Any extension configuration TUI work in this task must follow `specs/spec-configuration-tui-design-standard.md` for visual layout, responsive behavior, theme roles, focus states, and value alignment.

#### Acceptance criteria

- `/branchme` does not run git mutation or GitHub mutation actions.
- `/branchme help`, `--help`, and `-h` all display help.
- TUI mode uses a compact panel that respects terminal width.
- Any configuration-oriented TUI surface follows `specs/spec-configuration-tui-design-standard.md`.
- Non-TUI mode falls back gracefully.
- Tests cover argument parsing and help text generation.

### 9. Add extension registration and prompt metadata tests

- [ ] Add tests that instantiate the extension with a fake Pi API and verify registered commands/tools.

The tests should assert registration names, schema strictness, prompt snippets, prompt guidelines, and no template leftovers.

#### Acceptance criteria

- Exactly one BranchMe command is registered: `branchme`.
- Exactly four BranchMe tools are registered: `branch_status`, `create_branch`, `push_branch`, `pull_request`.
- Each tool has `promptSnippet` and non-empty `promptGuidelines`.
- Every prompt guideline names its tool explicitly.
- Template example command/tool names are absent.

### 10. Update public documentation for implemented behavior

- [ ] Update README, SECURITY, CHANGELOG, and structure docs to describe implemented BranchMe behavior.

Replace preparation wording with implementation-accurate instructions after features are built and tested.

#### Acceptance criteria

- README includes install, usage, tools, env vars, and CI examples.
- SECURITY documents git, network, token, and no-telemetry behavior.
- CHANGELOG records the implemented release contents.
- docs/STRUCTURE.md matches the actual source layout.
- Documentation does not claim unsupported features.

### 11. Validate in isolation

- [ ] Run full repository validation and an isolated Pi smoke test.

Use npm validation and `pi --no-extensions -e .` so other configured extensions do not affect BranchMe.

#### Acceptance criteria

- `npm run validate` passes.
- `npm run check:pack` confirms package contents are minimal.
- `pi --no-extensions -e .` loads BranchMe without template behavior.
- Any manual smoke-test findings are documented.
