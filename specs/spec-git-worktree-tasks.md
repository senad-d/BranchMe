# Plan: Git Worktree Management Tasks

## Task description

Implement safe Git worktree management in BranchMe for a specialized Git subagent. The Git subagent manages worktrees and returns structured handoff data; an orchestrator then starts a separate Pi session or subagent with the created worktree as its working directory.

## Objective

Add strict, current-repository worktree tools that can list worktrees, create a linked worktree for a new or existing local branch, and remove a verified clean linked worktree. Every successful mutation must verify the resulting Git state and report exactly what changed in both human-readable content and machine-readable handoff details.

## Approved decisions and boundaries

- Add three tools:
  - `list_worktrees` with a strict empty schema.
  - `create_worktree` with required `worktreePath`, `branchName`, and `branchMode` (`new` or `existing`).
  - `remove_worktree` with required `worktreePath`.
- The feature is designed for specialized Git subagents. BranchMe does not change Pi's current working directory, create Pi sessions, or spawn Pi processes.
- A caller or orchestrator starts the next agent session with the verified `handoff.cwd` returned by `create_worktree`.
- `create_worktree` requires an absolute destination path.
- `branchMode: new` creates a new local branch from the current `HEAD` only.
- `branchMode: existing` checks out an existing local branch. It does not infer or create a local branch from a remote branch.
- Worktree creation does not require the source worktree to be clean because it does not switch or overwrite the source worktree.
- Worktree removal is force-free and allowed only for a clean, unlocked, non-prunable linked worktree belonging to the current repository.
- The main worktree and the worktree containing the active Pi session cannot be removed.
- Removing a worktree never deletes its branch.
- Do not expose `force`, detached, orphan, move, prune, repair, lock, unlock, remote, refspec, or arbitrary start-point parameters in this implementation.
- Do not automatically copy ignored or untracked files such as `.env` into a new worktree.
- Keep automatic Git context focused on the active worktree. Worktree inventory remains an explicit `list_worktrees` operation.
- Use `pi.exec("git", args, { cwd, signal, timeout })` with argv arrays for every Git command.
- Treat paths, branch names, lock reasons, prune reasons, and Git output as untrusted metadata. Redact, escape, and bound all returned values.
- Execute tasks in order, one task per implementation session. Mark only the completed task with `x` after its acceptance criteria and validation pass.

### 1. Define worktree contracts, constants, and serializable details

- [x] Add the public worktree tool contracts and shared result types without implementing Git mutations.

#### Why

The parser, Git helpers, tools, tests, documentation, and subagent handoff all need one stable contract before behavior is implemented.

#### How

- Add constants for `list_worktrees`, `create_worktree`, and `remove_worktree`, then include them in `BRANCHME_TOOL_NAMES`.
- Add bounded worktree list/output limits and a mutation timeout using the existing Git timeout conventions.
- Define serializable types for:
  - a listed worktree entry;
  - list details and omitted-entry count;
  - create mode (`new` or `existing`);
  - handoff details;
  - create result details;
  - remove result details.
- Standardize mutation results around `action`, repository identity, verified before/after facts, and `handoff`.
- Define create handoff semantics as `ready: true` with an absolute `cwd`.
- Define remove handoff semantics as `ready: false` with `cwd: null`, while retaining the removed branch and HEAD for follow-up work.
- Add `@earendil-works/pi-ai` as a direct Pi peer/development dependency for `StringEnum` if required by the strict `branchMode` schema; preserve unrelated existing dependency changes.

#### Where

- `src/constants.ts`
- `src/types.ts`
- `package.json`
- `package-lock.json`

#### Acceptance criteria

- All three names are present in `BRANCHME_TOOL_NAMES`.
- Worktree details are JSON-serializable and contain no runtime objects or abort signals.
- Handoff details include `cwd`, `branch`, `head`, `ready`, and a concise summary.
- Result types distinguish the requested action from the post-action verified state.
- No tool is registered and no Git mutation is introduced in this task.
- `npm run typecheck` passes.

### 2. Implement bounded porcelain worktree parsing and listing

- [x] Implement and unit-test read-only worktree discovery using Git's stable NUL-delimited porcelain format.

#### Why

Creation and removal must verify repository membership and final state against a correctly parsed worktree inventory. The same inventory powers `list_worktrees` and handoff selection.

#### How

- Run `git worktree list --porcelain -z` from the verified current repository root.
- Parse records beginning with `worktree` and support `HEAD`, `branch`, `detached`, `bare`, `locked`, and `prunable` attributes.
- Preserve optional lock/prune reasons after sanitizing them.
- Mark the first entry as the main worktree and compare canonical paths to mark the current worktree.
- Strip only the `refs/heads/` prefix when returning a local branch name.
- Ignore unknown future porcelain attributes safely while rejecting malformed required fields.
- Bound raw output, entry count, paths, reasons, and formatted summaries. Report omitted records explicitly.
- Keep this helper read-only.

#### Where

- `src/git.ts`
- `src/types.ts`
- `test/git.test.mjs`

#### Acceptance criteria

- Parsing handles main, linked, detached, locked-with-reason, locked-without-reason, bare, and prunable records.
- NUL-delimited paths and reasons containing whitespace or control characters cannot corrupt result formatting.
- Malformed records fail without echoing unsafe raw output.
- Listing uses only read-only Git commands and propagates the caller's abort signal.
- Returned entries are bounded and include an omitted count when necessary.
- Focused Git unit tests pass.

### 3. Implement worktree path and repository-boundary validation

- [x] Add and unit-test path validation shared by worktree creation and removal.

#### Why

Worktree management intentionally writes outside the active checkout, so path handling becomes the feature's most important filesystem security boundary.

#### How

- Require `worktreePath` to be a non-empty absolute path with no NUL or control characters.
- Normalize the path, require its immediate parent to exist as a directory, resolve the parent through `realpath`, and build the canonical destination from that parent plus the requested basename.
- Use `lstat` so an existing file, directory, or symlink at a creation destination is rejected.
- Reject creation destinations inside any registered worktree or inside the repository's common Git directory.
- Resolve the common Git directory through Git rather than assuming `.git` is a directory.
- For removal, require an exact canonical match from a fresh worktree inventory; never pass an unverified user path directly to `git worktree remove`.
- Keep filesystem errors concise and redact/bound path metadata.

#### Where

- `src/git.ts`
- `test/git.test.mjs`

#### Acceptance criteria

- Relative, blank, control-character, existing, symlink-target, nested-worktree, and common-Git-directory destinations are rejected.
- Valid sibling or otherwise external absolute destinations with an existing parent are accepted.
- Removal lookup accepts only a canonical path registered to the current repository.
- Validation uses Node path/filesystem APIs and argv-style Git calls, not shell interpolation.
- No filesystem mutation occurs in this task.
- Focused Git unit tests pass.

### 4. Implement verified worktree creation

- [x] Implement and unit-test creation of linked worktrees for new and existing local branches.

#### Why

The specialized Git agent needs a deterministic operation that leaves the source worktree untouched and produces a worktree ready for a separate agent session.

#### How

- Resolve the current repository root, source branch/detached state, source HEAD, worktree inventory, and canonical destination before mutation.
- Validate `branchName` with existing local checks and `git check-ref-format --branch`.
- For `branchMode: new`:
  - require a valid current `HEAD`;
  - reject an existing local branch;
  - run `git worktree add -b <branchName> <canonicalPath> HEAD`.
- For `branchMode: existing`:
  - require `refs/heads/<branchName>` to exist;
  - reject a branch already checked out in any worktree;
  - run `git worktree add <canonicalPath> refs/heads/<branchName>`.
- Do not accept or infer a base ref, remote branch, detached mode, orphan mode, reset mode, or force mode.
- Run creation inside the existing repository mutation queue.
- After Git succeeds, recollect the inventory and inspect the new worktree to verify its canonical path, local branch, HEAD, and working-tree state.
- Return success only after postcondition verification.
- If Git fails or verification is inconclusive, throw a bounded error that says the repository and destination should be inspected; do not automatically delete a branch or partially created directory.

#### Where

- `src/git.ts`
- `src/types.ts`
- `test/git.test.mjs`

#### Acceptance criteria

- New-branch creation is based on current `HEAD` only and rejects existing branches.
- Existing-branch creation accepts only an existing local branch not checked out elsewhere.
- Source worktree changes are neither rejected nor modified.
- No command includes `--force`, `-B`, `--detach`, `--orphan`, a remote ref, or an arbitrary start point.
- Successful details contain verified worktree facts and a ready handoff with the canonical absolute `cwd`.
- Git and postcondition failures never trigger automatic destructive cleanup.
- Focused Git unit tests pass.

### 5. Implement verified force-free worktree removal

- [x] Implement and unit-test safe removal of a verified linked worktree while preserving its branch.

#### Why

Removal recursively deletes a checkout directory and is the most destructive operation in the feature. It must fail closed and report the surviving branch state for handoff.

#### How

- Resolve the current repository and collect a fresh full worktree inventory inside the repository mutation queue.
- Resolve `worktreePath` to an exact listed canonical entry.
- Reject the main worktree, current worktree, bare entries, locked entries, prunable/missing entries, and detached worktrees for this initial implementation.
- Run a status check in the verified target worktree and reject staged, unstaged, untracked, or unmerged changes.
- Capture the target branch and HEAD before removal.
- Run `git worktree remove <verifiedCanonicalPath>` without force.
- Recollect worktrees and verify that the exact entry is absent.
- Verify that `refs/heads/<branchName>` still exists at the captured HEAD.
- Return a non-ready handoff with `cwd: null`, the preserved branch, HEAD, and a concise explanation.

#### Where

- `src/git.ts`
- `src/types.ts`
- `test/git.test.mjs`

#### Acceptance criteria

- Only a clean, unlocked, present linked worktree can be removed.
- Main, current, dirty, detached, locked, prunable, missing, and foreign paths are rejected before removal.
- `git worktree remove` receives only a freshly verified canonical path.
- No force argument is accepted or executed.
- Successful removal is verified and the branch remains at the same commit.
- Result content/details clearly state that the directory was removed but the branch was retained.
- Focused Git unit tests pass.

### 6. Register strict worktree tools and handoff-oriented output

- [x] Register `list_worktrees`, `create_worktree`, and `remove_worktree` with strict schemas, prompt metadata, execution, and post-action summaries.

#### Why

The Git helpers must be exposed through Pi in a way that specialized agents can use safely and orchestrators can consume without parsing prose.

#### How

- Register all three tools in `registerBranchMeTools`.
- Use `StringEnum(["new", "existing"] as const)` for `branchMode`.
- Reject additional properties on every schema.
- Ensure descriptions, snippets, and every guideline explicitly name their tool.
- Require explicit user intent for creation/removal and instruct agents never to infer a filesystem path silently.
- Instruct agents not to batch dependent worktree mutations and to wait for creation before handing its `cwd` to another agent.
- Format `list_worktrees` as a compact inventory with path, branch/detached state, short HEAD, main/current, locked, and prunable indicators.
- Format successful mutations in the past tense and state both the performed action and verified final state.
- Return full structured details, including ready/non-ready handoff data, alongside concise content.

#### Where

- `src/tools/branchme-tools.ts`
- `src/constants.ts`
- `test/tools.test.mjs`
- `test/schema-validation.test.mjs`

#### Acceptance criteria

- `list_worktrees` accepts only `{}`.
- `create_worktree` requires exactly `worktreePath`, `branchName`, and `branchMode`.
- `remove_worktree` requires exactly `worktreePath`.
- Unsupported fields such as `force`, `baseRef`, `remote`, `detach`, `orphan`, `move`, `prune`, `repair`, `lock`, and `unlock` are rejected.
- Every prompt guideline names its associated tool.
- Mutation content says what was done and what postcondition was verified.
- Create details provide a ready absolute `handoff.cwd`; remove details provide `handoff.cwd: null` and `ready: false`.
- Focused tool and schema tests pass.

### 7. Add isolated real-Git worktree integration coverage

- [x] Add real-Git tests for the complete list/create/remove lifecycle in temporary repositories.

#### Why

Mocked command tests cannot prove Git's actual worktree metadata, checkout, cleanliness, and branch-preservation behavior.

#### How

- Extend the existing temporary-repository integration harness so approved worktree paths may be siblings under the same temporary test root.
- Test listing the main worktree.
- Test creating a new-branch worktree from current `HEAD` while the source worktree is dirty.
- Test creating a worktree for an existing local branch.
- Verify the created checkout's branch, HEAD, clean state, and handoff path.
- Test rejection when an existing branch is already checked out elsewhere.
- Test dirty linked-worktree removal rejection.
- Test successful clean removal and verify that its branch remains.
- Avoid real remotes and external filesystem locations.

#### Where

- `test/git-integration.test.mjs`

#### Acceptance criteria

- Tests use only temporary local repositories and directories.
- New and existing branch modes work against real Git.
- Source dirty state is preserved during creation.
- Dirty removal fails without deleting the linked checkout.
- Clean removal deletes the linked checkout metadata/path and preserves its branch and commit.
- Integration tests clean up all temporary directories even after failure.
- `node --test test/git-integration.test.mjs` passes.

### 8. Update BranchMe help, panel copy, and deterministic captures

- [x] Update informational user surfaces to describe the specialized-agent worktree workflow without adding command-side mutations.

#### Why

Users and agents need to understand that BranchMe creates a handoff target but a separate orchestrator starts the new Pi session.

#### How

- Add concise worktree tool guidance to `/branchme help`.
- Explain that `create_worktree` returns the absolute `handoff.cwd` for the next session/subagent.
- State that BranchMe does not change cwd, start Pi, copy `.env`, or remove branches automatically.
- Keep `/branchme` informational; do not add worktree action buttons or command mutations.
- Update the compact panel only if the additional copy remains within its width/height rules.
- Refresh deterministic captures intentionally when rendered text changes.

#### Where

- `src/commands/branchme-command.ts`
- `src/ui/branchme-panel.ts`
- `test/command.test.mjs`
- `test/tui-capture.test.mjs`
- `docs/TUI_CAPTURE.md`

#### Acceptance criteria

- Help names all three worktree tools and explains the separate-session handoff.
- No slash command executes `git worktree` mutations.
- TUI output remains bounded and responsive.
- JSON mode remains stdout-safe.
- Command and capture tests pass.

### 9. Update registration and real Pi runtime smoke verification

- [x] Update all hard-coded tool expectations and smoke verifiers for the expanded BranchMe tool set.

#### Why

The repository currently verifies exactly eight tools in multiple tests, scripts, and documentation. Those checks must fail if any worktree tool or prompt contract is missing at runtime.

#### How

- Update extension registration tests to expect the complete tool-name set.
- Update runtime verifier schemas for the three new tools.
- Update Git-context smoke expected tools without changing the automatic context behavior.
- Replace hard-coded textual tool counts with the new count or count-independent wording where appropriate.
- Verify source metadata, active status, strict schemas, descriptions, snippets, and named prompt guidelines through `pi.getAllTools()`.

#### Where

- `test/tools.test.mjs`
- `test/preparation.test.mjs`
- `scripts/smoke-pi-runtime.mjs`
- `scripts/smoke-pi-git-context.mjs`
- `docs/SMOKE_TEST.md`

#### Acceptance criteria

- Registration tests expect all existing and new BranchMe tools exactly once.
- Runtime smoke verifies strict worktree schemas and prompt metadata.
- Git-context smoke still proves automatic context and explicit `branch_status` behavior without network access.
- No smoke test invokes a real worktree mutation or remote.
- `npm run smoke:pi` passes.

### 10. Document worktree behavior and security boundaries

- [x] Update public documentation, package metadata, changelog, and structure documentation for the implemented feature.

#### Why

Worktree creation/removal expands BranchMe's filesystem mutation boundary beyond the active checkout and must be documented precisely.

#### How

- Update the package description/keywords if needed to include worktrees.
- Document all three tools, schemas, command semantics, and handoff details.
- Add the specialized Git subagent workflow and show how the orchestrator starts another agent with `handoff.cwd`.
- Explain that ignored/untracked files and repository-root `.env` files are not copied automatically; recommend process-level credentials for agents started in linked worktrees.
- Document absolute path handling and verified repository membership.
- Document force-free removal, clean-state checks, branch retention, and unsupported operations.
- State Git's submodule worktree limitations and that BranchMe does not add force-based submodule cleanup.
- Update structure/test descriptions and release notes accurately.

#### Where

- `README.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `docs/STRUCTURE.md`
- `docs/SMOKE_TEST.md`
- `package.json`

#### Acceptance criteria

- Public docs accurately describe implemented behavior and do not claim automatic Pi session switching.
- Security docs clearly disclose creation/removal of directories outside the active checkout.
- Documentation states that removal retains the branch.
- Documentation states that no force, move, prune, repair, lock, unlock, detached, orphan, or remote-inference behavior exists.
- Handoff examples use structured fields and an absolute `cwd`.
- Package metadata remains valid and package-content checks still exclude private/generated files.

### 11. Run complete validation and isolated handoff smoke testing

- [x] Validate the complete feature and record an isolated specialized-agent handoff smoke result.

#### Why

The final gate must prove type safety, formatting, unit behavior, real Git behavior, Pi registration, package integrity, and the intended new-session handoff contract.

#### How

- Run focused tests first and fix all failures.
- Run the complete repository validation suite.
- Run the installed-package smoke because dependency and package metadata may change.
- In a temporary repository, load BranchMe in isolation, create a worktree through the tool path or a deterministic verifier, and confirm the returned `handoff.cwd` identifies the expected branch and HEAD.
- Start any handoff verification session only in an isolated temporary directory with no network access and no real credentials.
- Remove the temporary worktree safely and verify the branch remains.
- Record the final smoke findings in project documentation.

#### Where

- `docs/SMOKE_TEST.md`
- Any narrowly required smoke script/test file

#### Acceptance criteria

- `npm run typecheck` passes.
- `npm run format:check` passes.
- `npm run test` passes.
- `npm run smoke:pi` passes.
- `npm run check:pack` passes.
- `npm run validate` passes.
- `npm run smoke:pi:packed` passes.
- The isolated handoff smoke confirms that a new session can use the returned absolute `handoff.cwd` and observe the expected branch/HEAD.
- No live remote, external API, user repository, or real credential is used during validation.

### 12. Reject ignored files before worktree removal

- [x] Prevent `remove_worktree` from deleting ignored files that the existing clean-worktree preflight does not report.

#### Why

`git status --porcelain=v1 --untracked-files=normal` excludes ignored files, while force-free `git worktree remove` can still recursively delete them. A linked checkout containing an ignored `.env`, build artifact, dependency directory, or other local-only file can therefore be reported as clean and removed, contradicting the safe-removal contract.

#### How

- Keep the general working-tree context parser's existing ignored-entry behavior unchanged.
- Add a removal-specific, argv-style, bounded preflight that detects ignored entries before mutation, for example with porcelain status configured to report matching ignored paths.
- Reject removal when any ignored file or directory is present, without echoing unsafe paths or file contents.
- Preserve the existing staged, unstaged, untracked, and unmerged checks.
- Add mocked command coverage and a temporary real-Git regression test containing an ignored local file.
- Verify the rejected worktree directory and ignored file both remain present and that no `git worktree remove` command ran.
- Update public removal documentation and error guidance to state that ignored files also block removal.

#### Where

- `src/git.ts`
- `test/git.test.mjs`
- `test/git-integration.test.mjs`
- `README.md`
- `SECURITY.md`
- `docs/STRUCTURE.md`

#### Acceptance criteria

- A linked worktree containing only ignored files is not considered removable.
- Rejection occurs before `git worktree remove` and preserves the complete checkout.
- Existing staged, unstaged, untracked, unmerged, locked, detached, prunable, main, and current rejection behavior remains intact.
- The ignored-file scan uses `pi.exec("git", args, { cwd, signal, timeout })` with an argv array and bounded output handling.
- A real-Git integration test proves an ignored local file survives the rejected operation.
- Focused Git tests and the complete test suite pass.

### 13. Guarantee lossless machine-readable worktree handoffs

- [x] Ensure successful worktree handoff identity fields always contain exact usable values rather than redacted, escaped, or truncated substitutes.

#### Why

`create_worktree` currently passes the canonical destination and branch through display sanitization before assigning them to `handoff.cwd` and `handoff.branch`. A valid token-shaped or over-limit path can be created successfully but returned as a different value such as `/tmp/[REDACTED]` while `ready` remains `true`, leaving the orchestrator unable to enter the real checkout.

#### How

- Separate display-safe formatting from machine-readable handoff identity handling.
- Before any worktree mutation, verify that the canonical path and branch can be returned losslessly within the documented security and size boundaries.
- Fail before mutation when redaction, control-character escaping, Unicode handling, or truncation would alter a required handoff identity field.
- Apply the same exactness rule to retained branch identity returned after removal.
- Keep list and prose output sanitized and bounded because those surfaces are informational rather than executable handoffs.
- Add tests for token-shaped paths and branch names, boundary-length values, and canonical paths that become unsafe after filesystem resolution.
- Ensure failed validation does not create a directory, branch, or worktree registration and does not remove a checkout.

#### Where

- `src/git.ts`
- `src/types.ts`
- `src/tools/branchme-tools.ts`
- `test/git.test.mjs`
- `test/tools.test.mjs`
- `test/git-integration.test.mjs`
- `README.md`
- `SECURITY.md`

#### Acceptance criteria

- Every successful `handoff.cwd` is the exact canonical absolute path accepted by Git and exists when `ready: true` is returned.
- Every successful handoff branch is the exact local branch name verified by Git.
- No successful machine-readable identity contains `[REDACTED]`, escaped control sequences, or an ellipsis introduced by BranchMe.
- Inputs that cannot be returned safely and losslessly fail before mutation with bounded guidance.
- Display summaries and list output remain redacted, escaped, and bounded.
- Focused handoff tests, real-Git integration tests, and the isolated handoff smoke pass.

### 14. Enforce installed-package smoke testing in automated publishing

- [x] Make the GitHub publish workflow run the installed npm artifact smoke before `npm publish`.

#### Why

The checkout validation suite does not run `smoke:pi:packed`. Worktree tool registration now adds a direct runtime import and peer dependency, so a checkout can pass while the packed artifact still fails to install or load. The local `release:check` script covers this risk, but the GitHub publish workflow currently runs only `npm run validate` before publishing.

#### How

- Change the publish workflow to run `npm run release:check`, or add an explicit `npm run smoke:pi:packed` step after validation and before publishing.
- Keep the packed smoke credential-free and isolated.
- Avoid publishing, tagging, or pushing when the packed smoke fails.
- Update smoke/release documentation so local and automated release gates describe the same commands.

#### Where

- `.github/workflows/publish.yml`
- `package.json`
- `README.md`
- `docs/SMOKE_TEST.md`

#### Acceptance criteria

- The publish job runs checkout validation and installed-artifact smoke before `npm publish`.
- A packed install/load failure stops the workflow before npm publication and Git tag creation.
- The workflow reuses the canonical package script rather than duplicating packed-smoke implementation logic.
- Public release documentation matches the automated publish gate.
- Workflow syntax and package scripts validate successfully.

### 15. Align packaged documentation and changelog with version 0.1.8

- [x] Remove stale branch-only and no-filesystem-mutation claims from packaged documentation and align the changelog heading with the package version.

#### Why

`docs/PROJECT_DEFINITION_BRIEF.md` is included in the npm package but still describes a branch-only tool set and says extension code writes no files beyond branch checkout/push metadata. `CHANGELOG.md` still labels the accumulated release notes as `0.1.0 - Unreleased` while package metadata is `0.1.8`.

#### How

- Update the project brief's identity, use cases, tool table, module boundaries, dependencies, file mutation boundary, security notes, and validation plan for the implemented eleven-tool worktree workflow.
- If the approved brief must remain a historical record, label it unambiguously as historical and link to current behavior instead of leaving stale claims presented as current.
- Add or rename the unreleased changelog section so it matches version `0.1.8` without inventing a release date.
- Include the ignored-file removal protection and exact handoff behavior after Tasks 12 and 13 are complete.
- Extend documentation preparation tests so packaged public docs cannot silently regress to branch-only or no-filesystem-mutation claims.

#### Where

- `docs/PROJECT_DEFINITION_BRIEF.md`
- `CHANGELOG.md`
- `test/preparation.test.mjs`
- `package.json`

#### Acceptance criteria

- No packaged current-state document claims that BranchMe has only branch/PR tools or cannot create/remove filesystem directories.
- The project brief either accurately describes worktree behavior or is clearly marked as historical with a current-document pointer.
- The active changelog heading matches package version `0.1.8` and remains unreleased until an actual release date is known.
- Documentation tests inspect the packaged project brief and all three worktree tool names.
- Formatting, documentation tests, and package-content checks pass.

### 16. Complete final release-readiness verification

- [ ] Re-run all safety and packaging gates and resolve repository hygiene before the worktree feature is landed.

#### Why

The new smoke script and remediation task file are currently untracked, and the local branch was reported behind its upstream. A clean validation result is not sufficient if required files are omitted from the eventual change or upstream integration is left unresolved.

#### How

- Confirm `scripts/smoke-worktree-handoff.mjs` and this task specification are intentionally included in the final change rather than omitted by a tracked-files-only commit flow.
- Run `git diff --check`, focused remediation tests, `npm run validate`, and `npm run smoke:pi:packed` after Tasks 12–15.
- Inspect the final package dry-run and confirm no private specs, credentials, generated files, or local state are packaged.
- Refresh upstream status after implementation is committed or otherwise made safe for Git integration.
- Report upstream divergence and obtain the user's chosen merge/rebase strategy before rewriting or integrating history; do not automatically pull, rebase, stash, discard, commit, push, or publish from this task.
- Review the final diff for accidental lockfile churn beyond the declared direct dependency and package version changes.

#### Where

- `scripts/smoke-worktree-handoff.mjs`
- `specs/spec-git-worktree-tasks.md`
- `package-lock.json`
- Repository and CI validation output

#### Acceptance criteria

- All required implementation and smoke files are included in the intended final change.
- `git diff --check`, focused tests, `npm run validate`, and `npm run smoke:pi:packed` pass after remediation.
- Package dry-run contents remain limited to approved public files.
- The final report clearly states upstream divergence and the user-approved integration next step without performing an implicit history rewrite.
- No live remote, external API, user repository, real credential, publish, push, or tag creation is used during validation.
