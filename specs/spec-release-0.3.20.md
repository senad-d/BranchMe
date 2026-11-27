# Version 0.3.20 validation

### 1. Bump the patch version and validate the current checkout

- [x] Align package metadata to `0.3.20`, run release checks and fresh coverage, scan with Sonar, and fix findings without discarding existing edits.

#### Why

The current checkout includes a stale `AUTO_MERGE` detection fix. Validate that code and the new patch version together rather than relying on previous analysis.

#### How

Update package and lockfile version fields and add a changelog entry. Run `npm run release:check` and `npm run test:coverage`, then submit a Sonar analysis with quality-gate waiting enabled. Address findings and rerun affected checks and the final scan as needed.

#### Where

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`
- Source and regression tests if validation identifies issues

#### Acceptance criteria

- Package, root lockfile entry, and latest changelog versions agree on `0.3.20`.
- Release checks and fresh coverage tests pass.
- Fresh Sonar processing completes, the quality gate passes, and no active issues or unreviewed security hotspots remain.
- Existing edits are preserved; no commit, tag, push, or publication is performed.

#### Validation receipt

- `npm run release:check` passed: typecheck, formatting, all 589 tests, Pi runtime/context/shell-free smokes, script and package checks, worktree handoff, and isolated installed-package smoke.
- `npm run test:coverage` passed all 589 tests with 94.59% local line coverage.
- Sonar analysis for `0.3.20` completed with quality-gate waiting enabled (CE task `AaIe3RS20uRB5MeaGWEQ`). The quality gate passed; follow-up queries reported zero active issues, zero security hotspots requiring review, and 92.1% Sonar coverage.
- Sonar warned about missing blame information for the uncommitted source and regression test; analysis and the quality gate still completed successfully.
- No additional source fixes were required. Existing changes in `src/git.ts`, `test/git.test.mjs`, and `test/tools.test.mjs` are preserved.
- No commit, tag, push, or publication was performed.
