# Changelog

## 0.1.0 - Unreleased

- Implemented the `branchme` informational slash command with help aliases.
- Added strict BranchMe tools: `branch_status`, `create_branch`, `push_branch`, and `pull_request`.
- Added argv-style git helpers for repository status, branch validation/creation, upstream detection, and current-branch push/publish.
- Added GitHub repository resolution, environment-token handling, REST pull request creation, response validation, and token redaction.
- Added unit tests with mocked `pi.exec` and `fetch` for git helpers, GitHub helpers, command behavior, tool schemas, prompt metadata, and extension registration.
- Updated public documentation for implemented behavior, security boundaries, package structure, and validation commands.
