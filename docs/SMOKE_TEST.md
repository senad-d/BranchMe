# BranchMe Smoke Test Notes

Date: 2026-06-30

Validated from the repository checkout with no discovered extensions enabled.

## Commands

```bash
npm run validate
npm run check:pack
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
pi --no-extensions -e .
```

## Result

- `npm run validate` passed.
- `npm run check:pack` confirmed the package contents are limited to public docs, images, source, license, package metadata, and `tsconfig.json`.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe status output instead of template behavior.
- The bare `pi --no-extensions -e .` smoke command exited cleanly in this non-interactive validation environment.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was also used so the smoke test could exit without leaving an interactive TUI session open.
