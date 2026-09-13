# Plan: Complete the Normal Branch and Pull Request Workflow

## Scope

Implement the core reviewed gaps. Optional clone support, remote configuration/deletion, fork PRs, and force-pushing remain deferred. Branch listing includes upstream ahead/behind counts; CI-check/review-policy inspection is separate from PR lifecycle status. Feature-base updates use a verified normal merge, so published history is not rewritten.

## Objective

Close the important gaps in BranchMe's normal workflow while preserving its strict, repository-scoped safety model and keeping staging, user-authored commits, commit-message generation, stashing, resets, arbitrary refspecs, force pushes, and direct remote deletion outside this extension.

### 1. Add bounded branch discovery

- [x] Add a read-only `list_branches` tool that discovers local and remote-tracking branches.

#### Why

BranchMe mutation tools require exact branch names, but the current tool set exposes only the current branch and worktree inventory. Agents should not need arbitrary shell commands to discover valid local branches, upstreams, remote-tracking refs, or worktree occupancy.

#### How

Use bounded `git for-each-ref` output plus the verified worktree inventory. Return local/remote kind, exact display-safe name, full commit identity, current state, configured upstream, symbolic-ref state, and checked-out worktree paths. Keep the tool read-only with a strict empty schema and bounded summary.

#### Where

- `src/constants.ts`
- `src/types.ts`
- `src/git.ts`
- `src/tools/branchme-tools.ts`
- `test/`

#### Acceptance criteria

- `list_branches` accepts only `{}` and performs no mutation.
- Local and remote-tracking branches are distinguished.
- Current branch, upstream, symbolic refs, and worktree occupancy are represented safely.
- Raw and rendered output is bounded and malformed output fails closed.
- Focused type, schema, helper, and tool tests pass.

### 2. Add verified remote-branch tracking

- [x] Add `track_branch` for checking out an existing remote branch as a new local tracking branch.

#### Why

`fetch_branch` can refresh `origin/feature`, but `change_branch` requires an existing local branch and `create_branch` starts only from current `HEAD`. The active checkout therefore lacks a safe tool-native path for joining an existing remote branch.

#### How

Require a clean active worktree, a new exact local `branchName`, optional configured `remote` (default `origin`), and optional `remoteBranch` (default the local name). Fetch only that remote branch, create the local branch with `git switch --track -c`, and verify current branch, commit, and configured upstream in one repository mutation queue window.

#### Where

- `src/constants.ts`
- `src/types.ts`
- `src/git.ts`
- `src/tools/branchme-tools.ts`
- `test/`

#### Acceptance criteria

- `track_branch` has a strict schema and requires explicit intent.
- Dirty worktrees, existing local branches, missing remotes, and missing remote branches fail before checkout mutation.
- Fetch uses the existing narrow remote-tracking refspec.
- Success verifies local branch, HEAD, and upstream.
- No force, reset, stash, arbitrary refspec, or remote inference is exposed.
- Focused unit and real-Git tests pass.

### 2a. Update a feature from its remote base

- [x] Add `update_from_base` to merge a freshly fetched remote base into the clean current branch.

#### Why

Rebasing onto a tracking upstream does not update a feature from `origin/main`. A normal merge supports already-published branches without introducing a force-push requirement.

#### How

Accept an exact `baseBranch` and optional configured `remote`. Reject self-updates, dirt, and ongoing operations; fetch narrowly, then reuse the verified integration state machine with an explicitly remote-tracking source. Keep fixed merge policy and automatic conflict abort. Do not change the current branch's upstream.

#### Where

- `src/git-workflow.ts`
- `src/git-integration.ts`
- `src/tools/workflow-tools.ts`
- `test/workflow.test.mjs`

#### Acceptance criteria

- No-op, fast-forward, divergent merge, and restored-conflict paths are tested with real Git.
- The fetched base and previous feature commits are verified as ancestors on success.
- Dirty and in-progress checkouts are preserved; upstream configuration is unchanged.
- No rebase, force push, reset, or stash is introduced.

### 3. Add pull request lifecycle status

- [x] Add a read-only `pull_request_status` tool for open, closed, and merged pull requests.

#### Why

Automatic context only looks for one open PR on the current branch. Normal lifecycle automation also needs exact merged/closed state and immutable head/base/merge identities.

#### How

Accept an optional positive PR `number` or optional `headBranch`; infer the current branch only when both are omitted. Query the resolved current GitHub repository, validate bounded REST responses, and return the PR number, URL, state, draft/merged status, timestamps, head/base refs, head SHA, and merge commit SHA.

#### Where

- `src/constants.ts`
- `src/types.ts`
- `src/github.ts`
- `src/tools/branchme-tools.ts`
- `test/`

#### Acceptance criteria

- The tool is read-only and repository-scoped.
- Number and branch lookup paths are supported and bounded.
- Cross-repository head metadata and malformed identities fail closed.
- Tokens and API errors remain redacted.
- Strict schema, helper, and tool tests pass.

### 4. Make pull request creation idempotent

- [x] Reuse an existing matching open PR instead of failing on safe retries.

#### Why

Automated workflows can retry after a timeout or interrupted response. Reissuing the current create-only call can produce a GitHub 422 even when the desired PR already exists.

#### How

After resolving and verifying the local/GitHub head, look up an existing open same-repository PR for the exact head. Reuse it only when its base matches the requested base; otherwise fail with an explicit mismatch. Report whether the result was `created` or `existing`.

#### Where

- `src/types.ts`
- `src/github.ts`
- `src/tools/branchme-tools.ts`
- `test/`

#### Acceptance criteria

- Repeated equivalent calls return the same open PR without a second POST.
- A same-head PR with a different base is not silently reused.
- GitHub head/local commit matching remains mandatory.
- Existing successful creation behavior remains compatible.
- Focused GitHub and tool tests pass.

### 5. Support verified landing after squash or rebase merges

- [x] Extend `land_branch` with optional `pullRequestNumber` evidence for host merges that do not preserve source ancestry.

#### Why

The current ancestry-only gate correctly handles merge commits and fast-forwards but rejects common GitHub squash and rebase merges, leaving the post-merge cleanup workflow incomplete.

#### How

When `pullRequestNumber` is supplied, retrieve a merged PR from the resolved repository and verify its exact source branch, source SHA, target branch, and merge commit SHA. Fetch the remote target and require the PR merge commit to be contained in it. Permit cleanup when either ordinary source ancestry succeeds or this stronger host-merge proof succeeds. Keep expected-HEAD leasing, worktree safety, ignored-residue disclosure, and target sync unchanged.

#### Where

- `src/git-landing.ts`
- `src/github.ts`
- `src/tools/branchme-tools.ts`
- `test/`

#### Acceptance criteria

- Existing ancestry-preserving landing behavior is unchanged.
- Squash/rebase cleanup requires explicit PR number and exact merged evidence.
- Open, closed-unmerged, wrong-head, wrong-base, moved-source, and missing-merge-commit cases refuse all cleanup.
- The fetched target must contain the reported merge commit.
- Local deletion remains expected-HEAD leased; no remote branch is deleted.
- Real-Git and mocked GitHub regression tests pass.

### 6. Update workflow guidance and remove documentation drift

- [x] Document the expanded discovery, tracking, PR status, idempotent creation, and PR-aware landing workflow.

#### Why

Public and security documentation must match the implemented schemas and safety boundaries. Existing text also contains stale claims about targeted fetch, remote-tracking ancestry, and worktree base refs.

#### How

Update help, README, security policy, project brief, structure guide, changelog, smoke documentation, runtime registration expectations, package metadata where needed, and deterministic captures.

#### Where

- `README.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `docs/`
- `src/commands/branchme-command.ts`
- `src/ui/branchme-panel.ts`
- `scripts/`
- `test/`

#### Acceptance criteria

- Every public tool list and count is current.
- Stale current-HEAD-only, no-parameter-fetch, and local-only ancestry claims are removed.
- Commit creation remains explicitly delegated outside BranchMe.
- Runtime smoke verifies every new strict schema and prompt contract.
- Documentation and capture tests pass.

### 7. Run complete validation

- [x] Run all checkout and installed-package validation gates.

#### Why

The expanded workflow changes Git parsing, GitHub REST behavior, mutation sequencing, schemas, prompt metadata, documentation, and packaged runtime behavior.

#### How

Run focused tests during each task, then run the canonical validation and release checks.

#### Where

- Repository-wide

#### Acceptance criteria

- `npm run typecheck` passes.
- `npm run format:check` passes.
- `npm run test` passes.
- `npm run smoke:pi` passes.
- `npm run check:pack` passes.
- `npm run validate` passes.
- `npm run smoke:pi:packed` passes.

#### Validation receipt

`npm run release:check` passed after review fixes: typecheck, formatting, all 306 tests, real Pi schema/context smoke, script checks, package-content checks, isolated worktree handoff, and installed-production-package smoke. GitHub lifecycle behavior was tested with mocked REST responses; Git mutations used isolated local repositories and bare remotes. No user repository branch/ref mutation, commit, push, PR creation, or remote deletion was performed.

### 8. Harden reviewed safety and verification edge cases

- [x] Fix confirmed diff-review defects and cover them with regression tests.

#### Why

Post-mutation validation is too late to stop a symbolic fetch destination from moving an unrelated branch. Cached upstream availability is not upstream configuration. Repository initialization must not treat failed discovery as proof of absence or inherit path redirection, and diagnostic truncation must not expose partial credentials.

#### How

Reject symbolic tracking destinations before workflow and landing fetches; compare stored upstream settings across base updates; reject unsafe initialization environments and inconclusive discovery; await initialization verification inside its error boundary; redact PR cancellation errors before truncation.

#### Where

- `src/git-workflow.ts`, `src/git-landing.ts`, `src/git.ts`, `src/github.ts`
- `test/workflow.test.mjs`, `test/land-branch.test.mjs`, `test/git-integration.test.mjs`, `test/pr-workflow.test.mjs`
- Public safety and validation documentation

#### Acceptance criteria

- Symbolic destinations are refused before fetching and unrelated refs remain unchanged.
- Restoring an absent upstream tracking ref does not falsely report changed configuration.
- Unsafe initialization environments and failed discovery cause no mutation; postcondition errors retain manual-inspection guidance.
- Long cancellation diagnostics cannot leak a truncated token prefix.
- All 306 tests and the complete `npm run release:check` pass.
