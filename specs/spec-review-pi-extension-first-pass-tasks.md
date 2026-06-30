# First-pass Pi extension review tasks

## Review scope and date

- Date: 2026-06-30
- Scope: Security, runtime bugs, high-risk correctness, dependency risk, secret leakage, unsafe input handling, async/race behavior, and Pi extension boundaries for the BranchMe TypeScript Pi extension.
- Review mode: Planning only. No source, test, dependency, doc, generated, state, or changelog files were modified.

## Files or areas reviewed

- Project/package setup: `package.json`, `package-lock.json` via `npm audit`, `tsconfig.json`, `.github/workflows/ci.yml`, `.gitignore`, `.env.example`.
- Pi extension docs/examples: `docs/extensions.md`, `docs/tui.md`, selected `examples/extensions/*` for tools, truncation, tool overrides, reload, and custom UI patterns.
- Extension entry and public surface: `src/extension.ts`, `src/constants.ts`, `src/tools/branchme-tools.ts`, `src/commands/branchme-command.ts`, `src/ui/branchme-panel.ts`.
- Git/GitHub helpers: `src/git.ts`, `src/github.ts`, `src/types.ts`.
- Tests and validation helpers: `test/*.test.mjs`, `scripts/check-format.mjs`, `scripts/check-package-contents.mjs`, `scripts/publish-npm.mjs`, `trivy_scan.sh` by inspection only.
- Public docs for security claims: `README.md`, `SECURITY.md`, `docs/STRUCTURE.md`, `docs/SMOKE_TEST.md`, `docs/TUI_CAPTURE.md`.
- Existing planning conventions: `specs/spec-architecture.md`, `specs/spec-guidelines.md`, `specs/spec-tasks.md`, `specs/spec-change-branch-tool.md`, `specs/spec-configuration-tui-design-standard.md`.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm run test` — passed, 44/44 tests.
- `npm run check` — passed syntax check for `scripts/check-package-contents.mjs`.
- `npm run format:check` — passed for 42 files.
- `npm run check:pack` — passed; npm dry-run package contains 22 public files and excludes specs/local state.
- `npm audit --audit-level=moderate --omit=optional` — passed, 0 vulnerabilities.
- `npm run validate` — passed; repeated typecheck, tests, syntax check, and package-content check.
- `git status --short` / `git diff --stat -- . ':!*.env'` — read-only review context; existing non-review changes were already present before generated review specs.
- `rg -n "eval|Function|child_process|execFile|spawn|readFileSync|process\\.env|fetch\\(|TODO|\\bany\\b|\\bas\\s" src scripts test package.json README.md SECURITY.md docs` — reviewed high-risk API usage.

## Findings summary by severity

- Critical: 0.
- High: 4 — git secret redaction gaps, un-serialized repository mutations, ambiguous `git push`, and PR `headBranch` repository-boundary smuggling.
- Medium: 1 — local token fallback reads `.env` synchronously without file type/size/root hardening.
- Low: 0.

## Ordered tasks

- [ ] Redact credential-bearing git output before returning or throwing BranchMe tool results

#### Why

`src/git.ts` formats git failures with `formatGitFailure()` and stores push output in `PushBranchDetails.output` without applying the GitHub/token redaction used in `src/github.ts`. Git can echo remote URLs and credential helpers can surface URLs such as `https://user:token@github.com/...` in push or remote errors. This contradicts `SECURITY.md` claims that token values are redacted from errors, tool content, and details, and can leak credentials into Pi session history and LLM context.

#### How to resolve

- Inspect `src/git.ts` paths that include `stdout`, `stderr`, command labels, push output, and thrown error messages.
- Add or share a redaction helper that removes URL userinfo, bearer headers, GitHub PAT patterns, `token=`-style pairs, and any explicitly known tokens when available.
- Apply the helper before throwing from `formatGitFailure()` and before returning `PushBranchDetails.output`.
- Add tests in `test/git.test.mjs` and `test/tools.test.mjs` that simulate git failures/success output containing credential-bearing remote URLs and token-like strings.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- Git command failure messages and `push_branch` details/content cannot contain credential-bearing URL userinfo, bearer tokens, GitHub PATs, or token-like key/value strings.
- Tests cover redaction for both thrown git errors and returned push details.
- `npm run typecheck`, `npm run test`, and `npm run validate` pass.

- [ ] Serialize BranchMe repository-state mutations across parallel Pi tool calls

#### Why

Pi can execute sibling tool calls in parallel. `create_branch`, `change_branch`, and `push_branch` currently run independent git operations against the same checkout without a repository-scoped queue or mutex. Concurrent branch creation, switching, and pushing can race on `HEAD`, upstream detection, dirty-state preflights, and branch verification, causing operations to run on an unintended branch or produce misleading details.

#### How to resolve

- Add a repository-scoped serialization mechanism for mutating git operations in `src/git.ts` or a small shared helper.
- Queue the complete read-preflight-mutate-verify window for `createLocalBranch()`, `changeExistingLocalBranch()`, and `pushCurrentBranch()` after resolving the repository root.
- Consider whether `pull_request` should share the queue or at least re-check current branch/repository immediately before making the network request when its behavior depends on just-pushed/current branch state.
- Add focused tests that invoke two mutating helpers/tools concurrently with controlled fake `pi.exec` delays and verify deterministic non-overlapping execution.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- Concurrent BranchMe mutating tool calls for the same repository cannot interleave their git preflight/mutation/verification windows.
- Concurrency tests prove branch mutation calls execute in a deterministic serialized order and preserve correct details.
- Relevant validation commands pass, and any remaining same-turn workflow limitations are documented.

- [ ] Make `push_branch` explicitly push only the current branch instead of relying on bare `git push`

#### Why

When an upstream exists, `pushCurrentBranch()` runs `git push` with no remote or refspec. Git behavior can depend on user configuration such as `push.default`, `remote.*.push`, or related settings, and may push refs beyond the current branch. This conflicts with BranchMe’s documented current-branch-only boundary and creates a remote mutation risk.

#### How to resolve

- In `src/git.ts`, replace the upstream-present `['push']` path with an explicit remote/refspec strategy for the current branch.
- Derive the correct upstream remote and merge branch safely, for example from `branch.<current>.remote` and `branch.<current>.merge`, or parse verified upstream data in a way that supports branch names containing `/`.
- Use argv arrays only and avoid shell command strings.
- Update `PushBranchDetails` as needed to record the target remote/ref safely.
- Add tests for custom upstreams, branch names with slashes, missing upstream config, and configs that would otherwise make bare `git push` unsafe.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- `push_branch` never calls bare `git push` for an upstream branch.
- Tests prove the command includes an explicit remote/refspec for the current branch only and still publishes with `--set-upstream origin <currentBranch>` when no upstream exists.
- Documentation and details accurately describe the explicit push target.
- Relevant validation commands pass.

- [ ] Validate PR branch refs so `pull_request` cannot smuggle cross-repository `head` values

#### Why

The `pull_request` schema rejects `owner` and `repo`, but GitHub’s create-pull-request API accepts `head` values in `owner:branch` form for cross-repository PRs. Because `src/github.ts` only checks that `headBranch`, `baseBranch`, and `title` are non-blank, a tool call can pass `headBranch: "other-owner:branch"` and bypass BranchMe’s documented current-repository-only/non-goal boundary.

#### How to resolve

- Define explicit validation for `pull_request` `headBranch` and `baseBranch` in `src/github.ts` or `src/tools/branchme-tools.ts`.
- Reject `headBranch` values containing an owner prefix, path traversal-like text, control characters, whitespace, or other forms outside the intended local branch/ref contract.
- Consider requiring `headBranch` to equal the current branch or to resolve as a local branch before creating the PR if the product boundary is “current repository only”.
- Add tests in `test/github.test.mjs` and `test/tools.test.mjs` for colon-prefixed cross-repo heads, invalid refs, valid slash-containing branch names, and clear error messages.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- `pull_request` cannot send `owner:branch` or otherwise cross-repository `head` values to GitHub.
- Valid current-repository branch names still work, including names with `/`.
- Tests cover accepted and rejected PR ref inputs.
- Relevant validation commands pass.

- [ ] Harden local `.env` token fallback against blocking, oversized, or unintended reads

#### Why

`resolveGitHubToken()` reads `join(ctx.cwd, ".env")` synchronously with `readFileSync()` when process tokens are absent. A large file, special file, symlink, or named pipe can block a command/tool, ignore abort signals, or read an unintended location. The behavior is also easy to misconfigure when Pi runs from a repository subdirectory rather than the repository root.

#### How to resolve

- In `src/github.ts`, replace the unbounded synchronous read with a hardened token fallback.
- Resolve the intended lookup location deliberately, preferably the verified git root for repository-scoped behavior or clearly documented `ctx.cwd` behavior.
- Check that the candidate is a regular file, enforce a small maximum size, and avoid following unsafe/surprising file types where practical.
- Use async I/O where possible and preserve cancellation behavior for tool execution.
- Add tests for missing files, oversized files, directory/special-file failures where portable, subdirectory behavior, and no token leakage in errors.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- Token fallback reads only the intended small regular file and fails quickly with a clear redacted message for unsafe file types or oversized content.
- The intended root-vs-cwd lookup behavior is documented and tested.
- Tool/command cancellation is not blocked by long synchronous file reads where practical.
- Relevant validation commands pass.

## Blocked checks or areas not reviewed

- The real `.env` file was intentionally not read because it is protected as a credential-bearing file.
- Live `git switch`, `git push`, and live GitHub PR creation were not run; tests use mocked `pi.exec` and `fetch`.
- `trivy_scan.sh` was inspected but not executed because it writes report/cache directories and may require a local Trivy installation and network/database updates.
- Interactive Pi TUI behavior was reviewed through renderer tests and docs, not through a live terminal session.
- No destructive, auto-fix, dependency-update, publish, or credential-requiring commands were run.
