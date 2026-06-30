# Final-pass Pi extension review tasks

## Review scope and date

- Date: 2026-06-30
- Pass focus: strict final verification, Pi-specific runtime behavior, lifecycle/tool correctness, edge cases, failure states, and unresolved assumptions from earlier passes.
- Target project: `/Users/senad/Documents/Code/Moj_git/pi-branchme`

## Files or areas reviewed

- Earlier generated review specs from this session: `specs/spec-review-pi-extension-first-pass-tasks.md`, `specs/spec-review-pi-extension-second-pass-tasks.md`
- Pi extension docs consulted: `docs/extensions.md`, `docs/tui.md` from the installed Pi package docs directory
- Extension entry and public surface: `src/extension.ts`, `src/constants.ts`, `src/tools/branchme-tools.ts`, `src/commands/branchme-command.ts`, `src/ui/branchme-panel.ts`
- Core behavior helpers: `src/git.ts`, `src/github.ts`, `src/redaction.ts`, `src/types.ts`
- Runtime/package validation: `package.json`, `scripts/smoke-pi-runtime.mjs`, `scripts/check-package-contents.mjs`, `.github/workflows/ci.yml`
- Tests: `test/command.test.mjs`, `test/git.test.mjs`, `test/git-integration.test.mjs`, `test/github.test.mjs`, `test/schema-validation.test.mjs`, `test/tools.test.mjs`, `test/tui-capture.test.mjs`
- Documentation and historical specs: `README.md`, `SECURITY.md`, `docs/STRUCTURE.md`, `docs/SMOKE_TEST.md`, `docs/PROJECT_DEFINITION_BRIEF.md`, `specs/spec-architecture.md`, `specs/spec-guidelines.md`, `specs/spec-tasks.md`, `specs/spec-change-branch-tool.md`

## Previous claims or assumptions verified

- Verified: `src/extension.ts` default export delegates to `registerBranchMeCommand` and `registerBranchMeTools`; it does not start long-lived resources.
- Verified: exactly one command (`branchme`) and five tools are expected by tests; direct fake-Pi tests cover registration and prompt metadata.
- Verified: tool schemas are strict TypeBox objects with `additionalProperties: false` and schema-validation tests simulate Pi's TypeBox conversion/check path.
- Verified: git operations use `pi.exec("git", args, ...)` with argv arrays, pass timeouts/signals, and mutation helpers serialize same-repository operation windows.
- Verified: GitHub API helpers use bounded response reads, token redaction, repository boundary checks, and injected `fetchImpl` for tests.
- Verified: `/branchme` avoids `ctx.ui.custom()` outside TUI mode and stays stdout-silent in JSON mode.
- Partially verified: `npm run smoke:pi` proves the extension loads through Pi and `/branchme help` or status output appears, but it does not inspect tool registration through the real Pi API or invoke BranchMe tools through Pi runtime.
- Partially verified: abort signals are passed through many git/fetch calls by code inspection, but focused tests do not prove all long-running public tool flows stop cleanly and avoid follow-up side effects when aborted.
- Blocked: live GitHub PR creation and real push behavior require credentials and external mutations, so they were not run.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm test` — passed, 85 tests.
- `npm run format:check` — passed, 46 files checked.
- `npm run check:pack` — passed, 22 package files listed.
- `npm run smoke:pi` — passed.
- `npm audit --omit=dev --audit-level=moderate` — passed, 0 vulnerabilities.
- `npm run validate` — passed.
- `rg -n ...` targeted searches — passed; used to verify command/tool/signal/package locations.

## Findings summary by severity and category

- High: 0
- Medium: 2
  - Pi Runtime / Testing: real Pi runtime coverage stops at command output and does not verify registered tools through Pi's actual extension API.
  - Async / Cancellation: abort/timeout behavior is present by inspection but not fully challenged for public long-running tool flows.
- Low: 0

## Ordered tasks

- [ ] Add Pi runtime smoke coverage for real BranchMe tool registration and non-mutating tool execution

#### Why

The current smoke test in `scripts/smoke-pi-runtime.mjs` loads the extension and feeds `/branchme help`, which proves the command path loads but does not prove Pi's real runtime sees all five BranchMe tools with their schemas, prompt snippets, and prompt guidelines. Most tool assertions use a fake Pi API in `test/tools.test.mjs`, so a mismatch with the actual Pi extension API could still pass unit tests and only appear after installation.

#### How to resolve

- Add a non-LLM runtime smoke path that loads BranchMe with Pi and inspects registered tools through a real Pi extension API surface, such as a temporary verifier extension/command that calls `pi.getAllTools()` after BranchMe loads.
- Assert the real runtime exposes `branch_status`, `change_branch`, `create_branch`, `push_branch`, and `pull_request` with strict schemas and prompt metadata.
- If Pi exposes a safe non-LLM way to invoke tools, execute only `branch_status` in an isolated temporary git repository and assert it does not issue mutating git commands; otherwise document the exact runtime limitation and keep registration inspection as the smoke gate.
- Keep the smoke isolated from user sessions, context files, discovered extensions, credentials, and external network calls.

#### Acceptance criteria

- A safe runtime smoke command proves BranchMe's tools are visible through Pi's actual extension runtime, not only through fake-Pi unit tests.
- The smoke confirms all five tool names and at least their schema strictness/prompt metadata at runtime.
- Any optional `branch_status` runtime invocation runs only in a temporary repository and does not mutate the source checkout or contact GitHub.
- The command is documented and either included in `npm run validate` or explicitly marked as a required release gate with its blockers.

- [ ] Add focused abort and timeout tests for long-running public tool flows

#### Why

Pi extension docs recommend respecting abort signals for long-running work, and BranchMe passes `signal` through git and fetch calls in `src/git.ts` and `src/github.ts`. Current tests cover some response-read aborts, but they do not fully challenge public tool flows such as `push_branch` and `pull_request` when an abort or timeout occurs mid-flow. Without focused coverage, a future change could continue network or git operations after cancellation or return misleading success details.

#### How to resolve

- Add tests in `test/git.test.mjs` and/or `test/tools.test.mjs` that pass an `AbortController.signal` through `push_branch`, `create_branch`, `change_branch`, and `pull_request` public paths and assert the fake `pi.exec`/`fetchImpl` receives the same signal.
- Simulate aborted or killed git results for status, switch, and push operations and assert BranchMe throws concise, redacted failures without running later mutation/network steps.
- Add `pull_request` tests where the head-branch preflight, base-branch preflight, or PR creation fetch rejects with an abort-like error, proving no later fetch/POST occurs after the abort.
- Keep tests deterministic and credential-free by using mocked `pi.exec` and `fetchImpl` only.

#### Acceptance criteria

- Public tool tests prove abort signals are propagated to every relevant git and fetch call.
- Aborted, killed, or timed-out git/fetch paths fail with actionable messages and do not return success details.
- `pull_request` cancellation tests prove later GitHub calls are skipped after an aborted earlier preflight.
- `npm run test` and `npm run validate` pass with the new cancellation coverage.

## Unknowns resolved

- Resolved: no code implementation work was performed; only pass-specific spec files were created.
- Resolved: the local `.env` file exists but was not read.
- Resolved: all current validation commands pass before follow-up tasks are implemented.
- Unresolved by design: real push and PR creation require credentials and external side effects; they remain covered by mocked tests and documentation rather than live execution.

## Blocked checks or areas not reviewed

- Live GitHub API PR creation, branch pushes, and credentialed integration tests were blocked by required secrets and external mutations.
- `trivy_scan.sh` was not run because it requires local Trivy and writes cache/report outputs.
- A real installed-package smoke and real runtime tool-inspection smoke were not run during review; they are captured as follow-up tasks.
