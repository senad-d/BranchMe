# BranchMe Smoke Test Notes

Date: 2026-06-30

Validated from the repository checkout with no discovered extensions enabled.

## Commands

```bash
npm run validate
npm run check:pack
printf '/branchme help\n/quit\n' | timeout 15s pi --no-extensions -e .
```

## Result

- `npm run validate` passed.
- `npm run check:pack` confirmed the package contents are limited to public docs, images, source, license, package metadata, and `tsconfig.json`.
- The isolated Pi smoke command loaded BranchMe and displayed BranchMe output instead of template behavior.
- No template command or template tool output was observed.

The piped `pi --no-extensions -e .` form was used so the smoke test could exit without leaving an interactive TUI session open.
