# BranchMe Structure Guide

BranchMe is a TypeScript Pi extension package prepared for current-repository git branch, push, and GitHub pull request workflows.

> Feature implementation is pending. Placeholder source files exist only to reserve the planned module boundaries; they must not be treated as implemented behavior.

## Planned layout

```text
src/
├── extension.ts                  # small extension entry point
├── constants.ts                  # names, tool names, status key, future limits
├── types.ts                      # future serializable domain/result types
├── commands/
│   └── branchme-command.ts       # future /branchme informational TUI/help command
├── tools/
│   └── branchme-tools.ts         # future BranchMe tool registration
├── git.ts                        # future git helper functions
├── github.ts                     # future GitHub REST/token/repo helpers
└── ui/
    └── branchme-panel.ts         # future simple TUI panel
```

## Planned module boundaries

1. `src/extension.ts` remains intentionally small and only calls registration functions after implementation.
2. `src/commands/branchme-command.ts` will parse `/branchme`, `/branchme help`, `--help`, and `-h`; it must stay informational only.
3. `src/tools/branchme-tools.ts` will register `branch_status`, `create_branch`, `push_branch`, and `pull_request`.
4. `src/git.ts` will own git command execution through `pi.exec("git", args)` and current-repository validation.
5. `src/github.ts` will own process-env token resolution, current-repository GitHub resolution, REST calls, and token redaction.
6. `src/types.ts` will keep tool details and helper result types serializable.
7. `src/ui/branchme-panel.ts` will contain only the simple `/branchme` status/config/help panel if custom UI is needed.

## Pi extension conventions

- Do not start long-lived processes, file watchers, timers, sockets, or background jobs in the extension factory.
- Keep action behavior in tools, not slash commands.
- Use TypeBox schemas, descriptions, `promptSnippet`, and tool-specific `promptGuidelines` for every tool.
- Every prompt guideline must name the tool it describes.
- Use `StringEnum` from `@earendil-works/pi-ai` if future string enum schemas are needed.
- Truncate unexpected large tool outputs and tell the agent when truncation happens.
- Store branch-sensitive state in tool result `details` when possible.
- Keep Pi core packages in `peerDependencies` with `"*"`.

## Security-sensitive areas for implementation

- Local git execution for branch creation, current branch push, and status inspection.
- GitHub REST API calls for PR creation.
- `GITHUB_TOKEN` / `GH_TOKEN` process-env token handling.
- Current-repository boundary checks so PRs cannot be created for arbitrary owner/repo tool input.
- No commit, staging, working-tree file mutation, telemetry, GitHub CLI dependency, or `.env` token loading in v1.

## Planning files

- `docs/PROJECT_DEFINITION_BRIEF.md` - approved preparation brief
- `specs/spec-architecture.md` - architecture blueprint
- `specs/spec-guidelines.md` - implementation rules
- `specs/spec-tasks.md` - future task checklist; all checkboxes remain unchecked during preparation
