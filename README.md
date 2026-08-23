<p align="center">
  <img alt="BranchMe logo" src="img/icon.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@senad-d/branchme"><img alt="npm" src="https://img.shields.io/npm/v/%40senad-d%2Fbranchme?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a align="center" href="https://sonarcloud.io/summary/new_code?id=senad-d_BranchMe"><img alt="Quality Gate Status" src="https://sonarcloud.io/api/project_badges/measure?project=senad-d_BranchMe&metric=alert_status" /></a>
</p>

<p align="center">
  Current-repository branch, worktree, integration, retirement, and pull request tools for <a href="https://pi.dev">pi</a>.
  <br />Inspect branch state, manage verified linked worktrees, integrate or retire local branches, push, and open GitHub PRs from pi prompts.
</p>

---

BranchMe is a Pi extension for safe branch and worktree workflow automation. Before each agent run, it appends a bounded, read-only snapshot of the current Git repository to the system prompt. It also adds an informational `/branchme` command and thirteen agent-callable tools that refresh state, manage, integrate, and retire local branches, inspect/create/remove linked worktrees, push the current branch, and create GitHub pull requests.

<table align="center">
  <tr>
    <th>BranchMe demo</th>
  </tr>
  <tr>
    <td align="center">
      <img src="img/demo.gif" alt="BranchMe demo: inspect branch status and use branch workflow tools in pi" title="BranchMe demo" width="760">
    </td>
  </tr>
</table>

- **Context-aware:** every agent run starts with bounded branch, working-tree, related-PR, and recent-commit metadata; repository metadata is untrusted data, not instructions.
- **Repository-scoped:** Git and GitHub operations resolve from the checkout where pi is running. Linked worktree directories may be outside that checkout, but must be verified members of the same repository.
- **Explicit history rewrites:** `rebase_branch` runs only when explicitly requested, requires a clean current branch with an upstream, disables autostash and multi-ref updates, and automatically attempts to abort on failure.
- **Verified worktree handoff:** `create_worktree` verifies path, branch, `HEAD`, and cleanliness before returning an absolute `handoff.cwd`; starting another Pi session or subagent there remains the caller's responsibility.
- **Commit-safe:** context collection is read-only, and BranchMe never stages files, creates user-authored commits, accepts or generates commit messages, force-pushes, resets, or edits files directly. An explicit `integrate_branch` call may let Git create its standard merge commit for divergent local histories.
- **Strict tools:** tool schemas reject undocumented properties such as `stash`, `discard`, `owner`, `repo`, `path`, or `baseRef`; the only force decision is the required boolean on `retire_branch`, and every tool accepts only its documented fields.
- **PR-ready:** create GitHub pull requests from existing local branches after verifying the `headBranch` matches GitHub and the base is visible. PR fields can stay explicit, or configured autofill can derive omitted fields from the current branch, default branch, and commit subjects.

> **Security:** pi packages run with your full system permissions. BranchMe runs local `git` commands, may create or remove verified linked-worktree directories outside the active checkout, may integrate local history or retire one exact local branch ref, may make an automatic authenticated GitHub request to find a related open pull request, can update branches and remotes, and can create GitHub pull requests. Repository-configured hooks—including `reference-transaction` hooks invoked by retirement—merge drivers, filters, and signing policy may run commands or contact networks outside BranchMe's direct argv guarantees. Read [`SECURITY.md`](SECURITY.md).

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Repository and GitHub Setup](#repository-and-github-setup)
- [Configuration](#configuration)
- [Commands](#commands)
- [Tools](#tools)
- [Workflow and Boundaries](#workflow-and-boundaries)
- [GitHub Actions](#github-actions)
- [Troubleshooting](#troubleshooting)
- [Diagnostics](#diagnostics)
- [Update and Uninstall](#update-and-uninstall)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Quick Start

```bash
pi install npm:@senad-d/branchme
cd /path/to/your/git/repo
pi
```

Inside pi:

```text
/branchme
/branchme help
```

A normal prompt can use the automatic start-of-run snapshot without a tool call. Ask for an explicit refresh when needed, for example:

```text
Refresh the repository state with branch_status, then create a branch named feature/update-docs with create_branch.
```

A typical BranchMe flow is:

1. Use the automatic snapshot to understand state at the start of the agent run.
2. Use `branch_status` when you explicitly need fresh state, especially after a Git mutation in the same run.
3. Switch to the local base branch with `change_branch`.
4. Update it from its configured upstream with `pull_branch`, which requires a clean worktree and uses fast-forward-only semantics.
5. Create from the updated `HEAD` with `create_branch`.
6. Make edits and commit outside BranchMe.
7. Push the current branch with `push_branch`.
8. After `push_branch` completes and GitHub can see the branches, create a pull request with `pull_request`.

For isolated work, a specialized Git subagent can use the explicit worktree workflow:

1. Call `list_worktrees` to inspect the current repository's bounded worktree inventory.
2. Ask the user to provide or approve an exact absolute destination and call `create_worktree` with `branchMode: "new"` or `"existing"`.
3. Wait for the result and require `details.handoff.ready === true`.
4. Have the caller or orchestrator start a **separate** Pi session or subagent with its working directory set to the returned absolute `details.handoff.cwd`.
5. After that session finishes, remove or preserve any staged, unstaged, untracked, unmerged, or ignored local files, then explicitly call `remove_worktree` if removal was requested. Removal retains the local branch.
6. If the user separately asks to retire that retained branch, obtain its fresh exact `HEAD`, verify it against an exact local target, and call `retire_branch` only after worktree removal has completed.

BranchMe does not change the active Pi process's cwd, start Pi or other processes, create sessions, copy `.env` or other ignored/untracked files, or automatically retire a branch when removing its worktree. For credentials needed by agents in linked worktrees, prefer process-level environment variables rather than copying repository-root secrets.

To refresh the current branch's configured remote-tracking ref without changing the local branch or working tree, use `fetch_branch`. To reconcile the clean current branch by rewriting its local commits, run `fetch_branch`, wait for it to complete, and then run `rebase_branch`. Both tools require a configured upstream; `rebase_branch` automatically attempts `git rebase --abort` if rebasing fails.

BranchMe is tool-based. The slash command is informational only and never changes or updates branches, creates or removes worktrees, changes cwd, starts processes/sessions, fetches, rebases, pushes, commits, stages, edits files, or opens pull requests.

---

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:@senad-d/branchme` | Loads in every trusted pi project. |
| Project-local | `pi install npm:@senad-d/branchme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:@senad-d/branchme` | Try without changing settings. |
| Git | `pi install git:github.com/senad-d/branchme@<tag>` | Pin a tag or commit. |
| Local checkout | `pi --no-extensions -e .` | Develop or test this repository in isolation. |

Once loaded, BranchMe collects automatic Git context before each agent run. This happens for ordinary prompts; there is no `/branchme context` command and no additional tool to enable it.

Source checkout:

```bash
git clone https://github.com/senad-d/branchme.git
cd branchme
npm install --ignore-scripts
npm run validate
pi --no-extensions -e .
```

Use the checkout globally while developing:

```bash
pi install /absolute/path/to/branchme
```

---

## Repository and GitHub Setup

BranchMe does not bundle Git and does not create repositories. Start pi from inside the repository you want BranchMe to manage:

```bash
cd /path/to/your/git/repo
git status
git remote get-url origin
pi
```

For pull requests, the repository must resolve to GitHub from local `origin` and/or `GITHUB_REPOSITORY`:

```bash
git remote set-url origin git@github.com:OWNER/REPO.git
# or
export GITHUB_REPOSITORY=OWNER/REPO
```

For automatic related-PR lookup and `pull_request`, set a token in the process environment before starting pi:

```bash
export GITHUB_TOKEN=github_pat_...
# or
export GH_TOKEN=ghp_...
pi
```

Or copy `.env.example` to `.env` in the repository root, fill in one token value, and optionally enable PR field autofill:

```bash
cp .env.example .env
$EDITOR .env
# Set BRANCHME_PR_AUTOFILL=true in .env if desired.
pi
```

`fetch_branch`, `pull_branch`, and `push_branch` use your normal Git remote credentials. BranchMe does not inject `GITHUB_TOKEN` into `git fetch`, `git pull`, or `git push`. `rebase_branch` operates on the locally available configured upstream ref and makes no network request itself.
When the current branch already has an upstream, BranchMe pushes an explicit `HEAD:<upstream-branch-ref>` refspec to the configured upstream remote instead of relying on a bare `git push`.
Run `pull_request` only after `push_branch` has completed; `pull_request` preflights the GitHub `headBranch` and `baseBranch` before creating the PR and fails with retry guidance if a branch is not visible yet or the GitHub `headBranch` commit does not match the local branch.

---

## Configuration

BranchMe has no separate project config file. It reads process environment variables and supported keys from a local `.env` file in the verified git root. Token lookup checks `process.env.GITHUB_TOKEN`, then `process.env.GH_TOKEN`; if neither is set, BranchMe checks the matching `.env` keys. Pull request field autofill checks `BRANCHME_PR_AUTOFILL` in the process environment first, then `.env`, and defaults to disabled.

| Variable | Meaning |
| --- | --- |
| `GITHUB_TOKEN` | Preferred token for automatic related-PR lookup and `pull_request`; process environment first, then local `.env` fallback. |
| `GH_TOKEN` | Fallback token for automatic related-PR lookup and `pull_request`; process environment first, then local `.env` fallback. |
| `BRANCHME_PR_AUTOFILL=true` | Allow `pull_request` to fill omitted PR fields. Accepts `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off`; disabled by default. |
| `GITHUB_REPOSITORY=owner/repo` | Optional CI fallback and boundary check for the current GitHub repository; process environment only. |

BranchMe reads only `GITHUB_TOKEN`, `GH_TOKEN`, and `BRANCHME_PR_AUTOFILL` from a small regular `.env` file; it rejects directories, symlinks, special files, and oversized files. BranchMe does not import other `.env` keys, read shell profiles, GitHub CLI credentials, or local credential stores. Token values are redacted from automatic context, errors, tool content, and tool details.

With autofill enabled, omitted fields are resolved as follows:

- `headBranch`: current local branch.
- `baseBranch`: the branch named by `origin/HEAD` when it exists locally, falling back to an existing local `main`, `master`, `trunk`, or `develop` branch.
- `title`: first commit subject in `baseBranch..headBranch`, falling back to a title derived from the head branch name.
- `body`: a bounded Markdown summary of commit subjects in `baseBranch..headBranch`.
- `draft`: `false`.

Explicit tool arguments always take precedence. Autofill does not create a PR by itself: the user must still ask the agent to create one.

If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, `pull_request` fails closed.

---

## Commands

| Command | Description |
| --- | --- |
| `/branchme` | Show a compact status panel or fallback message with current branch, GitHub repository resolution, token presence, and workflow notes. |
| `/branchme help` | Show concise BranchMe workflow help and runtime requirements. |
| `/branchme --help` | Alias for `/branchme help`. |
| `/branchme -h` | Alias for `/branchme help`. |

Commands are informational only. BranchMe actions are performed by agent-callable tools. `/branchme` uses the TUI panel in TUI mode, notifications in RPC mode, plain text only in print mode, and stays stdout-silent in JSON mode to avoid corrupting protocol output. Unsupported non-empty `/branchme` arguments return guidance to use `/branchme help` where the current mode can display it safely.

---

## Tools

| Tool | Schema | Behavior |
| --- | --- | --- |
| `branch_status` | `{ "ancestry"?: { "sourceBranch": string, "targetBranch": string } }` | Explicitly refreshes the same bounded context used at agent start. An optional strict ancestry query captures both exact local branch HEADs and reports whether the source commit is an ancestor of the target commit. It is read-only; automatic Git context does not run ancestry queries. |
| `list_worktrees` | `{}` | Runs a bounded, read-only inventory of the current repository's main and linked worktrees, including path, branch/detached state, `HEAD`, current/main, locked, prunable, and omitted-entry details. Automatic Git context does not include this inventory. |
| `create_worktree` | `{ "worktreePath": string, "branchName": string, "branchMode": "new" \| "existing" }` | Creates and verifies a linked worktree at an explicitly approved absolute path. `new` creates a local branch from current `HEAD`; `existing` requires an existing local branch not checked out elsewhere. It returns a ready handoff with the exact canonical absolute cwd and local branch identity. |
| `remove_worktree` | `{ "worktreePath": string }` | Force-free removal of an explicitly selected, verified clean linked worktree. It rejects the main/current, detached, locked, prunable/missing, dirty, ignored-file-containing, or foreign worktree and verifies that the local branch remains at the same commit. |
| `retire_branch` | `{ "branchName": string, "expectedHead": string, "targetBranch": string, "force": boolean }` | Deletes only the exact unoccupied local branch ref when its direct ref matches the supplied full commit ID and its relationship to the exact local target has been verified. Unmerged retirement requires explicit `force: true`; remote and remote-tracking refs are untouched. |
| `change_branch` | `{ "branchName": string }` | Validates `branchName`, requires `refs/heads/<branchName>` to exist locally, rejects dirty worktrees, and runs `git switch <branchName>`. |
| `fetch_branch` | `{}` | Requires a current branch with a configured upstream and runs `git fetch --no-tags --no-recurse-submodules <upstream-remote> <upstream-branch-ref>:<remote-tracking-ref>`; only that tracking ref is refreshed without changing local branches or working-tree files. |
| `pull_branch` | `{}` | Requires a clean current branch with a configured upstream and runs `git pull --ff-only --no-rebase --no-autostash <upstream-remote> <upstream-branch-ref>`; divergence fails without rebasing or creating a merge commit. |
| `rebase_branch` | `{}` | Requires a clean current branch with a configured upstream and runs `git rebase --no-autostash --no-update-refs <upstream>`; it rewrites local commits and automatically attempts `git rebase --abort` on failure. |
| `integrate_branch` | `{ "sourceBranch": string, "targetBranch": string }` | Integrates one exact existing local source branch into one distinct existing local target branch. The clean active control worktree must already have the target checked out. It returns `already_integrated`, `fast_forward`, `merge_commit`, or a `conflict` only after automatic abort and verified restoration. It never fetches or pushes. |
| `create_branch` | `{ "branchName": string }` | Validates `branchName`, rejects existing local branches, and runs `git switch -c <branchName>` from current `HEAD`. |
| `push_branch` | `{}` | Pushes the current branch to its configured upstream remote with an explicit `HEAD:<upstream-branch-ref>` refspec, or publishes it with `git push --set-upstream origin <currentBranch>` when no upstream exists. |
| `pull_request` | `{ "headBranch"?: string, "baseBranch"?: string, "title"?: string, "body"?: string, "draft"?: boolean }` | Preflights GitHub branch visibility and verifies the GitHub `headBranch` commit matches the local branch, then creates a pull request in the resolved current repository. Omitted fields require `BRANCHME_PR_AUTOFILL=true`; branch refs must be distinct, exist locally, and cannot use `owner:branch`. |

All schemas reject additional properties. `change_branch` never accepts `baseRef`, `force`, `stash`, `discard`, `create`, `owner`, `repo`, or path inputs. `fetch_branch`, `pull_branch`, and `rebase_branch` have strict empty schemas and never accept a branch, remote, refspec, force, autostash, or arbitrary rebase target. `integrate_branch` requires exactly `sourceBranch` and `targetBranch`; it accepts no repository, path, remote, strategy, message, squash, signing, commit, continuation, abort, force, fetch, push, deletion, or worktree controls. `create_worktree` requires exactly `worktreePath`, `branchName`, and `branchMode`; `remove_worktree` requires exactly `worktreePath`. No worktree tool accepts force, move, prune, repair, lock, unlock, detached, orphan, remote, refspec, or arbitrary start-point controls. `retire_branch` requires exactly `branchName`, a full 40- or 64-hex-character `expectedHead`, a distinct local `targetBranch`, and the boolean `force` decision; it accepts no repository, path, remote, refspec, pattern, branch list, prune, remote-delete, worktree-removal, or inferred-target control. `pull_request` never accepts `owner`, `repo`, or owner-prefixed branch refs; BranchMe resolves the repository from local `origin` and/or matching `GITHUB_REPOSITORY`. `continue_merge` and `abort_merge` are not available.

---

## Workflow and Boundaries

### Automatic context and freshness

Before each agent run, BranchMe appends an **Automatic Git Context** snapshot to the existing system prompt. The snapshot contains these fields in order:

- current branch or detached `HEAD`, plus upstream and ahead/behind counts when available;
- working-tree state and staged, unstaged, and untracked counts;
- up to 20 unstaged or untracked change entries with Git status, path, and original path for renames/copies;
- related open PR status and, when found, its number, title, repository, head/base branches, URL, state, and draft flag;
- whether pull request field autofill is enabled;
- up to 5 recent commits with short hash, date, and subject.

Collection defaults are a 5-second timeout per local Git command, a 4-second related-PR lookup timeout, at most 512 characters per metadata value, and at most 4,000 characters for the rendered snapshot. GitHub response bodies are limited to 64 KiB. The formatter can further shorten values or omit entries to stay within the total limit.

The snapshot is fresh at agent start but is not live. A fetch, branch switch, pull, rebase, integration, commit, file change, push, or other mutation later in the same run can make it stale. `branch_status` performs an explicit current-state refresh through the same shared collector and remains read-only; it does not mutate files, Git state, or GitHub state. Its optional `ancestry` object requires exact `sourceBranch` and `targetBranch` fields together, captures both local branch commit IDs, and reports `isAncestor`. This targeted proof is explicit only: automatic Git context remains unchanged. Run it after `integrate_branch` completes, never in the same parallel tool batch.

Related-PR metadata does not come from Git alone. When repository, branch, and credentials resolve, automatic collection and explicit `branch_status` may make an authenticated `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{branch}&per_page=1` request. Without a token there is no unauthenticated fallback or GitHub request; the PR field is reported as unavailable while local Git context remains usable.

Repository paths, commit subjects, branch names, and PR titles are treated as untrusted metadata. BranchMe redacts token values, escapes control characters, quotes and bounds values before prompt insertion, and never captures diffs or file contents. Staged files contribute only to the staged count; the path list is limited to unstaged and untracked entries.

Use BranchMe from pi prompts or automation that drives pi with explicit tool calls:

```text
Use branch_status.
Switch to the base branch with change_branch, then use pull_branch after the switch completes.
Fetch the current branch upstream with fetch_branch, wait for it to complete, then rebase with rebase_branch.
Create branch feature/docs-refresh from the updated current HEAD with create_branch.
Push the current branch with push_branch.
After push_branch completes, create a draft pull request from feature/docs-refresh to main titled "Refresh docs" with this body: "...".
If pull request field autofill is enabled, after push_branch completes create a pull request and fill any details I did not provide.
```

### Verified local branch integration

`integrate_branch` requires explicit intent and exactly two distinct existing local branch names: `sourceBranch` and `targetBranch`. The active Pi worktree is the control worktree; it must be clean, have no merge/rebase/cherry-pick/revert/sequencer operation in progress, and already have `targetBranch` checked out. BranchMe never switches to the target or infers one. A source checked out in another dirty linked worktree is allowed because integration reads only its committed local ref. Remote-only refs, commit IDs, paths, repositories, remotes, and owner-prefixed refs are rejected.

For a source not already reachable from the target, BranchMe runs this fixed normal-merge policy from the verified worktree root:

```text
git -c rerere.enabled=false merge --ff --no-edit --no-autostash --no-rerere-autoupdate --no-overwrite-ignore refs/heads/<sourceBranch>
```

This policy permits a fast-forward or lets Git create a standard two-parent merge commit for divergent histories. BranchMe does not create user-authored commits, accept a merge message, or expose strategy, squash, unrelated-history, signing, force, or commit controls. Before mutation, it rejects a non-empty `branch.<targetBranch>.mergeOptions` setting because those branch-specific defaults could silently change the fixed policy. Autostash is disabled, rerere is disabled so recorded resolutions are not applied or updated, and ignored files may not be overwritten. Repository-configured hooks, custom merge drivers, clean/smudge filters, and signing policy remain active; those Git extension points may execute arbitrary local commands or network operations under the user's identity.

The structured status is one of:

- `already_integrated`: no merge ran and both branch refs remained stable;
- `fast_forward`: the target advanced exactly to the captured source commit;
- `merge_commit`: Git created an exact normal two-parent merge whose parents are the captured prior target and source;
- `conflict`: bounded, exact repository-relative conflict paths were captured, `git merge --abort` succeeded, and repository identity, current target, exact source/target refs, clean state, and absence of operation state were verified.

All outcomes include captured before/after source and target commit IDs plus final source and prior-target ancestry proof. Failed non-conflict merges remain errors after cleanup. BranchMe uses no reset-based rollback; if abort or postcondition checks are inconclusive, or a ref moves unexpectedly, it reports that integration may have completed and tells the caller to inspect the repository before retrying.

The same-repository mutation queue covers preflight, merge, cleanup, and verification, but it exists only inside the current BranchMe process. It does not lock another Pi session or an external Git process. `integrate_branch` itself does not fetch, pull, push, delete branches, remove worktrees, start agents, ask questions, continue a merge, or resolve semantic conflicts. A Mission or other orchestrator may explicitly call it; after a verified `conflict`, that separate workflow decides whether to delegate analysis to an integration agent or ask the developer about semantic intent.

For an independent read-only proof after integration, call:

```json
{ "ancestry": { "sourceBranch": "feature/example", "targetBranch": "main" } }
```

with `branch_status` only after `integrate_branch` has returned. Do not batch the calls.

### Linked worktree verification and handoff

`create_worktree` requires a non-blank absolute path with no control characters. Its immediate parent must already be a directory. BranchMe resolves that parent to build a canonical destination, rejects any existing file, directory, or symlink there, and rejects destinations inside a registered worktree or the repository's common Git directory. Before mutation, the canonical path and local branch must be returnable without redaction, escaping, Unicode alteration, or truncation: canonical paths are limited to 4,096 characters and branch identities to 512 characters, and credential-like token text is rejected. A dirty source worktree is allowed because creation does not switch or overwrite it.

For `branchMode: "new"`, BranchMe creates the requested local branch from the current `HEAD` only. For `branchMode: "existing"`, it uses only an existing local branch that is not checked out in another worktree; it never infers a local branch from a remote. After Git succeeds, BranchMe re-lists worktrees and verifies the canonical path, local branch, `HEAD`, and clean checkout. A representative structured result subset is:

```json
{
  "action": "create_worktree",
  "handoff": {
    "cwd": "/absolute/path/to/branchme-feature",
    "branch": "feature/worktree-docs",
    "head": "<full-commit-id>",
    "ready": true,
    "summary": "Worktree ready at /absolute/path/to/branchme-feature on branch feature/worktree-docs at <full-commit-id>."
  }
}
```

The full details also distinguish requested input from verified before/after state. Successful `handoff.cwd` and `handoff.branch` values are the exact identities verified against Git; BranchMe never substitutes `[REDACTED]`, escaped control sequences, or a truncation ellipsis in these machine-readable fields. Display content, summaries, and worktree inventory remain sanitized and bounded separately. An orchestrator may use `handoff.cwd` only after `ready` is `true`, and must start the next Pi session or subagent itself with that exact working directory. BranchMe never changes the active process's cwd or starts another process/session.

`remove_worktree` canonicalizes the approved absolute path and requires an exact match in a fresh inventory for the current repository. It accepts only a present, unlocked, non-prunable, non-bare, branch-attached linked worktree that is neither main nor current, then rejects staged, unstaged, untracked, unmerged, or ignored entries. The canonical path and retained branch must pass the same pre-mutation lossless-identity checks used for creation. The ignored-entry preflight is bounded and does not return ignored paths. Removal uses `git worktree remove <verified-path>` without force, verifies the entry is gone, and returns the exact retained branch identity after confirming it still points to the captured commit:

```json
{
  "action": "remove_worktree",
  "handoff": {
    "cwd": null,
    "branch": "feature/worktree-docs",
    "head": "<full-commit-id>",
    "ready": false,
    "summary": "Worktree directory /absolute/path/to/branchme-feature was removed; local branch feature/worktree-docs was retained at <full-commit-id>."
  }
}
```

Ignored and untracked files—including a repository-root `.env`—are not copied into a new linked worktree. Prefer credentials inherited through the new agent process environment. Git documents support for multiple worktrees of a superproject containing submodules as incomplete; BranchMe adds no force-based submodule cleanup. There is no force, move, prune, repair, lock, unlock, detached, orphan, or remote-inference worktree behavior.

### Verified local branch retirement

`retire_branch` is a separate, explicit lifecycle step after integration and any linked-worktree removal. It accepts exactly:

```json
{
  "branchName": "feature/example",
  "expectedHead": "<full-40-or-64-hex-commit-id>",
  "targetBranch": "main",
  "force": false
}
```

Obtain or supply a fresh exact `HEAD` for `branchName` and verify its ancestry against the exact local `targetBranch`; `branch_status.ancestry` can provide both captured commit IDs and the read-only proof. Run that refresh and `retire_branch` sequentially, never in the same parallel tool batch. The retiring and target names must be distinct direct local refs. Any registered worktree that names the retiring branch blocks deletion, including main, current, linked, locked, prunable, or missing records. Removing an occupying linked worktree is a separate explicit `remove_worktree` call; wait for its verified result before retirement.

Merged retirement uses `force: false`. If the retiring commit is not an ancestor of the captured target, retirement fails unless the user explicitly authorizes unmerged data loss with `force: true`. Forced unmerged retirement can remove that commit's last local branch reference. Object recovery is not guaranteed: normal reflog expiry and Git garbage collection can eventually make the commit unreachable.

After validating the expected commit, complete worktree inventory, target ancestry, and repository identity, BranchMe deletes only the exact local ref with an expected-old-value lease:

```text
git update-ref --no-deref -d refs/heads/<branchName> <capturedRetiringHead>
```

The captured commit lease prevents deletion if the retiring ref moves after preflight. BranchMe does not use `git branch -d` or `git branch -D` because those commands do not provide this expected-`HEAD` lease and their default merge target does not satisfy the explicit `targetBranch` contract. Retirement never performs bulk or pattern deletion, infers a target, removes a worktree, fetches, pushes, deletes a remote branch or local remote-tracking ref, or recreates/resets a ref as rollback. Local `branch.<branchName>.*` configuration remains untouched in the initial contract; it can affect a later branch recreated with the same name.

The retirement preflight, immediate reinspection, leased deletion, and postcondition verification share a process-local mutation-queue window keyed by the canonical active worktree root. That queue coordinates BranchMe mutations invoked from the same active checkout, but it does not lock another active worktree, Pi process, or external Git process. The expected-old-value lease protects the retiring ref; target and worktree checks detect other observable movement. After deletion is attempted, BranchMe verifies repository identity, target stability, local-ref absence, and zero occupancy without using a cancelled caller signal. Contradictory or inconclusive outcomes produce a bounded uncertain error stating retirement may have completed; inspect the repository, target ref, retiring ref, and complete worktree inventory manually before retrying. BranchMe does not automatically recreate, reset, switch, merge, or force-update a branch as rollback.

Repository-configured `reference-transaction` hooks can run during `git update-ref`. Such hooks are inside the repository trust boundary and can execute arbitrary commands or contact networks; that behavior is distinct from BranchMe's direct local-only, no-remote-delete argv contract.

BranchMe operates only on the repository where pi is running:

- Automatic collection and `branch_status` run bounded, read-only Git commands from the verified git root.
- Git commands use `pi.exec("git", args, { cwd, signal, timeout })` with argv arrays; repository mutations run from the verified git root.
- `change_branch` switches only to existing local branches and has no `force`, `stash`, `discard`, remote, or path input.
- `fetch_branch` requires a configured upstream, uses an explicit source-to-remote-tracking refspec with tags and submodule recursion disabled, and does not change local branches or working-tree files.
- `pull_branch` requires a clean worktree and configured upstream, updates only the current branch with `git pull --ff-only --no-rebase --no-autostash`, and has no branch, remote, force, or rebase input.
- `rebase_branch` requires a clean worktree and configured upstream, rewrites only the current branch onto the locally available upstream with autostash and multi-ref updates disabled, and automatically attempts to abort on failure.
- `integrate_branch` merges one captured local source ref into the already-current clean local target with the fixed policy documented above. It verifies repository identity, refs, ancestry, clean state, and cleanup without fetching or pushing.
- `create_branch` creates from the current `HEAD` only and has no `baseRef` input.
- `list_worktrees` is an explicit, read-only repository inventory; it is intentionally absent from automatic active-worktree context.
- `create_worktree` may create a linked checkout outside the active checkout only after canonical path and current-repository boundary checks; dependent worktree calls must wait for its verified handoff.
- `remove_worktree` passes Git only a freshly verified canonical linked-worktree path, never uses force, and retains the branch.
- `retire_branch` deletes only one exact unoccupied direct local ref with the supplied expected-`HEAD` lease after captured target ancestry verification; it leaves remote refs, remote-tracking refs, worktrees, and branch configuration untouched.
- `push_branch` pushes only the current branch, uses no bare upstream `git push`, and has no `branchName` input.
- `pull_request` creates PRs only for the resolved current GitHub repository, requires resolved `headBranch` and `baseBranch` values to be distinct and exist locally, requires the GitHub `headBranch` commit to match the local branch, queues behind in-flight same-repository git mutation windows when possible, and rejects `owner:branch` head refs. Missing PR fields fail unless `BRANCHME_PR_AUTOFILL=true`.
- If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, `pull_request` fails closed.

BranchMe intentionally does **not** stage files, create user-authored commits, accept or generate commit messages, force checkout, stash changes, discard changes, force-push, reset, edit files directly, copy ignored/untracked files between worktrees, or delete branches during worktree removal. Rebase-driven rewriting occurs only through explicit `rebase_branch`; a Git-generated standard merge commit is possible only through explicit `integrate_branch` for divergent histories; one exact local ref can be deleted only through explicit `retire_branch` under the leased boundary above.

---

## GitHub Actions

GitHub Actions example:

```yaml
name: branchme-smoke
on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  branchme:
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GITHUB_REPOSITORY: ${{ github.repository }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g --ignore-scripts @earendil-works/pi-coding-agent
      - run: pi --no-extensions -e npm:@senad-d/branchme --help
```

Ensure the token and Git credentials have permission for the branch and pull request operation you ask BranchMe to perform.

---

## Troubleshooting

| Problem | Try |
| --- | --- |
| Not a git repository | Start pi from inside a git checkout. |
| Detached `HEAD` | Use `change_branch` to switch to an existing local branch, or checkout a branch before `fetch_branch`, `pull_branch`, `rebase_branch`, `create_branch`, or `push_branch`. |
| Branch already exists | Choose a new local branch name for `create_branch`, or use `change_branch` to switch to it. |
| Branch does not exist locally | Create a local branch first; `change_branch` and `create_worktree` existing mode do not infer local branches from remote branches. |
| Worktree destination rejected | Provide an exact absolute path whose immediate parent exists; the destination must not exist or be inside another registered worktree or the repository's common Git directory. Its canonical path and branch identity must also fit the documented limits without credential-like token text or characters that require escaping. |
| Existing worktree branch is occupied | Choose another existing local branch or remove its other linked checkout after cleaning it; BranchMe does not force multiple checkouts. |
| Worktree removal rejected | Use `list_worktrees`, select a non-main/non-current linked worktree, and remove or preserve staged, unstaged, untracked, unmerged, and ignored files outside the checkout. Locked, detached, prunable/missing, bare, and foreign paths are not removable. |
| Linked-worktree agent cannot find credentials | Pass credentials through the process environment. BranchMe does not copy repository-root `.env` or other ignored/untracked files. |
| Dirty worktree before branch switch, pull, rebase, or integration | Commit, stash, or discard changes outside BranchMe before using `change_branch`, `pull_branch`, `rebase_branch`, or a target control worktree for `integrate_branch`. |
| Fetch, pull, or rebase has no upstream | Configure the current branch upstream outside BranchMe, then retry the tool. |
| Pull is not a fast-forward | Run `fetch_branch`, wait for it to complete, then explicitly run `rebase_branch` if rewriting local commits is intended; otherwise reconcile outside BranchMe. |
| Rebase fails or conflicts | `rebase_branch` automatically attempts `git rebase --abort`. Inspect repository state before continuing if automatic cleanup also fails. |
| Integration target mismatch or missing local branch | Check out the exact local `targetBranch` in the active control worktree and ensure both distinct branch refs already exist locally; `integrate_branch` never switches, fetches, or accepts remote-only refs. |
| Integration rejects branch-specific merge options | Clear `branch.<targetBranch>.mergeOptions` outside BranchMe before retrying; options such as `--no-commit`, `--squash`, `--no-verify`, or a custom strategy would change the fixed policy. |
| Integration reports `conflict` | The initial merge was automatically aborted and exact restoration was verified. Use the returned conflict paths for separate analysis; BranchMe has no `continue_merge` tool and does not resolve semantic conflicts. |
| Integration is uncertain or cleanup fails | Inspect branch refs, `HEAD`, worktree status, and Git operation state manually before retrying. BranchMe does not use reset-based rollback. |
| Retirement expected `HEAD` is stale | Refresh the exact local branch commit and target ancestry, confirm the intended commit, then make a new sequential `retire_branch` call. Never reuse a stale commit identity. |
| Retirement branch is occupied | Remove the occupying linked worktree separately only after its own safety checks pass. Current, main, locked, prunable/missing, and any other registered occupancy block retirement. |
| Retirement rejects unmerged history | Preserve or integrate the commits, or obtain explicit user authorization for the data-loss risk before a separate call with `force: true`. |
| Retirement outcome is uncertain | Retirement may have completed. Manually inspect the repository identity, target ref, retiring local ref, and complete worktree inventory before retrying; do not recreate or reset a branch as automatic rollback. |
| Push fails | Confirm the current branch is correct and your normal Git remote credentials can push. |
| Related PR is unavailable | Set `GITHUB_TOKEN` or `GH_TOKEN` before starting pi if related-PR context is wanted. Without a token, BranchMe keeps local context and intentionally makes no unauthenticated GitHub request. |
| PR auth fails | Set `GITHUB_TOKEN` or `GH_TOKEN` before starting pi, or copy `.env.example` to `.env` and fill in one token. |
| Missing PR fields | Provide all five fields, or set `BRANCHME_PR_AUTOFILL=true` in the process environment or repository `.env`. |
| Autofill cannot infer the base | Ensure `origin/HEAD` names an existing local branch, keep a local `main`, `master`, `trunk`, or `develop` branch, or provide `baseBranch` explicitly. |
| PR branch does not exist locally | Create or fetch/check out the local `headBranch` and `baseBranch` branches first; BranchMe does not use remote-only or cross-repository PR refs. |
| PR branch is not visible or is stale on GitHub | Run `push_branch`, wait for it to complete, then retry `pull_request`; do not batch `push_branch` and `pull_request` in the same assistant tool call. |
| Repository mismatch | Make `origin` and `GITHUB_REPOSITORY` refer to the same `owner/repo`. |
| Need a user-authored commit | Use CommitMe or normal Git commands. BranchMe does not stage files, accept commit messages, or create user-authored commits; only `integrate_branch` may let Git create a standard merge commit. |
| Other extensions interfere | Test with `pi --no-extensions -e .`. |

---

## Diagnostics

From a source checkout:

```bash
npm run validate
npm run check:pack
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
```

Validation covers TypeScript typechecking, formatting checks, automatic context collection and prompt injection, mocked GitHub lookup, isolated real-Git worktree, branch-integration, and leased branch-retirement lifecycle tests, package checks, checkout Pi runtime smoke, and package-content verification. The checkout smoke loads BranchMe through Pi, then uses a temporary verifier command to confirm all thirteen BranchMe tools are visible through `pi.getAllTools()` with strict schemas and prompt metadata, including `integrate_branch`, `retire_branch`, and targeted `branch_status.ancestry`, with no merge-continuation tool. Runtime smoke inspects retirement registration and schema but never executes branch retirement. Smoke-test notes are recorded in [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md), and TUI/help captures are stored in [`docs/TUI_CAPTURE.md`](docs/TUI_CAPTURE.md).

Refresh TUI captures intentionally with:

```bash
UPDATE_TUI_CAPTURE=1 node --test test/tui-capture.test.mjs
```

---

## Update and Uninstall

```bash
pi update --extensions                  # update installed pi packages
pi update npm:@senad-d/branchme        # update BranchMe only
pi remove npm:@senad-d/branchme        # remove global install
pi remove npm:@senad-d/branchme -l     # remove project-local install
```

---

## Development

```bash
npm install
npm run typecheck
npm run format:check
npm run test
npm run check:pack
npm run validate
npm run smoke:pi:packed
pi --no-extensions -e .
```

`npm run check:pack` verifies the npm package does not include local state, specs, caches, `node_modules`, real environment files, or other private development artifacts. The safe `.env.example` template is included.
`npm run smoke:pi` is the checkout runtime smoke and verifies BranchMe command output plus real Pi tool registration metadata.
`npm run smoke:pi:packed` is the release-gate smoke: it packs the npm artifact into a temporary directory, installs it with production dependency settings, and runs pi against the installed package.

---

## Publishing

BranchMe publishes to npm as `@senad-d/branchme`. You need an npm account with publish access to the `@senad-d` scope.

```bash
npm login
npm whoami
npm run release:check # optional preflight; every publish path runs this gate
node scripts/publish-npm.mjs
```

`npm run release:check` is the canonical release gate: it runs checkout validation and then installs and loads the packed npm artifact in isolation. Both the local publish script and the GitHub `Publish to npm` workflow run this gate before npm publication; a failure prevents publication and the workflow's Git tag creation.

The publish script requires a clean working tree, asks for the version number, runs `npm run release:check`, runs `npm version <version>` to update `package.json` and `package-lock.json`, creates the `v<version>` git tag, publishes with `npm publish --access public`, and then offers to push the release commit and tag.

Run it only from a clean working tree after updating `CHANGELOG.md`.

## License

MIT
