# Merge workflow diff review

### 1. Review and harden kept-merge conclusion

- [x] Fix confirmed diff defects, add regression coverage, and verify local and Sonar quality checks.

#### Why

A staged conflict can evade an unmerged-only marker check. Custom-sized, CRLF, and binary marker lines must not be committed accidentally. Multi-head merges and lost commit responses must not produce misleading success receipts.

#### How

Check working-tree conflict paths and the candidate index, including clean-filter output; recognize default and configured marker sizes; reject multi-head merges before mutation; honor pre-mutation cancellation and bound uncertain diagnostics. Align the changelog version and document that Git commits the complete index, including already-staged merge entries.

#### Where

- `src/git-integration.ts`, `src/git.ts`, `src/tools/workflow-tools.ts`
- `test/workflow.test.mjs`
- `CHANGELOG.md`, `README.md`, `SECURITY.md`, `docs/STRUCTURE.md`

#### Acceptance criteria

- Staged, custom-sized, diff3, CRLF, binary, and filter-injected conflict markers are refused.
- Resolved deletions and literal special filenames conclude safely; unrelated unstaged files are preserved.
- Multi-head merges and cancellation are refused before mutation; lost commit responses require inspection.
- The package and unreleased changelog versions agree.
- Full release validation and fresh coverage pass.
- Sonar analysis completes with a passing quality gate, zero active issues, and no security hotspots requiring review.

#### Validation receipt

- `npm run release:check` passed: typecheck, formatting, all 320 tests, Pi runtime/context smoke, script/package checks, isolated worktree handoff, and installed-production-package smoke.
- `npm run test:coverage` passed with 320 tests and 95.40% local line coverage.
- Fixed Sonar `typescript:S9382` by starting the bounded independent marker-size checks concurrently; a real-Git regression proves both groups start before awaiting either result.
- Final Sonar analysis `AaENlRglJaue_doG-3M9` completed with a passing quality gate, 93.2% Sonar coverage, zero active issues, zero bugs/vulnerabilities/code smells, and no security hotspots requiring review.
- Scanner warnings about missing blame apply to uncommitted changed files; no commit, push, or user-repository branch/ref mutation was performed.
