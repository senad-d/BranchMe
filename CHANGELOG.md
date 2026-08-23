# Changelog

## 0.1.9 - Unreleased

- Implemented the `branchme` informational slash command with help aliases.
- Added twelve strict BranchMe tools: `branch_status`, `change_branch`, `fetch_branch`, `pull_branch`, `rebase_branch`, `integrate_branch`, `create_branch`, `push_branch`, `pull_request`, `list_worktrees`, `create_worktree`, and `remove_worktree`; merge-continuation tools are intentionally absent.
- Added argv-style git helpers for repository status, branch validation/creation/switching, clean-worktree preflight, upstream detection, configured-upstream fetch, fast-forward-only current-branch pull, current-branch rebase with automatic abort on failure, verified local branch integration, current-branch push/publish, and bounded NUL-delimited worktree discovery.
- Added `integrate_branch` for exact local source-to-target integration from a clean already-current target control worktree. It rejects branch-specific target merge options that could alter the fixed policy and supports already-integrated, fast-forward, verified normal merge-commit, and automatically aborted/restored conflict outcomes with before/after ref and ancestry proofs, while exposing no fetch, push, reset, merge-message, or continuation controls.
- Added optional targeted `branch_status.ancestry` verification for captured local source/target commits without changing automatic Git context.
- Added verified linked-worktree creation for a new branch from current `HEAD` or an unoccupied existing local branch, returning a structured ready handoff with the exact canonical absolute cwd and local branch for a caller-managed separate agent session.
- Added force-free removal for exact, verified, clean linked worktrees while preserving and re-verifying the local branch at its captured commit; main, current, dirty, ignored-entry-containing, detached, locked, prunable/missing, bare, and foreign worktrees are rejected.
- Added canonical absolute-path and lossless-identity validation before worktree mutations, including existing-destination, nested-worktree, common-Git-directory, repository-membership, redaction, escaping, and truncation boundaries. BranchMe does not copy ignored/untracked files or start/switch Pi sessions.
- Added GitHub repository resolution, environment-token and local `.env` token fallback handling, REST pull request creation, response validation, and token redaction.
- Added opt-in `BRANCHME_PR_AUTOFILL` support for omitted PR fields, including current/default branch inference, bounded, Markdown-safe, and token-redacted title/body generation from commit subjects, and a non-draft default.
- Added bounded automatic Git context before each agent run with branch/upstream state, working-tree counts and unstaged paths, authenticated related-open-PR lookup, and recent commits.
- Expanded `branch_status` into a shared, explicit, read-only context refresh for state that may change during a run.
- Added unit tests with mocked `pi.exec` and `fetch` for Git context collection and prompt safety, git, branch-integration and worktree helpers, GitHub helpers, command behavior, strict tool schemas, prompt metadata, and extension registration, plus isolated temporary-repository worktree and merge lifecycle coverage.
- Updated public documentation for automatic and targeted ancestry context, authenticated lookup and prompt-insertion security boundaries, specialized Git-subagent worktree handoff, verified branch integration, Git extension-point risk, conflict workflow, package structure, and validation commands.
