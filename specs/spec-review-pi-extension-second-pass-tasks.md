# Second-pass Pi extension review tasks

## Review scope and date

- Date: 2026-06-30
- Scope: Maintainability, clean-code, logic, type safety, Pi mode behavior, test gaps, documentation consistency, and best-practice review for BranchMe.
- Review mode: Planning only. No implementation, source, test, doc, dependency, generated, state, or changelog files were modified.

## Files or areas reviewed

- Extension structure and public surface: `src/extension.ts`, `src/constants.ts`, `src/tools/branchme-tools.ts`, `src/commands/branchme-command.ts`, `src/ui/branchme-panel.ts`.
- Core helpers and types: `src/git.ts`, `src/github.ts`, `src/types.ts`.
- Test coverage and fixtures: `test/command.test.mjs`, `test/git.test.mjs`, `test/github.test.mjs`, `test/tools.test.mjs`, `test/preparation.test.mjs`, `test/tui-capture.test.mjs`.
- Validation and release scripts: `package.json`, `scripts/check-format.mjs`, `scripts/check-package-contents.mjs`, `scripts/publish-npm.mjs`, `.github/workflows/ci.yml`.
- Documentation and existing specs: `README.md`, `SECURITY.md`, `docs/STRUCTURE.md`, `docs/PROJECT_DEFINITION_BRIEF.md`, `specs/spec-architecture.md`, `specs/spec-guidelines.md`, `specs/spec-tasks.md`, `specs/spec-change-branch-tool.md`.
- Pi docs/examples relevant to maintainability: extension command modes, custom UI component rendering, keyboard handling, and output width rules.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm run test` — passed, 44/44 tests.
- `npm run check` — passed syntax check for `scripts/check-package-contents.mjs`.
- `npm run format:check` — passed for 42 files.
- `npm run check:pack` — passed; npm dry-run package contains 22 public files and excludes local state/specs.
- `npm audit --audit-level=moderate --omit=optional` — passed, 0 vulnerabilities.
- `npm run validate` — passed; repeats typecheck, tests, syntax check, and package-content check.
- `rg -n "GitExecutor|UpstreamInfo|GitExecOptions|EXTENSION_STATUS_KEY|BranchMeToolOptions|CreateBranchParameters|ChangeBranchParameters|PullRequestParameters|TokenResolutionOptions|PullRequestFetchOptions" src test scripts docs README.md SECURITY.md` — identified unused or exported surface needing review.

## Findings summary by severity and category

- High: 0.
- Medium: 4 — command mode behavior, CI/validation coverage gap, TUI width/input robustness, stale planning docs/specs.
- Low: 1 — unused exported constants/types and stale development shim surface.
- Categories: Logic, Testing, Clean Code, Documentation, Type Safety, Pi Integration.

## Ordered tasks

- [ ] Make `/branchme` command output safe across print, JSON, RPC, and TUI modes

#### Why

`src/commands/branchme-command.ts` falls back to `console.log()` when `ctx.hasUI` is false. Pi docs identify JSON mode as `ctx.hasUI === false`; writing arbitrary text to stdout in JSON/protocol modes can corrupt machine-readable output. Existing command tests use an inconsistent fake context (`mode: "print"`, `hasUI: true`), so they do not prove the intended no-UI fallback behavior.

#### How to resolve

- Inspect `notifyOrLog()` and `/branchme help`/panel fallback paths in `src/commands/branchme-command.ts`.
- Define explicit behavior for each mode: TUI uses `ctx.ui.custom`, RPC/TUI use `ctx.ui.notify`, print may write plain text if that is the accepted print-mode contract, and JSON should avoid raw stdout writes.
- Add tests in `test/command.test.mjs` for realistic contexts: `mode: "tui"`, `"rpc"`, `"json"`, and `"print"` with matching `hasUI` values.
- If JSON mode cannot surface command text safely through current APIs, document the limitation and ensure it fails/returns silently without corrupting the stream.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- `/branchme` and `/branchme help` do not write raw non-protocol text to stdout in JSON mode.
- Tests cover realistic mode/`hasUI` combinations and assert the correct output path for each.
- TUI, RPC, and print behavior remains user-visible where supported.
- Relevant validation commands pass.

- [ ] Include formatting checks in the default validation and CI path

#### Why

`npm run format:check` exists and passed during review, but `npm run validate` and `.github/workflows/ci.yml` do not run it. CI currently calls only `npm run validate`, so trailing whitespace, CRLF, missing final newlines, or invalid JSON in files covered by `scripts/check-format.mjs` can merge without detection unless maintainers remember to run the format check separately.

#### How to resolve

- Update `package.json` so `npm run validate` includes `npm run format:check`, or add an explicit CI step in `.github/workflows/ci.yml` if keeping validation shorter is intentional.
- Consider making `npm run lint` include `format:check` or renaming scripts so their responsibilities are clear.
- Keep the check read-only; do not add format writers unless separately specified.
- Update README/CONTRIBUTING validation instructions if command expectations change.
- Validate with `npm run format:check` and `npm run validate`.

#### Acceptance criteria

- The same validation command used by CI fails on formatting violations covered by `scripts/check-format.mjs`.
- Local documentation tells contributors to run the updated validation path.
- `npm run format:check` and `npm run validate` pass after the change.
- The task does not introduce automatic formatting writes.

- [ ] Replace ad hoc TUI width and keyboard handling with Pi TUI utilities where needed

#### Why

`src/ui/branchme-panel.ts` manually clips strings with `value.length` and handles arrow keys with raw escape sequences such as `"\u001b[A"`. Pi TUI docs recommend width-aware utilities and `matchesKey()`/`Key` helpers. The current implementation is compact and tested for ASCII captures, but Unicode wide characters, ANSI-aware width, and alternate key encodings can break rendering or navigation in real terminals.

#### How to resolve

- Inspect `sanitize()`, `clip()`, `pad()`, `sanitizeLayout()`, `clipLayout()`, `padLayout()`, and `BranchMePanel.handleInput()` in `src/ui/branchme-panel.ts`.
- Use Pi TUI utilities such as `truncateToWidth`, `visibleWidth`, and `matchesKey()`/`Key` where appropriate, or explicitly constrain/sanitize displayed branch/repository strings so visible width remains predictable.
- Keep existing tiny/narrow/wide capture behavior stable unless intentionally updating `docs/TUI_CAPTURE.md`.
- Add tests for wide Unicode branch/status strings and key handling through `matchesKey`-style inputs.
- Validate with `npm run typecheck`, `npm run test`, `npm run format:check`, and `npm run validate`.

#### Acceptance criteria

- Rendered panel lines fit terminal width by visible width, including Unicode/wide characters and themed output.
- Up/down/tab/enter/escape navigation works through Pi TUI key utilities or covered equivalent behavior.
- TUI capture tests either remain stable or are intentionally refreshed with reviewable changes.
- Relevant validation commands pass.

- [ ] Reconcile stale planning docs and specs with implemented BranchMe behavior

#### Why

Several planning files still describe earlier constraints that no longer match the implementation, including four-tool assumptions and “process env only / do not read `.env` in v1” guidance. `docs/PROJECT_DEFINITION_BRIEF.md`, `specs/spec-architecture.md`, and `specs/spec-guidelines.md` are useful context, but stale language can mislead future workers and reviewers about current security boundaries and accepted behavior.

#### How to resolve

- Review `docs/PROJECT_DEFINITION_BRIEF.md`, `specs/spec-architecture.md`, `specs/spec-guidelines.md`, `specs/spec-tasks.md`, and `specs/spec-change-branch-tool.md` for historical-vs-current ambiguity.
- Decide whether each file should remain historical, be marked as historical, or be updated to current implemented behavior.
- At minimum, add clear notes where completed plans intentionally diverged, such as the addition of `change_branch` and local `.env` fallback.
- Keep task checkboxes and historical evidence intact unless a future documentation policy explicitly says to rewrite them.
- Validate with `npm run format:check` and `npm run test` if tests assert documentation text.

#### Acceptance criteria

- Future readers can distinguish historical preparation decisions from current implemented BranchMe behavior.
- No active guidance contradicts the actual tool count, token lookup policy, or security boundaries.
- Documentation tests still pass or are updated with intentional assertions.
- Relevant validation commands pass.

- [ ] Prune or justify unused exported surfaces and stale development shims

#### Why

Static search found exported items that appear unused by the current source/tests, including `EXTENSION_STATUS_KEY`, `UpstreamInfo`, `GitExecOptions`, and `GitExecutor`. `dev-shims/pi-coding-agent` also appears out of sync with the real extension API used by BranchMe because its `ExtensionAPI` surface lacks methods such as `registerTool` and `exec`. Unused exports and stale shims increase maintenance cost and can mislead future contributors about supported public API.

#### How to resolve

- Inspect each exported constant/type in `src/constants.ts` and `src/types.ts` to determine whether it is intentionally public, reserved for future use, or dead code.
- Remove dead exports or add comments/tests documenting why they are part of the supported package surface.
- Inspect `dev-shims/pi-coding-agent`; update it to match the methods BranchMe actually uses or remove it if it is obsolete and not referenced by tooling.
- Consider enabling targeted unused-code checks if they can be adopted without false positives for intentional exports.
- Validate with `npm run typecheck`, `npm run test`, `npm run format:check`, and `npm run check:pack`.

#### Acceptance criteria

- Unused exports are removed or explicitly justified as public/reserved API.
- Development shims either reflect the current extension API surface needed by BranchMe or are removed from active maintenance paths.
- Package contents remain minimal and do not accidentally include development-only shims.
- Relevant validation commands pass.

## Blocked checks or areas not reviewed

- No ESLint or unused-export analyzer is configured, so unused-code findings are based on targeted `rg` inspection rather than a complete symbol graph.
- No live terminal was used to test Unicode rendering or alternate keyboard encodings; review relied on renderer tests and Pi TUI docs.
- No source/docs beyond the generated review spec were changed during this pass.
