# Second-pass Pi extension review tasks

## Review scope and date

- Date: 2026-06-30
- Pass focus: maintainability, clean code, logic edge cases, type-safety gaps, duplicated validation, and important test coverage gaps.
- Target project: `/Users/senad/Documents/Code/Moj_git/pi-branchme`

## Files or areas reviewed

- Extension composition: `src/extension.ts`, `src/constants.ts`, `src/types.ts`
- Command/UI path: `src/commands/branchme-command.ts`, `src/ui/branchme-panel.ts`
- Tool registration and schemas: `src/tools/branchme-tools.ts`
- Git and GitHub helpers: `src/git.ts`, `src/github.ts`, `src/redaction.ts`
- Tests: `test/command.test.mjs`, `test/git.test.mjs`, `test/git-integration.test.mjs`, `test/github.test.mjs`, `test/preparation.test.mjs`, `test/schema-validation.test.mjs`, `test/tools.test.mjs`, `test/tui-capture.test.mjs`
- Package/release support: `package.json`, `scripts/check-format.mjs`, `scripts/check-package-contents.mjs`, `scripts/smoke-pi-runtime.mjs`
- Docs/spec conventions: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/STRUCTURE.md`, `specs/spec-architecture.md`, `specs/spec-guidelines.md`, `specs/spec-tasks.md`, `specs/spec-change-branch-tool.md`, `specs/spec-configuration-tui-design-standard.md`

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm test` — passed, 85 tests.
- `npm run format:check` — passed, 46 files checked.
- `npm run check:pack` — passed, 22 package files listed.
- `npm run smoke:pi` — passed.
- `npm audit --omit=dev --audit-level=moderate` — passed, 0 vulnerabilities.
- `npm run validate` — passed.
- Targeted `rg -n` searches — passed; used to inspect validation, command, and package-check locations.

## Findings summary by severity and category

- High: 0
- Medium: 3
  - Type Safety / Boundary Validation: exported GitHub PR helper validation relies partly on TypeBox callers.
  - Logic / Maintainability: PR branch validation duplicates and can drift from Git's branch-ref validation.
  - UX / Observability: `/branchme` collapses repository/token lookup failures into generic `not resolved` or `not set` states.
- Low: 0

## Ordered tasks

- [ ] Harden GitHub pull-request helper validation independently of tool schemas

#### Why

`src/github.ts:322-327` validates pull request input after the TypeBox tool schema has already run in normal tool execution, but `createGitHubPullRequest` is exported and can be called directly by tests or future embedders. In that direct path, `input.title.trim()` runs before confirming `title` is a string, so invalid input can produce a generic TypeError instead of a controlled BranchMe validation error. `src/github.ts:544` also accepts any JSON number for a pull request number rather than a finite positive integer.

#### How to resolve

- Update `validatePullRequestInput` in `src/github.ts` to check `title`, `body`, and `draft` types before using their methods or values.
- Consider accepting `unknown` internally for validation helpers, then narrowing to `PullRequestInput` after all fields are checked.
- Validate the GitHub response `number` as a finite positive safe integer before returning `PullRequestDetails`.
- Add focused tests in `test/github.test.mjs` for non-string `title`, missing/invalid `body`, invalid `draft`, and malformed PR response numbers.
- Re-run `npm run test`, `npm run typecheck`, and `npm run validate`.

#### Acceptance criteria

- Direct calls to `createGitHubPullRequest` with invalid `title`, `body`, or `draft` fail with explicit BranchMe validation messages, not TypeError messages.
- GitHub responses with missing, non-integer, non-finite, zero, or negative PR numbers are rejected before success details are returned.
- Existing tool schema behavior remains strict and unchanged for valid calls.
- Relevant tests and `npm run validate` pass.

- [ ] Consolidate local pull-request branch validation with Git ref-format checks

#### Why

Branch creation and switching use `validateBranchName` plus `git check-ref-format --branch` in `src/git.ts`, while pull-request branch refs use a separate custom validator in `src/github.ts:303-320` before `localBranchExists` is called. The custom validator currently covers many unsafe cases, but keeping a second branch-ref rule set increases drift risk and can produce inconsistent behavior for Git-valid versus Git-invalid local branch names.

#### How to resolve

- Introduce a shared local-branch validation path for PR branch inputs that keeps the PR-specific restrictions (`owner:branch`, full `refs/` paths, backslashes, traversal-like segments) and also uses Git's `check-ref-format --branch` semantics before local existence checks.
- Wire the shared validation through `requireExistingLocalPullRequestBranch` in `src/tools/branchme-tools.ts` without performing token lookup or network calls first.
- Add tests for edge-case refs that should fail before fetch/token work, including Git-invalid dot-component names and existing PR-specific rejections.
- Keep error messages clear about whether a value is unsafe syntax, not a local branch, or not visible on GitHub.

#### Acceptance criteria

- Pull-request `headBranch` and `baseBranch` validation uses one documented helper path for local branch-name semantics and cannot drift silently from create/change branch validation.
- Invalid Git branch refs fail before token lookup, repository network requests, or PR creation.
- Owner-prefixed and cross-repository refs remain rejected with clear messages.
- Focused tests prove no fetch call occurs for invalid branch refs, and `npm run validate` passes.

- [ ] Surface `/branchme` repository and token lookup failures as actionable warnings

#### Why

`collectPanelData` records git status failures in `data.statusNote`, but `src/commands/branchme-command.ts:83-90` silently converts GitHub repository and token lookup errors to `null`. As a result, a boundary mismatch, unreadable repository-root token file, or malformed configuration can look identical to an intentionally unconfigured repository in `/branchme` output. That slows diagnosis and hides the difference between absent configuration and broken configuration.

#### How to resolve

- Extend `BranchMePanelData` in `src/ui/branchme-panel.ts` to carry separate, redacted repository and token warning messages, or a small warnings array.
- Update `collectPanelData` in `src/commands/branchme-command.ts` to preserve safe error text for GitHub repository and token lookup failures without exposing token values.
- Update TUI and non-TUI formatting so `/branchme` still stays compact but distinguishes `not resolved` from `warning: <reason>`.
- Add tests in `test/command.test.mjs` and `test/tui-capture.test.mjs` for a repository mismatch and a token fallback error.

#### Acceptance criteria

- `/branchme` surfaces repository mismatch and token fallback failures as warnings in TUI, RPC, and print-safe fallback output.
- Token values and credential-looking strings remain redacted or absent from all command output and panel lines.
- Plain absence of repository or token still displays as `not resolved` or `not set` without a false warning.
- Updated command and capture tests pass with `npm run test` and `npm run validate`.

## Blocked checks or areas not reviewed

- No code was changed during this pass; findings were converted only into follow-up tasks.
- Live GitHub, live push, and real credential flows were not exercised.
- The repository is small enough that all tracked source/test/docs areas were sampled, but generated dependency internals under `node_modules/` and the local `.env` file were intentionally not reviewed.
