# Plan: Branch Retirement Tasks

## Task description

Add a bounded `retire_branch` tool that deletes one exact local branch only when its current commit matches an explicit expected `HEAD`, it is not occupied by any registered worktree, and its relationship to one exact local target branch has been verified. Unmerged retirement requires explicit force authorization. The tool never directly deletes a remote or remote-tracking branch.

## Objective

Provide a safe final lifecycle step after branch integration and linked-worktree removal without adding bulk deletion, remote deletion, inferred targets, or an unsafe branch-name-only mutation.

## Proposed implementation boundaries

- Add one tool: `retire_branch`.
- `retire_branch` accepts exactly four required fields:
  - `branchName`: exact existing local branch to retire;
  - `expectedHead`: full 40- or 64-character hexadecimal commit identity for that branch;
  - `targetBranch`: exact existing local branch used for ancestry verification;
  - `force`: boolean authorization, where `true` is required only when the retiring commit is not an ancestor of the captured target commit.
- `branchName` and `targetBranch` must be distinct, valid, direct local `refs/heads/*` branches in the current repository.
- Remote-only refs, full ref names, arbitrary commits as branch inputs, repositories, paths, remotes, refspecs, arrays, patterns, and bulk operations are not accepted.
- Capture the retiring and target branch commit IDs before mutation. Require the retiring commit to match `expectedHead` before any deletion.
- Inspect the complete bounded `git worktree list --porcelain -z` inventory, not only the public display subset. Reject the retiring branch when any main, linked, current, locked, prunable, missing, or otherwise registered worktree record names it.
- Worktree cleanliness is not required because the retiring branch must be unoccupied and the tool does not switch branches or edit working-tree files.
- Verify ancestry against captured commit IDs with `git merge-base --is-ancestor <retiringHead> <targetHead>`.
- Reject unmerged retirement unless `force` is exactly `true`. Expected-HEAD and worktree-occupancy checks remain mandatory even when forced.
- Delete only the exact local ref with an expected-old-value lease:
  - `git update-ref --no-deref -d refs/heads/<branchName> <capturedRetiringHead>`
- Do not use `git branch -d` or `git branch -D`; those commands do not provide the required expected-HEAD lease and their default merge target is not this tool's explicit `targetBranch` contract.
- Use one process-local repository mutation-queue window around preflight, immediate reinspection, deletion, and postcondition verification. Resolve and use the canonical active worktree root as the queue key, matching the existing `integrate_branch` pattern and coordinating retirement with mutations invoked from the same active checkout.
- The queue does not coordinate a different active worktree, another Pi session, or an external Git process. The expected-old-value ref update protects the retiring ref; before/after target and worktree verification detects other observable concurrent movement.
- Preflight and deletion may use the caller's abort signal. Once deletion is attempted, inspect and classify the final state without the caller's signal and with bounded timeouts.
- Verify repository identity, target stability, retiring-ref absence, and zero retiring-branch worktree occupancy after mutation. Inconclusive or contradictory postconditions produce a bounded uncertain error with manual inspection guidance.
- Never recreate, reset, switch, merge, or force-update a branch as rollback.
- Direct Git commands never fetch, pull, push, prune, or delete `refs/remotes/*` or remote refs. Local remote-tracking refs remain untouched.
- Initial scope deletes only the exact local branch ref. It intentionally leaves `branch.<branchName>.*` local configuration untouched because removing it would require a second non-atomic mutation. Document this behavior clearly.
- Repository-configured `reference-transaction` hooks may run during `git update-ref` and remain part of the repository trust boundary. Documentation must distinguish BranchMe's direct no-network/no-remote-delete argv contract from arbitrary hook behavior.
- Return JSON-serializable, bounded details with a retirement mode of `merged` or `forced_unmerged`, captured commit identities, ancestry proof, worktree checks, repository identity, and explicit local-only mutation facts.
- Execute tasks in order, one task per implementation session. Mark only the completed task with `x` after all acceptance criteria and validation pass.

### 1. Stabilize release metadata and define retirement contracts

- [x] Reconcile the pre-existing package/changelog version mismatch, then add the public branch-retirement contracts and bounded constants without registering a tool or introducing a ref deletion.

#### Why

The preflight, mutation state machine, formatter, schema, tests, and documentation need one stable serializable contract before runtime behavior is implemented.

#### How

- Preserve the existing `package.json` and `package-lock.json` version changes. Align only the active `CHANGELOG.md` heading with the current package version before running the baseline preparation test; do not introduce another version bump in this task.
- Add `RETIRE_BRANCH_TOOL_NAME = "retire_branch"`, but do not add it to `BRANCHME_TOOL_NAMES` until the registration task.
- Add dedicated retirement mutation and rendered-summary limits using the existing Git timeout and bounded-output conventions.
- Define `RetireBranchToolInput` with exactly `branchName`, `expectedHead`, `targetBranch`, and `force`.
- Define a successful status with:
  - `action: "retire_branch"`;
  - `status: "retired"`;
  - `mode: "merged" | "forced_unmerged"`;
  - exact normalized request values;
  - repository identity before/after;
  - retiring and target commit identities;
  - expected-HEAD match proof;
  - pre/post worktree occupancy proof;
  - captured ancestry result;
  - local branch absence after deletion;
  - direct remote deletion attempted as `false`.
- Keep details free of signals, command handles, filesystem objects, and raw unbounded Git output.
- Add preparation tests that keep the active tool-name list unchanged until registration.

#### Where

- `CHANGELOG.md`
- `src/constants.ts`
- `src/types.ts`
- `test/preparation.test.mjs`

#### Acceptance criteria

- The active changelog heading matches the existing package version without another package-version mutation.
- `RETIRE_BRANCH_TOOL_NAME` is defined exactly once and is not yet included in `BRANCHME_TOOL_NAMES`.
- The input requires one exact branch, one expected full commit identity, one exact target branch, and one boolean force decision.
- Details distinguish merged retirement from explicitly forced unmerged retirement without parsing prose.
- Details represent before/after repository, ref, ancestry, occupancy, and local-only mutation facts.
- No tool registration or `git update-ref` mutation exists in this task.
- `npm run typecheck` and `npm test` pass.

### 2. Add complete worktree-occupancy and direct-ref preflight helpers

- [x] Implement reusable bounded helpers and a read-only retirement preflight without deleting a branch.

#### Why

Branch retirement must fail before mutation when branch identity, expected `HEAD`, target ancestry, direct-ref status, repository identity, or worktree occupancy is ambiguous.

#### How

- Export a narrow helper from `src/git.ts` that checks one validated local branch against every parsed worktree inventory record.
- Reuse the existing NUL-delimited parser and raw-output limit; do not use the public `listWorktrees()` 100-entry display subset for safety decisions.
- Return only bounded occupancy facts needed by the retirement state machine. Do not disclose or retain unbounded path inventories.
- Add a strict local-ref inspection helper that distinguishes an absent exact ref from an inspection failure, returns a validated full object identity when present, and rejects symbolic local branch refs so `--no-deref` always operates on a verified direct `refs/heads/*` ref.
- Do not use the existing boolean `localBranchExists()` as the destructive postcondition proof because it intentionally collapses every nonzero Git exit into `false`.
- In `src/git-retirement.ts`, implement an unqueued `prepareBranchRetirement()` that:
  - validates all runtime inputs independently of TypeBox;
  - validates `expectedHead` as exactly 40 or 64 hexadecimal characters;
  - rejects identical retiring and target branches;
  - resolves the canonical active worktree root and canonical common Git directory;
  - validates both branch names with Git and requires both direct local refs to exist;
  - requires each direct ref object identity to equal its commit identity, then requires the retiring identity to equal `expectedHead` case-insensitively;
  - rejects any retiring-branch worktree occupancy;
  - captures ancestry from the two immutable commit IDs;
  - rejects unmerged history unless `force === true`;
  - requires lossless bounded branch identities before they can appear in structured details.
- Do not require a clean active worktree or require `targetBranch` to be checked out.
- Keep the preflight helper unqueued so the eventual production operation can call it inside one outer queue without deadlock.

#### Where

- `src/git.ts`
- `src/git-retirement.ts`
- `src/types.ts`
- `test/git.test.mjs` or a focused `test/git-retirement.test.mjs`
- `scripts/check-package-contents.mjs`

#### Acceptance criteria

- Occupancy checks examine every bounded parsed worktree record, including records beyond the public display limit.
- Current, linked, locked, prunable, missing, and main worktree occupancy all block retirement when their branch matches.
- Invalid, identical, symbolic, missing, mismatched-HEAD, occupied, and unmerged-without-force requests fail before mutation.
- Missing refs are distinguished from malformed output, killed commands, repository errors, and other unexpected inspection failures; unexpected failures never become an `absent` result.
- `force: true` bypasses only the negative ancestry result; it never bypasses identity, expected-HEAD, ref-existence, or occupancy checks.
- A dirty unrelated active worktree does not block preflight.
- Preflight issues no `update-ref`, branch deletion, fetch, pull, push, switch, reset, merge, rebase, or worktree mutation command.
- The caller's abort signal is propagated through read-only preflight commands.
- The new source module is required in the packed public-file check.
- Focused tests and `npm test` pass.

### 3. Implement leased local-ref retirement and verified postconditions

- [x] Implement the bounded retirement mutation, failure classification, and postcondition verifier.

#### Why

A branch-name-only deletion can remove a ref that moved after preflight. The mutation must use the expected commit as an atomic old-value lease and must not report success when final state is uncertain.

#### How

- Resolve the canonical active worktree root before queueing and use it as the retirement queue key, consistent with `integrate_branch`.
- Open one queue window, call the unqueued preflight inside it, and require its resolved canonical active worktree root to match the queued root before continuing.
- Immediately before mutation, re-resolve:
  - repository identity;
  - retiring branch `HEAD`;
  - target branch `HEAD`;
  - retiring-branch worktree occupancy;
  - ancestry when either captured ref changed.
- Reject any changed precondition rather than silently refreshing `expectedHead` or changing the requested target.
- Execute exactly:
  - `git update-ref --no-deref -d refs/heads/<branchName> <capturedRetiringHead>`
- Pass the verified full local ref and captured commit to Git; never pass an inferred branch, remote ref, remote, path, pattern, or refspec.
- Once the mutation command is attempted, perform bounded verification without the caller's abort signal.
- Verify:
  - the canonical active worktree/common Git identity is preserved;
  - `targetBranch` still points to the captured target commit;
  - the retiring local ref is absent;
  - no registered worktree record names the retired branch.
- Classify command failures by observed final state:
  - branch still at expected commit: deletion failed safely; throw a bounded failure;
  - branch moved to another commit: expected lease protected it; throw a concurrency error;
  - branch absent with every postcondition satisfied: return verified success even if command completion reporting was interrupted;
  - missing/changed target, occupied missing branch, changed repository identity, or inconclusive inspection: throw a bounded uncertain error stating retirement may have completed.
- Never recreate the deleted branch or modify the target as rollback.
- Return `mode: "merged"` when ancestry was true and `mode: "forced_unmerged"` only when ancestry was false and `force` was true.
- Do not remove branch configuration, reflogs through separate commands, remote-tracking refs, or remote refs.
- Bound and redact diagnostics using existing Git failure helpers and retirement-specific summary limits.

#### Where

- `src/git-retirement.ts`
- `src/git.ts` only for narrow reusable primitives
- `src/constants.ts`
- `src/types.ts`
- `test/git-retirement.test.mjs` or `test/git.test.mjs`

#### Acceptance criteria

- Successful retirement uses `update-ref --no-deref -d` with the exact local ref and captured expected commit.
- No implementation path uses `git branch -d`, `git branch -D`, fetch, pull, push, remote deletion, reset, switch, checkout, stash, merge, rebase, or worktree mutation.
- The expected-old-value lease prevents deletion when the branch moves.
- Target movement and post-delete worktree occupancy are never reported as verified success.
- Missing-ref success is established only by the strict local-ref inspector; unexpected Git failures are never treated as successful absence.
- Post-mutation inspection runs without a cancelled caller signal and remains timeout-bounded.
- Merged and forced-unmerged modes are classified correctly.
- Ambiguous final state produces manual-inspection guidance and no rollback mutation.
- Git diagnostics and returned details remain bounded and credential-redacted.
- Focused mutation tests and `npm test` pass.

### 4. Register the strict `retire_branch` tool

- [x] Expose the verified retirement helper through one strict, prompt-ready Pi tool.

#### Why

The helper must be callable only with explicit identities and enough sequencing guidance to avoid stale expected commits, parallel Git mutations, and accidental forced data loss.

#### How

- Add `RETIRE_BRANCH_TOOL_NAME` to `BRANCHME_TOOL_NAMES` in the same change that registers the tool.
- Add a strict TypeBox schema with exactly four required properties in this order:
  - `branchName` string;
  - `expectedHead` string constrained to exactly 40 or 64 hexadecimal characters;
  - `targetBranch` string;
  - `force` boolean.
- Reject additional properties and unsupported controls such as path, repo, remote, refspec, pattern, branches, all, prune, deleteRemote, push, fetch, worktreePath, and inferred target fields.
- Add a bounded formatter for merged and forced-unmerged success. Forced-unmerged content must state that the retired commit may lose its remaining local branch reference and can eventually become unreachable.
- Return complete structured details from the helper while keeping text concise.
- Add a description, `promptSnippet`, and guidelines that explicitly name `retire_branch`.
- State in guidance that:
  - `retire_branch` requires explicit user intent to delete one local branch;
  - callers should obtain a fresh expected commit and ancestry proof with `branch_status` unless the exact commit was already supplied;
  - `branch_status` and `retire_branch` must run sequentially, never in the same parallel tool batch;
  - `retire_branch` must run by itself rather than beside another Git mutation;
  - `force: true` requires explicit user authorization for unmerged data loss;
  - removing a linked worktree and retiring its retained branch are separate sequential operations;
  - `retire_branch` never directly deletes a remote or remote-tracking branch.

#### Where

- `src/tools/branchme-tools.ts`
- `src/git-retirement.ts`
- `src/constants.ts`
- `test/tools.test.mjs`
- `test/schema-validation.test.mjs`

#### Acceptance criteria

- Exactly thirteen BranchMe tools are registered once after this task.
- The schema requires exactly `branchName`, `expectedHead`, `targetBranch`, and `force` and rejects every unsupported field.
- Description, snippet, and every guideline explicitly name `retire_branch`.
- Tool content distinguishes ordinary merged retirement from explicitly forced unmerged retirement and makes the forced-unmerged reachability risk explicit.
- Operational and postcondition failures throw so Pi marks them as errors.
- The caller's signal reaches preflight and mutation; post-mutation verification follows the helper's cancellation-safe contract.
- Tool, schema, typecheck, and full unit tests pass.

### 5. Add isolated real-Git retirement coverage

- [x] Verify the complete retirement lifecycle in temporary local repositories and linked worktrees.

#### Why

Mocked argv tests cannot prove Git's actual expected-old-value behavior, worktree occupancy semantics, ancestry results, local ref deletion, or preservation of remote-tracking refs and branch configuration.

#### How

- Reuse the isolated real-Git fixture conventions:
  - temporary directories only;
  - local test user identity;
  - signing disabled;
  - system/global Git configuration disabled;
  - no network contact.
- Cover:
  - merged local branch retirement with the expected `HEAD`;
  - stale expected `HEAD` rejection with the branch retained;
  - unmerged branch rejection when `force` is false;
  - successful unmerged retirement only when `force` is true;
  - retiring the current branch rejection;
  - retiring a branch checked out in a linked worktree rejection;
  - locked/prunable occupancy behavior where portable, with mocked coverage for non-portable states;
  - a dirty unrelated active worktree being allowed;
  - a target branch that is not the current branch being accepted;
  - target ref preservation;
  - local `refs/remotes/origin/<branch>` preservation without contacting a remote;
  - `branch.<branchName>.*` configuration preservation as the documented initial contract;
  - no branch/worktree/remote mutation beyond deletion of the one exact local ref.
- Assert the recorded deletion argv contains `update-ref --no-deref -d` and excludes `branch -d`, `branch -D`, `push`, `fetch`, and remote ref targets.

#### Where

- `test/git-integration.test.mjs` or a focused `test/git-retirement-integration.test.mjs`

#### Acceptance criteria

- Real Git proves successful merged and explicitly forced-unmerged retirement.
- Stale expected commits, unapproved unmerged history, current occupancy, and linked-worktree occupancy preserve the branch.
- Successful retirement removes only `refs/heads/<branchName>`.
- The target local branch, remote-tracking ref, linked worktrees, working-tree files, and branch configuration remain unchanged.
- No test contacts or mutates a real remote.
- Focused real-Git tests and `npm test` pass.

### 6. Update help, panel, registration, smoke, and capture expectations

- [x] Update user-facing and runtime-validation surfaces for the thirteenth BranchMe tool.

#### Why

Current help, panel content, exact tool-name sets, runtime verifiers, Git-context smoke, and deterministic captures assume twelve tools and state that BranchMe does not delete branches.

#### How

- Add a concise branch-retirement section to `/branchme help` covering exact expected `HEAD`, target ancestry, occupancy rejection, explicit force, and local-only deletion.
- Add `retire_branch` to the informational panel without adding an action button.
- Place the row deliberately in the integration/retirement lifecycle section and ensure every row remains reachable at supported widths.
- Update exact registration arrays and counts from twelve to thirteen.
- Update runtime smoke schema expectations for all four required fields and `additionalProperties: false`.
- Add `retire_branch` to the Git-context smoke's forbidden mutation tools so smoke validation never deletes a branch.
- Regenerate deterministic help/TUI captures intentionally.
- Preserve assertions that no bulk, remote-delete, or merge-continuation tool is registered.

#### Where

- `src/commands/branchme-command.ts`
- `src/ui/branchme-panel.ts`
- `test/command.test.mjs`
- `test/tools.test.mjs`
- `test/tui-capture.test.mjs`
- `scripts/smoke-pi-runtime.mjs`
- `scripts/smoke-pi-git-context.mjs`
- `scripts/smoke-worktree-handoff.mjs`
- `docs/TUI_CAPTURE.md`
- `docs/SMOKE_TEST.md`

#### Acceptance criteria

- Exactly thirteen BranchMe tools are expected and visible once through Pi runtime APIs.
- Runtime smoke validates the strict four-field retirement schema without executing it.
- Git-context and worktree-handoff smoke tests never invoke `retire_branch`.
- Help and panel text accurately distinguish linked-worktree removal from later local branch retirement.
- TUI output remains width-bounded and capture tests pass.
- Focused command, panel, tool, and smoke tests pass.

### 7. Update public architecture, security, workflow, and release documentation

- [x] Document the branch-retirement boundary and remove obsolete blanket claims that BranchMe never deletes branches.

#### Why

The current public documentation repeatedly says BranchMe does not delete branches. Shipping `retire_branch` without revising those statements would contradict the actual mutation and security boundary.

#### How

- Document the exact schema and required workflow:
  - obtain or supply the exact expected branch `HEAD`;
  - verify target ancestry;
  - remove any occupying linked worktree separately;
  - use `force: true` only with explicit authorization for unmerged history;
  - retire only the local branch ref.
- Document the exact `git update-ref --no-deref -d` expected-old-value lease and why `git branch -d/-D` is not used.
- Clarify that BranchMe still never performs bulk deletion, inferred-target deletion, remote deletion, remote-tracking deletion, reset rollback, or automatic worktree removal during retirement.
- Document that local `branch.<name>.*` configuration remains untouched in the initial contract and may affect a later branch recreated with the same name.
- Document that forced unmerged retirement can remove the commit's last local branch reference; object recovery is not guaranteed and normal Git expiry/garbage collection can eventually make it unreachable.
- Document the active-worktree-keyed, process-local queue limitation and the uncertain-error/manual-inspection behavior for other worktrees and external races.
- Add `reference-transaction` hooks to the Git extension-point trust boundary and distinguish hook behavior from BranchMe's direct argv guarantees.
- Update tool counts, package description where appropriate, source-layout documentation for `src/git-retirement.ts`, troubleshooting, diagnostics, smoke notes, and changelog entries beneath the version heading established in Task 1.
- Mark historical specs as superseded where they still prohibit all branch deletion.

#### Where

- `README.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `package.json` only if description metadata changes
- `package-lock.json` only when matching package metadata requires it
- `docs/STRUCTURE.md`
- `docs/PROJECT_DEFINITION_BRIEF.md`
- `docs/SMOKE_TEST.md`
- `specs/spec-architecture.md`
- `specs/spec-guidelines.md`
- `test/preparation.test.mjs`

#### Acceptance criteria

- Active public documentation consistently describes thirteen tools and the exact local branch-retirement boundary.
- No active document claims BranchMe never deletes local branches.
- Documentation clearly states that remote and remote-tracking branches are not deleted.
- Documentation clearly states that branch configuration remains and that worktree removal is a separate operation.
- Security documentation covers expected-HEAD leasing, worktree occupancy, ancestry, explicit force, process-local queue limits, uncertain outcomes, and hook risk.
- The changelog heading matches the current package version.
- Documentation and preparation tests pass.

### 8. Run full validation and isolated Pi smoke tests

- [x] Validate the completed retirement feature across source, package, temporary Git repositories, and isolated Pi runtime boundaries.

#### Why

Branch retirement changes local refs, tool registration, schemas, prompt guidance, help, security documentation, package contents, and exact runtime smoke expectations. The complete gate must pass before implementation is considered finished.

#### How

- Run focused tests while resolving failures, followed by the canonical validation commands.
- Inspect the final diff for accidental bulk deletion, remote deletion, branch-name-only deletion, force bypasses, rollback ref creation, hidden worktree mutation, or unrelated package-version changes.
- Verify package contents include `src/git-retirement.ts` but exclude task specs and temporary Git fixtures.
- Confirm the development repository has no deleted branch, changed worktree registration, in-progress Git operation, generated artifact, or temporary test state.
- Update this checklist by marking Task 8 complete only after every acceptance criterion passes.

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
- The packaged extension registers exactly thirteen BranchMe tools with a strict `retire_branch` schema.
- No direct retirement path can delete a remote or remote-tracking branch.
- The repository is left without temporary fixtures, in-progress Git state, or unintended generated files.
