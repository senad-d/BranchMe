# Plan: Clarify LLM-facing tool guidance

### 1. Improve tool selection without changing the public API

- [x] Rewrite tool descriptions, snippets, and overlapping guidance for clearer LLM tool selection.

#### Why

Lifecycle metaphors and implementation-heavy descriptions obscure scope and side effects. Similar operations need explicit contrasts: local inspection versus remote fetching, upstream pulling versus base merging, and merge execution versus post-merge cleanup. Pi already prefixes prompt snippets with the tool name, so embedding that prefix duplicates it.

#### How

Keep canonical names, parameter shapes, defaults, and execution behavior unchanged. Lead descriptions with the action and target, followed by important prerequisites, side effects, and neighboring-tool distinctions. Use concise single-line snippets without an embedded name prefix; retain explicit tool names in standalone guideline bullets. Consolidate repetition without dropping authorization, data-loss, conflict recovery, or sequencing rules. Add deterministic metadata regression tests and verify actual Pi prompt rendering; these are not a live-model tool-selection evaluation.

#### Where

- `src/tools/branchme-tools.ts`
- `src/tools/workflow-tools.ts`
- `test/tools.test.mjs`, `test/tool-guidance.test.mjs`, and focused metadata tests
- `scripts/smoke-pi-runtime.mjs`
- `README.md`, `docs/STRUCTURE.md`, `docs/SMOKE_TEST.md`, and `CHANGELOG.md`

#### Acceptance criteria

- Every canonical tool retains its name, parameter contract, and implementation behavior.
- Descriptions distinguish tracked diffs from status metadata, cached refs from fresh remote state, local switching from tracking checkout, upstream pull/rebase from remote-base merging, and merge execution from destructive post-merge cleanup.
- `push_branch` no longer implies a caller-supplied target; ancestry guidance permits independent checks as well as sequential post-integration checks.
- Worktree deletion options and merge completion side effects remain explicit; authorization and conflict lifecycle safeguards remain covered.
- Snippets are nonempty single lines, do not repeat their name prefix, and appear with exactly one prefix in the real Pi tools section.
- Unit tests, typechecking, formatting, script checks, package checks, and isolated Pi runtime/model-loop smoke tests pass.

#### Validation receipt

`npm run validate` passed: TypeScript typechecking, formatting, all 426 tests (including 30 new deterministic tool-guidance contracts), actual Pi snippet rendering and model-loop smoke, script syntax checks, package-content dry run, and isolated worktree-handoff smoke. The canonical tool inventory, parameter shapes, defaults, and execution implementations remain unchanged. Guideline bullets were consolidated from 107 to 85 without removing authorization, destructive-option, or conflict-lifecycle safeguards. No live-provider LLM selection evaluation, commit, push, PR mutation, or mutation of the user's repository branches was performed.

### 2. Replace exhaustive prose with minimal sufficient guidance

- [x] Shorten descriptions and rules instead of repeating names, schemas, and documentation.

#### Why

The first pass still used 4,170 words / 29,518 characters of description, snippet, and guideline prose. Most descriptions repeated the tool name and schema, and tests incorrectly required that duplication.

#### How

Use short action/effect descriptions without tool-name prefixes, brief discovery snippets, and only essential safety, authorization, freshness, and sequencing guidelines. Parameter usage stays in schemas. Permit empty guideline lists for simple tools. Remove tests that require exhaustive descriptions; retain checks for dangerous effects and API compatibility.

#### Where

- Tool registrations, metadata tests, and Pi runtime smoke
- Current README, structure/smoke documentation, and changelog

#### Acceptance criteria

- Names, parameter schemas, and execution behavior remain unchanged.
- Descriptions and snippets do not repeat their tool-name prefix; simple tools may have no guidelines.
- Descriptions retain operation scope and non-obvious side effects; essential authorization, destructive-option, and merge lifecycle guidance remains covered.
- Description/snippet/guideline prose is at least 50% smaller by characters than the first pass; report measurements separately from model-token usage.
- Full validation passes.

#### Validation receipt

`npm run validate` passed: all 414 tests, typechecking, formatting, Pi runtime/model-loop smoke, script checks, package-content checks, and isolated worktree handoff. Descriptions shrank from 1,462 to 439 words; total descriptions/snippets/guidelines shrank from 4,170 words / 29,518 characters to 1,287 words / 9,026 characters (about 69% less prose). Serialized metadata including unchanged schemas shrank from 44,338 to 23,760 characters (about 46%); these measurements are not tokenizer-specific counts. Names, schemas, defaults, and execution behavior are unchanged. Essential scope/safety checks remain; tests no longer require redundant names, exhaustive wording, or nonempty guideline lists for simple tools.
