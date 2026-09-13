# Git Repository Initialization Tool

> Historical note (completed, updated 2026-09-13): this task records the implemented `init_repository` addition. Use `README.md`, `SECURITY.md`, and `docs/STRUCTURE.md` for the current `0.3.1` package contract.

### 1. Add verified current-directory repository initialization

- [x] Add a strict `init_repository` tool that initializes and verifies pi's exact current working directory without exposing arbitrary filesystem or repository-mode controls.

#### Why

BranchMe can manage an existing repository but cannot initialize a new project directory. Agents otherwise need an unrestricted shell command before the repository-scoped workflow can begin.

#### How

- Accept only optional `initialBranch`, defaulting to `main`.
- Canonicalize and validate the existing current directory.
- Reject filesystem root, existing `.git` entries, reinitialization, and nested repositories.
- Run argv-style `git init --no-template --initial-branch <name>` in the exact canonical directory.
- Verify an in-place non-bare `.git` directory, requested unborn branch, exact repository root, and absence of a commit.
- Create no README, `.gitignore`, remote, user configuration, staged content, or initial commit.
- Use Pi's file-mutation queue for the new `.git` entry, serialize initialization by canonical target directory and leave uncertain partial state for explicit inspection rather than automatic deletion.
- Register strict schema and prompt guidance, and update documentation/runtime inventories.

#### Where

- `src/constants.ts`
- `src/types.ts`
- `src/git.ts`
- `src/tools/branchme-tools.ts`
- `src/commands/branchme-command.ts`
- `src/ui/branchme-panel.ts`
- `test/`
- `scripts/`
- Public documentation

#### Acceptance criteria

- Empty input creates a verified non-bare repository with unborn `main`.
- A valid custom `initialBranch` is honored.
- Existing and nested repositories are rejected before `git init`.
- The schema rejects path, bare, template, shared, remote, commit, and project-file controls.
- Tool registration, real-Git integration, TypeScript, formatting, tests, smoke checks, and package checks pass.
