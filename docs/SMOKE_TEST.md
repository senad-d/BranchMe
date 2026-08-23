# BranchMe Smoke Test Notes

Date: 2026-08-23

Validated from the repository checkout with no discovered extensions enabled.

## Commands

```bash
npm run typecheck
npm run format:check
npm run test
npm run smoke:pi
npm run check:pack
npm run smoke:worktree-handoff
npm run validate
npm run smoke:pi:packed
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
pi --no-extensions -e .
```

## Automated smoke behavior

- `npm run smoke:pi` first runs isolated checkout Pi processes from a temporary non-Git working directory: one with `pi --no-extensions -e <package> -e <temporary verifier>` and `/branchmeverify verify`, then one with `pi --no-extensions -e <package>` and `/branchme help`.
- The temporary command verifier calls `pi.getAllTools()` after BranchMe loads and confirms `branch_status`, `change_branch`, `create_branch`, `create_worktree`, `fetch_branch`, `list_worktrees`, `pull_branch`, `pull_request`, `push_branch`, `rebase_branch`, and `remove_worktree` are each registered exactly once and active with strict schemas, named prompt guidelines, descriptions, and extension source metadata.
- A second temporary verifier registers a deterministic local smoke model, blocks `fetch`, and runs normal prompts through real Pi lifecycle handling. It verifies automatic no-tool Git context in a temporary repository, one real `branch_status` tool refresh after a verifier-created local change, safe credential-free related-PR status with no request, and non-Git startup fallback.
- The Pi runtime smoke validates worktree tool registration, strict schemas, and prompt contracts only; it never creates or removes a worktree. Real-Git `list_worktrees`/`create_worktree`/`remove_worktree` lifecycle coverage runs under `npm run test` in temporary local repositories with sibling destinations under the same temporary root and no remotes.
- `npm run smoke:worktree-handoff` loads only BranchMe into a deterministic extension host backed by real local Git, creates a new-branch linked worktree through the registered `create_worktree` tool, and launches a separate Node verification process with the returned absolute `handoff.cwd`. That process verifies its cwd, branch, full `HEAD`, and lack of remotes. The smoke then calls the registered `remove_worktree` tool, verifies the directory is absent, and verifies the retained local branch remains at the original commit.
- The handoff smoke uses only a freshly created temporary source repository and sibling worktree, an empty Git config, a minimal credential-free environment, no remotes, offline Pi flags, and a fetch guard that fails on any network request. Cleanup recursively removes the isolated temporary root even on failure.
- `npm run validate` includes the isolated handoff smoke after package-content checks.
- The checkout command smoke accepts either `/branchme help` text or the read-only BranchMe status fallback as equivalent non-mutating command output.
- `npm run smoke:pi:packed` creates an npm tarball under a temporary directory, installs that tarball into a separate temporary package with `npm install --omit=dev`, and runs pi against the installed package instead of the source checkout.
- `npm run smoke:pi:packed` is the release gate for packaged runtime imports and required packaged files; `npm run release:check` and `node scripts/publish-npm.mjs` run it before publish, while everyday `npm run validate` keeps the faster checkout smoke.
- Both Pi smoke runs disable discovered extensions, skills, prompt templates, themes, context files, persistent sessions, telemetry, startup network checks, and GitHub token environment variables.
- Both Pi smoke runs are credential-free, allow documented credential variable names in help text, reject credential value patterns, do not call BranchMe mutation or remote tools, and do not contact GitHub.
- Pi's documented `getAllTools()` metadata exposes parameter schemas, descriptions, prompt guidelines, and source metadata, while command context exposes active `promptSnippet` values through `getSystemPromptOptions().toolSnippets`; the runtime verifier checks both surfaces. The deterministic local smoke model exercises `branch_status` through Pi's normal model tool-call loop without provider or GitHub network access.
- Set `BRANCHME_SKIP_PI_SMOKE=1` to skip intentionally, or `BRANCHME_PI_BIN=/path/to/pi` to test a specific Pi binary for the checkout smoke.
- If no Pi binary is available, the checkout smoke script prints an explicit skip message; default CI installs the Pi dev dependency, so `npm run validate` exercises the real Pi loading path.

## Result

- `npm run typecheck`, `npm run format:check`, `npm run test`, `npm run smoke:pi`, `npm run check:pack`, `npm run validate`, and `npm run smoke:pi:packed` passed.
- `npm run smoke:worktree-handoff` returned `ok: true`, an absolute ready cwd, the expected `feature/isolated-handoff-smoke` branch and full commit ID from a separate process, `branchRetained: true` after force-free removal, zero network requests, and an isolated empty credential source.
- `npm run smoke:pi` loaded BranchMe through Pi, verified the complete BranchMe tool set and prompt metadata through real Pi runtime APIs, and confirmed non-mutating BranchMe command output.
- The isolated Git-context prompt smoke observed the `before_agent_start` snapshot, answered branch and dirty-tree state without a tool call, refreshed a verifier-created local change through one real `branch_status` call, returned safe unavailable context without credentials or outside Git, and attempted no network request.
- `npm run smoke:pi:packed` packed BranchMe outside the repository, installed the artifact in a temporary production workspace, loaded the installed package through Pi, and confirmed non-mutating BranchMe command output.
- `npm run check:pack` confirmed the package contents are limited to public docs (including worktree behavior and security boundaries), images, source, license, package metadata, `.env.example`, and `tsconfig.json`; private planning specs and generated files remain excluded.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe help or status output instead of template behavior.
- The bare `pi --no-extensions -e .` smoke command exited cleanly in this non-interactive validation environment.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was also used so the smoke test could exit without leaving an interactive TUI session open.
