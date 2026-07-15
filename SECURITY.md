# Security Policy

## Trust model

Pi packages and extensions run with the full local permissions of the user account that starts Pi. Review BranchMe source before installing it, pin versions in sensitive environments, and install only from trusted sources.

```bash
pi install npm:@senad-d/branchme@<version>
pi install git:https://github.com/senad-d/branchme@<tag>
```

## Git behavior

BranchMe runs local `git` commands through Pi's extension API with argv-style arguments. Repository mutations first resolve the git root and then run from that verified root.

Implemented git mutations are limited to:

- `change_branch`: `git switch <branchName>` after branch-name validation, local `refs/heads/<branchName>` verification, and clean-worktree preflight.
- `create_branch`: `git switch -c <branchName>` from current `HEAD` after branch-name validation and existing-branch checks.
- `push_branch`: `git push <upstreamRemote> HEAD:<upstreamBranchRef>` for the current branch when an upstream exists, or `git push --set-upstream origin <currentBranch>` when no upstream exists.

Before each agent run, BranchMe also runs bounded, read-only Git commands to collect branch/upstream/ahead-behind state, working-tree counts, up to 20 unstaged or untracked path entries, and up to 5 recent commits. The same collector runs when `branch_status` explicitly refreshes context. Collection does not run `switch`, `push`, `add`, `commit`, or any other mutation, and it never reads diffs or file contents.

Branch switching can update working-tree files as normal Git checkout behavior. Mutating branch operations for the same repository are serialized to avoid same-turn branch races. `pull_request` also uses the same repository queue around PR preflight and creation so it can wait behind an already-started same-repository push. BranchMe rejects dirty worktrees before `change_branch` and does not force checkout, stash, stage files, create commits, reset, rebase, merge, or edit files directly.

## Network behavior

BranchMe's GitHub helpers use these REST API requests:

```text
GET  https://api.github.com/repos/{owner}/{repo}/pulls?state=open&head={owner}:{currentBranch}&per_page=1
GET  https://api.github.com/repos/{owner}/{repo}/branches/{headBranch}
GET  https://api.github.com/repos/{owner}/{repo}/branches/{baseBranch}
POST https://api.github.com/repos/{owner}/{repo}/pulls
```

The first request is an automatic network boundary: it can run before each agent run and whenever `branch_status` explicitly refreshes context. It is a bounded, read-only lookup for one open pull request whose head is the current local branch (`per_page=1`), with a default 4-second timeout and a 64 KiB response-body limit. It is skipped when repository/branch resolution or authentication is unavailable, so BranchMe never makes an unauthenticated fallback request. Timeout, HTTP, network, malformed, and oversized-response failures become a safe unavailable state without exposing response bodies or raw network errors. Git alone is not used or claimed to provide PR metadata.

The branch preflight requests have no body. BranchMe uses the `headBranch` preflight response to compare GitHub's branch commit with the local branch commit before creating the PR. The PR request body contains only the explicit PR fields supplied to the tool: title, head branch, base branch, body, and draft flag. All GitHub response reads are bounded.

## Repository boundary

BranchMe operates on the current repository only.

- The GitHub repository is inferred from local `origin` and/or `GITHUB_REPOSITORY`.
- Tool inputs never accept filesystem paths, `owner`, `repo`, or owner-prefixed `owner:branch` PR refs.
- `change_branch` accepts only `branchName` and never creates branches, checks out remote branches, forces, stashes, or discards changes.
- If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, PR creation and related-PR lookup fail closed.
- PR branch inputs are validated as existing local branch-name refs; missing local branches and cross-repository `head` values are rejected before token lookup or any GitHub request.
- PR branch inputs must also be visible on GitHub before the PR is created, and `headBranch` must match the local branch commit; unpublished or stale `headBranch` values fail with guidance to run `push_branch`, wait for it to complete, and retry `pull_request`.

## Credentials

`pull_request` and related-PR lookup check `process.env.GITHUB_TOKEN`, then `process.env.GH_TOKEN`. If neither process token is set, BranchMe reads a local `.env` file from the verified git root and checks:

- `GITHUB_TOKEN` (preferred)
- `GH_TOKEN` (fallback)

Only these two token keys are read from `.env`; other `.env` keys are ignored. The fallback uses async file I/O, requires `.env` to be a small regular file, and rejects directories, symlinks, special files, and oversized files. BranchMe does not read shell profiles, GitHub CLI credentials, or local credential stores. Token values are redacted from thrown errors, automatic context, tool content, and tool details.

## System prompt boundary

Automatic context is appended to Pi's system prompt before each agent run. Branch names, paths, Git status values, commit subjects, and GitHub PR metadata are repository-controlled, untrusted data and must never be interpreted as instructions. BranchMe redacts recognized token values, escapes control and format characters, quotes metadata, limits individual values to 512 characters by default, and limits the complete rendered snapshot to 4,000 characters. It further shortens values or omits entries when needed to enforce the total bound.

The automatic snapshot can become stale after a Git or filesystem mutation during the same run. `branch_status` is the explicit, read-only refresh path. Neither automatic collection nor `branch_status` captures diff hunks or file contents; staged paths are not listed, although the staged file count is included.

## Telemetry

BranchMe does not collect telemetry. Related-PR lookup sends only the resolved repository owner/name and current branch in the authenticated GitHub API URL. PR creation sends only the explicit GitHub pull request fields described above; BranchMe does not send diff contents, filenames, commit subjects, or local file contents to GitHub during context collection.

## Reporting vulnerabilities

Please report suspected security vulnerabilities privately by email: <senad.dizdarevic@proton.me>.

For non-sensitive issues, use the repository issue tracker:

<https://github.com/senad-d/branchme/issues>

Do not open public issues for security-sensitive reports that include exploit details, private repository contents, secrets, or credentials.

## Secure development checklist

- Do not commit secrets, tokens, local `.env`, local `.pi/` state, or generated artifacts.
- Keep tool schemas strict and reject unsupported fields.
- Keep all git calls argv-style through `pi.exec("git", args)`.
- Mock `pi.exec` and `fetch` in tests; do not touch real remotes.
- Keep package contents minimal with `npm run check:pack`.
- Use isolated smoke tests with `pi --no-extensions -e .`.
