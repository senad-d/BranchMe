# Git workflows without Bash

Ordinary commits happen only through explicit `commit_changes` calls. No other tool creates ordinary commits, generates commit messages, or hands work to `commit_changes` automatically. Editing code and running tests still require separate development tools.

## Inspection

- `git_status` enumerates index/worktree/untracked/conflict states. Follow `next` as `after` with identical filters and worktree selection until `complete`. It supplies `head` and a logical `index` fingerprint for guarded operations. Explicit path filters also supply bounded content fingerprints.
- `git_log` accepts `ref` (default HEAD), optional `excludeRef`, literal `paths`, `after`, and `worktreePath`. Pages contain up to 25 commits. Continuation pins captured commits even when a branch moves; repeat the original query fields. Shallow repositories explicitly report that only available local history is covered. Missing objects fail rather than triggering a lazy fetch.
- `git_show` accepts `ref`, `output` (`summary`, `patch`, `file`), optional literal `path`, 1-based `parent`, and `worktreePath`. File output requires a path. Merge comparisons require an explicit parent. Root comparisons use the empty tree. Historical blobs are read without checkout or text conversion; directories/gitlinks are not file previews. Display patches are not apply-ready.
- `git_conflicts` lists unmerged paths or inspects one `path`, optionally one `stage` (1=base, 2=ours, 3=theirs). Missing stages are normal for add/delete conflicts. Pass `expectedIndex` to reject changed conflicts. Ours/theirs are operation-dependent index-stage labels, especially during rebase. This tool never resolves or stages a conflict.

Read-only Git commands disable optional locks, lazy object fetching, pagers, and fsmonitor. Raw responses are capped at 4 MiB. Text previews are sanitized before limiting to 32 KiB / 1,000 lines; individual conflict previews are limited to 6 KiB / 200 lines. Blobs above 4 MiB are summarized without content. Binary/non-UTF-8 blobs are summarized. History metadata supports at most 16 parents per commit. Redaction is best effort, not a secret scanner: requested repository content may still be sensitive and reaches the model. Automatic context remains metadata-only and unchanged.

## Worktree coordination

`create_branch`, `change_branch`, `track_branch`, `fetch_branch`, `pull_branch`, `rebase_branch`, `push_branch`, `update_from_base`, and `pull_request` accept optional `worktreePath`. The selector must resolve to a live root of the same repository; it never changes Pi's cwd or launches another session. PR status/feedback lookup also accepts it for branch inference, but rejects it alongside an exact PR number. Initialization still targets the exact current directory.

Mutating tool calls share a process-wide outer coordinator, then retain their existing root/common-directory queues in that order. This serializes BranchMe tool mutations across linked worktrees, including configuration/ref changes. Reads remain independent. Direct helper callers retain their helper-level queues; neither mechanism locks other processes/extensions or external filesystem writers. Detected interference and ambiguous outcomes require inspection, not an invented success or automatic destructive rollback.

## Branch bases and tracking

```text
create_branch({ branchName: "feature/example", baseRef: "origin/main" })
rebase_branch({ baseRef: "origin/main" })
```

Both bases resolve an exact local branch, cached remote-tracking branch, or full commit before mutation. Fetch separately if freshness is needed. Neither changes upstream configuration. Omitting the base preserves the existing behavior: creation starts at current HEAD, and rebase uses configured upstream. Explicit-base creation requires tracked-clean, idle state and protects ignored collisions. Explicit-base rebase requires a clean idle checkout and refuses ignored local-only files because Git rebase has no ignored-overwrite protection flag. It disables autostash, multi-ref updates, autosquash, and rebase-merges, and verifies restoration after conflicts/failure. Prefer `update_from_base` for published features: force-pushing rewritten history remains unsupported.

`list_remotes` returns configured/effective fetch and push destination previews, unsupported/multiple-destination flags, and a configuration fingerprint. It returns at most 25 remotes, two configured URLs per direction, and bounded effective URL previews; omissions are explicit. More than 100 configured remotes or oversized configuration fails closed.

`add_remote({ name, url, expectedConfig })` requires an unused, non-overlapping name, a credential-free HTTPS/SSH destination, and the current fingerprint from `list_remotes`. It creates normal branch fetch mappings but performs no fetch. Existing names and URL rewriting configurations are refused; URL replacement/removal and arbitrary Git config writes are not exposed.

`set_upstream({ branchName, upstream, expectedConfig })` requires one exact local branch and an existing configured remote-tracking branch. Use `unset: true` instead of `upstream` to remove tracking. Only that branch's remote/merge keys change; inherited, included, ambiguous, or worktree-specific tracking settings are refused. No checkout, fetch, or push occurs. Config writes require a regular repository config file and are verified; no global/system configuration is changed.

## Stage and unstage, without committing

First inspect `git_status`. Supply its `head` as `expectedHead` (null before the first commit), its `index` as `expectedIndex`, and exact approved files:

```text
stage_changes({ paths: ["src/example.ts"], expectedHead: "<captured HEAD>", expectedIndex: "<index fingerprint>" })
unstage_changes({ paths: ["src/example.ts"], expectedHead: "<captured HEAD>", expectedIndex: "<index fingerprint>" })
```

Staging handles selected additions/modifications/deletions. Unstaging restores only selected index entries to captured HEAD, or removes selected staged additions from an unborn index. Working-file bytes and unrelated staged entries are verified unchanged. Partial staging is preserved by unstage. Both sides of a selected rename require explicit approval.

Initial guarded index/restore operations reject active Git operations, conflicts, directories, ignored additions, forced add, sparse/split/intent-to-add/assume-unchanged/skip-worktree indexes, gitlinks, and relevant Git path environment overrides. Selected working files need safe fingerprints (regular files up to 8 MiB or symlinks). Selected paths are limited to 512 characters each and 8 KiB combined; split larger batches. No all-files, interactive/hunk, glob, or directory-expansion mode exists. Git clean filters may run during staging. These operations never commit.

## Restore selected working files

Restoration intentionally discards local edits. Obtain a preview before authorizing it:

```text
restore_paths({ paths: ["src/example.ts"], expectedHead: "<HEAD>", expectedIndex: "<index>", preview: true })
```

The preview identifies replaced/deleted paths and returns `expectedFiles`. Apply with the same path/index/HEAD expectations, copied `expectedFiles`, and explicitly authorized `discardChanges: true`. Default source is the current index. If using `sourceRef` in a preview, apply with the full returned `sourceCommit` so a moving branch cannot change the restoration source.

Restoration is limited to currently index-tracked files. Untracked/ignored files are never cleaned or overwritten. Staged entries remain unchanged, including partial staging; Git may refresh raw index stat-cache bytes without changing logical entries. A source missing an approved tracked path can delete that working file. Symlink ancestors, directories, conflicts and unsupported index modes are refused. No automatic reset/clean/rollback follows a partial failure.

## Prepare a no-commit revert

`revert_changes({ commit, expectedHead, expectedIndex, worktreePath? })` applies the inverse of one full-ID non-merge commit already contained in HEAD. It requires clean idle state and refuses ignored local-only files at the paths the commit touches; ignored files elsewhere do not block it. HEAD, branch, refs, and configuration remain unchanged; inverse changes are staged and ordinary commit creation remains a separate explicit workflow.

Conflicts attempt `git revert --abort` and verify restoration. A successful `--no-commit` application may still leave REVERT_HEAD; BranchMe verifies ownership, then uses `git revert --quit` to clear only that operation while preserving its index/worktree result. This is not a general sequencer continuation API. Uncertain recovery requires a person; no reset, stash, commit, or private recovery state is introduced. Returned paths may be partial; enumerate `git_status` for every resulting path.

## PR checks, editing, and host merge

- `pull_request_checks({ number, after? })` reports latest check runs and legacy context statuses for the captured head, with 25 records per source per page. It also reports available host mergeability, review decision, and aggregate head rollup. Unknown permissions/policy, pending/failed/cancelled/skipped/neutral runs, no checks, stale heads, and partial pages remain distinct. Only a complete first-page successful check set with a successful rollup can report a checks verdict of `passed`; this is not merge authorization. Later pages cannot independently certify aggregate success. Statuses can change between pages; reread before a readiness decision. No reruns or polling occur.
- `edit_pull_request({ number, title?, body?, draft? })` changes explicitly supplied fields only on an open PR. An empty body deliberately clears it; omissions preserve existing values. No base retargeting, reviewers, or close/reopen behavior is exposed. Draft changes use the corresponding GitHub mutation. Verification failures report partial/uncertain outcomes without automatically retrying or rolling back edits.
- `merge_pull_request({ number, expectedHead, mergeMethod })` requires explicit workflow merge authorization, an exact head identity, and `merge`, `squash`, or `rebase`. Host readiness must be available and CLEAN/MERGEABLE with no known outstanding review/check requirement. Unknown or blocked policy refuses merging. The selected method must be enabled by the repository. The request supplies only the expected-head SHA and merge method; no admin/bypass/auto-merge/delete-branch controls exist.

The merge endpoint atomically leases HEAD but has no base-SHA lease. BranchMe rechecks head/base/state immediately before merging and verifies resulting host identities afterward; concurrent external actors cannot be fully locked out. GitHub enforces repository protections. A lost mutation response triggers read-only reconciliation, never a second blind write. Merging does not push local commits, switch files, remove worktrees, or delete remote branches. Run `land_branch` separately after exact merged evidence is available.

All new GitHub requests use the resolved current repository and existing environment/verified-root token policy, bounded 10-second requests and 64 KiB bodies. GitHub responses are untrusted; tokens never appear in returned client objects or diagnostics. A readiness read does not grant permission to merge.
