# Project Definition Brief

Originally approved on 2026-06-30. Updated to describe the implemented `0.3.0` package.

## 1. Bootstrap history

- Template source: `/Users/senad/Documents/Code/Moj_git/pi-tmp`
- Target directory: `/Users/senad/Documents/Code/Moj_git/pi-branchme`
- Copy status: copied; the target's existing `.git/` and `.pi/` directories were preserved and excluded from the copy.

## 2. Project identity

- Package name: `@senad-d/branchme`
- Display name: `BranchMe`
- Exported extension function: `branchMeExtension`
- Repository URL: `https://github.com/senad-d/branchme`
- One-sentence pitch: Verified current-repository Pi tools for branch, integration, retirement, linked-worktree, push, and GitHub pull request workflows.
- Tool count: fourteen strict agent-callable tools.

## 3. Users and use cases

- Primary users: Pi users, specialized Git subagents, orchestrators, and CI/GitHub Actions workflows.
- Primary use cases:
  - Inspect bounded current-repository branch, upstream, working-tree, related-PR, and recent-commit state, with an optional explicit local source/target ancestry proof.
  - Integrate one exact existing local source branch into the already-current clean local target, returning verified no-op, fast-forward, merge-commit, or restored-conflict details.
  - List the current repository's main and linked worktrees explicitly.
  - Create and verify a linked worktree for a new branch from current `HEAD` or an unoccupied existing local branch.
  - Return an exact, absolute, machine-readable worktree handoff for a caller-managed separate Pi session or subagent.
  - Remove an exact verified linked worktree only when it is clean and contains no ignored entries, while retaining its local branch.
  - Land a host-merged feature in one cwd-independent call: fetch/prove remote ancestry, remove a clean linked checkout including ignored residue, lease-delete the source branch, and sync the target independently without touching a dirty checkout.
  - Retire one exact unoccupied local branch ref only when it matches a full expected `HEAD` and its relationship to one exact local target has been verified; unmerged retirement requires explicit force authorization.
  - Switch to an existing local branch after a clean-worktree preflight or create a new branch from current `HEAD`.
  - Fetch a configured upstream tracking ref, fast-forward the current branch, or explicitly rebase it.
  - Push the current branch to its configured upstream, or publish it to `origin` when no upstream exists.
  - Create a pull request in the resolved current GitHub repository through the REST API.
- Non-goals:
  - No staging, direct working-tree edits, user-authored commits, commit-message input/generation, diff generation, stashing, resets, or force pushes. Explicit `integrate_branch` may let Git create its standard merge commit for divergent histories.
  - No automatic Pi cwd changes, process/session creation, or copying of `.env` and other ignored/untracked files into linked worktrees.
  - No bulk or pattern branch deletion, inferred retirement targets, remote or remote-tracking deletion, automatic worktree removal during retirement, or reset-based retirement rollback.
  - No GitHub CLI dependency or cross-repository pull requests.
  - No labels, reviewers, projects, or issue-linking behavior.

## 4. Pi integration surface

| Surface | Name | Purpose | Notes |
| --- | --- | --- | --- |
| Command | `/branchme` | Compact TUI status and workflow panel | Informational; no Git or GitHub mutations |
| Command | `/branchme help` | Runtime requirements and workflow guidance | Informational; no actions |
| Tool | `branch_status` | Refresh bounded current-worktree Git and related-PR context; optionally prove captured local-branch ancestry | Read-only; targeted ancestry is absent from automatic context |
| Tool | `integrate_branch` | Integrate one exact local source into the already-current clean local target | Fixed normal-merge policy; verified automatic abort/restoration on conflict |
| Tool | `list_worktrees` | List bounded main/linked worktree inventory | Read-only and explicit |
| Tool | `create_worktree` | Create and verify a linked worktree | Exact absolute handoff cwd; new/existing local branch modes only |
| Tool | `remove_worktree` | Remove an exact verified clean linked worktree | Force-free; ignored entries block removal; branch retained |
| Tool | `retire_branch` | Delete one exact verified local branch ref | Expected-`HEAD` lease; exact target ancestry; explicit force for unmerged history; local-only |
| Tool | `land_branch` | Post-host-merge cleanup and final target sync in one call | Remote ancestry gate, ignored-residue deletion, leased local source deletion, per-step receipts; run from repository root |
| Tool | `change_branch` | Switch to an existing local branch | Rejects dirty worktrees |
| Tool | `fetch_branch` | Refresh the current branch's configured tracking ref | Explicit fetch refspec; no checkout change |
| Tool | `pull_branch` | Fast-forward the clean current branch | No rebase, merge commit, or autostash |
| Tool | `rebase_branch` | Rebase the clean current branch onto its upstream | Explicit history rewrite; automatic abort attempt on failure |
| Tool | `create_branch` | Create and check out a new branch from current `HEAD` | Fails when invalid or already present |
| Tool | `push_branch` | Push or publish the current branch | Explicit remote/refspec behavior |
| Tool | `pull_request` | Preflight branch state and create a GitHub pull request | Current repository only; autofill is opt-in |
| Event | `before_agent_start` | Append fresh bounded Git context to the system prompt | Read-only collection; no worktree inventory |
| UI | TUI panel | Compact BranchMe workflow/configuration view | Responsive and width-bounded |
| Resource | none | No bundled skills, prompts, or themes | Package remains extension-focused |

## 5. Architecture

- Implemented source layout:
  - `src/extension.ts`
  - `src/constants.ts`
  - `src/types.ts`
  - `src/redaction.ts`
  - `src/git-context.ts`
  - `src/commands/branchme-command.ts`
  - `src/tools/branchme-tools.ts`
  - `src/git.ts`
  - `src/git-integration.ts`
  - `src/git-retirement.ts`
  - `src/git-landing.ts`
  - `src/github.ts`
  - `src/ui/branchme-panel.ts`
- Module boundaries:
  - The extension entry point registers the informational command, fourteen tools, and automatic context hook.
  - The context module owns bounded read-only collection, prompt formatting, targeted ancestry rendering, and the `before_agent_start` hook; automatic context never runs ancestry queries.
  - The command and UI modules own mode-safe informational help/status behavior and never invoke mutations.
  - The tools module owns strict TypeBox schemas, descriptions, prompt metadata, bounded display content, and serializable result details.
  - The general Git helper owns reusable argv-style current-repository inspection, branch/ref/ancestry and operation-state primitives, branch/upstream workflows, worktree parsing/path validation/create/remove verification, and process-local same-repository mutation serialization.
  - The integration module owns the clean-control preflight, fixed merge mutation, automatic conflict abort, outcome classification, and repository/ref/worktree/ancestry verification without absorbing that state machine into the general helper.
  - The retirement module owns exact request validation, direct-ref and expected-`HEAD` preflight, complete worktree occupancy checks, target ancestry, leased local-ref deletion, cancellation-safe verification, and bounded uncertain outcomes without absorbing that state machine into the general helper.
  - The GitHub helper owns repository resolution, token/autofill configuration, related-PR lookup, branch visibility and commit preflight, and pull request REST calls.
  - The redaction module owns shared credential redaction for display and prompt-bound metadata.
  - Shared public details remain JSON-serializable and contain no runtime objects or abort signals.
- Dependencies:
  - `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` are direct peer/development dependencies; Pi peers use `"*"` for host compatibility.
  - `@earendil-works/pi-ai` supplies `StringEnum` for the strict `create_worktree.branchMode` schema.
  - `@earendil-works/pi-tui` supplies panel width and key utilities.
  - Node 22 supplies `fetch`; BranchMe does not depend on Octokit or GitHub CLI.

## 6. Configuration, state, and filesystem boundary

- Config source: no separate BranchMe config file. `GITHUB_TOKEN`, `GH_TOKEN`, and `BRANCHME_PR_AUTOFILL` use process-environment values first and may fall back to supported keys in a hardened regular `.env` file at the verified Git root.
- Session state: no persisted BranchMe state. Tool calls return serializable details, and mutation/PR coordination is in-memory and process-local only; other Pi sessions and external Git processes are not locked.
- Active-checkout mutations: explicit branch switching, creation, pull, rebase, and integration operations can update Git metadata and working-tree files through Git. Explicit retirement can delete one exact local branch ref. Push and fetch operations can update remote or remote-tracking refs through Git.
- Linked-worktree mutations: `create_worktree` can create a checkout directory outside the active checkout after canonical destination and repository-boundary validation. `remove_worktree` can recursively remove only an exact verified linked-worktree directory after clean and ignored-entry preflights.
- BranchMe does not directly edit project files, stage content, create user-authored commits, accept commit messages, copy local-only files into new worktrees, delete the retained branch during removal, or mutate worktrees through slash commands. `integrate_branch` may cause Git to create a standard merge commit under the verified boundary below; `retire_branch` may delete one exact local branch ref only under the separate leased boundary below.

The standalone worktree-removal/retirement contracts below remain unchanged. `land_branch` is an explicit combined post-merge alternative: it authorizes deletion of ignored residue, uses the fetched remote-tracking target for leased retirement, reports each outcome, and syncs the local target last. See [README landing contract](../README.md#post-merge-cleanup-in-one-call) and [security boundary](../SECURITY.md#post-merge-landing-boundary).

## 7. Worktree handoff contract

- `list_worktrees` reads bounded NUL-delimited porcelain inventory and keeps worktree discovery out of automatic active-worktree context.
- `create_worktree` requires an explicitly approved absolute destination whose immediate parent exists. It rejects existing destinations and locations inside registered worktrees or the repository's common Git directory.
- New mode creates a local branch from current `HEAD` only. Existing mode accepts only an existing local branch not checked out in another worktree; no remote branch is inferred.
- Before mutation, canonical cwd and branch identity must fit documented limits and remain unchanged by redaction, escaping, Unicode handling, or truncation.
- Successful creation verifies canonical path, local branch, full `HEAD`, and clean state, then returns the exact canonical absolute cwd and local branch in `handoff: { cwd, branch, head, ready: true, summary }`.
- Removal accepts only an exact fresh inventory match that is linked, present, unlocked, non-prunable, non-bare, branch-attached, and neither main nor current.
- Staged, unstaged, untracked, unmerged, and ignored entries all block removal. The bounded ignored-entry preflight does not disclose ignored paths or contents.
- Successful force-free removal verifies that the worktree entry is absent and the retained local branch still points to its captured commit, then returns `handoff: { cwd: null, branch: <exact retained branch>, head, ready: false, summary }`.
- BranchMe never returns a ready handoff containing `[REDACTED]`, escaped control sequences, or a BranchMe-introduced truncation ellipsis in machine-readable cwd or branch identity fields.

## 8. Branch integration contract

- `integrate_branch` accepts exactly `sourceBranch` and `targetBranch`. They must identify distinct existing local refs in the current repository; remote-only refs, full refs, commit IDs, paths, repositories, remotes, and owner-prefixed refs are rejected.
- The active Pi worktree is the control worktree and must already have the target checked out, be clean, and have no merge/rebase/cherry-pick/revert/sequencer state. The source may be checked out in another dirty worktree because only its captured commit ref is read.
- Before mutation, BranchMe rejects a non-empty `branch.<targetBranch>.mergeOptions` setting so branch-specific defaults cannot change the policy. The fixed command is `git -c rerere.enabled=false merge --ff --no-edit --no-autostash --no-rerere-autoupdate --no-overwrite-ignore refs/heads/<sourceBranch>`. It does not fetch or push, disables autostash and rerere, protects ignored files, and preserves hooks, custom merge drivers, clean/smudge filters, and signing policy.
- Results distinguish `already_integrated`, `fast_forward`, `merge_commit`, and `conflict`. Before/after source and target commit IDs, repository/control-worktree identity, clean/operation state, and source/prior-target ancestry are verified. Merge-commit classification requires exact captured target/source parents.
- Conflict paths are exact bounded repository-relative identities. `conflict` is returned only after `git merge --abort` succeeds and exact ref, repository, branch, operation-state, and clean-worktree restoration is verified. Failed non-conflict merges remain errors.
- There is no reset-based rollback, `continue_merge`, `abort_merge`, custom merge message, strategy, squash, unrelated-history, signing, force, or commit control. Unexpected ref movement or inconclusive cleanup produces an uncertain error and manual inspection guidance.
- The mutation queue covers the complete operation but is process-local. BranchMe neither starts agents nor resolves semantic conflicts; Mission or another orchestrator may separately decide whether to delegate conflict analysis to an integration agent or ask the developer about intent.
- `branch_status` may receive `{ "ancestry": { "sourceBranch": string, "targetBranch": string } }` for an independent read-only proof. It must run after integration completes, not in the same parallel tool batch; automatic context remains unchanged.

## 9. Local branch-retirement contract

- `retire_branch` accepts exactly `{ "branchName": string, "expectedHead": string, "targetBranch": string, "force": boolean }`. `expectedHead` is a full 40- or 64-hex-character commit identity; both distinct branch names must resolve to direct local refs in the current repository.
- Callers obtain or supply a fresh exact retiring `HEAD` and verify captured ancestry against the exact local target. `branch_status.ancestry` and retirement run sequentially. Any main, current, linked, locked, prunable/missing, or otherwise registered worktree occupancy blocks retirement; linked-worktree removal is a separate operation that must complete first.
- Merged retirement uses the captured positive ancestry proof. Negative ancestry fails unless `force` is exactly `true` with explicit user authorization. Forced unmerged retirement can remove a commit's last local branch reference; object recovery is not guaranteed, and normal Git expiry and garbage collection can eventually make it unreachable.
- Deletion uses exactly `git update-ref --no-deref -d refs/heads/<branchName> <capturedRetiringHead>`. The expected-old-value lease protects a moved retiring ref. `git branch -d/-D` is not used because it lacks the required lease and does not enforce this contract's explicit target.
- Retirement deletes no remote or remote-tracking ref, performs no bulk or inferred-target deletion, removes no worktree automatically, and creates/resets no branch as rollback. Local `branch.<branchName>.*` configuration remains untouched and may affect a later same-name branch.
- One process-local queue window keyed by the canonical active worktree root covers preflight, immediate reinspection, deletion, and final verification. It does not lock another active worktree, Pi process, or external Git process. After deletion is attempted, bounded inspection without the caller's cancelled signal verifies repository identity, target stability, local-ref absence, and zero occupancy. Contradictory or inconclusive state produces an uncertain error requiring manual inspection because retirement may have completed.
- Repository-configured `reference-transaction` hooks may execute arbitrary commands or contact networks during `git update-ref`; they are separate from BranchMe's direct local-only, no-network/no-remote-delete argv guarantee.

## 10. Security and privacy

- Every Git command uses `pi.exec("git", args, { cwd, signal, timeout })` with an argv array rather than shell interpolation.
- Paths, branch names, Git output, commit subjects, and pull request metadata are treated as untrusted. Display and prompt surfaces are escaped, redacted, and bounded separately from prevalidated exact handoff identities.
- Worktree paths are canonicalized and checked against a fresh current-repository inventory or the common Git directory before mutation. User-supplied removal paths are never passed directly to Git.
- Worktree removal has no force path and rejects dirty, ignored-entry-containing, detached, locked, prunable/missing, bare, main, current, and foreign entries before mutation.
- Worktree tools expose no force, move, prune, repair, lock, unlock, detached, orphan, remote-inference, arbitrary refspec, or arbitrary start-point controls. Git's incomplete submodule worktree support is not bypassed with force cleanup.
- Retirement requires exact direct local refs, full expected-`HEAD` leasing, complete worktree occupancy inspection, captured target ancestry, and explicit unmerged force authorization. Final verification is cancellation-safe and bounded; uncertain state requires manual inspection and no rollback mutation.
- Automatic context and `branch_status` never collect diffs or file contents. Related-PR lookup may make a bounded authenticated GitHub request only when credentials and repository identity resolve; there is no unauthenticated fallback.
- `pull_request` uses the resolved current GitHub repository, preflights local and GitHub branch identity, and rejects cross-repository head refs. Git fetch/pull/push use the user's normal Git credentials.
- BranchMe's direct integration and retirement commands are local-only, but repository-configured hooks—including `reference-transaction` hooks during retirement—merge drivers, filters, and signing policy may execute arbitrary commands or network operations under the user's identity outside BranchMe's argv guarantees.
- Tokens are resolved from supported process or verified-root `.env` keys and redacted from prompts, errors, content, and details. BranchMe collects no telemetry.
- Creation and removal require explicit user intent and an exact approved path. BranchMe does not silently infer worktree destinations or start a separate agent session.

## 11. Documentation and packaging

- `README.md` is the primary public workflow and tool reference.
- `SECURITY.md` documents local filesystem, Git, GitHub, credential, and prompt-insertion boundaries.
- `docs/STRUCTURE.md` describes the implemented source and test layout.
- `docs/SMOKE_TEST.md` records isolated checkout, handoff, and installed-package smoke behavior.
- `CHANGELOG.md` tracks the active `0.2.0` unreleased changes.
- npm distribution uses package `@senad-d/branchme`; package-content checks exclude private specs, credentials, generated files, caches, and local state.

## 12. Validation plan

- Typecheck: `npm run typecheck`
- Formatting and documentation checks: `npm run format:check`
- Unit and isolated real-Git integration tests: `npm run test`
- Checkout Pi runtime/context smoke: `npm run smoke:pi`
- Isolated specialized-agent handoff smoke: `npm run smoke:worktree-handoff`
- Package dry-run/content boundary: `npm run check:pack`
- Complete checkout validation: `npm run validate`
- Installed-artifact smoke: `npm run smoke:pi:packed`
- Canonical local and automated release gate: `npm run release:check`

## 13. Current decisions

- Slash commands remain informational; tools perform all Git and GitHub actions.
- Automatic context remains focused on the active worktree; inventory is available only through `list_worktrees`.
- `create_worktree` returns a verified target for a caller-managed session but does not change cwd or create processes.
- `integrate_branch` is the only merge surface; it uses normal local merge semantics, automatically aborts initial conflicts, and exposes no merge continuation or semantic-resolution workflow.
- Worktree removal remains force-free, blocks ignored entries, and preserves the local branch.
- Local branch retirement remains a separate explicit operation requiring a fresh expected `HEAD`, exact target ancestry, zero complete-inventory occupancy, and an explicit boolean force decision; it deletes only the leased local ref and leaves branch configuration and remote/remote-tracking refs untouched.
- `push_branch` uses `origin` only when the current branch has no configured upstream.
- `pull_request` infers owner/repository from the current checkout or matching `GITHUB_REPOSITORY`, never accepts owner/repository tool inputs, and requires local branch refs with the head matching GitHub.
- Pull request fields remain explicit unless `BRANCHME_PR_AUTOFILL=true`; explicit values always take precedence.
- `pull_request` is available to autonomous and delegated workflows without separate end-user confirmation. PR creation may be directed by user, system, or developer prompts, `AGENTS.md`, skills, automation, or delegated/subagent prompts.
