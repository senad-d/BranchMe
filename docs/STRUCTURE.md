# BranchMe Structure Guide

BranchMe is a TypeScript Pi extension package for current-repository Git branch, verified branch-integration and retirement, linked-worktree, push, and GitHub pull request workflows.

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
│   └── branchme-tools.ts         # registration for thirteen branch/integration/retirement/worktree/GitHub tools
├── git.ts                        # shared argv-style Git primitives and per-repo mutation queue
├── git-integration.ts            # integration preflight, merge, cleanup, and verification state machine
├── git-retirement.ts             # leased local-ref retirement and postcondition state machine
├── github.ts                     # GitHub repo resolution, env/.env tokens, branch preflight, REST calls, redaction
└── ui/
    └── branchme-panel.ts         # compact /branchme status panel renderer
```

## Module boundaries

1. `src/extension.ts` stays small and registers the command, thirteen tools, and one `before_agent_start` context hook.
2. `src/git-context.ts` owns the shared read-only collector, escaped/bounded formatter, automatic system-prompt append, and the current-state output used by `branch_status`.
3. `src/commands/branchme-command.ts` parses `/branchme`, `/branchme help`, `--help`, and `-h`; it never performs git or GitHub mutations and avoids raw stdout in JSON mode.
4. `src/tools/branchme-tools.ts` owns strict TypeBox schemas, prompt metadata, bounded tool content, and safe structured details. `branch_status` delegates to the shared context collector and optional ancestry verifier; `integrate_branch` and `retire_branch` delegate to focused mutation state machines; worktree tools expose explicit inventory and verified handoff operations.
5. `src/git.ts` owns reusable current-repository Git primitives: root and canonical common-Git-directory identity, strict direct local-ref inspection, branch/ref validation, local commit ancestry, operation-state and working-tree inspection, complete bounded worktree occupancy, branch/upstream workflows, worktree parsing/path validation/create/remove verification, and the process-local per-repository mutation queue.
6. `src/git-integration.ts` owns the integration preflight, one-window merge mutation, conflict-path capture, automatic abort, outcome classification, and repository/ref/worktree/ancestry postcondition verification. It never fetches, pushes, resets, switches branches, or continues merges.
7. `src/git-retirement.ts` owns strict runtime input validation, expected-`HEAD` and target-ancestry preflight, complete worktree-occupancy rejection, expected-old-value `update-ref` deletion, cancellation-safe final inspection, merged/forced-unmerged classification, and bounded uncertain errors. It never deletes remote or remote-tracking refs, removes worktrees, edits branch configuration, or performs reset rollback.
8. `src/github.ts` owns GitHub `owner/repo` parsing, repository boundary checks, `GITHUB_TOKEN`/`GH_TOKEN` and `BRANCHME_PR_AUTOFILL` process-env/hardened git-root `.env` resolution, authenticated related-open-PR lookup, PR branch-name syntax validation, GitHub branch visibility/commit preflight, PR REST calls, bounded response validation, and redacted errors.
9. `src/redaction.ts` owns shared credential redaction for Git, GitHub, and prompt-bound metadata.
10. `src/types.ts` keeps serializable details shared by helpers, context, and tools.
11. `src/ui/branchme-panel.ts` renders a compact status panel and clips lines to terminal width.

## Pi extension conventions

- No long-lived processes, watchers, timers, sockets, or background jobs start in the extension factory.
- A single `before_agent_start` handler synchronously collects a fresh snapshot for each agent run and appends it to the existing system prompt; failures degrade to bounded unavailable context rather than blocking startup.
- Slash commands are informational; tools perform branch, integration, retirement, worktree, push, and PR actions. Commands never create/remove worktrees, merge or retire branches, change cwd, or start Pi sessions. There is no context command.
- Every tool uses a strict TypeBox object schema with `additionalProperties: false`; `integrate_branch` requires exactly `sourceBranch` and `targetBranch`; `retire_branch` requires exactly `branchName`, full commit `expectedHead`, distinct `targetBranch`, and boolean `force`; worktree creation requires exactly `worktreePath`, `branchName`, and `branchMode`, listing is empty, and removal accepts only `worktreePath`.
- Every tool defines a description, `promptSnippet`, and tool-specific `promptGuidelines` that explicitly name the tool.
- Git commands use `pi.exec("git", args, { cwd, signal, timeout })` with argv arrays; repository mutations run from verified locations and same-repository mutation/PR windows are serialized per repository. Retirement uses one canonical-active-worktree-keyed queue window from preflight through final verification. The queue is process-local and does not lock a different active worktree, another Pi process, or an external Git process.
- Worktree results expose serializable requested and verified before/after state. Create returns `handoff: { cwd: <absolute>, branch, head, ready: true, summary }`; remove returns the retained branch/HEAD with `cwd: null` and `ready: false`.
- Tool details avoid token values, abort signals, runtime objects, and unbounded raw command/API output.
- Automatic and explicit context include branch/upstream/ahead-behind state, working-tree counts, up to 20 unstaged/untracked entries, related open PR state, and up to 5 recent commits. Explicit `branch_status` may additionally verify one strict local source/target ancestry query; automatic context never does. Metadata values default to 512 characters and rendered context to 4,000 characters.
- Pi core packages, including `@earendil-works/pi-tui` for key/width utilities, remain in `peerDependencies` with `"*"`.

## Security-sensitive areas

- Automatic context and `branch_status` share bounded, read-only collection. They run no mutations and capture repository metadata only—never diffs or file contents.
- Repository-controlled paths, branch names, commit subjects, and PR fields are escaped, quoted, redacted, bounded, and labeled untrusted before system-prompt insertion.
- Related-PR lookup may issue an authenticated `GET /pulls` before every agent run and on explicit refresh. It has a 4-second timeout and 64 KiB response limit, and makes no unauthenticated fallback request.
- The start-of-run snapshot may be stale after a mutation in that same run; `branch_status` is the explicit read-only refresh. Its optional targeted ancestry proof accepts exact local branches or remote-tracking refs such as `origin/main` as read-only endpoints and must run after `integrate_branch` or `fetch_branch`, not in the same parallel tool batch.
- `change_branch` mutates local HEAD and working-tree files only through `git switch <branchName>` for existing local branches after a clean-worktree preflight.
- `fetch_branch` runs `git fetch --no-tags --no-recurse-submodules <remote> <remote-ref>:<remote-tracking-ref>`; its explicit refspec updates only that tracking ref without changing local branches or working-tree files. Without arguments it requires a configured upstream; with an explicit `branch` (and optional configured `remote`, default `origin`) it refreshes only `refs/remotes/<remote>/<branch>` and never touches upstream configuration.
- `pull_branch` requires a clean worktree and configured upstream, then updates only the current branch with an explicit `git pull --ff-only --no-rebase --no-autostash <remote> <remote-ref>` command; divergence fails without a rebase or merge commit.
- `rebase_branch` requires a clean worktree and configured upstream, then rebases only the current branch with `git rebase --no-autostash --no-update-refs <upstream>`; it rewrites local commits and automatically attempts `git rebase --abort` on failure.
- `integrate_branch` requires distinct existing local refs and a clean control worktree already on the target. It rejects non-empty target-branch `mergeOptions`, runs `git -c rerere.enabled=false merge --ff --no-edit --no-autostash --no-rerere-autoupdate --no-overwrite-ignore refs/heads/<sourceBranch>`, verifies before/after refs and ancestry, and classifies already-integrated, fast-forward, exact two-parent merge-commit, or conflict.
- Conflict status is emitted only after bounded lossless paths are captured, `git merge --abort` succeeds, and repository identity, exact refs, target checkout, absent operation state, and clean worktree restoration are verified. Failed or uncertain postconditions throw; no reset rollback or continuation tool exists.
- `retire_branch` requires one direct local ref, its exact full expected `HEAD`, one distinct direct local target, and a boolean force decision. It rejects complete-inventory worktree occupancy, proves ancestry against captured commits, and allows negative ancestry only with explicit `force: true` authorization.
- Retirement deletes only `refs/heads/<branchName>` with `git update-ref --no-deref -d <fullRef> <capturedHead>`. The expected-old-value lease prevents deleting a moved ref; final repository, target, retiring-ref, and occupancy checks run with bounded timeouts after the mutation attempt even if the caller cancels. Contradictory or inconclusive state throws an uncertain error with manual-inspection guidance and no rollback ref mutation.
- Local branch configuration, worktrees, remote refs, and remote-tracking refs remain untouched by retirement. Forced unmerged retirement may remove a commit's last local branch reference, and normal expiry/garbage collection can eventually make it unreachable.
- Git hooks, custom merge drivers, clean/smudge filters, signing policy, and `reference-transaction` hooks stay active where Git invokes them and may execute commands or network operations outside BranchMe's direct argv boundary.
- `create_branch` mutates local branch/HEAD only with `git switch -c`.
- `list_worktrees` reads a bounded `git worktree list --porcelain -z` inventory and remains explicit rather than expanding automatic active-worktree context.
- `create_worktree` requires an explicitly approved absolute destination, canonicalizes its existing parent, rejects existing or nested/common-Git-directory destinations, and creates from current `HEAD`, from an explicit read-only `baseRef` (exact local branch, remote-tracking ref, or full commit resolved to a commit before mutation and never checked out or reset), or from an unoccupied existing local branch. It verifies canonical path, branch, `HEAD`, and cleanliness before returning a ready handoff.
- `remove_worktree` resolves an exact fresh current-repository inventory match, rejects main/current/dirty/ignored-entry-containing/detached/locked/prunable/missing/bare entries, runs a bounded removal-specific ignored-entry scan, performs force-free removal with the verified path, and confirms that the local branch remains at the same commit.
- `push_branch` mutates remote refs only for the current branch and uses an explicit upstream remote/refspec instead of bare `git push` when an upstream exists.
- `pull_request` requires resolved `headBranch` and `baseBranch` values to be distinct and exist locally, requires `headBranch` to match the GitHub-visible branch commit, queues behind already-started same-repository git mutation windows, makes GitHub REST API calls for the resolved current repository only, and rejects owner-prefixed or unsafe branch refs before the request. Omitted fields require configured autofill.
- `pull_request` reads `GITHUB_TOKEN` or `GH_TOKEN` from process environment first; only when neither process token is set does it read those token keys from a small regular `.env` file in the verified git root as a fallback. `BRANCHME_PR_AUTOFILL` uses the same process-first, `.env`-fallback precedence and defaults off.
- BranchMe does not force checkout/removal, move/prune/repair/lock/unlock worktrees, create detached/orphan worktrees, infer remote worktree branches, copy ignored/untracked files such as `.env`, remove linked worktrees that contain ignored entries, delete retained worktree branches during removal, change Pi's cwd, or start Pi sessions. It also does not stash, stage, create user-authored commits, accept commit messages, reset, force-push, directly edit files, read unsupported `.env` keys, follow unsafe `.env` file types, depend on GitHub CLI, or collect telemetry. Only explicit `integrate_branch` may let Git create a standard merge commit for divergent histories; only explicit leased `retire_branch` may delete one exact local branch ref. Retirement has no bulk, inferred-target, remote, remote-tracking, rollback, or automatic worktree deletion. Git documents submodule worktree support as incomplete; BranchMe adds no force-based submodule cleanup.

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
├── git.test.mjs          # branch/worktree parsing, validation, command construction, postconditions, failures
├── git-integration.test.mjs # isolated real-Git context, branch integration, and worktree lifecycle coverage
├── git-retirement.test.mjs # mocked retirement preflight, lease, postconditions, and failures
├── git-retirement-integration.test.mjs # isolated real-Git local-ref retirement lifecycle coverage
├── github.test.mjs       # GitHub parsing, token resolution, related-PR lookup, redaction
├── preparation.test.mjs  # package/docs/source metadata checks
├── schema-validation.test.mjs # strict TypeBox schema validation, including worktree and retirement fields
├── tools.test.mjs        # extension registration, prompt metadata, shared refresh, tool behavior
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
