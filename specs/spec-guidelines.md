# Plan: BranchMe Implementation Guidelines

> Historical note (updated 2026-06-30): this preparation guideline is retained for context, but current behavior is documented in `README.md`, `SECURITY.md`, and `docs/STRUCTURE.md`. Current implementation includes `change_branch`, hardened repository-root `.env` token fallback, repository-scoped mutation serialization, explicit upstream push refspecs, PR branch-ref validation, and Pi TUI width/key utilities.

## Task Description

Define implementation rules for a later BranchMe development session.

## Objective

Keep BranchMe minimal, safe for automation, and consistent with Pi extension best practices while avoiding feature implementation during repository preparation.

## Coding Guidelines

- Use TypeScript strict mode and keep functions small.
- Keep `src/extension.ts` as the registration entry point only.
- Prefer pure helper functions in `src/git.ts`, `src/github.ts`, and `src/types.ts`.
- Use explicit return types for exported helpers and public tool details.
- Avoid broad abstractions until a second implementation need appears.
- Do not add classes unless they materially simplify UI component state.
- Keep user-facing messages concise and action-oriented.
- Use Node built-ins before adding dependencies; `@earendil-works/pi-tui` is used for panel width/key handling.

## Pi Extension Guidelines

- Do not start long-lived processes, file watchers, timers, sockets, or background jobs directly in the extension factory.
- Start session-scoped resources from `session_start`, a command, or a tool only when needed.
- Clean up status/footer/UI state in `session_shutdown` if set.
- Keep slash commands separate from tools:
  - `/branchme` is a TUI/help/config surface only.
  - Git and GitHub actions are performed only by tools.
- In non-TUI modes, commands should avoid `ctx.ui.custom()` and provide a safe fallback.
- Prefer `ctx.mode === "tui"` before terminal-only custom UI.
- Use `ctx.hasUI` before dialogs or notifications that require UI support.

## Tool Guidelines

Every BranchMe tool must define:

- A clear TypeBox schema.
- `additionalProperties: false` on object schemas.
- A concise description.
- `promptSnippet`.
- `promptGuidelines` where every guideline explicitly names that tool.
- Structured `details` that are safe to store in the Pi session.

Use `StringEnum` from `@earendil-works/pi-ai` for string enum schemas if enum fields are introduced later. Do not use `Type.Union([Type.Literal(...)])` for string enums.

### Tool Naming

- `branch_status`: read current repo/branch status.
- `change_branch`: switch to an existing local branch after clean-worktree preflight.
- `create_branch`: create and checkout a branch from current `HEAD`.
- `push_branch`: push/publish the current branch.
- `pull_request`: create a GitHub pull request in the current repository.

### Prompt Metadata Style

Good guideline examples:

- `Use branch_status before create_branch when the user asks for the current branch state.`
- `Use change_branch only when the user explicitly wants to switch to an existing local branch.`
- `Use create_branch only when the user explicitly wants a new branch from current HEAD.`
- `Use push_branch only after commits already exist; push_branch never commits or stages files.`
- `Use pull_request only when the user provides explicit head branch, base branch, title, body, and draft values.`

Avoid vague wording like `Use this tool when...` because Pi appends guidelines without grouping.

### Error Semantics

- Throw errors for failed tool executions so Pi marks the tool result as failed.
- Return normal results only for successful or intentionally cancelled non-error outcomes.
- Include concise, redacted remediation in thrown messages.
- Never expose raw token values, full request headers, or unbounded command output.

### Output Limits

- Git and GitHub outputs should be compact by design.
- Truncate unexpected large stdout/stderr/API response text before returning it to the model.
- If output is truncated, tell the model what was omitted.
- Details should contain structured summaries, not full raw outputs.

## Git Guidelines

- Run git via `pi.exec("git", args, options)` with argv arrays.
- Do not use shell command strings for branch names, refs, or user input.
- Resolve the git root and run mutating operations from that verified root; pass the active `signal` when available.
- Use short timeouts for status commands and a longer timeout for push.
- Validate branch names with `git check-ref-format --branch`.
- Fail on detached HEAD for `push_branch`.
- `create_branch` must create from current `HEAD` only.
- `push_branch` must push the current branch only and use an explicit upstream remote/refspec instead of bare `git push`.
- Do not implement commit, staging, stash, reset, merge, rebase, or file-editing behavior.

## GitHub Guidelines

- Use process environment first for auth:
  - Prefer `GITHUB_TOKEN`.
  - Fallback to `GH_TOKEN`.
- If neither process token is set, read only those token keys from a small regular `.env` file in the verified git root.
- Do not depend on GitHub CLI.
- Use Node 22 `fetch` for REST API calls.
- Use `https://api.github.com` only.
- Set headers:
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <token>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: BranchMe Pi extension`
- Redact token and token-like values from errors.
- Validate GitHub API response shape before returning success.
- Treat env/local repository mismatch as a boundary violation.

## Repository Boundary Rules

- BranchMe works on the current Pi `ctx.cwd` repository only.
- Tools must not accept filesystem paths, owner, repo fields, or owner-prefixed PR branch refs in v1.
- Resolve the git root from `ctx.cwd` and do not operate elsewhere.
- `pull_request` must infer the GitHub repo from the current checkout and/or matching `GITHUB_REPOSITORY`.
- If current repo cannot be resolved as GitHub, fail with a clear error.

## TUI Guidelines

- Treat `specs/spec-configuration-tui-design-standard.md` as the mandatory visual standard for any extension configuration TUI or configuration panel.
- Keep `/branchme` basic.
- Show configuration/status/help, not action buttons.
- Do not duplicate tool behavior in commands.
- Use semantic theme roles; do not hardcode ANSI color values.
- Ensure rendered lines do not exceed terminal visible width; use Pi TUI width/key utilities where needed.
- Tiny/narrow terminals may fall back to plain text.
- `/branchme help`, `/branchme --help`, and `/branchme -h` should work without requiring custom UI.

## Package Metadata Rules

- Package name: `@senad-d/branchme`.
- Description should mention current-repo branch/push/PR tools for Pi.
- Repository, bugs, and homepage must point to `senad-d/branchme`.
- Keep `pi.extensions` pointed at `./src/extension.ts` unless the entry point moves.
- Include keywords:
  - `pi-package`
  - `pi-extension`
  - `branchme`
  - `git`
  - `github`
  - `pull-request`
- Keep Pi core packages in `peerDependencies` with `"*"`.
- Put non-Pi runtime libraries in `dependencies`; none are expected for v1.
- Put local development tools in `devDependencies`.

## Documentation Rules

- README must describe current implemented behavior and clearly label historical plans as historical.
- SECURITY.md must document:
  - git branch checkout/push behavior
  - GitHub network access
  - token environment variables
  - no telemetry
  - no commit/staging behavior
- CHANGELOG.md should track implementation milestones.
- docs/STRUCTURE.md should describe actual module boundaries.
- Specs are historical or future-work context once implementation lands; current behavior lives in README, SECURITY, and docs/STRUCTURE.
- Do not mark task checkboxes complete during preparation.

## Testing Rules

Later implementation should include tests for:

- Package metadata.
- Extension registration.
- Tool schema strictness.
- Tool prompt metadata presence and naming.
- Git helper command construction and failure paths.
- Branch name validation.
- Push behavior with/without upstream.
- GitHub repository parsing.
- GitHub token resolution and redaction.
- PR request body construction.
- `/branchme help` parsing.

Tests should avoid touching real remotes. Mock `pi.exec` and `fetch`.

## Security and Privacy Rules

- BranchMe must not collect telemetry.
- BranchMe must not send repository contents to GitHub beyond explicit PR fields.
- BranchMe must not send token values to the model.
- BranchMe must not write secrets and must read only supported token keys from process env or hardened repository-root `.env` fallback.
- BranchMe must not mutate working-tree files.
- Mutating git operations must be explicit tool calls.
- Automation-friendly behavior is preferred over extra prompts, but schemas and validation must be strict.

## Isolated Smoke-Test Rules

Use isolated extension loading for manual checks:

```bash
pi --no-extensions -e .
```

Do not use `pi -e .` unless deliberately testing interaction with other configured extensions.

## Acceptance Criteria

- Future implementation follows current-repository-only behavior.
- Future implementation keeps BranchMe smaller than CommitMe and avoids commit functionality.
- Future implementation documents every security-sensitive behavior.
- Future implementation can run in GitHub Actions with `GITHUB_TOKEN` or `GH_TOKEN`.
