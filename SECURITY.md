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

Branch switching can update working-tree files as normal Git checkout behavior. Mutating branch operations for the same repository are serialized to avoid same-turn branch races. BranchMe rejects dirty worktrees before `change_branch` and does not force checkout, stash, stage files, create commits, reset, rebase, merge, or edit files directly.

## Network behavior

BranchMe makes network requests only for `pull_request`, which calls the GitHub REST API:

```text
POST https://api.github.com/repos/{owner}/{repo}/pulls
```

The request body contains only the explicit PR fields supplied to the tool: title, head branch, base branch, body, and draft flag.

## Repository boundary

BranchMe operates on the current repository only.

- The GitHub repository is inferred from local `origin` and/or `GITHUB_REPOSITORY`.
- Tool inputs never accept filesystem paths, `owner`, `repo`, or owner-prefixed `owner:branch` PR refs.
- `change_branch` accepts only `branchName` and never creates branches, checks out remote branches, forces, stashes, or discards changes.
- If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, PR creation fails closed.
- PR branch inputs are validated as local branch-name refs; cross-repository `head` values are rejected before any GitHub request.

## Credentials

`pull_request` checks `process.env.GITHUB_TOKEN`, then `process.env.GH_TOKEN`. If neither process token is set, BranchMe reads a local `.env` file from the verified git root and checks:

- `GITHUB_TOKEN` (preferred)
- `GH_TOKEN` (fallback)

Only these two token keys are read from `.env`; other `.env` keys are ignored. The fallback uses async file I/O, requires `.env` to be a small regular file, and rejects directories, symlinks, special files, and oversized files. BranchMe does not read shell profiles, GitHub CLI credentials, or local credential stores. Token values are redacted from thrown errors, tool content, and tool details.

## Telemetry

BranchMe does not collect telemetry and does not send repository contents to any service beyond the explicit GitHub pull request fields provided to `pull_request`.

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
