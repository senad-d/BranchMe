# Changelog

## 0.1.0 - Unreleased

- Implemented the `branchme` informational slash command with help aliases.
- Added strict BranchMe tools: `branch_status`, `change_branch`, `fetch_branch`, `pull_branch`, `rebase_branch`, `create_branch`, `push_branch`, and `pull_request`.
- Added argv-style git helpers for repository status, branch validation/creation/switching, clean-worktree preflight, upstream detection, configured-upstream fetch, fast-forward-only current-branch pull, current-branch rebase with automatic abort on failure, and current-branch push/publish.
- Added GitHub repository resolution, environment-token and local `.env` token fallback handling, REST pull request creation, response validation, and token redaction.
- Added bounded automatic Git context before each agent run with branch/upstream state, working-tree counts and unstaged paths, authenticated related-open-PR lookup, and recent commits.
- Expanded `branch_status` into a shared, explicit, read-only context refresh for state that may change during a run.
- Added unit tests with mocked `pi.exec` and `fetch` for Git context collection and prompt safety, git helpers, GitHub helpers, command behavior, tool schemas, prompt metadata, and extension registration.
- Updated public documentation for automatic context behavior, authenticated lookup and prompt-insertion security boundaries, package structure, and validation commands.
