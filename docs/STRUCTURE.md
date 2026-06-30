# BranchMe Structure Guide

BranchMe is a TypeScript Pi extension package for current-repository git branch, push, and GitHub pull request workflows.

## Source layout

```text
src/
├── extension.ts                  # extension entry point; registers command and tools only
├── constants.ts                  # command/tool names, timeouts, GitHub API constants
├── types.ts                      # serializable tool details and helper result types
├── commands/
│   └── branchme-command.ts       # /branchme status/help command; informational only
├── tools/
│   └── branchme-tools.ts         # branch_status/change_branch/create_branch/push_branch/pull_request registration
├── git.ts                        # argv-style git helpers and per-repo workflow queue
├── github.ts                     # GitHub repo resolution, env/.env tokens, branch preflight, REST calls, redaction
└── ui/
    └── branchme-panel.ts         # compact /branchme status panel renderer
```

## Module boundaries

1. `src/extension.ts` stays small and only calls `registerBranchMeCommand(pi)` and `registerBranchMeTools(pi)`.
2. `src/commands/branchme-command.ts` parses `/branchme`, `/branchme help`, `--help`, and `-h`; it never performs git or GitHub mutations and avoids raw stdout in JSON mode.
3. `src/tools/branchme-tools.ts` owns TypeBox schemas, prompt metadata, tool content, and safe structured details.
4. `src/git.ts` owns current-repository git behavior: root detection, branch/upstream/status inspection, branch validation, branch creation, existing-local-branch switching, clean-worktree preflight, current-branch push/publish, and the per-repository workflow queue.
5. `src/github.ts` owns GitHub `owner/repo` parsing, repository boundary checks, `GITHUB_TOKEN`/`GH_TOKEN` process-env and hardened git-root `.env` fallback resolution, PR branch-name syntax validation, GitHub branch visibility/commit preflight, PR REST calls, response validation, and redacted errors.
6. `src/redaction.ts` owns shared credential redaction for Git and GitHub messages.
7. `src/types.ts` keeps serializable details shared by helpers and tools.
8. `src/ui/branchme-panel.ts` renders a compact status panel and clips lines to terminal width.

## Pi extension conventions

- No long-lived processes, watchers, timers, sockets, or background jobs start in the extension factory.
- Slash commands are informational; tools perform branch, push, and PR actions.
- Every tool uses a strict TypeBox object schema with `additionalProperties: false`.
- Every tool defines a description, `promptSnippet`, and tool-specific `promptGuidelines` that explicitly name the tool.
- Git commands use `pi.exec("git", args, { cwd, signal, timeout })` with argv arrays; repository mutations run from the verified git root and same-repository mutation/PR windows are serialized per repository.
- Tool details avoid token values and unbounded raw command/API output.
- Pi core packages, including `@earendil-works/pi-tui` for key/width utilities, remain in `peerDependencies` with `"*"`.

## Security-sensitive areas

- `change_branch` mutates local HEAD and working-tree files only through `git switch <branchName>` for existing local branches after a clean-worktree preflight.
- `create_branch` mutates local branch/HEAD only with `git switch -c`.
- `push_branch` mutates remote refs only for the current branch and uses an explicit upstream remote/refspec instead of bare `git push` when an upstream exists.
- `pull_request` requires `headBranch` and `baseBranch` to exist locally, requires `headBranch` to match the GitHub-visible branch commit, queues behind already-started same-repository git mutation windows, makes GitHub REST API calls for the resolved current repository only, and rejects missing, owner-prefixed, or unsafe branch refs before token lookup or the request.
- `pull_request` reads `GITHUB_TOKEN` or `GH_TOKEN` from process environment first; only when neither process token is set does it read those token keys from a small regular `.env` file in the verified git root as a fallback.
- BranchMe does not force checkout, stash, stage, commit, directly edit files, read non-token `.env` keys, follow unsafe `.env` file types, depend on GitHub CLI, or collect telemetry.

## Documentation

- `docs/PROJECT_DEFINITION_BRIEF.md` preserves the approved project definition.
- `docs/STRUCTURE.md` describes the implemented source layout.
- `docs/SMOKE_TEST.md` records isolated validation/smoke-test findings.
- `docs/TUI_CAPTURE.md` stores deterministic text captures of BranchMe TUI/help surfaces for visual regression review.

## Tests

```text
test/
├── command.test.mjs      # /branchme parsing, help, fallback, panel width
├── git.test.mjs          # git helper command construction and failures
├── git-integration.test.mjs # isolated real-git branch helper coverage
├── github.test.mjs       # GitHub parsing, token resolution, fetch wrapper, redaction
├── preparation.test.mjs  # package/docs/source metadata checks
├── tools.test.mjs        # extension registration, schemas, prompt metadata, tool behavior
└── tui-capture.test.mjs  # generated text capture for TUI/help visual baselines
```

Validation commands:

```bash
npm run typecheck
npm run format:check
npm run test
npm run check:pack
npm run validate
npm run smoke:pi:packed # release gate for the installed npm artifact
pi --no-extensions -e .
```
