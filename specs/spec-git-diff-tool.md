# Git diff tool

### 1. Add explicit read-only diff inspection

- [x] Implement and document `git_diff` with isolated real-Git and registration/schema coverage.

#### Why
Agents need actual local diffs without a shell command or commit-message workflow. Automatic context should remain metadata-only.

#### How
Add a strict tool with unstaged (default), staged, and ref-range modes; optional merge-base comparison; patch/stat/name-status output; bounded context and literal repository-relative path filters; and optional same-repository worktree targeting. Resolve range endpoints to captured commit IDs before diffing. Redact credential patterns and escape terminal controls before limiting both content and structured output. Disable external diff, text conversion, optional locks, and submodule working-tree inspection. Never write a diff artifact, stage, fetch, or modify refs/files.

#### Where
`src/git-diff.ts`, shared constants/types, tool registration, help/public docs, tests, and runtime smoke inventories.

#### Acceptance criteria
- Default unstaged, staged (including unborn HEAD), direct range, and merge-base comparisons behave correctly.
- Literal path filters and another live worktree of the same repository work; invalid combinations, unsafe paths/refs, and foreign worktrees fail.
- Outputs are redacted, control-escaped, bounded, and explicitly marked when truncated; untracked file contents are excluded and Git's normal binary summaries are used without `--binary` payloads.
- Git helpers/text conversion are disabled; cancellation/failures remain observable; index, refs, configuration, and files are unchanged.
- Strict schema, named prompt metadata, tool inventories, documentation, and validation pass.

### 2. Audit agent-facing contracts and remove inventory-count maintenance

- [x] Remove remaining fixed inventory assumptions and improve agent-visible clarity without weakening mutation safety.

#### Why
Agents should not guess output lengths, confuse a partial result with a complete one, or follow misleading recovery instructions. Tool additions should not require maintaining parallel name-only inventories or prose-count assertions.

#### How
Use the canonical tool names for registration and smoke inventories, keep explicit schema contracts, and verify documented tool names rather than prose totals. Preserve optional sizing defaults and automatic safety caps. Make diff results identify scope/comparison/completeness in model-visible content, including a useful response to unmatched filters. Improve local-timeout guidance and correct stale landing metadata. Keep destructive-operation preconditions explicit.

#### Where
Shared constants, diff collection/formatting, tool metadata, blocker guidance, public docs, registration/documentation tests, and Pi smoke scripts.

#### Acceptance criteria
- Registration, docs, and smoke inventories agree by exact names and uniqueness, not a manually maintained number.
- No tool requires an agent to supply a result length; diff defaults and sizing bounds are sourced from shared constants.
- Diff content identifies the repository, comparison, filters, status, and truncation with actionable next steps; no-match results do not imply a clean checkout.
- Missing refs, unrelated histories, unsupported Git flags, and timeouts are distinguishable from empty diffs; cancellation remains observable.
- Landing metadata reflects the existing guarded primary-checkout switch; local timeouts do not falsely claim an unreachable remote.
- Focused tests and full validation pass.
