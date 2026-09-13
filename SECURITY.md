# Security Policy

## Trust model

Pi packages and extensions run with the full local permissions of the user account that starts Pi. Review BranchMe source before installing it, pin versions in sensitive environments, and install only from trusted sources.

```bash
pi install npm:@senad-d/branchme@<version>
pi install git:https://github.com/senad-d/branchme@<tag>
```

## Git behavior

BranchMe runs local `git` commands through Pi's extension API with argv-style arguments. `init_repository` first canonicalizes its non-repository target directory; other repository mutations resolve the Git root and run from that verified root.

Implemented git mutations are limited to:

- `init_repository`: `git init --no-template --initial-branch <initialBranch>` in pi's exact canonical current directory after rejecting filesystem root, an existing `.git` entry, reinitialization, and nesting inside another repository. It verifies an in-place non-bare `.git` directory, the requested unborn branch, and absence of a commit.
- `change_branch`: `git switch <branchName>` after branch-name validation, local `refs/heads/<branchName>` verification, and clean-worktree preflight.
- `create_branch`: `git switch -c <branchName>` from current `HEAD` after branch-name validation and existing-branch checks.
- `track_branch`: narrow fetch followed by `git switch --no-overwrite-ignore --track=direct -c <branchName> refs/remotes/<remote>/<remoteBranch>`. Requires a new local branch, clean idle checkout, direct fetched commit ref, and verified final HEAD/upstream.
- `update_from_base`: narrow fetch followed by the fixed integration merge policy against a captured remote-base commit. Reuses verified outcomes and automatic conflict abort; does not rewrite published history or change upstream. Both new fetch workflows explicitly disable pruning, extra ref mappings, tags, and submodule recursion, and reject symbolic remote-tracking destinations before fetching so Git cannot dereference them into unrelated refs. Base updates compare stored upstream configuration, not whether cached upstream refs happen to resolve.
- `fetch_branch`: `git fetch --no-tags --no-recurse-submodules <remote> <remoteBranchRef>:<remoteTrackingRef>`. With no arguments it validates and fetches the current branch's configured upstream; with explicit `branch` and optional configured `remote` (default `origin`) it fetches that exact remote branch. The explicit destination is limited to the selected remote-tracking ref, so local branches and working-tree files are not changed.
- `pull_branch`: `git pull --ff-only --no-rebase --no-autostash <upstreamRemote> <upstreamBranchRef>` for the clean current branch after validating its configured upstream target.
- `rebase_branch`: `git rebase --no-autostash --no-update-refs <upstream>` for the clean current branch after validating its configured upstream target. It rewrites local commits and automatically attempts `git rebase --abort` without the cancelled caller signal if the rebase fails or is killed.
- `integrate_branch`: after rejecting a non-empty `branch.<targetBranch>.mergeOptions` setting, runs `git -c rerere.enabled=false merge --ff --no-edit --no-autostash --no-rerere-autoupdate --no-overwrite-ignore refs/heads/<sourceBranch>` from the verified clean control worktree, which must already have the distinct existing local `targetBranch` checked out. It uses normal merge semantics: no-op, fast-forward, or a Git-generated standard two-parent merge commit for divergent histories.
- `push_branch`: `git push <upstreamRemote> HEAD:<upstreamBranchRef>` for the current branch when an upstream exists, or `git push --set-upstream origin <currentBranch>` when no upstream exists.
- `create_worktree`: `git worktree add -b <branchName> <canonicalPath> <capturedCommit>` for a new local branch from current HEAD or optional read-only `baseRef`, or `git worktree add <canonicalPath> <existingLocalBranch>` for an existing unoccupied local branch, after destination and repository-boundary validation.
- `remove_worktree`: `git worktree remove <verifiedCanonicalPath>` without force, only after fresh repository-membership, safety-state, path, tracked/untracked status, and ignored-entry checks. The local branch is retained and verified at the same commit.
- `land_branch`: explicit post-host-merge targeted fetch, linked-worktree removal including ignored residue, leased source-local-ref deletion against the fetched remote target, and independent final target sync. Every Git command uses an explicit `-C` directory; unoccupied targets use a non-forced fetch refspec, clean occupied targets use an explicit ff-only pull, and dirty targets are left untouched. No remote mutation, prune, stash, reset, or branch switching is attempted.
- `retire_branch`: `git update-ref --no-deref -d refs/heads/<branchName> <capturedRetiringHead>` only for one exact unoccupied direct local ref whose commit matches the required full `expectedHead`. The exact local target commit and ancestry are captured first; unmerged retirement requires explicit `force: true` authorization.

Before each agent run, BranchMe also runs bounded, read-only Git commands to collect branch/upstream/ahead-behind state, working-tree counts, up to 20 unstaged or untracked path entries, and up to 5 recent commits. The same collector runs when `branch_status` explicitly refreshes context. An explicit optional `branch_status.ancestry` query captures exact local or remote-tracking source/target commit IDs and uses `git merge-base --is-ancestor` against those commits; automatic Git context never runs this query and remains unchanged. Collection does not run `fetch`, `switch`, `pull`, `rebase`, `merge`, `push`, `add`, `commit`, or any other mutation, and it never reads diffs or file contents.

Repository initialization creates `.git` metadata in the current directory. Branch switching, worktree creation/removal, fast-forward pulls, successful rebases, and branch integration can update or remove filesystem content as normal Git behavior; fetch updates one validated remote-tracking ref without changing local branches or the working tree, and retirement deletes one verified local branch ref. Mutating operations for the same repository are serialized to avoid same-turn races; initialization uses Pi's file-mutation queue for the new `.git` entry and is serialized by its canonical target directory. `integrate_branch` holds one queue window across preflight, merge, cleanup, and final verification; `retire_branch` holds one active-worktree-keyed window across preflight, immediate reinspection, leased deletion, and postcondition verification; `pull_request` uses the queue around PR preflight and creation. This in-memory queue is process-local: it coordinates BranchMe calls using the same active checkout but does not lock a different active worktree, another Pi process, or an external Git process. Integration refs are captured and re-verified. Retirement additionally uses an expected-old-value ref lease and rechecks its captured target and complete worktree occupancy. Unexpected or inconclusive movement produces a bounded uncertain error with manual inspection guidance and no reset-based rollback.

BranchMe rejects a dirty control worktree before `change_branch`, `pull_branch`, `rebase_branch`, and `integrate_branch`, and rejects any staged, unstaged, untracked, or unmerged entry in a linked worktree before standalone `remove_worktree`. Standalone removal protects ignored residue by default and deletes it only with explicit `deleteIgnored: true` authorization. `land_branch` also allows ignored residue to be deleted, but still refuses tracked/staged or non-ignored untracked changes. Retirement does not require an unrelated active worktree to be clean, but every registered worktree record is inspected and any occupancy of the retiring branch blocks deletion. Integration also rejects an existing merge, rebase, cherry-pick, revert, or sequencer state and any non-empty target-branch `mergeOptions` setting that could alter the fixed command policy. After merge or retirement mutation begins, cleanup/postcondition inspection ignores caller cancellation and uses bounded timeouts. A `conflict` result is returned only after exact repository-relative conflict paths are captured, `git merge --abort` succeeds, source and target refs are restored, repository/control-worktree identity is preserved, operation state is cleared, and the control worktree is clean. Failed non-conflict merges remain errors; inconclusive cleanup or verification is never reported as success. After retirement is attempted, contradictory or inconclusive repository, target-ref, retiring-ref, or occupancy state is an uncertain error stating that retirement may have completed and requiring manual inspection before retry.

BranchMe does not force checkout/removal, stash, stage files, create user-authored commits, accept commit messages, reset, force-push, or edit project files directly. Rebase-driven rewriting occurs only through explicit `rebase_branch`. Explicit `integrate_branch` or `update_from_base` may let Git create a standard merge commit for divergent histories, but BranchMe exposes no strategy, squash, unrelated-history, signing, force, commit, `continue_merge`, or `abort_merge` control. Explicit `retire_branch` and merged-only `land_branch` are the local branch-deletion surfaces. Standalone retirement has no bulk, pattern, inferred-target, remote-delete, remote-tracking-delete, automatic worktree-removal, or rollback-ref control.

## Network behavior

`track_branch`, `update_from_base`, `fetch_branch`, `pull_branch`, `land_branch`, and `push_branch` contact the configured Git remote through the user's normal Git transport and credentials. They do not use or inject `GITHUB_TOKEN` or `GH_TOKEN`. `rebase_branch`, `integrate_branch`, and `retire_branch` use locally available refs; BranchMe's direct retirement argv never fetches, pulls, pushes, or names a remote or remote-tracking ref for deletion.

Git extension points are a separate trust boundary. `integrate_branch` preserves repository-configured hooks, custom merge drivers, clean/smudge filters, and signature policy; it does not pass `--no-verify`. Retirement's `git update-ref` can invoke repository-configured `reference-transaction` hooks. Those configurations may execute arbitrary local commands, mutate other state, or contact networks under the user's identity. BranchMe's fixed argv, direct no-network contract, and direct no-remote-delete guarantees cannot constrain hook behavior.

BranchMe's GitHub helpers use these REST API requests:

```text
GET  https://api.github.com/repos/{owner}/{repo}/pulls?state=open&head={owner}:{currentBranch}&per_page=1
GET  https://api.github.com/repos/{owner}/{repo}/branches/{headBranch}
GET  https://api.github.com/repos/{owner}/{repo}/branches/{baseBranch}
POST https://api.github.com/repos/{owner}/{repo}/pulls
GET  https://api.github.com/repos/{owner}/{repo}/pulls/{number}
GET  https://api.github.com/repos/{owner}/{repo}/pulls?state={open|all}&head={owner}:{branch}&sort=updated&direction=desc&per_page={1|2}
```

Explicit `pull_request_status`, idempotent `pull_request` lookup, and PR-aware `land_branch` use the last two read-only endpoints. Each request has a 10-second transport/body deadline and 64 KiB response limit. Exact PR number, repository, branch identities, and commit IDs are validated. Status does not certify CI checks or review approvals. Idempotent creation preserves existing PR fields and reuses only an exact head-SHA/base match; HTTP 422 races get one read-only recheck. All of these operations require `GITHUB_TOKEN` or `GH_TOKEN` from the process environment or verified-root `.env` fallback.

`list_branches` is an explicit read-only local inventory, limited to 200 returned refs, 128 KiB raw ref output, and 4,000 characters of text. Paths and names are display-safe metadata, not executable handoffs. Upstream counts reflect cached refs, not a fresh remote fetch.

The first request is an automatic network boundary: it can run before each agent run and whenever `branch_status` explicitly refreshes context. It is a bounded, read-only lookup for one open pull request whose head is the current local branch (`per_page=1`), with a default 4-second timeout and a 64 KiB response-body limit. It is skipped when repository/branch resolution or authentication is unavailable, so BranchMe never makes an unauthenticated fallback request. Timeout, HTTP, network, malformed, and oversized-response failures become a safe unavailable state without exposing response bodies or raw network errors. Git alone is not used or claimed to provide PR metadata.

The branch preflight requests have no body. BranchMe uses the resolved `headBranch` preflight response to compare GitHub's branch commit with the local branch commit before creating the PR. The PR request body contains only the resolved title, head branch, base branch, body, and draft flag. By default every field must be supplied explicitly. When `BRANCHME_PR_AUTOFILL=true`, omitted fields may be derived from local branch names and bounded commit subjects before being sent to GitHub. Generated body bullets escape Markdown punctuation so commit subjects remain text rather than active mentions or formatting. All GitHub response reads are bounded.

## Repository boundary

`init_repository` operates only on pi's exact current directory before a repository exists. Every other BranchMe operation targets the current repository.

- `init_repository` accepts only optional `initialBranch` (default `main`), never a path. It rejects existing and nested repositories and exposes no bare, separate-Git-dir, template, shared, remote, commit, README, `.gitignore`, or configuration controls. Ambient Git repository/object/index path and discovery overrides are refused before execution and rechecked inside the mutation queue. Ancestor `.git` entries block initialization even when Git discovery fails; only an explicit Git non-repository diagnostic permits initialization. Unrecognized or localized discovery failures fail closed. Failed postcondition verification reports partial-state inspection guidance and performs no cleanup.
- The GitHub repository is inferred from local `origin` and/or `GITHUB_REPOSITORY`.
- Except for `land_branch`'s optional absolute cleanup path, repository initialization, branch, and PR tools never accept filesystem paths. They reject `owner`, `repo`, and owner-prefixed `owner:branch` PR refs. Worktree mutations accept only an explicitly approved absolute `worktreePath`, with `branchName` and `branchMode` additionally required for creation.
- `list_worktrees` is read-only and returns a bounded inventory collected from `git worktree list --porcelain -z`; automatic Git context remains focused on the active worktree.
- `create_worktree` requires `worktreePath`, `branchName`, and `branchMode` (`new` or `existing`), with optional read-only `baseRef` in new mode. New mode uses current `HEAD` or an exact local/remote-tracking ref or full commit; existing mode requires an existing local branch not checked out elsewhere and does not infer remote branches.
- `remove_worktree` requires `worktreePath`, accepts optional boolean `deleteIgnored`, requires an exact canonical match in a fresh current-repository inventory, removes no branch, and does not accept force.
- `retire_branch` accepts exactly `branchName`, a full 40- or 64-hex-character `expectedHead`, a distinct exact local `targetBranch`, and boolean `force`. Both names must resolve to direct local refs. Paths, repositories, remotes, remote-only or full refs, refspecs, patterns, arrays, inferred targets, worktree controls, and bulk deletion are rejected.
- `change_branch` accepts only `branchName` and never creates branches, checks out remote branches, forces, stashes, or discards changes.
- `fetch_branch` accepts optional `branch` and `remote` (remote requires branch), otherwise resolves the current branch's configured upstream. It constructs the source-to-remote-tracking refspec internally and disables tag fetching and submodule recursion; no arbitrary refspec or prune controls are exposed.
- `pull_branch` accepts no parameters, updates only the clean current branch from its configured upstream, and uses fast-forward-only semantics.
- `rebase_branch` accepts no parameters, rebases only the clean current branch onto its configured upstream, disables autostash and multi-ref updates, never pushes, and attempts to abort on failure.
- `integrate_branch` accepts exactly `sourceBranch` and `targetBranch`. Both must be distinct existing local refs in the current repository, and the active clean control worktree must already be on the target. Remote-only refs, full refs, commit IDs, paths, repository/remotes, owner-prefixed refs, and merge controls are rejected. A source branch may be checked out in another dirty linked worktree because only its captured committed ref is read.
- Targeted `branch_status.ancestry` accepts a nested object containing two exact local branch or remote-tracking names; it is read-only, must run after integration completes, and must not share the same parallel tool batch.
- If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, PR creation and related-PR lookup fail closed.
- Resolved PR branches are validated as distinct, existing local branch-name refs; identical or missing local branches and cross-repository `head` values are rejected before any GitHub request.
- PR branch inputs must also be visible on GitHub before the PR is created, and `headBranch` must match the local branch commit; unpublished or stale `headBranch` values fail with guidance to run `push_branch`, wait for it to complete, and retry `pull_request`.

## Worktree filesystem boundary

Linked worktree management expands the mutation boundary beyond the active checkout. `create_worktree` may create a directory anywhere the user can write when the explicitly supplied destination passes all checks. BranchMe requires a non-blank absolute path without control characters, requires the immediate parent to exist as a directory, resolves that parent with `realpath`, and rejects any existing destination—including a symlink. It also rejects a destination inside any registered worktree or inside the current repository's common Git directory. Before mutation, the resulting canonical path and local branch must remain exactly identical as JavaScript strings after BranchMe's redaction, control/format escaping, Unicode-safe truncation, and size checks; the path limit is 4,096 characters and the branch limit is 512 characters.

`remove_worktree` never passes an unverified user path to Git. It canonicalizes the supplied absolute path, requires an exact match in a fresh inventory belonging to the current repository, applies the same lossless checks to the canonical path and retained branch, and rejects the main worktree, the worktree containing the active Pi session, bare, detached, locked, prunable/missing, and dirty worktrees. A separate bounded porcelain scan detects ignored files and directories. They block removal by default without path disclosure; explicit `deleteIgnored: true` authorizes deleting all of them with the worktree and reports only redacted top-level paths, never contents. After force-free removal, BranchMe verifies the worktree is no longer registered and that its local branch remains at the captured `HEAD`.

Paths, branch names, lock/prune reasons, and Git output are untrusted metadata. Informational inventory, prose, summaries, and non-identity details are escaped, redacted, and bounded. Successful machine-readable `handoff.cwd` and handoff branch fields instead contain exact verified identities, so BranchMe rejects any identity that would require display transformation before mutation. This also applies to the retained branch returned after removal. Creation failures do not trigger automatic deletion of a possibly created directory or branch; the caller is told to inspect the repository and destination. No force, move, prune, repair, lock, unlock, detached, orphan, or remote-inference worktree operation is implemented.

BranchMe does not copy ignored or untracked files, including repository-root `.env` files, into linked worktrees. If a caller creates ignored local files in a linked checkout, those files block standalone `remove_worktree` until they are removed, preserved outside the checkout, or explicitly authorized for deletion with `deleteIgnored: true`. An explicit `land_branch` call also authorizes deletion of ignored residue with that worktree. Git documents support for multiple worktrees of a superproject containing submodules as incomplete; BranchMe does not add force-based submodule cleanup.

## Post-merge landing boundary

`land_branch` is execution-only and accepts required exact local `sourceBranch`/`targetBranch`, optional configured `remote` (default `origin`), optional absolute `worktreePath`, and optional positive `pullRequestNumber`. It resolves the primary checkout from the caller's repository and holds its process-local mutation queue for the entire operation. This is not an external-process or cross-worktree lock. Both the actual process cwd and tool-context cwd are checked against the canonical removal path; if either is inside it, landing refuses before fetching and says to run from the repository root.

The remote-tracking fetch destination is checked for symbolic indirection before fetching. The captured source tip must be an ancestor of the freshly fetched remote-tracking target before any deletion, unless explicit `pullRequestNumber` evidence proves an exact merged GitHub PR. PR evidence requires matching resolved repository and landing remote, closed/merged state, exact source branch/SHA and target branch, and containment of the reported merge commit in the fetched target. The receipt preserves actual graph ancestry (which can remain false) separately from `mergeProof: "pull-request"`. This proof authorizes internal non-ancestor local retirement using the existing expected-HEAD lease; no public force option is added. Original pre-squash/rebase commits may eventually become unreachable. The primary checkout is never removed. The selected linked checkout must be on the source or target branch, clean of tracked/staged/non-ignored untracked changes, unlocked, attached, and part of the same repository. Its HEAD must also be contained in the captured target, or be the exact proven merged PR head on the source branch. A checkout parked on the target still requires graph ancestry. Ignored files and directories, including `.env` and `.pi/`, are intentionally deleted by force-free `git worktree remove`; preserve needed files first. The receipt lists redacted top-level ignored paths, never file contents. The source branch is then retired with the same atomic expected-old-value lease and full occupancy checks as standalone retirement, but ancestry is against the fetched remote-tracking ref. No remote or remote-tracking ref is deleted.

Target sync always follows attempted cleanup, including cleanup refusals, unless initial cwd/fetch/ancestry checks refuse the whole operation. No branch switching, stash, reset, force update, or prune occurs. Explicit fetch mappings and prune-disabling flags/config prevent Git's configured extra fetch mappings and pruning from expanding the landing scope. Actual local target refs are read before/after sync; errors, dirty skips, and unattempted steps are reported, not described as successful fast-forwards. After possible sync mutation, final ref verification ignores cancellation. Missing branches/worktrees are idempotent; a leftover missing-worktree registration is not pruned and can still block retirement. Repository hooks and external concurrent mutations remain within the existing trust/uncertainty boundary.

## Local branch-retirement boundary

`retire_branch` requires explicit intent to delete one exact local branch and exactly four fields: `branchName`, full commit identity `expectedHead`, distinct exact local `targetBranch`, and boolean `force`. Callers should obtain a fresh expected commit and captured target ancestry with `branch_status.ancestry` unless the exact commit is already supplied. The read-only proof and mutation run sequentially, and retirement runs by itself rather than beside another Git mutation.

Preflight resolves the canonical active worktree and common Git directory, requires both branch names to be existing direct `refs/heads/*` refs, and requires the retiring ref to match `expectedHead` case-insensitively. It captures both commit IDs, inspects the complete bounded NUL-delimited worktree inventory rather than the public display subset, and rejects the retiring branch if any registered record names it. Main, current, linked, locked, prunable, missing, and other registered occupancy all block retirement. Removing an occupying linked worktree is a separate explicit operation with its own safety contract; retirement never removes one automatically.

BranchMe checks `git merge-base --is-ancestor <retiringHead> <targetHead>` against the captured immutable commits. Negative ancestry is rejected unless `force` is exactly `true`, and force bypasses no identity, expected-`HEAD`, direct-ref, or occupancy check. Forced unmerged retirement can remove the commit's last local branch reference. Reflog-based or object recovery is not guaranteed, and normal Git expiry and garbage collection can eventually make the commit unreachable.

Deletion uses only:

```text
git update-ref --no-deref -d refs/heads/<branchName> <capturedRetiringHead>
```

The expected-old-value argument is an atomic lease on the retiring ref, so movement after preflight prevents deletion. BranchMe does not use `git branch -d` or `git branch -D`: neither supplies the required expected-`HEAD` lease, and their default merge target is not the explicit captured target required by this contract. The operation does not directly delete remote refs or local `refs/remotes/*` refs and has no bulk, wildcard, inferred-target, fetch, pull, push, prune, automatic worktree-removal, or arbitrary ref-update path.

One process-local queue window, keyed by the canonical active worktree root, covers preflight, immediate repository/ref/occupancy reinspection, deletion, and verification. This serializes BranchMe mutations invoked through that same active checkout only. It cannot lock a different active worktree, another Pi process, or an external Git process. The expected-old-value lease protects the retiring ref; target and worktree reinspection detect other observable concurrent movement. Once deletion is attempted, bounded final inspection continues without the caller's abort signal and verifies repository identity, target stability, retiring-ref absence, and zero occupancy. If those facts are contradictory or inconclusive, BranchMe throws a bounded uncertain error that says retirement may have completed and requires manual inspection before retrying. It never recreates, resets, switches, merges, or force-updates a branch as automatic rollback.

Only the local branch ref is deleted. Local `branch.<branchName>.*` configuration remains untouched because removing it would be a separate non-atomic mutation; those settings may affect a later branch recreated with the same name. Repository-configured `reference-transaction` hooks may run during `git update-ref` and remain part of the repository trust boundary. They can violate BranchMe's direct no-network/no-remote-delete expectations through arbitrary hook behavior, so sensitive repositories must review hook configuration separately.

## Credentials

Git fetch, pull, and push authentication is handled by the user's configured Git credential and transport setup. BranchMe never passes GitHub API tokens to Git commands.

Automatic related-PR lookup, `pull_request_status`, PR-aware `land_branch`, and `pull_request` check `process.env.GITHUB_TOKEN`, then `process.env.GH_TOKEN`. If neither process token is set, BranchMe reads a local `.env` file from the verified git root and checks:

- `GITHUB_TOKEN` (preferred)
- `GH_TOKEN` (fallback)

BranchMe also reads the non-secret `BRANCHME_PR_AUTOFILL` setting from the process environment or verified-root `.env`; all other `.env` keys are ignored. The `.env` reader uses async file I/O, requires a small regular file, and rejects directories, symlinks, special files, and oversized files. BranchMe does not read shell profiles, GitHub CLI credentials, or local credential stores. Token values are redacted from thrown errors, automatic context, generated PR text, tool content, and tool details.

A newly created linked worktree does not receive the source checkout's `.env` or other ignored/untracked files. Start the separate agent with required credentials in its process environment rather than copying secrets into the linked checkout.

## System prompt boundary

Automatic context is appended to Pi's system prompt before each agent run. Branch names, paths, Git status values, commit subjects, and GitHub PR metadata are repository-controlled, untrusted data and must never be interpreted as instructions. BranchMe redacts recognized token values, escapes control and format characters, quotes metadata, limits individual values to 512 characters by default, and limits the complete rendered snapshot to 4,000 characters. It further shortens values or omits entries when needed to enforce the total bound.

The automatic snapshot can become stale after a Git or filesystem mutation during the same run. `branch_status` is the explicit, read-only refresh path. Neither automatic collection nor `branch_status` captures diff hunks or file contents; staged paths are not listed, although the staged file count is included. Optional targeted ancestry details appear only when explicitly requested and are never added to automatic context.

## Telemetry

BranchMe does not collect telemetry. Related-PR lookup and explicit PR lifecycle reads send only the resolved repository owner/name plus the current/requested branch or PR number in authenticated GitHub API URLs. PR-aware landing additionally reads the supplied PR number to verify host-merge evidence. PR creation sends only the resolved GitHub pull request fields described above. When autofill supplies title or body, those fields can contain bounded, redacted local commit subjects. BranchMe does not send diff contents, filenames, or local file contents to GitHub during context collection or PR lifecycle verification.

## Reporting vulnerabilities

Please report suspected security vulnerabilities privately by email: <senad.dizdarevic@proton.me>.

For non-sensitive issues, use the repository issue tracker:

<https://github.com/senad-d/branchme/issues>

Do not open public issues for security-sensitive reports that include exploit details, private repository contents, secrets, or credentials.

## Secure development checklist

- Do not commit secrets, tokens, local `.env`, local `.pi/` state, or generated artifacts.
- Keep tool schemas strict and reject unsupported fields.
- Keep all git calls argv-style through `pi.exec("git", args)`.
- Preserve the fixed `integrate_branch` merge policy, verified automatic abort/restoration contract, and process-local queue caveat; never add reset-based rollback or merge-continuation controls.
- Preserve `retire_branch` expected-`HEAD` leasing, complete occupancy checks, exact target ancestry, explicit unmerged force authorization, local-only ref scope, cancellation-safe final inspection, and uncertain-error behavior; never add bulk, inferred, remote, remote-tracking, or automatic worktree deletion.
- Treat `reference-transaction` hooks as arbitrary repository-controlled code outside BranchMe's direct retirement argv guarantees.
- Treat worktree paths as a filesystem security boundary; canonicalize them, verify current-repository membership before removal, and never add force cleanup.
- Mock `pi.exec` and `fetch` in unit tests; use only temporary local repositories and directories for real-Git integration tests, and do not touch real remotes.
- Keep package contents minimal with `npm run check:pack`.
- Use isolated smoke tests with `pi --no-extensions -e .`.
