# Version 0.3.17 validation

### 1. Bump the patch version and validate the updated checkout

- [x] Align package metadata to `0.3.17`, run the release checks and fresh coverage, scan with Sonar, and fix findings without discarding existing edits.

#### Why

The ignored-file revert fix already has a `0.3.17` changelog entry, while package metadata still names `0.3.16`. Release readiness requires testing the current checkout rather than relying on earlier analysis.

#### How

Update only the package and lockfile version fields. Run `npm run release:check` and `npm run test:coverage`, then submit a Sonar analysis and wait for processing. Address failures and active findings, rerunning affected checks and scanning the final source.

#### Where

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`
- Source and regression tests if validation identifies issues

#### Acceptance criteria

- Package, root lockfile entry, and latest changelog versions agree on `0.3.17`.
- The complete release gate and fresh coverage tests pass.
- Fresh Sonar processing completes, the quality gate passes, and no active issues or unreviewed security hotspots remain.
- Existing edits are preserved; no repository commit, tag, push, or publication is performed.

#### Validation receipt

- `npm run release:check` passed: typecheck, formatting, all 586 tests, Pi runtime/context/shell-free smokes, script and package checks, worktree handoff, and isolated installed-package smoke.
- `npm run test:coverage` passed all 586 tests with 94.59% local line coverage.
- Sonar analysis for `0.3.17` completed with quality-gate waiting enabled (CE task `AaGCkOxguVw6d8oIrSDe`). The quality gate passed; follow-up queries reported zero active issues, zero security hotspots requiring review, and 92.1% Sonar coverage.
- No additional source fixes were required. The existing revert implementation, regression test, changelog, and security/workflow documentation edits remain intact.
- HEAD and the logical index expectation remained unchanged; no commit, tag, push, or publication was performed.
