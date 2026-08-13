# BranchMe Structure Guide

BranchMe is a TypeScript Pi extension package for current-repository git branch fetch/update/rebase, push, and GitHub pull request workflows.

## Source layout

```text
src/
├── extension.ts                  # extension entry point; registers command, tools, and context hook
├── constants.ts                  # names plus Git, context, timeout, API, and output bounds
├── types.ts                      # serializable tool details and helper result types
├── git-context.ts                # shared collector/formatter and before_agent_start prompt hook
├── commands/
│   └── branchme-command.ts       # /branchme status/help command; informational only
├── tools/
│   └── branchme-tools.ts         # registration for eight branch/GitHub workflow tools
├── git.ts                        # argv-style git helpers and per-repo workflow queue
├── github.ts                     # GitHub repo resolution, env/.env tokens, branch preflight, REST calls, redaction
└── ui/
    └── branchme-panel.ts         # compact /branchme status panel renderer
```

## Module boundaries

1. `src/extension.ts` stays small and registers the command, eight tools, and one `before_agent_start` context hook.
2. `src/git-context.ts` owns the shared read-only collector, escaped/bounded formatter, automatic system-prompt append, and the current-state output used by `branch_status`.
3. `src/commands/branchme-command.ts` parses `/branchme`, `/branchme help`, `--help`, and `-h`; it never performs git or GitHub mutations and avoids raw stdout in JSON mode.
4. `src/tools/branchme-tools.ts` owns TypeBox schemas, prompt metadata, tool content, and safe structured details. `branch_status` delegates to the shared context collector for an explicit refresh.
5. `src/git.ts` owns current-repository git behavior: root detection, branch/upstream/ahead-behind inspection, working-tree parsing, recent-commit collection, PR base/commit-subject inference, branch validation, branch creation, existing-local-branch switching, configured-upstream fetch, clean-worktree preflight, fast-forward-only current-branch pull, current-branch rebase with automatic abort on failure, current-branch push/publish, and the per-repository workflow queue.
6. `src/github.ts` owns GitHub `owner/repo` parsing, repository boundary checks, `GITHUB_TOKEN`/`GH_TOKEN` and `BRANCHME_PR_AUTOFILL` process-env/hardened git-root `.env` resolution, authenticated related-open-PR lookup, PR branch-name syntax validation, GitHub branch visibility/commit preflight, PR REST calls, bounded response validation, and redacted errors.
7. `src/redaction.ts` owns shared credential redaction for Git, GitHub, and prompt-bound metadata.
8. `src/types.ts` keeps serializable details shared by helpers, context, and tools.
9. `src/ui/branchme-panel.ts` renders a compact status panel and clips lines to terminal width.

## Pi extension conventions

- No long-lived processes, watchers, timers, sockets, or background jobs start in the extension factory.
- A single `before_agent_start` handler synchronously collects a fresh snapshot for each agent run and appends it to the existing system prompt; failures degrade to bounded unavailable context rather than blocking startup.
- Slash commands are informational; tools perform branch fetch/update/rebase, push, and PR actions. There is no context command.
- Every tool uses a strict TypeBox object schema with `additionalProperties: false`.
- Every tool defines a description, `promptSnippet`, and tool-specific `promptGuidelines` that explicitly name the tool.
- Git commands use `pi.exec("git", args, { cwd, signal, timeout })` with argv arrays; repository mutations run from the verified git root and same-repository mutation/PR windows are serialized per repository.
- Tool details avoid token values and unbounded raw command/API output.
- Automatic and explicit context include branch/upstream/ahead-behind state, working-tree counts, up to 20 unstaged/untracked entries, related open PR state, and up to 5 recent commits. Metadata values default to 512 characters and rendered context to 4,000 characters.
- Pi core packages, including `@earendil-works/pi-tui` for key/width utilities, remain in `peerDependencies` with `"*"`.

## Security-sensitive areas

- Automatic context and `branch_status` share bounded, read-only collection. They run no mutations and capture repository metadata only—never diffs or file contents.
- Repository-controlled paths, branch names, commit subjects, and PR fields are escaped, quoted, redacted, bounded, and labeled untrusted before system-prompt insertion.
- Related-PR lookup may issue an authenticated `GET /pulls` before every agent run and on explicit refresh. It has a 4-second timeout and 64 KiB response limit, and makes no unauthenticated fallback request.
- The start-of-run snapshot may be stale after a mutation in that same run; `branch_status` is the explicit read-only refresh.
- `change_branch` mutates local HEAD and working-tree files only through `git switch <branchName>` for existing local branches after a clean-worktree preflight.
- `fetch_branch` requires a configured upstream and runs `git fetch --no-tags --no-recurse-submodules <remote> <remote-ref>:<remote-tracking-ref>`; its explicit refspec updates only that tracking ref without changing local branches or working-tree files.
- `pull_branch` requires a clean worktree and configured upstream, then updates only the current branch with an explicit `git pull --ff-only --no-rebase --no-autostash <remote> <remote-ref>` command; divergence fails without a rebase or merge commit.
- `rebase_branch` requires a clean worktree and configured upstream, then rebases only the current branch with `git rebase --no-autostash --no-update-refs <upstream>`; it rewrites local commits and automatically attempts `git rebase --abort` on failure.
- `create_branch` mutates local branch/HEAD only with `git switch -c`.
- `push_branch` mutates remote refs only for the current branch and uses an explicit upstream remote/refspec instead of bare `git push` when an upstream exists.
- `pull_request` requires resolved `headBranch` and `baseBranch` values to be distinct and exist locally, requires `headBranch` to match the GitHub-visible branch commit, queues behind already-started same-repository git mutation windows, makes GitHub REST API calls for the resolved current repository only, and rejects owner-prefixed or unsafe branch refs before the request. Omitted fields require configured autofill.
- `pull_request` reads `GITHUB_TOKEN` or `GH_TOKEN` from process environment first; only when neither process token is set does it read those token keys from a small regular `.env` file in the verified git root as a fallback. `BRANCHME_PR_AUTOFILL` uses the same process-first, `.env`-fallback precedence and defaults off.
- BranchMe does not force checkout, stash, stage, create user-authored commits, reset, force-push, create merge commits, directly edit files, read unsupported `.env` keys, follow unsafe `.env` file types, depend on GitHub CLI, or collect telemetry. Rebase-driven commit rewriting occurs only through explicit `rebase_branch` calls.

## Documentation

- `docs/PROJECT_DEFINITION_BRIEF.md` preserves the approved project definition.
- `docs/STRUCTURE.md` describes the implemented source layout.
- `docs/SMOKE_TEST.md` records isolated validation/smoke-test findings.
- `docs/TUI_CAPTURE.md` stores deterministic text captures of BranchMe TUI/help surfaces for visual regression review.

## Tests

```text
test/
├── command.test.mjs      # /branchme parsing, help, fallback, panel width
├── git-context.test.mjs  # collection, prompt hook, formatting, safety, and output bounds
├── git.test.mjs          # git helper command construction and failures
├── git-integration.test.mjs # isolated real-git context and branch helper coverage
├── github.test.mjs       # GitHub parsing, token resolution, related-PR lookup, redaction
├── preparation.test.mjs  # package/docs/source metadata checks
├── tools.test.mjs        # extension registration, schemas, shared refresh, tool behavior
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
