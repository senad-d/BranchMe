<p align="center">
  <img alt="BranchMe icon" src="img/icon.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@senad-d/branchme"><img alt="npm" src="https://img.shields.io/npm/v/%40senad-d%2Fbranchme?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  Current-repository branch and pull request tools for <a href="https://pi.dev">pi</a>.
</p>

---

BranchMe is a minimal Pi extension for branch workflow automation. It adds one informational slash command and four agent-callable tools that inspect the current repository, create a branch from current `HEAD`, push the current branch, and create a GitHub pull request.

BranchMe intentionally does **not** stage files, create commits, edit working-tree files, or generate commit messages.

## Installation

From a local checkout:

```bash
git clone https://github.com/senad-d/branchme.git
cd branchme
npm install
npm run validate
pi --no-extensions -e .
```

After package publication:

```bash
pi install npm:@senad-d/branchme
cd /path/to/your/git/repo
pi
```

## Usage

Inside Pi:

```text
/branchme
/branchme help
```

Slash commands are informational only. Ask the agent to use BranchMe tools for actions, for example:

```text
Use branch_status, then create a branch named feature/update-docs.
Push the current branch with push_branch.
Create a draft pull request from feature/update-docs to main titled "Update docs" with this body: "...".
```

## Command

| Command | Behavior |
| --- | --- |
| `/branchme` | Shows a compact status panel/fallback with current branch, GitHub repository resolution, token presence, and workflow notes. |
| `/branchme help`, `/branchme --help`, `/branchme -h` | Shows concise BranchMe workflow help. |

The command never creates branches, pushes, commits, stages, edits files, or opens pull requests.

## Tools

| Tool | Schema | Behavior |
| --- | --- | --- |
| `branch_status` | `{}` | Read-only git status: repo root, current branch/detached state, upstream, dirty state, ahead/behind counts, and GitHub repository when resolvable. |
| `create_branch` | `{ "branchName": string }` | Validates `branchName`, rejects existing local branches, and runs `git switch -c <branchName>` from current `HEAD`. |
| `push_branch` | `{}` | Pushes the current branch with `git push`, or publishes it with `git push --set-upstream origin <currentBranch>` when no upstream exists. |
| `pull_request` | `{ "headBranch": string, "baseBranch": string, "title": string, "body": string, "draft": boolean }` | Creates a GitHub pull request in the resolved current repository via `POST /repos/{owner}/{repo}/pulls`. |

All schemas reject additional properties. `pull_request` never accepts `owner` or `repo`; BranchMe resolves the repository from local `origin` and/or matching `GITHUB_REPOSITORY`.

## Environment variables

`pull_request` reads tokens from the process environment only:

- `GITHUB_TOKEN` (preferred)
- `GH_TOKEN` (fallback)
- `GITHUB_REPOSITORY` (`owner/repo`, optional CI fallback and boundary check)

BranchMe does not read `.env` files and redacts token values from errors and tool details.

## GitHub Actions example

```yaml
name: branchme-smoke
on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  branchme:
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GITHUB_REPOSITORY: ${{ github.repository }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g --ignore-scripts @earendil-works/pi-coding-agent
      - run: pi --no-extensions -e npm:@senad-d/branchme --help
```

Use BranchMe from Pi prompts or automation that drives Pi with explicit tool calls. Ensure the token has permission to push branches and create pull requests.

## Current repository boundary

BranchMe operates only on the repository where Pi is running:

- Git commands use `pi.exec("git", args, { cwd: ctx.cwd })` with argv arrays.
- `create_branch` creates from the current `HEAD` only and has no `baseRef` input.
- `push_branch` pushes only the current branch and has no `branchName` input.
- `pull_request` creates PRs only for the resolved current GitHub repository.
- If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, `pull_request` fails closed.

## Development

```bash
npm install
npm run typecheck
npm run test
npm run check:pack
npm run validate
pi --no-extensions -e .
```

Smoke-test notes are recorded in [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md), and TUI/help captures are stored in [`docs/TUI_CAPTURE.md`](docs/TUI_CAPTURE.md). Refresh TUI captures intentionally with `UPDATE_TUI_CAPTURE=1 node --test test/tui-capture.test.mjs`. `npm run check:pack` verifies the npm package does not include local state, specs, caches, `node_modules`, or environment files.

## Troubleshooting

| Problem | Try |
| --- | --- |
| Not a git repository | Start Pi from inside a git checkout. |
| Detached HEAD | Checkout a branch before `create_branch` or `push_branch`. |
| Branch already exists | Choose a new local branch name. |
| PR auth fails | Set `GITHUB_TOKEN` or `GH_TOKEN`. |
| Repository mismatch | Make `origin` and `GITHUB_REPOSITORY` refer to the same `owner/repo`. |
| Need a commit | Use CommitMe or normal git commands; BranchMe never commits. |
| Other extensions interfere | Test with `pi --no-extensions -e .`. |

## Security

Pi extensions run with your local permissions. See [`SECURITY.md`](SECURITY.md) for BranchMe's git, network, token, and no-telemetry behavior.

## License

MIT
