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
npm run format:check
npm run test
npm run check:pack
pi --no-extensions -e .
```

## Project status

BranchMe is implemented. The historical preparation specs remain for context, but current behavior is documented in:

- `README.md`
- `SECURITY.md`
- `docs/STRUCTURE.md`
- `docs/PROJECT_DEFINITION_BRIEF.md`

Do not mark task checkboxes complete unless you have completed the matching task with validation.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Update README/docs/examples when commands, tools, settings, packaging, or security behavior changes.
- Run `npm run validate` before requesting review, or explain why it could not be run.
- Do not commit secrets, local `.pi/` state, generated package tarballs, `node_modules/`, or machine-local paths.

## Security expectations

BranchMe behavior includes local git commands and GitHub REST API calls. Treat changes that execute shell commands, read files, write files, push branches, call the network, or handle credentials as security-sensitive and document the behavior.
