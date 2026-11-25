# BranchMe Testing

Run these checks from the root of a repository checkout with the development dependencies installed. See the [smoke test notes](SMOKE_TEST.md) for how the runtime checks are isolated.

| Check | Command | Covers |
| --- | --- | --- |
| Type check | `npm run typecheck` | TypeScript in `src/`, using `tsconfig.json` without emitting files. |
| Format check | `npm run format:check` | Line endings, final newlines, trailing whitespace, and JSON syntax in the source, tests, scripts, docs, and other files selected by `scripts/check-format.mjs`. |
| Script syntax | `npm run check` | JavaScript syntax of the validation, smoke, and publishing scripts listed in `package.json`. |
| Lint | `npm run lint` | Type check, format check, and script syntax together. |
| Full test suite | `npm run test` | All `test/*.test.mjs`, including unit tests and integration tests against disposable Git repositories. |
| Single test file | `node --test test/truncation.test.mjs` | Example focused check for bounded output, including multibyte character handling. |
| Terminal UI baseline | `node --test test/tui-capture.test.mjs` | Compares rendered help and panels with `docs/TUI_CAPTURE.md`. |
| Test coverage | `npm run test:coverage` | Runs the full test suite with Node coverage and writes `coverage/lcov.info` for CI analysis. |
| Checkout runtime smoke | `npm run smoke:pi` | Extension loading, tool registration, Git context delivery, and shell-free scenarios. |
| Shell-free workflow smoke | `npm run smoke:shell-free` | History, index and worktree operations, conflict inspection, and mocked GitHub operations without shell tools available to the model. |
| Worktree handoff smoke | `npm run smoke:worktree-handoff` | Isolated linked-worktree creation, handoff to a separate process, and removal with the branch retained. |
| Package dry run | `npm run pack:dry-run` | Prints the prospective npm tarball manifest as JSON without creating a tarball. |
| Package contents | `npm run check:pack` | Verifies required public files are included in the npm tarball and private or generated files are excluded. |
| Checkout validation | `npm run validate` | CI gate: type check, format check, full test suite, checkout runtime smoke, script syntax, package contents, and worktree handoff. |
| Installed-package smoke | `npm run smoke:pi:packed` | Packs the release artifact, installs it in an isolated production workspace, and loads the installed extension. |
| Release validation | `npm run release:check` | Checkout validation plus installed-package smoke. |
