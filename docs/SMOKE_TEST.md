# BranchMe Smoke Test Notes

Date: 2026-06-30

Validated from the repository checkout with no discovered extensions enabled.

## Commands

```bash
npm run validate
npm run smoke:pi
npm run check:pack
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
pi --no-extensions -e .
```

## Automated smoke behavior

- `npm run smoke:pi` runs `pi --no-extensions -e <package>` with `/branchme help` followed by `/quit` from an isolated temporary working directory.
- The smoke run accepts either `/branchme help` text or the read-only BranchMe status fallback as equivalent non-mutating command output.
- The smoke run disables discovered extensions, skills, prompt templates, themes, context files, persistent sessions, telemetry, startup network checks, and GitHub token environment variables.
- The smoke run is credential-free, does not call BranchMe mutation tools, and does not contact GitHub.
- Set `BRANCHME_SKIP_PI_SMOKE=1` to skip intentionally, or `BRANCHME_PI_BIN=/path/to/pi` to test a specific Pi binary.
- If no Pi binary is available, the script prints an explicit skip message; default CI installs the Pi dev dependency, so `npm run validate` exercises the real Pi loading path.

## Result

- `npm run validate` passed.
- `npm run smoke:pi` loaded BranchMe through Pi and confirmed non-mutating BranchMe command output.
- `npm run check:pack` confirmed the package contents are limited to public docs, images, source, license, package metadata, and `tsconfig.json`.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe status output instead of template behavior.
- The bare `pi --no-extensions -e .` smoke command exited cleanly in this non-interactive validation environment.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was also used so the smoke test could exit without leaving an interactive TUI session open.
