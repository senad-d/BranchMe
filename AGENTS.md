# AGENTS.md

## Purpose

BranchMe is an extension for developers and coding agents who need verified Git and GitHub operations for repositories, commits, branches, linked worktrees, and pull requests.

## Commands

Run from the repository root. There is no separate build step.

| Action | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Test the whole suite | `npm run test` |
| Test one file | `node --test test/truncation.test.mjs` |
| Lint | `npm run lint` |
| Start for local development | `npm run dev` |

## Layout

- [`.github/`](.github/) — issue forms, pull request template, and repository automation.
- [`.pi/`](.pi/) — repository-local automation settings.
- [`dev-shims/`](dev-shims/) — development runtime stubs and type declarations.
- [`docs/`](docs/) — project guides and validation references.
- [`img/`](img/) — project icons and demo media.
- [`scripts/`](scripts/) — validation and release scripts.
- [`specs/`](specs/) — design and planning history.
- [`src/`](src/) — extension implementation.
- [`test/`](test/) — automated tests and shared helpers.

## Rules

- Focus on completing one task at a time and mark it with an "x" when the acceptance criteria are met.
- Avoid nesting functions.
- Regenerate `docs/TUI_CAPTURE.md` as directed in its header; do not edit the generated capture by hand. Update installed dependencies through the package manager, not by editing `node_modules/`.
- Follow the [credential setup](README.md#configuration) for secrets and repository-root `.env` files; keep `.env.example` safe to share.

Task golden standard example:
```
### 1. <task_name>

- [ ] <task_description>

#### Why
<why>

#### How
<how>

#### Where
<where>

#### Acceptance criteria
- <criteria_list>
```

## Documents

- [README](README.md) — read for setup, configuration, and public behavior.
- [Contributing](CONTRIBUTING.md) — read before preparing a change for review.
- [Testing](docs/testing.md) — find the exact check to run and what it covers.
- [Structure guide](docs/STRUCTURE.md) — find module boundaries and implementation conventions.
- [Project definition](docs/PROJECT_DEFINITION_BRIEF.md) — read for scope, non-goals, and design decisions.
- [Security](SECURITY.md) — consult before changing credential, repository, filesystem, or network boundaries.
- [Git operations without a shell](docs/SHELL_FREE_WORKFLOWS.md) — look up operation-specific preconditions and safeguards.
- [Smoke test notes](docs/SMOKE_TEST.md) — see how runtime and installed-package behavior are exercised.
- [Terminal UI capture](docs/TUI_CAPTURE.md) — compare user-facing output or refresh the generated baseline.
- [Changelog](CHANGELOG.md) — check what shipped in each release.