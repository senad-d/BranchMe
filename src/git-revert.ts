import { inspectIndex, requireSimpleIndex } from "./git-index.ts";
import { getGitStatus } from "./git-status.ts";
import { boundedGitText, OBJECT_ID, openGitReader, readGit, errorText, validateKeys, type GitAPI, type GitReader } from "./git-read.ts";
import { getCurrentBranch, getGitOperationState, isCommitAncestor, runGit, withRepositoryMutationQueue, type GitCommandContext } from "./git.ts";

export interface RevertInput { commit: string; expectedHead: string; expectedIndex: string; worktreePath?: string }
async function revertInside(host: GitAPI, reader: GitReader, input: RevertInput) {
  await requireSimpleIndex(reader);
  const before = await getGitStatus(reader.pi, reader.ctx, {}, reader.signal, reader.tokens);
  if (before.head !== input.expectedHead || before.index !== input.expectedIndex || before.hasChanges) throw new Error("No-commit revert requires fresh HEAD/index expectations and a clean idle checkout.");
  if ((await readGit(reader, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).stdout) throw new Error("No-commit revert refuses ignored local-only files; preserve them outside the checkout first.");
  const metadata = (await readGit(reader, ["rev-list", "--parents", "-n", "1", input.commit, "--"])).stdout.trim().split(" ");
  if (metadata[0] !== input.commit || metadata.length > 2 || !metadata.every(validOid) || !(await isCommitAncestor(reader.pi, reader.ctx, input.commit, input.expectedHead, reader.signal))) throw new Error("Revert requires one non-merge commit already contained in current HEAD.");
  if (metadata[1]) {
    const tree = await readGit(reader, ["ls-tree", "-r", "--format=%(objectmode)", metadata[1]]);
    if (tree.stdout.split("\n").includes("160000")) throw new Error("Reverts introducing gitlinks are unsupported.");
  }
  const branch = (await getCurrentBranch(reader.pi, reader.ctx, reader.signal)).currentBranch;
  const refs = (await readGit(reader, ["show-ref"])).stdout;
  const config = (await readGit(reader, ["config", "--null", "--list"])).stdout;
  await inspectIndex(reader);
  const immediate = await getGitStatus(reader.pi, reader.ctx, {}, reader.signal, reader.tokens);
  if (immediate.head !== before.head || immediate.index !== before.index || immediate.hasChanges) throw new Error("Checkout changed during revert preparation; inspect git_status again.");
  reader.signal?.throwIfAborted();
  let failure: unknown;
  try { await runGit(host, reader.ctx, ["--no-lazy-fetch", "-c", "rerere.enabled=false", "revert", "--no-commit", input.commit], { signal: reader.signal, timeout: 120000, tokens: reader.tokens }); }
  catch (error) { failure = error; }
  const final = { ...reader, signal: undefined };
  if (failure) {
    await recoverRevert(host, final, input, before, branch, refs, config);
    throw new Error(`Revert failed; automatic abort/restoration was verified. ${boundedGitText(errorText(failure), reader.tokens, 2000).text}`);
  }
  return verifyRevert(host, final, input, before, branch, refs, config);
}
type RevertStatus = Awaited<ReturnType<typeof getGitStatus>>;
async function recoverRevert(host: GitAPI, final: GitReader, input: RevertInput, before: RevertStatus, branch: string | null, refs: string, config: string) {
  try {
    const operation = await getGitOperationState(final.pi, final.ctx);
    if (operation.active.includes("revert")) {
      const reverting = (await readGit(final, ["rev-parse", "--verify", "REVERT_HEAD"])).stdout.trim();
      if (reverting !== input.commit || (await getGitStatus(final.pi, final.ctx)).head !== input.expectedHead) throw new Error("Revert state is not owned by this request.");
      await runGit(host, final.ctx, ["revert", "--abort"], { timeout: 30000, tokens: final.tokens });
    }
    const restored = await getGitStatus(final.pi, final.ctx);
    if (restored.head !== before.head || restored.index !== before.index || restored.hasChanges || restored.operations.length || (await getCurrentBranch(final.pi, final.ctx)).currentBranch !== branch || (await readGit(final, ["show-ref"])).stdout !== refs || (await readGit(final, ["config", "--null", "--list"])).stdout !== config) throw new Error("Restoration was not verified.");
  } catch { throw new Error("Revert recovery is uncertain; stop mutations and inspect git_status/git_conflicts. A person must reconcile the checkout; no reset/stash rollback was attempted."); }
}
async function verifyRevert(host: GitAPI, final: GitReader, input: RevertInput, before: RevertStatus, branch: string | null, refs: string, config: string) {
  const applied = await getGitStatus(final.pi, final.ctx, {}, undefined, final.tokens);
  if (applied.operations.includes("revert")) {
    const reverting = (await readGit(final, ["rev-parse", "--verify", "REVERT_HEAD"])).stdout.trim();
    if (reverting !== input.commit || applied.head !== before.head) throw new Error("Successful inverse has uncertain operation ownership; inspect git_status before continuing.");
    // --no-commit may leave REVERT_HEAD even after a successful application.
    // Quit only the owned operation; unlike abort this preserves the staged inverse.
    await runGit(host, final.ctx, ["revert", "--quit"], { timeout: 30000, tokens: final.tokens });
  }
  const after = await getGitStatus(final.pi, final.ctx, {}, undefined, final.tokens);
  if (after.index !== applied.index || after.head !== before.head || after.operations.length || (await getCurrentBranch(final.pi, final.ctx)).currentBranch !== branch || (await readGit(final, ["show-ref"])).stdout !== refs || (await readGit(final, ["config", "--null", "--list"])).stdout !== config) throw new Error("Revert postconditions are uncertain; inspect git_status before another mutation.");
  return { action: "revert_changes", commit: input.commit, head: after.head, index: after.index, committed: false, stagedPaths: after.entries.map((entry) => entry.path), pathsComplete: after.complete, note: "Inverse changes are staged, not committed. Enumerate git_status for all paths; ordinary commit creation is a separate explicit workflow." };
}
function validOid(value: string): boolean { return OBJECT_ID.test(value); }
export async function revertChanges(host: GitAPI, ctx: GitCommandContext, input: RevertInput, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateKeys(input, ["commit", "expectedHead", "expectedIndex", "worktreePath"]);
  if (typeof input.commit !== "string" || !OBJECT_ID.test(input.commit) || typeof input.expectedHead !== "string" || !OBJECT_ID.test(input.expectedHead) || !/^[a-f0-9]{64}$/u.test(input.expectedIndex)) throw new TypeError("Require a full commit identity and fresh HEAD/index expectations from git_status.");
  const reader = await openGitReader(host, ctx, input.worktreePath, signal, tokens);
  return withRepositoryMutationQueue(reader.ctx.cwd, revertInside.bind(undefined, host, reader, input));
}
