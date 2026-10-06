# Remote branch discovery without shell access

### 1. Refresh and optionally prune one remote's branch cache

- [x] Add `fetch_remote` with optional configured `remote` (default `origin`) and boolean `prune` (default `false`).

#### Why
Agents cannot discover unknown issue branches with `fetch_branch`, which requires an exact branch or configured upstream. Cached discovery alone can miss newly published branches or retain deleted ones.

#### How
Fetch all remote heads into only `refs/remotes/<remote>/*` using an internal refspec, explicit prune policy, atomic ref updates, no tags or submodules, and an empty configured refmap. Validate configured remote identity, non-overlapping remote namespaces, and symbolic destinations (including dangling loose refs) before mutation; require the files ref backend. Serialize on both the active-root and common Git directory queues. Preserve conventional same-namespace remote HEAD aliases; exclude the remote branch named HEAD from the wildcard mapping to prevent alias writes.

#### Where
`src/git-discovery.ts`, `src/constants.ts`, `src/types.ts`, `src/tools/branchme-tools.ts`, tests and public documentation.

#### Acceptance criteria
- Strict schema; invalid remotes and prune values fail before fetch.
- New branches are discovered, rewritten branch tips refresh, and deleted tracking refs are pruned only when requested.
- Local refs, tags, other remotes, HEAD, upstream settings, index, and dirty worktree files remain untouched even with hostile fetch/prune configuration.
- Symbolic destinations outside the conventional safe HEAD alias fail closed; errors are bounded and redacted.
- Unit, real-Git, schema, and runtime registration tests pass.

### 2. Filter cached branch discovery

- [x] Extend `list_branches` with optional `kind` and bounded Git branch-list `patterns`.

#### Why
Issue #23 needs `origin/feat/23` and `origin/feat/23-*`, not an unfiltered inventory whose 200-entry limit may hide relevant branches.

#### How
Keep `{}` compatible. Delegate pattern matching to Git's branch-list glob semantics on local names and remote-tracking names (including the remote prefix). Filter before parsing and entry limits; preserve upstream counts, symbolic refs, and occupancy.

#### Where
`src/git.ts`, `src/types.ts`, `src/tools/branchme-tools.ts`, tests and public documentation.

#### Acceptance criteria
- Exact and wildcard issue patterns match, without accidentally matching `feat/230` or unrelated refs.
- Local-only, remote-only, combined, overlapping-pattern, and empty results are tested.
- Filters are applied before entry limits; display redaction, raw limits, and occupancy remain intact.
- Documentation gives the sequential tool-native replacement for the reported commands.

### 3. Validate the complete extension

- [x] Run checkout and installed-package validation and review the diff.

#### Why
New tool registration and schemas must remain consistent across prompt contracts, help, documentation, smoke verifiers, and production package loading.

#### How
Run focused tests, then `npm run release:check`.

#### Where
Repository-wide.

#### Acceptance criteria
- Typecheck, formatting, all tests, runtime/context smoke, packaging, worktree handoff, and installed-package smoke pass.
- No fetch, prune, checkout, commit, or push is performed on the user's real repository during validation.

#### Validation receipt
`npm run release:check` passed: typecheck, formatting, all 334 tests, Pi runtime/context smoke, script checks, package-content verification, isolated worktree handoff, and installed-production-package smoke. Fourteen focused remote-discovery tests cover the reported sequential workflow, hostile fetch/prune configuration, rewritten tips, dirty/detached checkout preservation, packed stale refs, empty remotes, safe HEAD aliases, unsafe/dangling aliases, overlapping remote namespaces, unsupported ref backends, symlinks, cancellation, malformed/oversized output, bounded redaction, cross-worktree fetch serialization, filtering before limits/redaction, detached pseudo-branch exclusion, occupancy, and strict schemas. Git mutations and network transports were restricted to disposable repositories and local bare remotes; the user's repository was not fetched, pruned, switched, committed, or pushed.
