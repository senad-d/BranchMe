import { captureSelectedFiles, inspectIndex, requireExpectedState, requireSimpleIndex, validateIndexInput, type IndexInput, type IndexRecord } from "./git-index.ts";
import { OBJECT_ID, openGitReader, readGit, resolveReadCommit, safeGitText, type GitAPI, type GitReader } from "./git-read.ts";
import { getGitStatus } from "./git-status.ts";
import { runGit, withRepositoryMutationQueue, type GitCommandContext } from "./git.ts";

export interface RestoreInput extends IndexInput {
  sourceRef?: string;
  preview?: boolean;
  discardChanges?: boolean;
  expectedFiles?: { path: string; fingerprint: string }[];
}
async function previewRestorePath(reader: GitReader, entries: IndexRecord[], files: Map<string, string>, source: string | null, path: string) {
  const entry = entries.find((candidate) => candidate.path === path)!;
  const tree = source === null ? `${entry.mode} blob ${entry.oid}\t${path}\0` : (await readGit(reader, ["--literal-pathspecs", "ls-tree", "-z", source, "--", path])).stdout;
  if (tree && (!/^(?:100644|100755|120000) blob /u.test(tree) || !tree.endsWith(`\t${path}\0`))) throw new Error("Source path is not a supported regular file or symlink.");
  return { path, fingerprint: files.get(path)!, operation: tree ? "replace" : "delete", source: tree ? tree.slice(0, tree.indexOf("\t")) : null };
}
function requireRestoreApproval(input: RestoreInput, source: string | null, files: Map<string, string>): void {
  if (input.discardChanges !== true) throw new Error("Restoration discards local edits. Require explicit discardChanges: true after inspecting the preview.");
  if (source !== null && !OBJECT_ID.test(input.sourceRef!)) throw new Error("Apply must use the full sourceCommit from the preview, not a moving ref.");
  if (!Array.isArray(input.expectedFiles) || input.expectedFiles.length !== input.paths.length || new Set(input.expectedFiles.map((entry) => entry.path)).size !== input.paths.length || input.expectedFiles.some((entry) => !input.paths.includes(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.fingerprint) || files.get(entry.path) !== entry.fingerprint)) throw new Error("Selected working files changed or preview expectations are missing; request a fresh restore_paths preview.");
}
async function restoreInside(host: GitAPI, reader: GitReader, input: RestoreInput) {
  await requireSimpleIndex(reader);
  const before = await inspectIndex(reader);
  const statusBefore = await requireExpectedState(reader, input, false);
  if (input.paths.some((path) => !before.entries.some((entry) => entry.path === path))) throw new Error("restore_paths only restores index-tracked files; untracked/ignored content is protected.");
  const files = await captureSelectedFiles(reader, input.paths);
  const source = input.sourceRef === undefined ? null : await resolveReadCommit(reader, input.sourceRef);
  const preview = await Promise.all(input.paths.map(previewRestorePath.bind(undefined, reader, before.entries, files, source)));
  if (input.preview === true) return { action: "restore_paths", applied: false, head: input.expectedHead, index: input.expectedIndex, sourceCommit: source, expectedFiles: preview.map((entry) => ({ path: entry.path, fingerprint: entry.fingerprint })), preview };
  requireRestoreApproval(input, source, files);
  await requireExpectedState(reader, input, false);
  if (JSON.stringify([...files]) !== JSON.stringify([...await captureSelectedFiles(reader, input.paths)])) throw new Error("Selected files changed during preparation; request a fresh preview.");
  reader.signal?.throwIfAborted();
  try {
    await runGit(host, reader.ctx, ["--no-optional-locks", "--no-lazy-fetch", "--literal-pathspecs", "-c", "core.fsmonitor=false", "restore", "--worktree", "--no-overlay", ...(source ? [`--source=${source}`] : []), "--", ...input.paths], { signal: reader.signal, tokens: reader.tokens });
    const final = { ...reader, signal: undefined };
    const after = await inspectIndex(final);
    const status = await getGitStatus(host, reader.ctx, {}, undefined, reader.tokens);
    const verify = await readGit(final, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--quiet", "--ignore-submodules=all", ...(source ? [source] : []), "--", ...input.paths], true);
    if (before.raw !== after.raw || status.head !== input.expectedHead || status.branch !== statusBefore.branch || status.operations.length || verify.code !== 0) throw new Error("Index/HEAD preservation or selected restoration could not be verified.");
    return { action: "restore_paths", applied: true, head: status.head, index: after.index, sourceCommit: source, paths: preview.map((entry) => ({ path: entry.path, operation: entry.operation })), committed: false };
  } catch (error) { throw new Error(`Restoration may have partially changed selected paths; inspect git_status. No rollback attempted. ${safeGitText(String(error), reader.tokens).slice(0, 2000)}`); }
}
export async function restorePaths(host: GitAPI, ctx: GitCommandContext, input: RestoreInput, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateIndexInput(input, ["sourceRef", "preview", "discardChanges", "expectedFiles"]);
  if (input.preview !== undefined && typeof input.preview !== "boolean") throw new TypeError("preview must be boolean.");
  if (input.discardChanges !== undefined && typeof input.discardChanges !== "boolean") throw new TypeError("discardChanges must be boolean.");
  if (input.expectedFiles !== undefined && (!Array.isArray(input.expectedFiles) || input.expectedFiles.some((entry) => !entry || typeof entry !== "object" || Object.keys(entry).some((key) => !["path", "fingerprint"].includes(key))))) throw new TypeError("Malformed selected-file expectations.");
  const reader = await openGitReader(host, ctx, input.worktreePath, signal, tokens);
  return withRepositoryMutationQueue(reader.ctx.cwd, restoreInside.bind(undefined, host, reader, input));
}
