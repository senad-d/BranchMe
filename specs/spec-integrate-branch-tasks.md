# Plan: Branch Integration Tasks

## Task description

Add a minimal `integrate_branch` tool that merges one exact local source branch into one exact local target branch from a clean control worktree. The operation must verify repository and branch identity, return before/after commit identities, automatically abort conflicts, and never push, delete branches, remove worktrees, or leave an initial conflict-resolution workflow in progress.

## Objective

Provide a safe branch-integration primitive for Mission and specialized integration agents while keeping BranchMe's public surface small. Extend the existing `branch_status` tool for targeted ancestry verification instead of adding another read-only tool, and do not expose `continue_merge`.

## Approved decisions and boundaries

- Add one tool: `integrate_branch`.
- `integrate_branch` requires exactly `sourceBranch` and `targetBranch`.
- Both inputs identify distinct, existing local branches in the current repository. Remote-only refs, full refs, commit IDs, paths, repositories, remotes, and owner-prefixed refs are not accepted.
- The active Pi worktree is the control worktree.
- The control worktree must already have `targetBranch` checked out and must be clean. `integrate_branch` never switches branches, infers a target, stashes, discards changes, or resets.
- A source branch may be checked out in another linked worktree. Dirty state in that source worktree does not block integration because the operation reads the committed source ref and does not mutate the source worktree.
- The repository is identified through the verified worktree root and canonical common Git directory. Identity is captured before mutation and verified afterward.
- Capture the source and target branch commit IDs before mutation and verify both refs after mutation.
- Use normal merge semantics: return `already_integrated` when no mutation is needed, allow a fast-forward, and allow Git to create a merge commit for divergent histories.
- Reject a non-empty `branch.<targetBranch>.mergeOptions` setting before mutation so branch-specific defaults cannot silently add options such as `--no-commit`, `--squash`, `--no-verify`, or a custom strategy.
- Run the merge with explicit safe policy arguments:
  - `git -c rerere.enabled=false merge --ff --no-edit --no-autostash --no-rerere-autoupdate --no-overwrite-ignore refs/heads/<sourceBranch>`
- Disable rerere for this operation so a repository-configured recorded resolution cannot silently alter conflict contents or leave new rerere cache state. Keep `--no-rerere-autoupdate` explicit as defense in depth.
- Preserve configured Git hooks, merge drivers, filters, and signature policy. Do not pass `--no-verify`, do not accept a custom merge message, and do not expose strategy, squash, unrelated-history, signing, force, or commit controls.
- Repository-configured hooks, merge drivers, and filters may execute arbitrary local commands or network operations under the user's identity. Documentation and tests must not imply that BranchMe can constrain those external Git extension points.
- Supported statuses are `already_integrated`, `fast_forward`, `merge_commit`, and `conflict`.
- A conflict is an expected structured result only after conflict paths are captured, `git merge --abort` succeeds, and exact restoration postconditions pass.
- Keep reusable local-ref ancestry and repository-identity primitives in `src/git.ts`, but place the integration preflight/mutation/cleanup state machine in a focused `src/git-integration.ts` module so the already-large general Git helper does not absorb another complex workflow.
- Use exactly one repository mutation-queue window around preflight, merge, cleanup when needed, and final verification. Do not nest the existing non-reentrant queue or release it between captured state and mutation.
- The in-memory queue coordinates only mutations in the current BranchMe process; it cannot lock other Pi sessions or external Git processes. Capture and re-verify both refs, and report an uncertain error without rollback if external concurrent mutation is detected.
- Preflight and merge execution use the caller's abort signal. Once merge execution begins, cleanup and all post-mutation verification must run without the caller's signal and with their own bounded timeouts so cancellation cannot prevent state classification or restoration.
- Any failed merge that leaves `MERGE_HEAD` must be automatically aborted, including non-conflict commit, hook, signing, or identity failures. Return `conflict` only when unmerged paths prove a conflict; otherwise abort, verify restoration, and throw the original bounded failure.
- If abort or postcondition verification is inconclusive, throw a bounded error and tell the caller to inspect the repository. Never attempt reset-based rollback or destructive cleanup.
- `integrate_branch` never fetches, pulls, pushes, rebases, stages user files directly, deletes branches, creates/removes worktrees, changes Pi's cwd, starts agents, or resolves semantic conflicts.
- Mission or another orchestrator decides whether to delegate conflict analysis and when to ask the developer about semantic intent.
- Do not add `continue_merge`, `abort_merge`, or a separate ancestry tool in this implementation.
- Extend `branch_status` with an optional strict nested ancestry query containing exact `sourceBranch` and `targetBranch` values. Existing `{}` calls and automatic Git context remain unchanged.
- A targeted `branch_status` ancestry verification must run only after `integrate_branch` completes; it must not be batched with integration because read-only status calls do not participate in the mutation queue.
- Treat branch names, paths, commit output, and Git diagnostics as untrusted metadata. Redact, escape, and bound display values and conflict-path results.
- Returned structured conflict-path entries must remain exact repository-relative identities after the same lossless safety checks used for machine-readable handoffs. If a path would require redaction, control/format escaping, Unicode alteration, or truncation, abort and verify restoration but throw a bounded error instead of returning an unusable `conflict` result. Human-readable content remains sanitized separately.
- Execute tasks in order, one task per implementation session. Keep the full existing test suite green after every task, and mark only the completed task with `x` after all of its acceptance criteria and validation pass.

### 1. Define integration contracts, constants, and serializable details

- [x] Add the public integration and ancestry contracts without registering a tool or introducing a merge mutation.

#### Why

The Git helper, conflict cleanup, tool formatter, targeted status query, tests, and documentation need a stable result model before runtime behavior is implemented.

#### How

- Add `INTEGRATE_BRANCH_TOOL_NAME`, but do not include it in the active `BRANCHME_TOOL_NAMES` list until Task 5 registers the tool. This keeps extension-registration invariants valid between tasks.
- Add dedicated integration timeout, conflict raw-output, conflict-entry, conflict-path, and rendered-summary limits using existing Git/context conventions.
- Define strict serializable input types for `integrate_branch` and the optional `branch_status` ancestry query.
- Define ancestry details containing source/target branch names, captured full commit IDs, and `isAncestor`.
- Define integration details as a discriminated result using these statuses:
  - `already_integrated`;
  - `fast_forward`;
  - `merge_commit`;
  - `conflict`.
- Include repository/control-worktree verification, requested branches, before/after source and target HEADs, final ancestry proof, clean-state proof, bounded conflict paths with an omitted count, and abort/restoration facts where relevant.
- Keep details JSON-serializable and free of runtime objects, signals, command handles, and unbounded raw Git output.

#### Where

- `src/constants.ts`
- `src/types.ts`
- `test/preparation.test.mjs`

#### Acceptance criteria

- `INTEGRATE_BRANCH_TOOL_NAME` is defined exactly once but is not yet present in `BRANCHME_TOOL_NAMES`.
- The details contract can distinguish no-op, fast-forward, merge-commit, and restored-conflict outcomes without parsing prose.
- Before and after source/target full commit IDs are represented explicitly.
- Conflict details represent exact lossless returned entries, omitted count, successful abort, and verified restoration; display summaries are sanitized separately.
- No `integrate_branch`, `continue_merge`, or other merge tool is registered in this task.
- No Git merge mutation is introduced in this task.
- `npm run typecheck` and `npm test` pass.

### 2. Add targeted local-branch ancestry verification to `branch_status`

- [x] Implement and test an optional read-only ancestry query on the existing `branch_status` tool.

#### Why

After integration, callers need an independent read-only proof that the captured source branch is reachable from the target branch. Adding this to `branch_status` keeps the tool surface minimal.

#### How

- Add an optional strict nested input:
  - `ancestry.sourceBranch`;
  - `ancestry.targetBranch`.
- Require both nested fields together and reject all additional properties.
- Preserve compatibility with the existing empty `{}` input.
- Validate both branch names and require both local refs to exist.
- Capture both branch commit IDs, then run `git merge-base --is-ancestor <sourceHead> <targetHead>` against the captured commits rather than mutable branch-name arguments.
- Interpret exit code `0` as true and `1` as false; treat other exits, killed commands, and malformed commit identities as errors.
- Add optional structured ancestry details and one bounded ancestry line to explicit `branch_status` output only when requested.
- Prioritize the requested ancestry proof over optional change/commit display entries so summary-limit fallback cannot silently omit the requested result; the structured details must always retain the proof.
- Add prompt guidance that targeted ancestry verification runs after `integrate_branch` completes and must not be issued in the same parallel tool batch.
- Do not add ancestry scanning to automatic `before_agent_start` context and do not enumerate every local branch.

#### Where

- `src/git.ts`
- `src/git-context.ts`
- `src/tools/branchme-tools.ts`
- `src/types.ts`
- `test/git.test.mjs`
- `test/git-context.test.mjs`
- `test/tools.test.mjs`
- `test/schema-validation.test.mjs`

#### Acceptance criteria

- `branch_status({})` behaves exactly as before and issues no ancestry commands.
- A valid nested ancestry query returns captured full source/target HEADs and a correct boolean proof.
- Missing half-pairs, extra nested fields, extra top-level fields, invalid branch names, and missing local refs are rejected.
- Ancestry checks are read-only and propagate the caller's abort signal.
- Automatic Git context remains unchanged in schema, command count, and rendered fields.
- Explicit ancestry output remains visible under worst-case bounded context input, stays within `GIT_CONTEXT_SUMMARY_LIMIT_CHARS`, and treats branch metadata as untrusted.
- Focused Git, context, tool, and schema tests pass.
- `npm test` passes.

### 3. Implement integration preflight and repository-identity verification

- [x] Add and unit-test the read-only preflight that prepares an exact local branch integration without running `git merge`.

#### Why

The merge must not start unless the active worktree, repository, target branch, source branch, and captured commits are all unambiguous and safe.

#### How

- Resolve the active worktree root from `ctx.cwd` before queueing so it can be used as the existing mutation-queue key.
- Let the eventual `integrateBranch` caller open exactly one existing per-repository mutation-queue window; keep the preflight helper itself unqueued so Task 4 cannot deadlock by nesting the non-reentrant queue.
- Inside that window, resolve and canonicalize the repository's common Git directory to establish repository identity across linked worktrees.
- Validate source and target branch names and reject identical branches.
- Require both `refs/heads/<branch>` refs to exist and resolve to valid full commit IDs.
- Require the current symbolic branch to equal `targetBranch`; reject detached HEAD and target mismatch without switching.
- Require the control worktree to have no staged, unstaged, untracked, or unmerged changes.
- Detect and reject any existing merge, rebase, cherry-pick, revert, or sequencer state before integration begins, even when ordinary porcelain status appears clean.
- Compute whether source is already an ancestor of target from the captured commit IDs.
- Return an internal prepared state suitable for the later mutation and postcondition verifier.
- Do not inspect or reject dirtiness in another worktree that has the source branch checked out.

#### Where

- `src/git.ts`
- `src/git-integration.ts`
- `test/git.test.mjs`

#### Acceptance criteria

- Integration-specific orchestration lives in `src/git-integration.ts`; only narrow reusable primitives are added/exported from `src/git.ts`.
- Invalid, identical, missing, detached, wrong-target, dirty-control, and existing-merge states fail before any mutation.
- The prepared state contains the verified worktree root, canonical common Git directory, target branch, source branch, and both captured commit IDs.
- Source branch occupancy or dirty state in another linked worktree does not block preflight.
- No command switches branches, fetches, pulls, merges, rebases, pushes, stashes, resets, stages, commits, or mutates worktrees.
- Unit tests call the unqueued preflight helper directly; production integration calls it only from the one outer repository mutation-queue window.
- Preflight propagates the caller's signal.
- Focused Git unit tests and `npm test` pass.

### 4. Implement verified merge outcomes and automatic conflict abort

- [x] Implement and unit-test `integrateBranch` for no-op, fast-forward, merge-commit, and restored-conflict outcomes.

#### Why

The core mutation must provide deterministic status and strong postconditions while ensuring that an initial conflict never remains in progress.

#### How

- Resolve the worktree root, open one repository mutation-queue window, and run preflight, merge, cleanup when needed, and final verification without releasing or nesting that window.
- Return `already_integrated` without running `git merge` when the captured source is already an ancestor of the captured target, but still verify stable repository identity, refs, current target, absent operation state, and clean control state before returning.
- Otherwise run exactly the approved `git -c rerere.enabled=false merge ...` policy against `refs/heads/<sourceBranch>` with argv-style execution.
- Preserve hooks and normal Git commit behavior for divergent histories.
- On successful merge:
  - re-resolve repository identity and require the same canonical common Git directory;
  - require the current branch to remain `targetBranch`;
  - require the source ref to remain at its captured commit;
  - resolve the resulting target HEAD;
  - require both the captured source and captured target commits to be ancestors of the resulting target;
  - require no merge/rebase/sequencer state and a clean control worktree;
  - classify `fast_forward` only when the resulting target equals the captured source;
  - otherwise parse the resulting commit's parents and require an exact normal two-parent merge whose first parent is the captured target and whose second parent is the captured source before classifying `merge_commit`.
- On every nonzero, killed, timed-out, thrown, or caller-aborted merge execution:
  - inspect merge state without the caller's signal;
  - when unmerged entries exist, collect `git diff --name-only --diff-filter=U -z --` paths before cleanup;
  - validate returned conflict-path entries as bounded, lossless repository-relative identities, sanitize display copies separately, and report omitted entries;
  - if `MERGE_HEAD` exists, run `git merge --abort` without the caller's signal and with a bounded cleanup timeout, even when there are no unmerged paths;
  - verify repository identity, current target branch, exact source HEAD preservation, exact target HEAD restoration, absent merge/rebase/sequencer state, and clean control worktree;
  - return `conflict` only when unmerged paths proved a conflict and every restoration check passes;
  - after a restored non-conflict failure such as commit identity, hook, or signing failure, throw the original bounded failure rather than returning `conflict`.
- Run every post-merge success/failure check without the caller's signal and with bounded timeouts once merge execution has begun.
- If a failed merge has no operation state but the target moved, cleanup fails, repository identity changes, refs move unexpectedly, commit parents are unexpected, or postconditions are inconclusive, throw a bounded redacted error that includes safe before/after identities and says integration may have completed. Do not reset or delete anything.

#### Where

- `src/git-integration.ts`
- `src/git.ts` only for shared narrow primitives
- `src/types.ts`
- `test/git.test.mjs`

#### Acceptance criteria

- Already-integrated history performs no mutation and returns unchanged before/after HEADs.
- Fast-forward and divergent histories return the correct status and verified before/after HEADs.
- Successful results prove captured source ancestry and prior-target ancestry in the resulting target.
- Conflict paths are captured before abort and returned only after exact restoration is verified.
- Conflict cleanup and all post-mutation verification run without a cancelled caller signal.
- Source and target refs are preserved exactly after a conflict.
- A failed non-conflict merge with `MERGE_HEAD` is aborted and restored but remains an error.
- A killed/timed-out merge and an abort failure are covered explicitly.
- A nonzero merge that already moved the target is reported as uncertain and is never reset or misreported as conflict.
- Merge-commit classification verifies exact parent identities rather than ancestry alone.
- No failure path invokes reset, checkout/switch, stash, push, branch deletion, worktree removal, or merge continuation.
- Ambiguous failures never return a false successful or restored status.
- Git output and conflict displays are bounded and redacted; structured returned path entries are bounded and exact or the operation aborts and fails closed.
- Focused Git unit tests and `npm test` pass.

### 5. Register the strict `integrate_branch` tool

- [x] Expose the verified integration helper through one strict, prompt-ready Pi tool.

#### Why

The helper must be callable by Mission and integration agents with enough guidance to avoid parallel mutation races and unsupported conflict-resolution behavior.

#### How

- Add `INTEGRATE_BRANCH_TOOL_NAME` to `BRANCHME_TOOL_NAMES` in the same change that registers `integrate_branch`, keeping the active-name list and runtime registration atomic.
- Register `integrate_branch` with exactly two required string properties: `sourceBranch` and `targetBranch`.
- Reject additional properties and unsupported controls such as path, repo, remote, refspec, force, switch, strategy, message, squash, commit, continue, abort, delete, push, fetch, and worktree fields.
- Add a concise description, `promptSnippet`, and guidelines that explicitly name `integrate_branch`.
- State in prompt guidance that:
  - user intent must be explicit;
  - the current clean control worktree must already be on the target;
  - local refs must already contain the commits to integrate;
  - the tool does not fetch or push;
  - it must not be batched with other Git mutations;
  - any follow-up `branch_status` ancestry proof must wait until `integrate_branch` completes and must not share the same parallel tool batch;
  - conflict status means the merge was automatically aborted;
  - semantic conflict analysis belongs to a separate delegated workflow.
- Add concise bounded formatters for all four statuses while returning the complete structured details.
- Do not register `continue_merge` or another merge-management tool.

#### Where

- `src/tools/branchme-tools.ts`
- `src/git-integration.ts`
- `src/constants.ts`
- `test/tools.test.mjs`
- `test/schema-validation.test.mjs`

#### Acceptance criteria

- The schema requires exactly `sourceBranch` and `targetBranch` and rejects every unsupported field.
- Description, snippet, and every guideline explicitly name `integrate_branch`.
- Tool content distinguishes already-integrated, fast-forward, merge-commit, and automatically aborted conflict outcomes.
- Conflict is returned as a normal structured result only when abort/restoration verification succeeded.
- Operational, cleanup, and postcondition failures throw so Pi marks them as errors.
- The tool forwards the caller's signal to preflight and merge execution; after merge starts, cleanup and post-mutation verification ignore caller cancellation and remain bounded by their own timeouts.
- No `continue_merge`, `abort_merge`, or ancestry-only tool is registered.
- Focused tool and schema tests pass.
- `npm test` passes.

### 6. Add isolated real-Git integration coverage

- [x] Verify the complete integration lifecycle in temporary local repositories and linked worktrees.

#### Why

Mocked argv tests cannot prove Git's actual merge, conflict, abort, ancestry, index, working-tree, and linked-worktree behavior.

#### How

- Add temporary-repository tests with local user name/email configuration, signing disabled, no remotes, no system/global Git configuration, and no inherited hooks path or merge/rerere policy.
- Cover:
  - source already included in target;
  - clean fast-forward integration;
  - clean divergent integration that creates a merge commit;
  - a content conflict that returns paths and automatically aborts;
  - target mismatch;
  - dirty control worktree rejection;
  - branch-specific target `mergeOptions` rejection before mutation;
  - unrelated histories failing without `--allow-unrelated-histories` and without leaving merge state;
  - an ignored control-worktree file that would be overwritten by the source, proving `--no-overwrite-ignore` preserves it and does not produce a false conflict status;
  - source branch checked out in a separate dirty linked worktree while the clean target control worktree integrates its committed source HEAD.
- After successful integration, independently verify branch, HEAD, clean status, merge-state absence, and source ancestry.
- After conflict, independently verify exact source/target HEAD preservation, clean status, absence of `MERGE_HEAD` and `AUTO_MERGE`, retained branches/worktrees, and no created merge commit. `ORIG_HEAD` may remain because it is recovery metadata rather than an in-progress merge.
- Keep every test isolated under temporary directories and never contact a remote.
- Assert the recorded merge argv includes the approved rerere, autostash, rerere-autoupdate, and ignored-file protections and excludes `--no-verify`.
- Where portable, install a temporary repository-local merge hook that writes only inside the temporary fixture to prove hooks are preserved; otherwise retain an explicit argv assertion that `--no-verify` is absent.

#### Where

- `test/git-integration.test.mjs`

#### Acceptance criteria

- Real Git confirms all four statuses and the documented postconditions.
- The divergent case creates one normal Git merge commit with captured source and previous target ancestry.
- The conflict case returns the conflicting path before cleanup and leaves neither `MERGE_HEAD` nor `AUTO_MERGE` afterward.
- The source linked worktree, including its dirty uncommitted files, remains untouched.
- Branch-specific target merge options fail before mutation; ignored-file and unrelated-history failures preserve exact refs and leave no merge operation in progress.
- No test executes fetch, pull, push, remote mutation, branch deletion, force, reset, or worktree removal as part of integration behavior.
- `node --test test/git-integration.test.mjs` and `npm test` pass.

### 7. Update BranchMe help, registration, smoke, and capture expectations

- [x] Update user-facing extension surfaces and validation fixtures for the twelfth BranchMe tool.

#### Why

Tool registration counts, command help, TUI captures, and isolated Pi smoke checks currently assume eleven tools and no branch-integration capability.

#### How

- Add `integrate_branch` to `/branchme help` and the informational panel without adding action buttons.
- Keep the help concise: clean control target, exact local source/target, no push, and automatic abort on conflict.
- Adjust panel section rows/body-height or layout deliberately so adding the twelfth tool cannot silently truncate `integrate_branch` or an existing workflow row at supported widths.
- Update extension-registration expectations and exact tool-name sets.
- Update checkout/runtime smoke scripts to verify the strict two-field `integrate_branch` schema and named prompt metadata without running a merge.
- Update runtime schema inspection for `branch_status` to verify its optional top-level `ancestry` object, both required nested branch fields, and nested/top-level `additionalProperties: false`.
- Update deterministic TUI/help captures intentionally.
- Ensure smoke validation proves `continue_merge` is absent.

#### Where

- `src/commands/branchme-command.ts`
- `src/ui/branchme-panel.ts`
- `test/command.test.mjs`
- `test/tools.test.mjs`
- `test/tui-capture.test.mjs`
- `scripts/smoke-pi-runtime.mjs`
- `scripts/smoke-pi-git-context.mjs`
- `docs/TUI_CAPTURE.md`
- `docs/SMOKE_TEST.md`

#### Acceptance criteria

- Exactly twelve BranchMe tools are expected and registered once.
- Help and panel text describe `integrate_branch` accurately and remain informational only.
- TUI output stays width-bounded, every intended workflow row remains reachable/visible, and capture tests pass.
- Smoke checks validate schema and prompt metadata without mutating Git history.
- No surface advertises `continue_merge` or automatic semantic conflict resolution.
- Focused command, tool, capture, and smoke tests pass.

### 8. Update public architecture, security, workflow, and release documentation

- [x] Document the implemented merge boundary and remove obsolete claims that BranchMe never creates merge commits.

#### Why

The current public documentation repeatedly defines merge commits as a non-goal. Shipping `integrate_branch` without revising those statements would make the security and workflow contract contradictory.

#### How

- Document the exact tool schema, clean control-worktree requirement, local-only refs, target-current requirement, merge policy, statuses, ancestry proof, conflict paths, and verified automatic abort.
- Clarify that BranchMe still never creates user-authored commits or accepts commit messages, but `integrate_branch` may let Git create its standard merge commit for divergent histories.
- Document that configured Git hooks, custom merge drivers, clean/smudge filters, and signing policy remain active and may execute arbitrary commands or network operations outside BranchMe's direct argv guarantees.
- Document `--no-autostash`, disabled rerere, ignored-file overwrite protection, no fetch/push, and no reset-based rollback.
- Document that the mutation queue is process-local and external Git/Pi processes are not locked; unexpected ref movement produces an uncertain error and manual inspection guidance.
- Explain the Mission/integration-agent/developer conflict workflow without claiming BranchMe starts agents or resolves conflicts.
- Document the optional targeted `branch_status.ancestry` query and state that automatic Git context remains unchanged.
- Update tool counts, package description where appropriate, the new `src/git-integration.ts` module responsibility, troubleshooting, diagnostics, and changelog entries.
- Mark older architecture/guideline statements as historical or superseded where they still forbid all merge behavior.

#### Where

- `README.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json` if package-root metadata changes affect it
- `docs/STRUCTURE.md`
- `docs/PROJECT_DEFINITION_BRIEF.md`
- `docs/SMOKE_TEST.md`
- `specs/spec-architecture.md`
- `specs/spec-guidelines.md`

#### Acceptance criteria

- Public docs consistently describe twelve tools and the exact `integrate_branch` boundary.
- No active documentation claims BranchMe can never create a merge commit.
- Documentation clearly distinguishes Git-generated merge commits from unsupported user-authored commit tooling.
- Conflict documentation promises structured conflict status only after verified abort/restoration.
- Documentation explicitly states that `continue_merge` is not available.
- Security documentation distinguishes BranchMe's direct no-fetch/no-push behavior from arbitrary effects that repository-configured Git hooks, drivers, or filters may perform.
- Documentation does not claim that BranchMe delegates agents, asks the developer questions, fetches, pushes, or semantically resolves conflicts itself.
- Documentation and preparation tests pass.
- `npm test` passes.

### 9. Run full validation and isolated Pi smoke tests

- [x] Validate the completed integration feature across source, package, and isolated Pi runtime boundaries.

#### Why

The merge feature changes Git history, tool registration, schemas, prompt guidance, documentation, and package/runtime smoke assumptions. The complete gate must pass before the checklist is considered finished.

#### How

- Run focused tests while fixing failures, then run the canonical validation commands.
- Verify package contents remain minimal and no temporary repositories, conflict files, merge state, or generated artifacts are included.
- Load BranchMe in isolation and confirm all twelve tools are active with strict schemas.
- Confirm `branch_status({})`, targeted ancestry status, no-op integration, successful integration, and restored conflict behavior through automated coverage rather than an unsafe manual merge in the development checkout.
- Inspect the final diff for accidental `continue_merge`, reset, force, deletion, push, or cross-repository behavior.

#### Where

- Entire repository

#### Acceptance criteria

- `npm run typecheck` passes.
- `npm run format:check` passes.
- `npm test` passes.
- `npm run smoke:pi` passes.
- `npm run check` passes.
- `npm run check:pack` passes.
- `npm run smoke:worktree-handoff` passes.
- `npm run validate` passes.
- `npm run smoke:pi:packed` passes when running the release gate.
- The packaged extension registers exactly twelve BranchMe tools and no merge-continuation tool.
- The repository is left without an in-progress merge, temporary conflict state, or unintended generated files.
