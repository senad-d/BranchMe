<p align="center">
  <img alt="BranchMe logo" src="img/icon.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@senad-d/branchme"><img alt="npm" src="https://img.shields.io/npm/v/%40senad-d%2Fbranchme?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  Current-repository branch and pull request tools for <a href="https://pi.dev">pi</a>.
  <br />Inspect branch state, switch/create branches, push, and open GitHub PRs from pi prompts.
</p>

---

BranchMe is a Pi extension for safe branch workflow automation. It adds an informational `/branchme` command and five agent-callable tools that inspect the current repository, switch to an existing local branch, create a branch from the current `HEAD`, push the current branch, and create a GitHub pull request.

<table align="center">
  <tr>
    <th>BranchMe demo</th>
  </tr>
  <tr>
    <td align="center">
      <img src="img/demo.gif" alt="BranchMe demo: inspect branch status and use branch workflow tools in pi" title="BranchMe demo" width="760">
    </td>
  </tr>
</table>

- **Current-repository only:** Git and GitHub operations are scoped to the checkout where pi is running.
- **Commit-safe:** BranchMe never stages files, creates commits, generates commit messages, rebases, merges, resets, or edits files directly.
- **Strict tools:** tool schemas reject extra properties such as `force`, `stash`, `discard`, `owner`, `repo`, `path`, or `baseRef`.
- **PR-ready:** create GitHub pull requests with explicit PR fields and `GITHUB_TOKEN` or `GH_TOKEN` from the process environment or a local `.env` fallback.

> **Security:** pi packages run with your full system permissions. BranchMe can run local `git` commands, switch/create branches, push the current branch, and call the GitHub REST API to create pull requests. Read [`SECURITY.md`](SECURITY.md).

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Repository and GitHub Setup](#repository-and-github-setup)
- [Configuration](#configuration)
- [Commands](#commands)
- [Tools](#tools)
- [Workflow and Boundaries](#workflow-and-boundaries)
- [GitHub Actions](#github-actions)
- [Troubleshooting](#troubleshooting)
- [Diagnostics](#diagnostics)
- [Update and Uninstall](#update-and-uninstall)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Quick Start

```bash
pi install npm:@senad-d/branchme
cd /path/to/your/git/repo
pi
```

Inside pi:

```text
/branchme
/branchme help
```

Ask the agent to use BranchMe tools explicitly, for example:

```text
Use branch_status, then create a branch named feature/update-docs with create_branch.
```

A typical BranchMe flow is:

1. Inspect state with `branch_status`.
2. Switch with `change_branch` or create from current `HEAD` with `create_branch`.
3. Make edits and commit outside BranchMe.
4. Push the current branch with `push_branch`.
5. Create a GitHub pull request with `pull_request`.

BranchMe is tool-based. The slash command is informational only and never changes branches, pushes, commits, stages, edits files, or opens pull requests.

---

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:@senad-d/branchme` | Loads in every trusted pi project. |
| Project-local | `pi install npm:@senad-d/branchme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:@senad-d/branchme` | Try without changing settings. |
| Git | `pi install git:github.com/senad-d/branchme@<tag>` | Pin a tag or commit. |
| Local checkout | `pi --no-extensions -e .` | Develop or test this repository in isolation. |

Source checkout:

```bash
git clone https://github.com/senad-d/branchme.git
cd branchme
npm install --ignore-scripts
npm run validate
pi --no-extensions -e .
```

Use the checkout globally while developing:

```bash
pi install /absolute/path/to/branchme
```

---

## Repository and GitHub Setup

BranchMe does not bundle Git and does not create repositories. Start pi from inside the repository you want BranchMe to manage:

```bash
cd /path/to/your/git/repo
git status
git remote get-url origin
pi
```

For pull requests, the repository must resolve to GitHub from local `origin` and/or `GITHUB_REPOSITORY`:

```bash
git remote set-url origin git@github.com:OWNER/REPO.git
# or
export GITHUB_REPOSITORY=OWNER/REPO
```

For `pull_request`, set a token in the process environment before starting pi:

```bash
export GITHUB_TOKEN=github_pat_...
# or
export GH_TOKEN=ghp_...
pi
```

Or copy `.env.example` to `.env` in the directory where you start pi and fill in one token value:

```bash
cp .env.example .env
$EDITOR .env
pi
```

`push_branch` uses your normal Git remote credentials. BranchMe does not inject `GITHUB_TOKEN` into `git push`.

---

## Configuration

BranchMe has no project config file. It reads process environment variables for GitHub pull request creation and optional repository boundary checks, with a local `.env` token fallback when no process token is set. Token lookup checks `process.env.GITHUB_TOKEN`, then `process.env.GH_TOKEN`; if neither is set, BranchMe reads `.env` from the directory where pi is running and checks `GITHUB_TOKEN`, then `GH_TOKEN`.

| Variable | Meaning |
| --- | --- |
| `GITHUB_TOKEN` | Preferred token for `pull_request`; process environment first, then local `.env` fallback. |
| `GH_TOKEN` | Fallback token for `pull_request`; process environment first, then local `.env` fallback. |
| `GITHUB_REPOSITORY=owner/repo` | Optional CI fallback and boundary check for the current GitHub repository; process environment only. |

BranchMe reads only `GITHUB_TOKEN` and `GH_TOKEN` from `.env`; it does not import other `.env` keys. BranchMe does not read shell profiles, GitHub CLI credentials, or local credential stores. Token values are redacted from errors, tool content, and tool details.

If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, `pull_request` fails closed.

---

## Commands

| Command | Description |
| --- | --- |
| `/branchme` | Show a compact status panel or fallback message with current branch, GitHub repository resolution, token presence, and workflow notes. |
| `/branchme help` | Show concise BranchMe workflow help and runtime requirements. |
| `/branchme --help` | Alias for `/branchme help`. |
| `/branchme -h` | Alias for `/branchme help`. |

Commands are informational only. BranchMe actions are performed by agent-callable tools.

---

## Tools

| Tool | Schema | Behavior |
| --- | --- | --- |
| `branch_status` | `{}` | Read-only git status: repo root, current branch or detached state, upstream, dirty state, ahead/behind counts, and GitHub repository when resolvable. |
| `change_branch` | `{ "branchName": string }` | Validates `branchName`, requires `refs/heads/<branchName>` to exist locally, rejects dirty worktrees, and runs `git switch <branchName>`. |
| `create_branch` | `{ "branchName": string }` | Validates `branchName`, rejects existing local branches, and runs `git switch -c <branchName>` from current `HEAD`. |
| `push_branch` | `{}` | Pushes the current branch with `git push`, or publishes it with `git push --set-upstream origin <currentBranch>` when no upstream exists. |
| `pull_request` | `{ "headBranch": string, "baseBranch": string, "title": string, "body": string, "draft": boolean }` | Creates a GitHub pull request in the resolved current repository via `POST /repos/{owner}/{repo}/pulls`. |

All schemas reject additional properties. `change_branch` never accepts `baseRef`, `force`, `stash`, `discard`, `create`, `owner`, `repo`, or path inputs. `pull_request` never accepts `owner` or `repo`; BranchMe resolves the repository from local `origin` and/or matching `GITHUB_REPOSITORY`.

---

## Workflow and Boundaries

Use BranchMe from pi prompts or automation that drives pi with explicit tool calls:

```text
Use branch_status.
Create branch feature/docs-refresh from the current HEAD with create_branch.
Push the current branch with push_branch.
Create a draft pull request from feature/docs-refresh to main titled "Refresh docs" with this body: "...".
```

BranchMe operates only on the repository where pi is running:

- Git commands use `pi.exec("git", args, { cwd: ctx.cwd })` with argv arrays.
- `change_branch` switches only to existing local branches and has no `force`, `stash`, `discard`, remote, or path input.
- `create_branch` creates from the current `HEAD` only and has no `baseRef` input.
- `push_branch` pushes only the current branch and has no `branchName` input.
- `pull_request` creates PRs only for the resolved current GitHub repository.
- If local `origin` and `GITHUB_REPOSITORY` both resolve but disagree, `pull_request` fails closed.

BranchMe intentionally does **not** stage files, create commits, force checkout, stash changes, discard changes, edit files directly, or generate commit messages.

---

## GitHub Actions

GitHub Actions example:

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

Ensure the token and Git credentials have permission for the branch and pull request operation you ask BranchMe to perform.

---

## Troubleshooting

| Problem | Try |
| --- | --- |
| Not a git repository | Start pi from inside a git checkout. |
| Detached `HEAD` | Use `change_branch` to switch to an existing local branch, or checkout a branch before `create_branch` or `push_branch`. |
| Branch already exists | Choose a new local branch name for `create_branch`, or use `change_branch` to switch to it. |
| Branch does not exist locally | Create a local branch first; `change_branch` does not checkout remote branches. |
| Dirty worktree before branch switch | Commit, stash, or discard changes outside BranchMe before using `change_branch`. |
| Push fails | Confirm the current branch is correct and your normal Git remote credentials can push. |
| PR auth fails | Set `GITHUB_TOKEN` or `GH_TOKEN` before starting pi, or copy `.env.example` to `.env` and fill in one token. |
| Repository mismatch | Make `origin` and `GITHUB_REPOSITORY` refer to the same `owner/repo`. |
| Need a commit | Use CommitMe or normal git commands; BranchMe never commits. |
| Other extensions interfere | Test with `pi --no-extensions -e .`. |

---

## Diagnostics

From a source checkout:

```bash
npm run validate
npm run check:pack
printf '/branchme help\n/quit\n' | pi --no-extensions -e .
```

Validation covers TypeScript typechecking, unit tests, package checks, and package-content verification. Smoke-test notes are recorded in [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md), and TUI/help captures are stored in [`docs/TUI_CAPTURE.md`](docs/TUI_CAPTURE.md).

Refresh TUI captures intentionally with:

```bash
UPDATE_TUI_CAPTURE=1 node --test test/tui-capture.test.mjs
```

---

## Update and Uninstall

```bash
pi update --extensions                  # update installed pi packages
pi update npm:@senad-d/branchme        # update BranchMe only
pi remove npm:@senad-d/branchme        # remove global install
pi remove npm:@senad-d/branchme -l     # remove project-local install
```

---

## Development

```bash
npm install
npm run typecheck
npm run test
npm run format:check
npm run check:pack
npm run validate
pi --no-extensions -e .
```

`npm run check:pack` verifies the npm package does not include local state, specs, caches, `node_modules`, real environment files, or other private development artifacts. The safe `.env.example` template is included.

---

## Publishing

BranchMe publishes to npm as `@senad-d/branchme`. You need an npm account with publish access to the `@senad-d` scope.

```bash
npm login
npm whoami
node scripts/publish-npm.mjs
```

The publish script requires a clean working tree, asks for the version number, validates the package, runs `npm version <version>` to update `package.json` and `package-lock.json`, creates the `v<version>` git tag, publishes with `npm publish --access public`, and then offers to push the release commit and tag.

Run it only from a clean working tree after updating `CHANGELOG.md`.

## License

MIT
