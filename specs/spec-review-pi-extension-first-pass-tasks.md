# First-pass Pi extension review tasks

## Review scope and date

- Date: 2026-06-30
- Pass focus: security, runtime bugs, high-risk correctness, dependency/package risks, secret-handling paths, unsafe inputs, async flows, and Pi extension registration.
- Target project: `/Users/senad/Documents/Code/Moj_git/pi-branchme`

## Files or areas reviewed

- Pi extension docs consulted: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- Skill instructions: `/Users/senad/Documents/Code/Moj_git/pi-code/.pi/skills/review-pi-extension/SKILL.md`, `first-pass.md`, `second-pass.md`, `final-pass.md`
- Package and validation: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.github/workflows/ci.yml`, `.github/dependabot.yml`
- Extension entry points and public surface: `src/extension.ts`, `src/constants.ts`, `src/tools/branchme-tools.ts`, `src/commands/branchme-command.ts`, `src/ui/branchme-panel.ts`
- Security-sensitive helpers: `src/git.ts`, `src/github.ts`, `src/redaction.ts`, `src/types.ts`
- Validation and release scripts: `scripts/check-format.mjs`, `scripts/check-package-contents.mjs`, `scripts/smoke-pi-runtime.mjs`, `scripts/publish-npm.mjs`, `trivy_scan.sh`
- Tests: `test/command.test.mjs`, `test/git.test.mjs`, `test/git-integration.test.mjs`, `test/github.test.mjs`, `test/preparation.test.mjs`, `test/schema-validation.test.mjs`, `test/tools.test.mjs`, `test/tui-capture.test.mjs`
- Docs: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/STRUCTURE.md`, `docs/PROJECT_DEFINITION_BRIEF.md`, `docs/SMOKE_TEST.md`, `docs/TUI_CAPTURE.md`

## Safe commands run and results

- `ls -la` — passed; confirmed project layout and noted a local `.env` file exists but was not read.
- `git ls-files | sort | head -250` — passed; mapped tracked project files.
- `npm run typecheck` — passed.
- `npm test` — passed, 85 tests.
- `npm run format:check` — passed, 46 files checked.
- `npm run check:pack` — passed; dry-run package contained 22 files and did not include `.env.example`.
- `npm run smoke:pi` — passed; loaded BranchMe with `pi --no-extensions -e <package>` and observed non-mutating command output.
- `npm audit --omit=dev --audit-level=moderate` — passed, 0 vulnerabilities.
- `npm run validate` — passed; repeated typecheck, format check, tests, Pi smoke, syntax check, and package-content check.
- `test -f .env.example; echo env_example_exists=$?` — returned `env_example_exists=1`, confirming the documented/package-listed example file is missing.
- `rg -n ...` targeted source/docs/scripts searches — passed; used for location evidence.

## Findings summary by severity

- Critical: 0
- High: 0
- Medium: 2
  - Missing documented `.env.example` token template and missing package required-file assertion.
  - Release smoke validates the checkout with development dependencies, not an installed production package artifact.
- Low: 0

## Ordered tasks

- [x] Restore the packaged `.env.example` token template and assert required package files

#### Why

`README.md:146-150` tells users to copy `.env.example` to `.env`, `README.md:323` says the safe template is included, and `package.json:29-31` lists `.env.example` in the package `files`. The file is absent (`test -f .env.example` returned `1`), and `npm run check:pack` still passed while the dry-run package omitted it. This creates a setup bug in the credential path and lets documentation/package drift bypass validation.

#### How to resolve

- Add a safe root-level `.env.example` containing only comments and empty placeholders for `GITHUB_TOKEN=` and `GH_TOKEN=`; do not include real-looking token values.
- Update `scripts/check-package-contents.mjs` to assert required public files are present in `npm pack --dry-run --json` output, including `.env.example`.
- Add or update tests in `test/preparation.test.mjs` or a focused package-content test so the missing template fails validation before publish.
- Re-run `npm run check:pack`, `npm run test`, and `npm run validate`.

#### Acceptance criteria

- `.env.example` exists at the repository root with placeholder-only token guidance and no credential-looking value.
- `npm run check:pack` output includes `.env.example` and still excludes real `.env` files, `.pi/`, `node_modules/`, specs, caches, reports, and tarballs.
- A validation test or package-content assertion fails if `.env.example` is deleted or omitted from the dry-run package.
- `npm run validate` passes after the package/template checks are updated.

- [x] Add a production installed-package smoke check for the packed artifact

#### Why

`scripts/smoke-pi-runtime.mjs:9-10` resolves the source checkout and local Pi binary, and `scripts/smoke-pi-runtime.mjs:101` loads `repoRoot` with `pi -e`. That proves the development checkout loads with the current `node_modules`, but it does not prove the packed npm artifact installs and runs with production dependencies only. Missing package files or runtime imports can therefore pass current validation and fail after publish.

#### How to resolve

- Add a safe temp-directory smoke path that creates a package tarball outside the repo, installs it with production dependency settings, and runs Pi against the installed package in an isolated workspace.
- Keep the smoke credential-free by removing `GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_REPOSITORY`, and keep all install/package outputs under a temporary directory.
- Assert that `/branchme help` or another non-mutating BranchMe command is observed from the installed artifact.
- Decide whether this check runs in `npm run validate` by default or as a separate documented release gate if runtime cost is too high.

#### Acceptance criteria

- A command exists that installs the packed BranchMe artifact into a temporary location without relying on the repository `node_modules` tree.
- The installed-artifact smoke fails with an actionable error when a runtime import or required packaged file is missing.
- The smoke command does not read credentials, contact GitHub, mutate the source checkout, or leave package artifacts in the repository.
- The release/validation documentation names the new installed-package smoke command and when maintainers must run it.

## Blocked checks or areas not reviewed

- The local `.env` file was intentionally not read.
- `trivy_scan.sh` was not run because it requires the Trivy CLI and writes cache/report directories (`.trivycache`, `trivy-reports/`).
- Live GitHub PR creation, live push behavior, and credentialed API paths were not run because they require credentials and mutate external state.
- A full installed-artifact smoke was not run during review; it is captured as a task above.
