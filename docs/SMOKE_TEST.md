# BranchMe Smoke Test Notes

Baseline smoke record: 2026-08-23. Updated for the normal-workflow expansion.

Validated from the repository checkout with no discovered extensions enabled.

## Commands

```bash
npm run typecheck
npm run format:check
npm run test
npm run smoke:pi
npm run check:pack
npm run smoke:worktree-handoff
npm run validate
npm run smoke:pi:packed
npm run release:check
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
pi --no-extensions -e .
```

## Automated smoke behavior

- `npm run smoke:pi` first runs isolated checkout Pi processes from a temporary non-Git working directory: one with `pi --no-extensions -e <package> -e <temporary verifier>` and `/branchmeverify verify`, then one with `pi --no-extensions -e <package>` and `/branchme help`.
- The temporary command verifier calls `pi.getAllTools()` after BranchMe loads and confirms every documented tool in the canonical `BRANCHME_TOOL_NAMES` inventory is registered exactly once and active with strict schemas, nonempty descriptions without repeated tool-name prefixes, optional tool-named guidelines, and extension source metadata. It also proves `continue_merge` and `abort_merge` are absent.
- Runtime schema contracts must cover the canonical `BRANCHME_TOOL_NAMES` inventory exactly once; there is no separate fixed tool count or name-only inventory. Runtime schema inspection verifies that `integrate_branch` has exactly the required `sourceBranch` and `targetBranch` fields plus optional `keepConflicts` and `worktreePath` and that `retire_branch` has exactly the required `branchName`, `expectedHead`, `targetBranch`, and `force` fields with `additionalProperties: false`. It also verifies that `branch_status` has only optional top-level `worktreePath` and `ancestry`, the `ancestry` object's required nested `sourceBranch` and `targetBranch` fields reject additional nested or top-level properties.
- A second temporary verifier registers a deterministic local smoke model, blocks `fetch`, and runs normal prompts through real Pi lifecycle handling. It verifies automatic no-tool Git context in a temporary repository, one real `branch_status` tool refresh after a verifier-created local change, one `git_diff({})` call with no sizing arguments and a clear model-visible comparison/scope/completeness result, safe credential-free related-PR status with no request, and non-Git startup fallback. It derives expected names from `BRANCHME_TOOL_NAMES`. Its model-visible active tools are restricted to BranchMe (no Bash). Its `tool_call` guard permits only the designated read (`branch_status` for refresh, `git_diff` for diff inspection, or `git_status` for status pagination) in that scenario and blocks every other call, including future tools, before execution. The status scenario creates more than 50 paths in its disposable fixture and requires the agent to follow a continuation to the final page.
- The Pi runtime smoke validates worktree, integration, and retirement tool registration, strict schemas, and prompt contracts only; it never creates or removes a worktree, runs a merge, or retires a branch. Real-Git lifecycle coverage runs under `npm run test` in isolated temporary local repositories with no remote contact.
- Isolated real-Git integration tests cover `already_integrated`, `fast_forward`, exact two-parent `merge_commit`, and conflict-path capture followed by verified automatic abort/restoration. They also cover target mismatch, dirty control state, rejection of branch-specific target merge options, unrelated histories, ignored-file overwrite protection, preserved repository hooks, and a committed source ref checked out in another dirty linked worktree. The recorded merge argv proves autostash and rerere are disabled, ignored-file protection is enabled, and `--no-verify` is absent.
- Isolated real-Git retirement tests cover merged and explicitly forced-unmerged local-ref deletion, stale expected-`HEAD` rejection, current and linked-worktree occupancy, dirty unrelated worktrees, non-current targets, and preservation of target refs, remote-tracking refs, worktrees, working-tree files, and `branch.<name>.*` configuration without contacting a remote. Recorded argv proves retirement uses `update-ref --no-deref -d` with the captured expected commit and never uses `git branch -d/-D`, fetch, push, or a remote ref target.
- `npm run smoke:worktree-handoff` loads only BranchMe into a deterministic extension host backed by real local Git, creates a new-branch linked worktree through the registered `create_worktree` tool, and launches a separate Node verification process with the returned absolute `handoff.cwd`. That process verifies its cwd, branch, full `HEAD`, and lack of remotes. The smoke then calls the registered `remove_worktree` tool, verifies the directory is absent, verifies the retained local branch remains at the original commit, and asserts that `retire_branch` was never invoked.
- The handoff smoke uses only a freshly created temporary source repository and sibling worktree, an empty Git config, a minimal credential-free environment, no remotes, offline Pi flags, and a fetch guard that fails on any network request. Cleanup recursively removes the isolated temporary root even on failure.
- `npm run validate` includes the isolated handoff smoke after package-content checks.
- The checkout command smoke accepts either `/branchme help` text or the read-only BranchMe status fallback as equivalent non-mutating command output.
- `npm run smoke:pi:packed` creates an npm tarball under a temporary directory, installs that tarball into a separate temporary package with `npm install --omit=dev`, and runs pi against the installed package instead of the source checkout.
- `npm run release:check` is the canonical release gate: it runs `npm run validate` and then `npm run smoke:pi:packed`. Both `node scripts/publish-npm.mjs` and the GitHub `Publish to npm` workflow run it before npm publication; a packed install/load failure stops publication and the workflow's Git tag step. Everyday `npm run validate` keeps the faster checkout smoke.
- Both Pi smoke runs disable discovered extensions, skills, prompt templates, themes, context files, persistent sessions, telemetry, startup network checks, and GitHub token environment variables.
- Registration/context/packed command smokes are credential-free and do not invoke mutation tools or contact GitHub. The separate shell-free workflow smoke intentionally exercises authorized mutations only in disposable repositories and uses fake credentials with a fully mocked GitHub transport; no live token, API write, or remote transport is used.
- Pi's documented `getAllTools()` metadata exposes parameter schemas, descriptions, prompt guidelines, and source metadata, while command context exposes active `promptSnippet` values through `getSystemPromptOptions().toolSnippets`. The runtime verifier checks both surfaces and the actual `getSystemPrompt()` tools section: each snippet must be a nonempty single line without an embedded tool-name prefix and must render exactly once with Pi's own prefix. The deterministic local smoke model exercises `branch_status` through Pi's normal model tool-call loop without provider or GitHub network access.
- Set `BRANCHME_SKIP_PI_SMOKE=1` to skip intentionally, or `BRANCHME_PI_BIN=/path/to/pi` to test a specific Pi binary for the checkout smoke.
- If no Pi binary is available, the checkout smoke script prints an explicit skip message; default CI installs the Pi dev dependency, so `npm run validate` exercises the real Pi loading path.

- `npm run smoke:shell-free` (included in `smoke:pi`/`validate`) runs three deterministic real-Pi scenarios with only scenario-specific BranchMe tools active. No Bash, file tools, CommitMe, or other extension is available to the model. The local scenario covers history/blob reads, status, stage/unstage, preview/apply restore, remote/upstream setup, selected-worktree branch/rebase bases, and no-commit revert. Another inspects kept-merge stages, and a mocked-GitHub scenario reads all-state checks, edits explicit metadata, and performs a leased host merge. Harness-only setup uses isolated real Git; live HTTP is forbidden. This complete workflow gate requires Pi unless explicitly skipped.

## Normal-workflow regression coverage

- Shell-free status delivery: `npm run validate` passed all 427 tests and the new two-page real Pi status smoke; `npm run smoke:pi:packed` passed against an isolated production installation. No real repository Git mutation or GitHub write was used.
- `test/git-status.test.mjs` covers complete multi-page status, staged-only changes, renames/deletions/conflicts, stale cursors and collection-time edits, literal filters, unborn/detached HEAD, same-repository worktree selectors, safe paths/redaction, file expectation bounds, malformed/oversized output, strict schemas, cancellation, and index/ref/config/file preservation in disposable local repositories.
- `test/git-diff.test.mjs` covers explicit local diff modes (including unborn staged additions and detached HEAD), captured direct/merge-base ranges, literal root-relative filters, linked-worktree routing, index/ref/config/file preservation, disabled external helpers/textconv/fsmonitor, safe redacted/control-escaped output bounds, invalid inputs, and cancellation/failure paths. It runs only in isolated local repositories; runtime schema smoke also includes `git_diff`.

- `test/workflow.test.mjs` uses isolated repositories and local bare remotes for bounded branch discovery, upstream counts, tracking checkout verification, dirty/missing-branch refusals, and base no-op/fast-forward/divergent/conflict outcomes.
- `test/pr-workflow.test.mjs` mocks GitHub lifecycle state, repository/commit validation, API failures/cancellation, idempotent creation, and HTTP 422 races. It never contacts GitHub.
- `test/land-branch.test.mjs` additionally exercises real squash/cherry-pick rewritten histories with mocked merged-PR evidence, rejected mismatches, source movement, and unchanged remote refs.
- Review regressions cover symbolic fetch destinations before mutation, missing upstream tracking refs, initialization environment/discovery refusals and failed postconditions, and redaction before truncating PR cancellation errors.
- Runtime schema smoke checks every canonical tool and `land_branch.pullRequestNumber`; none of these mutation or GitHub paths run against the user's repository.

## Result

- Complete shell-free expansion: `npm run release:check` passed all 456 tests, registration/schema/context smoke, the BranchMe-only workflow model loops, script/package checks, isolated worktree handoff, and installed-production-package smoke. New GitHub lifecycle tests use mocked APIs; Git mutations use only disposable local repositories/bare remotes. No commit, fetch, push, branch switch, or GitHub write was performed on the user's repository.

- `git_diff` expansion and agent-usability audit: `npm run validate` passed the complete test suite, TypeScript/format checks, checkout Pi registration/context smoke against the canonical inventory, default-argument diff inspection through the real model/tool loop, package-content checks, and isolated worktree handoff. Coverage includes model-visible scope/completeness, unmatched filters, local failure guidance, and exact documentation/inventory names without prose-count assertions. Diff coverage uses temporary local repositories without network calls.
- Normal-workflow expansion and review fixes: `npm run release:check` passed with all 306 tests, checkout schema/context smoke, package-content checks, isolated worktree handoff, and installed-production-package smoke. GitHub behavior used mocked REST responses; no live GitHub lifecycle mutation was tested or performed.
- `npm run typecheck`, `npm run format:check`, `npm run test`, `npm run smoke:pi`, `npm run check:pack`, `npm run validate`, and `npm run smoke:pi:packed` passed.
- `npm run smoke:worktree-handoff` returned `ok: true`, an absolute ready cwd, the expected `feature/isolated-handoff-smoke` branch and full commit ID from a separate process, `branchRetained: true` after force-free removal, `retireBranchInvoked: false`, zero network requests, and an isolated empty credential source.
- `npm run smoke:pi` loaded BranchMe through Pi, verified the complete canonical BranchMe inventory (including strict `land_branch`, `integrate_branch`, `retire_branch`, and nested `branch_status.ancestry` schemas), proved merge-continuation tools absent, and confirmed non-mutating BranchMe command output.
- The isolated Git-context prompt smoke observed the `before_agent_start` snapshot, answered branch and dirty-tree state without a tool call, refreshed a verifier-created local change through one real `branch_status` call, returned safe unavailable context without credentials or outside Git, and attempted no network request.
- `npm run smoke:pi:packed` packed BranchMe outside the repository, installed the artifact in a temporary production workspace, loaded the installed package through Pi, and confirmed non-mutating BranchMe command output.
- `npm run check:pack` confirmed the package contents are limited to public docs (including worktree, local integration, leased local branch-retirement, and security boundaries), images, source, license, package metadata, `.env.example`, and `tsconfig.json`; private planning specs and generated files remain excluded.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe help or status output instead of template behavior.
- The bare `pi --no-extensions -e .` smoke command exited cleanly in this non-interactive validation environment.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was also used so the smoke test could exit without leaving an interactive TUI session open.
