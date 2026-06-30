# Final-pass Pi extension review tasks

## Review scope and date

- Date: 2026-06-30
- Scope: Strict final verification of BranchMe core Pi extension behavior, previous review assumptions, Pi lifecycle/mode concerns, edge cases, failure states, and important test gaps.
- Review mode: Planning only. No implementation, source, test, doc, dependency, generated, state, or changelog files were modified.

## Files or areas reviewed

- Previous generated review specs: `specs/spec-review-pi-extension-first-pass-tasks.md`, `specs/spec-review-pi-extension-second-pass-tasks.md`.
- Public extension entry: `src/extension.ts`.
- Tool registration and schemas: `src/tools/branchme-tools.ts`, `src/constants.ts`, `src/types.ts`.
- Git behavior: `src/git.ts`.
- GitHub behavior: `src/github.ts`.
- Command/UI behavior: `src/commands/branchme-command.ts`, `src/ui/branchme-panel.ts`.
- Tests and validation: `test/*.test.mjs`, `package.json`, `.github/workflows/ci.yml`, `scripts/check-format.mjs`, `scripts/check-package-contents.mjs`.
- Docs/security claims: `README.md`, `SECURITY.md`, `docs/STRUCTURE.md`, `docs/SMOKE_TEST.md`, `docs/TUI_CAPTURE.md`.
- Pi extension/TUI docs and examples already read during earlier passes: `docs/extensions.md`, `docs/tui.md`, and selected `examples/extensions/*`.

## Previous claims or assumptions verified

- Verified: default export is `branchMeExtension` and registers only the BranchMe command/tools in `src/extension.ts`.
- Verified: five tools are registered by name: `branch_status`, `create_branch`, `change_branch`, `push_branch`, and `pull_request`.
- Verified: tool schemas use `additionalProperties: false`; existing tests inspect schema shape but do not exercise Pi’s runtime validator.
- Verified: git helpers use `pi.exec("git", args, ...)` with argv arrays and pass `cwd`, `signal`, and timeouts.
- Verified: mutating git helpers are not serialized against parallel Pi tool execution; see first-pass task.
- Verified: upstream-present `push_branch` uses bare `git push`; see first-pass task.
- Verified: GitHub PR input validation does not reject `owner:branch` `head` values; see first-pass task.
- Verified: GitHub API error bodies are truncated after `response.text()` reads the full body; response reading itself is unbounded.
- Verified: `/branchme` has TUI and non-TUI paths; JSON-mode stdout safety remains unproven and is captured in the second-pass task.
- Verified: `npm run validate` passes but does not include `format:check`; see second-pass task.
- Verified: generated review specs are formatting-clean after `npm run format:check`.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm run test` — passed, 44/44 tests.
- `npm run format:check` — passed after first/second review spec creation; 44 files checked.
- Previously run during this review: `npm run check`, `npm run check:pack`, `npm audit --audit-level=moderate --omit=optional`, `npm run validate`, read-only `git status`/`git diff --stat`, and targeted `rg` inspections — all completed without implementation changes.

## Findings summary by severity and category

- High: 0 new final-pass-only findings. Earlier high-risk items remain in the first-pass spec.
- Medium: 4 — runtime Pi smoke coverage, partial-status resilience, bounded GitHub response handling, runtime schema validation coverage.
- Low: 0.
- Categories: Pi Integration, Testing, Edge Cases, Error Handling, Output Bounding, Tool Schema Validation.

## Ordered tasks

- [ ] Add automated non-mutating Pi runtime smoke coverage for the packaged extension

#### Why

Current tests instantiate BranchMe with fake Pi APIs and inspect helper behavior, but they do not prove that the package loads through Pi’s real extension discovery/runtime path. `docs/SMOKE_TEST.md` records manual `pi --no-extensions -e .` checks, yet CI does not enforce even a minimal non-mutating load/help path. A packaging, export, module-resolution, or real Pi API drift could pass unit tests and fail when installed or loaded by Pi.

#### How to resolve

- Add a safe smoke test or CI validation step that loads the extension with Pi in isolation, such as `pi --no-extensions -e .`, without creating branches, pushing, or making GitHub API calls.
- Prefer a deterministic command path like `/branchme help` followed by `/quit`, or a Pi-supported package/list/load check if that is less brittle in CI.
- Keep the check credential-free and non-mutating.
- Document any environment constraints if the smoke test must be skipped when the Pi binary is unavailable.
- Validate locally with the new smoke command plus `npm run validate`.

#### Acceptance criteria

- CI or the default validation path exercises real Pi extension loading for this package without mutating git state or contacting GitHub.
- The smoke test proves `/branchme help` or equivalent non-mutating extension behavior works outside fake unit-test APIs.
- The check has clear skip/failure behavior when Pi is unavailable.
- Relevant validation commands pass or documented blockers explain why the smoke check is deferred.

- [ ] Make `branch_status` resilient to partial git status failures

#### Why

`getBranchStatus()` has a structured output shape that allows unavailable ahead/behind counts, but if `git rev-list --left-right --count HEAD...@{u}` fails for a stale or broken upstream, the whole `branch_status` tool fails. The `/branchme` panel then loses otherwise useful current branch, dirty-state, and upstream information. Core status inspection should degrade gracefully when non-essential sub-checks fail.

#### How to resolve

- Inspect `getBranchStatus()` in `src/git.ts` and `formatBranchStatus()` in `src/tools/branchme-tools.ts`.
- Treat ahead/behind count failures as a warning/unavailable state while preserving repo root, current branch, upstream, and dirty-state details.
- Add an optional warning field to `BranchStatusDetails` only if needed and keep details serializable and bounded.
- Add tests in `test/git.test.mjs`, `test/tools.test.mjs`, and/or `test/command.test.mjs` for stale upstream or unparsable ahead/behind output.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- `branch_status` returns useful partial status when only ahead/behind counting fails.
- User-facing content clearly says ahead/behind is unavailable without hiding the current branch and dirty state.
- Tests cover stale/unavailable upstream count behavior.
- Relevant validation commands pass.

- [ ] Bound GitHub API response consumption and error parsing

#### Why

`createGitHubPullRequest()` truncates HTTP error text after calling `response.text()`, and parses success bodies with `response.json()` without a size bound. GitHub responses are normally small, but robust tools should bound output and memory before feeding data into tool errors/details. This also aligns with Pi guidance that custom tools must avoid unbounded outputs.

#### How to resolve

- Inspect `createGitHubPullRequest()` in `src/github.ts`.
- Add a small response-body read limit for both error and success paths, or use a helper that reads/truncates response streams before parsing.
- Preserve secret redaction and useful HTTP status messages.
- Add tests for oversized error bodies, malformed oversized JSON, non-object JSON, and abort behavior if supported by the chosen helper.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- GitHub response bodies are bounded before being included in errors or parsed into details.
- Oversized and malformed responses fail with concise redacted messages.
- Existing successful PR response parsing still works.
- Relevant validation commands pass.

- [ ] Add runtime schema-validation tests for BranchMe tool inputs

#### Why

Existing tests inspect schema objects and required properties, but they do not run the same validation path that Pi or TypeBox uses to reject bad tool inputs. The extension relies on strict schemas for security boundaries such as rejecting `owner`, `repo`, `force`, `stash`, `discard`, `path`, and missing required PR fields. A schema-shape regression could be missed if object inspection remains green while runtime validation behavior changes.

#### How to resolve

- Add tests that validate each exported TypeBox schema with the same validator semantics Pi uses, or a closest TypeBox validator available in the project.
- Cover success cases plus invalid types, missing required fields, blank strings where min length should apply, and extra properties for all tools.
- Include explicit negative tests for forbidden fields called out in README/SECURITY.
- Keep tests independent of real git/GitHub operations.
- Validate with `npm run typecheck`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- Runtime schema validation rejects extra and invalid tool arguments for every BranchMe tool.
- Tests specifically cover forbidden boundary fields for `change_branch`, `create_branch`, `push_branch`, and `pull_request`.
- The validation test path matches or clearly documents any differences from Pi’s runtime validation.
- Relevant validation commands pass.

## Unknowns resolved

- The extension does not start background resources in its factory.
- The command is informational; git/GitHub mutations are exposed only through tools.
- Tests mock `pi.exec` and `fetch`, so normal validation does not mutate a real repository or call GitHub.
- Package dry-run excludes specs, local Pi state, node_modules, and real environment files.
- Review-generated spec files are included in format checking and passed after creation.

## Blocked checks or areas not reviewed

- The protected real `.env` file was not read.
- Live branch switching, pushing, and GitHub PR creation were intentionally not executed.
- Real interactive TUI behavior was not exercised in a terminal; review used source inspection, docs, and capture tests.
- Trivy was not run because the provided script writes report/cache directories and may require local installation/database updates.
- A full symbol-graph unused-export analysis was not available because no such analyzer is configured.
