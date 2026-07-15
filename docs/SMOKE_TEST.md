# BranchMe Smoke Test Notes

Date: 2026-07-15

Validated from the repository checkout with no discovered extensions enabled.

## Commands

```bash
npm run validate
npm run smoke:pi
npm run smoke:pi:packed
npm run check:pack
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
pi --no-extensions -e .
```

## Automated smoke behavior

- `npm run smoke:pi` first runs isolated checkout Pi processes from a temporary non-Git working directory: one with `pi --no-extensions -e <package> -e <temporary verifier>` and `/branchmeverify verify`, then one with `pi --no-extensions -e <package>` and `/branchme help`.
- The temporary command verifier calls `pi.getAllTools()` after BranchMe loads and confirms `branch_status`, `change_branch`, `create_branch`, `push_branch`, and `pull_request` are active runtime tools with strict schemas, prompt guidelines, descriptions, and extension source metadata.
- A second temporary verifier registers a deterministic local smoke model, blocks `fetch`, and runs normal prompts through real Pi lifecycle handling. It verifies automatic no-tool Git context in a temporary repository, one real `branch_status` tool refresh after a verifier-created local change, safe credential-free related-PR status with no request, and non-Git startup fallback.
- The checkout command smoke accepts either `/branchme help` text or the read-only BranchMe status fallback as equivalent non-mutating command output.
- `npm run smoke:pi:packed` creates an npm tarball under a temporary directory, installs that tarball into a separate temporary package with `npm install --omit=dev`, and runs pi against the installed package instead of the source checkout.
- `npm run smoke:pi:packed` is the release gate for packaged runtime imports and required packaged files; `npm run release:check` and `node scripts/publish-npm.mjs` run it before publish, while everyday `npm run validate` keeps the faster checkout smoke.
- Both smoke runs disable discovered extensions, skills, prompt templates, themes, context files, persistent sessions, telemetry, startup network checks, and GitHub token environment variables.
- Both smoke runs are credential-free, allow documented credential variable names in help text, reject credential value patterns, do not call BranchMe mutation tools, and do not contact GitHub.
- Pi's documented `getAllTools()` metadata currently exposes parameter schemas and prompt guidelines, but not `promptSnippet`. The deterministic local smoke model exercises `branch_status` through Pi's normal model tool-call loop without provider or GitHub network access.
- Set `BRANCHME_SKIP_PI_SMOKE=1` to skip intentionally, or `BRANCHME_PI_BIN=/path/to/pi` to test a specific Pi binary for the checkout smoke.
- If no Pi binary is available, the checkout smoke script prints an explicit skip message; default CI installs the Pi dev dependency, so `npm run validate` exercises the real Pi loading path.

## Result

- `npm run validate` passed.
- `npm run smoke:pi` loaded BranchMe through Pi, verified all five BranchMe tools through the real `pi.getAllTools()` runtime surface, and confirmed non-mutating BranchMe command output.
- The isolated Git-context prompt smoke observed the `before_agent_start` snapshot, answered branch and dirty-tree state without a tool call, refreshed a verifier-created local change through one real `branch_status` call, returned safe unavailable context without credentials or outside Git, and attempted no network request.
- `npm run smoke:pi:packed` packed BranchMe outside the repository, installed the artifact in a temporary production workspace, loaded the installed package through Pi, and confirmed non-mutating BranchMe command output.
- `npm run check:pack` confirmed the package contents are limited to public docs, images, source, license, package metadata, `.env.example`, and `tsconfig.json`.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe help or status output instead of template behavior.
- The bare `pi --no-extensions -e .` smoke command exited cleanly in this non-interactive validation environment.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was also used so the smoke test could exit without leaving an interactive TUI session open.
