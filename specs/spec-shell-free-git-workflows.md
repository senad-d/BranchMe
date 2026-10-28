# Plan: Important Git Workflows Without Shell Access

## Status and objective

Completed. All tasks below are implemented and validated. Ordinary commits and CommitMe remain independent; the items in “Deferred beyond this plan” are still out of scope.

Enable agents to inspect and perform common Git actions without Bash while keeping BranchMe and CommitMe independent. Ordinary commit creation remains outside BranchMe. File editing and test execution still require separate tools; this is not a plan for a general-purpose development shell.

## Scope boundaries

- Do not add commit creation, commit-message generation/input, amend, or any dependency on CommitMe. Do not invoke CommitMe, discover its installation, or automatically hand work to it.
- Preserve the existing verified merge/conclusion and rebase exceptions; do not expand them into a general commit API.
- Keep the existing `git_diff`, remote discovery, tracking, integration, retirement, and landing capabilities. Do not duplicate them.
- Guarded index changes and selected-file restoration are deliberate, explicit boundary expansions. Public/security documentation now describes the implemented authorization and preservation guarantees.
- No arbitrary Git arguments, shell strings, arbitrary refspecs, hard reset, clean, automatic stash, force-push, or remote branch deletion.
- Use strict schemas, validated literal paths, captured commit identities, existing mutation queues, bounded output, redaction, and control-character escaping. Avoid nesting functions.
- Queues coordinate BranchMe calls, not independent Git processes or extensions. Recheck expected state immediately before mutation, use Git's available locking/leasing guarantees, and report uncertain outcomes instead of claiming isolation from external writers.
- Read Pi extension documentation and relevant examples before implementing tool registration or changing runtime behavior.

## Delivery order

| Priority | Tasks | Outcome |
| --- | --- | --- |
| P0: inspect and coordinate | 1–4 | Complete change discovery, history/object inspection, conflict inspection, and cross-worktree actions |
| P1: normal workflow | 5–8 | Explicit branch bases, remote/upstream setup, index control, and complete PR checks |
| P2: guarded extensions | 9–12 | Explicit rebase targets, selected-file restore, no-commit revert preparation, and PR editing/merge |
| Every delivery | 13 | Current documentation, isolated regression coverage, and shell-free workflow smoke |

P0/P1 inspection and coordination were implemented before the guarded P2 operations. The user's follow-up authorized completing all remaining tasks; all listed tools are now available. Deferred work remains separate.

### 1. Add complete, paginated file status (P0)

- [x] Add `git_status` for per-path state without enlarging automatic context or changing the default `branch_status` summary.

#### Why

The current snapshot lists at most 20 changes and is display-oriented. An agent must be able to discover every changed path before selecting files, resolving conflicts, or trusting a cleanliness claim.

#### How

Read NUL-delimited porcelain status and return separate index/worktree states, untracked entries, conflict states, and rename source/destination paths. Support literal root-relative filters, optional same-repository `worktreePath`, and optional continuation. Use bounded default pages; agents must not need to guess an output length. Include current operation state from the existing operation detector.

Bind continuation to the repository/worktree, filters, and observed status snapshot. Detect relevant changes between pages and require a restart rather than silently skipping or duplicating records. Expose safe HEAD/index expectation identities for later index operations; explicit path inspection should also provide content/mode expectations for destructive restoration. Keep `branch_status` as branch/upstream/PR/ancestry context, and `git_diff` as content comparison.

#### Where

New `src/git-status.ts`; existing status/operation helpers in `src/git.ts`; shared types/constants; `src/tools/branchme-tools.ts`; new `test/git-status.test.mjs`.

#### Acceptance criteria

- More than 20 changed paths can be enumerated to completion, including staged-only changes, untracked files, renames, deletions, and conflicts.
- Results distinguish a clean whole checkout from an empty filtered page, an incomplete page, and a failed inspection.
- Pagination is bounded and stale continuation is rejected; unsafe paths are identified as non-reusable rather than silently transformed into executable identities.
- Unborn/detached HEAD and another verified worktree work. No network request, optional index refresh, or file/ref/config mutation occurs.
- Automatic context remains metadata-only and retains its existing limits.

#### Validation receipt

`npm run validate` passed: typecheck, formatting, all 427 tests, Pi registration/context smoke (including complete two-page `git_status` enumeration with no Bash tool available), package-content checks, and isolated worktree handoff. `npm run smoke:pi:packed` passed against an isolated production install. Twelve focused real-Git status tests cover pagination, state preservation, renames/deletions/conflicts, stale snapshots, worktrees, malformed output, redaction/non-reusable paths, expectations, and cancellation. Git setup/mutations were confined to disposable test repositories; no fetch, commit, push, or GitHub write was performed on the user's repository. This is the historical first-delivery receipt; the final completion receipt below supersedes its rollout status.

### 2. Add history and committed-object inspection (P0)

- [x] Add bounded `git_log` and `git_show` tools.

#### Why

Five recent commit subjects and a range diff are not enough to investigate regressions, understand a historical change, or inspect a file before choosing a recovery action.

#### How

`git_log` should accept a locally resolvable starting revision (default `HEAD`), optional excluded base revision, and literal paths. Return full commit/parent IDs, dates, subjects, and bounded metadata with continuation anchored to captured commits and filters.

`git_show` should inspect one captured commit's metadata/change summary/patch or one literal file at that commit. Keep options structured, not a free-form revision expression or argv escape hatch. For merge patches, make the parent comparison explicit; never quietly report an empty ordinary diff as no change. Reuse/extract proven diff safety helpers where appropriate rather than duplicating them speculatively.

#### Where

New `src/git-history.ts`; reusable read-only helpers from `src/git-diff.ts`; shared types/constants; tool registration; new `test/git-history.test.mjs`.

#### Acceptance criteria

- Agents can inspect older commits, compare branch history, and read a historical file without checking it out.
- History continuation does not drift when a branch moves. Roots, merges, missing objects, shallow history, and unborn HEAD have explicit behavior.
- Binary/oversized objects return safe metadata or bounded previews; truncation is explicit and narrowed requests are possible.
- Disable external diff, textconv, pager, fsmonitor, and lazy network fetching; do not return apply-ready patches or write artifacts.
- Credentials and controls are sanitized before both text and structured output are limited; repository state is unchanged.

### 3. Add conflict-version inspection (P0)

- [x] Add `git_conflicts` to list conflicts and inspect their available index stages.

#### Why

A file-editing agent can remove markers, but difficult add/delete/rename and binary conflicts require the actual base, ours, and theirs versions. Existing conflict summaries do not expose these objects.

#### How

Provide a paginated listing mode and an explicit literal-path inspection mode. Return stage presence, blob IDs, modes, and bounded text for requested stages 1/2/3. Label absent stages and explain that ours/theirs are index-stage terms whose meaning depends on the active operation. Include an index-state identity so subsequent inspection cannot silently read a different conflict.

#### Where

New `src/git-conflicts.ts`; operation helpers in `src/git.ts`; existing conflict formatting in `src/git-integration.ts`; types, tool registration, and new isolated tests.

#### Acceptance criteria

- Content, add/add, modify/delete, rename-related, and binary conflicts expose correct available stages, including legitimate absence of stage 1, 2, or 3.
- A changed index between listing and inspection is detected when a supplied snapshot identity is used.
- File contents remain bounded/untrusted display data. No automatic side selection, staging, editing, or conflict conclusion occurs.
- Kept merge inspection works before the existing `conclude_merge` workflow; unsupported operation states are reported, not treated as clean.

### 4. Make worktree targeting consistent (P0)

- [x] Add optional `worktreePath` to checkout-dependent tools that currently require another session's cwd.

#### Why

A coordinator with only BranchMe tools can currently inspect or integrate another worktree, but cannot complete its switch/update/push/PR workflow from the control session.

#### How

Reuse `resolveRepositoryWorktreeCwd` for `create_branch`, `change_branch`, `track_branch`, `fetch_branch`, `pull_branch`, `rebase_branch`, `push_branch`, `update_from_base`, and `pull_request`. Add it to branch-inferred PR status/feedback lookup; exact-number GitHub queries remain repository-scoped. Use the selected worktree consistently for branch/default inference, cleanliness, HEAD verification, and existing authentication policy.

New checkout-dependent tools in this plan must support the selector from their first release. Keep initialization tied to the exact current directory and preserve the separate create/remove/landing path contracts. Serialize shared ref/config mutations through the common Git directory where needed, with a consistent lock order.

#### Where

`src/git.ts`, `src/git-workflow.ts`, both tool registration modules, shared types, and existing worktree/workflow/transport tests.

#### Acceptance criteria

- From the primary checkout, an agent can switch/create a branch in a selected linked worktree, update it, push it to a local bare remote, and create a mocked PR without changing the primary checkout.
- Omitted selectors preserve current behavior. Foreign repositories, unregistered paths, unsafe aliases, and occupied target branches are rejected.
- Selected-worktree preconditions and postconditions are verified; no Pi cwd change or separate agent/session launch is required.
- Concurrent BranchMe actions on shared refs/config are serialized and revalidated; detected external interference reports a failed/uncertain outcome rather than verified success. Selection does not silently broaden token lookup to a different repository.

### 5. Support an explicit branch starting point (P1)

- [x] Extend `create_branch` with optional `baseRef`.

#### Why

Starting a branch from `origin/main` should not require switching or updating the control checkout, or creating an otherwise unnecessary worktree.

#### How

Reuse the validated local-branch, cached remote-tracking, or full-commit resolution policy already supported by new-branch `create_worktree`. Capture the starting commit before mutation. Omission still means current `HEAD`; specifying a base does not fetch or implicitly configure an upstream. Preserve checkout cleanliness and overwrite protections.

#### Where

`src/git.ts`, `src/tools/branchme-tools.ts`, shared types, `test/git.test.mjs`, `test/tools.test.mjs`, and worktree coverage in the existing test suite.

#### Acceptance criteria

- Explicit local, remote-tracking, and full-commit bases produce the requested new branch at the captured commit.
- The base ref itself is not checked out, moved, or reset. No tracking configuration is inferred.
- Invalid/missing refs, existing destination branches, unsafe inputs, dirt, and in-progress operations are handled before mutation.
- Fetch-then-create and cross-worktree creation work sequentially; `{ branchName }` remains backward compatible.

### 6. Add remote and upstream setup (P1)

- [x] Add `list_remotes`, add-only `add_remote`, and explicit `set_upstream`.

#### Why

An agent cannot currently discover configured remotes or finish the Git setup after `init_repository`. Existing branches with no or incorrect tracking also need a supported setup path.

#### How

List bounded configured fetch/push destinations, distinguish display-safe URLs from executable identities, and flag unsupported/multiple destination settings. `add_remote` should require an unused exact name and explicit credential-free HTTPS or SSH destination, create standard branch tracking configuration, and perform no fetch. Reject custom helper/transport syntax; do not expose arbitrary Git config writes.

`set_upstream` should target an exact local branch and one existing configured remote-tracking branch, or explicitly unset its upstream. Do not switch, fetch, push, or infer that a feature tracks the default branch. Use before-state checks and serialized repository-local configuration changes. Editing/removing remote URLs and multiple push destinations remain deferred.

#### Where

New `src/git-remotes.ts`; transport/ref helpers in `src/git.ts` and `src/git-discovery.ts`; shared types, registration, and new isolated remote-configuration tests.

#### Acceptance criteria

- A newly initialized repository can acquire `origin` without Bash. A separate fetch remains necessary before using a remote-tracking branch.
- Existing remote names are never overwritten. Embedded credentials, option-like names, helper syntax, unsafe namespaces, and unintended config scopes are refused.
- Upstream changes affect only the named branch's tracking settings; refs, HEAD, index, and files remain unchanged.
- No global/system config changes or hidden network requests occur. Effective transport/URL rewriting risks are checked or refused where they invalidate the supported destination policy.
- Receipts and errors never expose URL credentials; empty remote inventories and unsupported settings are explicit.

### 7. Add explicit stage and unstage operations (P1)

- [x] Add `stage_changes` and `unstage_changes` for exact approved file paths, without committing.

#### Why

Agents need to correct accidental staging, prepare selective changes, and leave a deliberate index state. This is useful independently of any commit extension.

#### How

Require a nonempty bounded list of literal root-relative files, with expected HEAD/index state captured from inspection. Do not expose implicit all-files, recursive directory, glob, interactive patch, or force-add modes. `stage_changes` stages selected additions/modifications/deletions; `unstage_changes` returns only selected index entries to `HEAD`, preserving working files. Handle unborn HEAD explicitly.

Initially reject unmerged entries and active operations; kept merges remain owned by `conclude_merge`. Document that Git clean filters can run during staging. A failed mutation must report actual/uncertain index state and must not claim rollback unless verified.

#### Where

New `src/git-index.ts`; path/state/queue helpers in `src/git.ts`; shared types/constants, registration, and new `test/git-index.test.mjs`.

#### Acceptance criteria

- Selected new/modified/deleted files are staged or unstaged correctly, while unrelated index entries and all working-file bytes are preserved.
- Partially staged files, unborn HEAD, renames, symlinks, ignored files, and sparse/submodule boundaries have explicit tested policies.
- Renames do not silently expand approval to an unlisted path; both sides must be selected when needed.
- Stale expectations, unsafe paths, directory expansion, conflicts, and unsupported index modes fail before mutation.
- No commit/message generation, CommitMe import/call/config, or dependency on another extension exists.

### 8. Expose complete PR checks (P1)

- [x] Add read-only `pull_request_checks` covering all check states, not only failures.

#### Why

No failing checks does not mean checks have passed. Agents need to distinguish pending, running, skipped, successful, absent, and unavailable results before declaring a PR ready.

#### How

Require an exact PR number, capture the head SHA, and inspect check runs plus legacy commit statuses for that SHA. Return bounded pages with context/source, state/conclusion, URL, and completeness. Report required-check/review/mergeability information only when the API and permissions expose it; otherwise label it unknown. Keep `pull_request_feedback` focused on actionable review and failure details.

#### Where

New `src/github-checks.ts`; existing bounded/authenticated request helpers in `src/github.ts` and `src/github-feedback.ts`; workflow tool registration and mocked API tests.

#### Acceptance criteria

- Successful, queued, running, failing, cancelled, neutral, skipped, and no-check cases are distinguishable.
- Check runs and legacy statuses are combined without letting superseded attempts produce misleading summaries.
- Pagination/permission failures and a moving PR head invalidate any blanket success claim; every report identifies the examined SHA.
- Missing required checks, incomplete policy visibility, and insufficient permissions are not presented as approval or merge authorization.
- No polling loop, rerun, comment, or PR mutation is performed automatically.

### 9. Support explicit rebase targets (P2)

- [x] Extend `rebase_branch` with optional locally resolvable `baseRef` while preserving its existing default and abort policy.

#### Why

A feature usually tracks its published feature branch, not `origin/main`. Changing upstream just to choose a rebase base is incorrect.

#### How

Capture the requested base commit and rebase onto it without changing tracking configuration. Require explicit authorization for history rewriting, a clean idle selected checkout, and separate fetching when freshness is required. Preserve automatic abort/restoration verification; do not add interactive rebase, `--onto`, autostash, or multi-ref update modes.

Make the publication limitation explicit: BranchMe still cannot force-push rewritten published history. Recommend `update_from_base` for published feature updates; do not describe explicit-base rebase as a complete published-branch workflow.

#### Where

`src/git.ts`, `src/tools/branchme-tools.ts`, shared types, existing rebase/workflow tests and guidance.

#### Acceptance criteria

- Rebasing onto an explicit base works without an upstream; omission preserves the existing configured-upstream behavior.
- Upstream settings, unrelated branches, and the base ref are unchanged. The resulting branch contains the captured base.
- Conflicts/cancellation/failures attempt abort and verify restoration; abort failures clearly block further mutation.
- No fetch or force-push is hidden inside the operation, and guidance warns before a published-history rewrite.

### 10. Add selected-file restoration (P2)

- [x] Add `restore_paths` for explicitly authorized discarding of selected tracked working-file edits.

#### Why

An agent without Bash cannot abandon an approved edit safely except by manually reconstructing file contents. Removal of an entire worktree is not an acceptable substitute.

#### How

Require exact file paths, an explicit discard authorization, and an expected per-path snapshot from inspection. Default source is the selected files' current index state; an explicit captured commit may be used as a source. Restore only working-file content, preserving logical index entries/staging, and identify replaced/deleted paths and content fingerprints in a preview before applying it. Real-Git testing showed that `git restore --worktree` may refresh index stat-cache bytes even with optional locks disabled; preservation is therefore explicitly defined and verified at the logical-entry/staging level, not byte-for-byte cache identity.

Initially refuse active operations, conflicts, directory expansion, submodule recursion, sparse-checkout expansion, and overwriting untracked/ignored content. Do not add clean, reset, all-files, or choose-ours/theirs modes.

#### Where

New `src/git-restore.ts`; shared path/state inspection and queue helpers; tool registration, security documentation, and new isolated restoration tests.

#### Acceptance criteria

- Only approved tracked paths change; refs, HEAD, logical index entries/staging, and unrelated/untracked/ignored files are preserved.
- Staged and partially staged files retain their index state. Missing files in the chosen source and symlink boundaries are handled explicitly.
- Stale previews/expectations and missing discard authorization refuse mutation. Discard authorization is never inferred from a general cleanup request.
- Partial failures are reported honestly with affected paths; no automatic destructive rollback or commit follows.

### 11. Prepare a revert without creating a commit (P2)

- [x] Add `revert_changes` only after proving a safe no-commit implementation and recovery path.

#### Why

Undoing a committed change should not require rewriting history or invoking a shell. It must also not introduce ordinary commit creation into BranchMe.

#### How

Limit the initial tool to one full captured non-merge commit, a clean idle checkout, and an expected current HEAD/index state. Apply its inverse without committing, return the resulting staged paths and exact before/after state, and leave ordinary commit creation to a separate explicit user workflow. There is no CommitMe integration or automatic handoff.

Before implementation, demonstrate in disposable repositories that conflicts/failures can be aborted with verified restoration using Git's operation machinery. If that cannot be guaranteed without reset/stash or private recovery state, leave this task deferred rather than weakening the boundary. No kept-conflict mode, ranges, merge mainline option, or automatic continuation in the initial release.

#### Where

New `src/git-revert.ts`; existing operation detection and mutation queues; registration, types, and isolated real-Git recovery tests.

#### Acceptance criteria

- Successful inverse application changes only the index/worktree; HEAD does not move and no commit/message is created.
- Conflicting inverse application is restored and verified, or clearly reports uncertain recovery and blocks further mutation; it never claims success from partial application.
- Dirty/in-progress worktrees, merge commits, stale expectations, and invalid commit IDs are rejected before applying changes.
- No automatic commit, extension-to-extension call, reset, stash, force-push, or published-history rewrite is added.

### 12. Complete the essential PR lifecycle (P2)

- [x] Add explicit PR editing and guarded host merging as separate operations.

#### Why

Creating and answering a PR is supported, but a shell-free workflow cannot currently update its metadata or perform an authorized merge before `land_branch` cleanup.

#### How

Add `edit_pull_request` for an exact open PR number and explicitly supplied title/body/draft changes, with omitted fields preserved. Keep base retargeting, reviewer management, and close/reopen outside this first scope.

Add `merge_pull_request` with exact PR number, expected head SHA, and an explicitly selected host-supported merge method. Re-read head/base/lifecycle/readiness before requesting the host merge; rely on GitHub to enforce repository protections, and expose no bypass, auto-merge, or branch-deletion switch. Verify the resulting merged identities. Do not automatically call `land_branch`.

#### Where

New `src/github-lifecycle.ts`; existing repository/token/request/status helpers in `src/github.ts`; workflow registration and mocked API lifecycle tests.

#### Acceptance criteria

- Metadata updates preserve unspecified fields, verify the resulting values, and handle empty bodies deliberately.
- Merging requires explicit workflow authorization and expected-head matching; changed heads, draft/closed PRs, known blockers, and incomplete required-policy evidence are handled conservatively.
- Host refusal is an error, not a local merge fallback. Ambiguous network outcomes are reconciled by exact PR status before retrying a mutation.
- Merge receipts expose exact head/base/merge identities for later landing. Merging and local cleanup remain distinct sequential actions.
- No administrative bypass, push, force-push, remote branch deletion, or local file mutation is performed.

### 13. Validate and document each delivered task

- [x] Apply documentation, registration, safety, and shell-free workflow checks to every task rather than postponing them until the end.

#### Why

Additional tools are useful only if an agent can discover the correct operation, understand partial results, and recover without falling back to Bash or receiving misleading guidance.

#### How

For each delivered task, update the canonical inventory, strict schemas, model-visible descriptions/guidelines, help, public docs, security boundaries, and smoke scenarios. Use the existing canonical tool-name inventory rather than introducing fixed tool counts. Keep future plans out of shipped-behavior claims.

Add scripted workflows whose model-visible tool allowlist contains only the necessary BranchMe tools and no Bash; harness setup may use Git directly in disposable repositories. Use local bare remotes and mocked GitHub responses. Read-only tests must verify files/index/refs/config stay unchanged; mutation tests must verify only authorized state changed.

#### Where

`src/constants.ts`, both registration modules, `src/blocker-guidance.ts`, `src/commands/branchme-command.ts`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/`, `test/`, and `scripts/smoke-pi-*.mjs`.

#### Acceptance criteria

- Every delivered tool is registered exactly once with a strict schema, useful defaults, explicit completeness/scope, cancellation/error handling, and concise tool-native recovery guidance.
- P0/P1 smoke demonstrates complete file discovery, older commit/file inspection, kept-merge stage inspection, selected-worktree coordination, remote/upstream setup, index control, and all-state PR checks without Bash calls by the agent.
- Recovery messages do not instruct agents to run an unavailable shell command when an existing tool can do the job; genuinely unsupported recovery is reported as requiring a person.
- Focused tests, `npm run validate`, and installed-package smoke pass for each implementation delivery; no real user-repository fetch, mutation, commit, push, or GitHub write is used for validation.
- BranchMe loads and these workflows work with no CommitMe installation. Public commit boundaries remain explicit.

## Completion receipt

`npm run release:check` passed: typecheck, formatting, all 456 tests, canonical registration/schema/context smoke, the new shell-free Pi workflows, script/package-content checks, worktree handoff, and isolated installed-production-package smoke. `git diff --check` passed. No commit, fetch, push, branch change, or GitHub write was performed on the user's repository.

- History/conflict inspection: real-Git coverage verifies pinned continuation after HEAD movement, root/merge comparisons, literal historical blobs, shallow/unborn state, binary/oversized content, absent conflict stages, changed indexes, pagination, and state preservation.
- Coordination/setup/index: isolated local bare-remotes and mocked PR tests verify selected-worktree actions without moving the control checkout, outer mutation serialization, explicit bases, expected configuration changes, partial staging, unborn additions/deletions, selected rename approval, intent-to-add/special-index refusal, and fresh expectations.
- Guarded P2: explicit-base rebase tests verify conflict restoration. Restore tests verify preview/authorization, stale-file rejection, logical staging preservation and source-driven deletion. Revert safety probes and regression tests prove owned `git revert --abort` restoration without reset/stash/private state, and owned `git revert --quit` after successful no-commit application without discarding the inverse.
- GitHub lifecycle: mocked API tests cover all-state checks, partial/unknown readiness, moved heads, explicit/omitted metadata, enabled merge methods, expected-head request leases, policy refusal and lost-response reconciliation. No live GitHub mutation was used.
- Real Pi smoke exposes only scenario-specific BranchMe tools: no Bash, file tools, CommitMe, or other extension is available to the deterministic model. Workflows cover history/blobs, status, stage/unstage, restore/revert, remote/upstream setup, cross-worktree bases, kept-conflict versions, and mocked checks/edit/merge.
- Remaining limitations and exact safety boundaries are public in `docs/SHELL_FREE_WORKFLOWS.md`, `README.md`, and `SECURITY.md`; raw stat-cache refresh, bounded/unsupported indexes, ignored-residue refusal for explicit rebase/revert, and the host merge API's lack of an atomic base-SHA lease are not hidden.

## Deferred beyond this plan

- Cherry-pick, kept revert conflicts, interactive rebase, and general sequencer continue/skip/abort APIs.
- Stash management, hunk-level staging, arbitrary patch application, reflog recovery, and reset/clean.
- Force-with-lease pushing and other published-history rewrite publication workflows.
- Clone, remote URL replacement/removal, remote branch deletion, fork PR workflows, and arbitrary Git configuration.
- Tags/releases, branch rename, blame/bisect, submodule/LFS management, and worktree repair/pruning.
- CI reruns, auto-merge, review approval/submission, and repository-policy administration.

These are not declared unnecessary; they are deferred to keep the first shell-free expansion focused and its destructive boundaries reviewable.
