# BranchMe Smoke Test Notes

Date: 2026-06-30

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

- `npm run smoke:pi` runs isolated checkout Pi processes from a temporary working directory: one with `pi --no-extensions -e <package> -e <temporary verifier>` and `/branchmeverify verify`, then one with `pi --no-extensions -e <package>` and `/branchme help`.
- The temporary verifier is a non-LLM Pi extension command that calls `pi.getAllTools()` after BranchMe loads and confirms `branch_status`, `change_branch`, `create_branch`, `push_branch`, and `pull_request` are active runtime tools with strict schemas, prompt guidelines, descriptions, and extension source metadata.
- The checkout smoke accepts either `/branchme help` text or the read-only BranchMe status fallback as equivalent non-mutating command output.
- `npm run smoke:pi:packed` creates an npm tarball under a temporary directory, installs that tarball into a separate temporary package with `npm install --omit=dev`, and runs pi against the installed package instead of the source checkout.
- `npm run smoke:pi:packed` is the release gate for packaged runtime imports and required packaged files; `npm run release:check` and `node scripts/publish-npm.mjs` run it before publish, while everyday `npm run validate` keeps the faster checkout smoke.
- Both smoke runs disable discovered extensions, skills, prompt templates, themes, context files, persistent sessions, telemetry, startup network checks, and GitHub token environment variables.
- Both smoke runs are credential-free, allow documented credential variable names in help text, reject credential value patterns, do not call BranchMe mutation tools, and do not contact GitHub.
- Pi's documented `getAllTools()` metadata currently exposes parameter schemas and prompt guidelines, but not `promptSnippet`, and the ExtensionAPI does not expose a safe non-LLM tool invocation method. The checkout runtime smoke therefore gates real Pi tool registration metadata; isolated `branch_status` execution remains covered by mocked unit tests and real-git helper tests until Pi exposes a direct runtime invocation API.
- Set `BRANCHME_SKIP_PI_SMOKE=1` to skip intentionally, or `BRANCHME_PI_BIN=/path/to/pi` to test a specific Pi binary for the checkout smoke.
- If no Pi binary is available, the checkout smoke script prints an explicit skip message; default CI installs the Pi dev dependency, so `npm run validate` exercises the real Pi loading path.

## Result

- `npm run validate` passed.
- `npm run smoke:pi` loaded BranchMe through Pi, verified all five BranchMe tools through the real `pi.getAllTools()` runtime surface, and confirmed non-mutating BranchMe command output.
- `npm run smoke:pi:packed` packed BranchMe outside the repository, installed the artifact in a temporary production workspace, loaded the installed package through Pi, and confirmed non-mutating BranchMe command output.
- `npm run check:pack` confirmed the package contents are limited to public docs, images, source, license, package metadata, `.env.example`, and `tsconfig.json`.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe help or status output instead of template behavior.
- The bare `pi --no-extensions -e .` smoke command exited cleanly in this non-interactive validation environment.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was also used so the smoke test could exit without leaving an interactive TUI session open.
