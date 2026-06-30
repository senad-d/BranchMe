# Contributing

## Development setup

BranchMe requires Node.js `>=22.19.0`.

```bash
npm install
npm run validate
```

Useful commands:

```bash
npm run typecheck
npm run test
npm run check:pack
pi --no-extensions -e .
```

## Preparation status

The repository is currently prepared for BranchMe, but feature implementation is pending. Start with the approved brief and specs before writing feature code:

- `docs/PROJECT_DEFINITION_BRIEF.md`
- `specs/spec-architecture.md`
- `specs/spec-guidelines.md`
- `specs/spec-tasks.md`

Do not mark task checkboxes complete unless you are in a later implementation session and have completed the matching task with validation.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Update README/docs/examples when commands, tools, settings, packaging, or security behavior changes.
- Run `npm run validate` before requesting review, or explain why it could not be run.
- Do not commit secrets, local `.pi/` state, generated package tarballs, `node_modules/`, or machine-local paths.

## Security expectations

BranchMe's planned behavior includes local git commands and GitHub REST API calls. Treat changes that execute shell commands, read files, write files, push branches, call the network, or handle credentials as security-sensitive and document the behavior.
