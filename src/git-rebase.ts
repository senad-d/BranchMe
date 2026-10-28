import { getCurrentBranch, getGitOperationState, getLocalBranchCommit, isCommitAncestor, requireCurrentBranch, resolveWorktreeBaseCommit, runGit, withRepositoryMutationQueue, type GitCommandContext } from "./git.ts";
import { getGitStatus } from "./git-status.ts";
import { boundedGitText, errorText, openGitReader, readGit, safeGitText, validateReadRef, type GitAPI, type GitReader } from "./git-read.ts";

async function otherRefs(reader: GitReader, branch: string): Promise<string> {
  const raw = (await readGit(reader, ["for-each-ref", "--format=%(refname) %(objectname)"])).stdout;
  return raw.split("\n").filter((line) => !line.startsWith(`refs/heads/${branch} `)).join("\n");
}
async function rebaseInside(host: GitAPI, reader: GitReader, baseRef: string) {
  const branch = await requireCurrentBranch(reader.pi, reader.ctx, reader.signal);
  if (safeGitText(branch, reader.tokens) !== branch) throw new Error("Current branch is not a reusable identity.");
  const source = await getLocalBranchCommit(reader.pi, reader.ctx, branch, reader.signal);
  const status = await getGitStatus(reader.pi, reader.ctx, {}, reader.signal, reader.tokens);
  if (status.hasChanges || status.operations.length) throw new Error("Explicit-base rebase requires a clean idle checkout.");
  // Rebase has no no-overwrite-ignore switch. Refuse local-only residue rather than
  // silently allowing Git's intermediate checkouts to overwrite ignored files.
  if ((await readGit(reader, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).stdout) throw new Error("Explicit-base rebase refuses ignored local-only files; preserve them outside the checkout first.");
  const base = await resolveWorktreeBaseCommit(reader.pi, reader.ctx, baseRef, reader.signal);
  const refs = await otherRefs(reader, branch);
  const config = (await readGit(reader, ["config", "--null", "--list"])).stdout;
  reader.signal?.throwIfAborted();
  let failure: unknown;
  try {
    await runGit(host, reader.ctx, ["rebase", "--no-autostash", "--no-update-refs", "--no-autosquash", "--no-rebase-merges", base], { signal: reader.signal, timeout: 120000, tokens: reader.tokens });
  } catch (error) { failure = error; }
  const final = { ...reader, signal: undefined };
  if (failure) {
    try {
      const operation = await getGitOperationState(final.pi, final.ctx);
      if (operation.active.includes("rebase")) await runGit(host, reader.ctx, ["rebase", "--abort"], { timeout: 30000, tokens: reader.tokens });
      if ((await getCurrentBranch(final.pi, final.ctx)).currentBranch !== branch || await getLocalBranchCommit(final.pi, final.ctx, branch) !== source || (await getGitStatus(final.pi, final.ctx)).hasChanges || (await getGitOperationState(final.pi, final.ctx)).active.length || await otherRefs(final, branch) !== refs || (await readGit(final, ["config", "--null", "--list"])).stdout !== config) throw new Error("Restoration could not be verified.");
    } catch { throw new Error("Explicit-base rebase recovery is uncertain. Stop mutations and inspect git_status; a person must resolve any remaining rebase state."); }
    throw new Error(`Rebase failed; restoration was verified. ${boundedGitText(errorText(failure), reader.tokens, 2000).text}`);
  }
  if ((await getCurrentBranch(final.pi, final.ctx)).currentBranch !== branch || !(await isCommitAncestor(final.pi, final.ctx, base, await getLocalBranchCommit(final.pi, final.ctx, branch))) || (await getGitOperationState(final.pi, final.ctx)).active.length || await otherRefs(final, branch) !== refs || (await readGit(final, ["config", "--null", "--list"])).stdout !== config) throw new Error("Rebase postconditions are uncertain; inspect git_status before another mutation.");
  return { action: "rebase_branch", currentBranch: branch, upstream: safeGitText(baseRef, reader.tokens), base, previousHead: source, head: await getLocalBranchCommit(final.pi, final.ctx, branch), publicationWarning: "History was rewritten locally; force-push remains unsupported. Prefer update_from_base for published feature updates." };
}
export async function rebaseOntoBase(host: GitAPI, ctx: GitCommandContext, baseRef: string, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateReadRef(baseRef);
  const reader = await openGitReader(host, ctx, undefined, signal, tokens);
  return withRepositoryMutationQueue(reader.ctx.cwd, rebaseInside.bind(undefined, host, reader, baseRef));
}
