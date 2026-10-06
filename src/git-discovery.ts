import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GIT_BRANCH_RAW_OUTPUT_LIMIT_BYTES,
  GIT_CONTEXT_VALUE_LIMIT_CHARS,
  GIT_FETCH_TIMEOUT_MS,
  GIT_WORKTREE_PATH_LIMIT_CHARS,
  MAX_SUMMARY_OUTPUT_CHARS,
} from "./constants.ts";
import {
  getCanonicalCommonGitDirectory,
  getGitRoot,
  isLosslessGitMetadata,
  runGit,
  safeWorktreeValue,
  withRepositoryMutationQueue,
  type GitCommandContext,
} from "./git.ts";
import type { FetchRemoteDetails } from "./types.ts";

function validateRemoteDiscoveryInput(remote: unknown, prune: unknown): asserts remote is string {
  if (typeof remote !== "string" || !remote || remote === "." || remote.startsWith("-") ||
      /[\s:@\p{Cc}\p{Cf}]/u.test(remote) ||
      !isLosslessGitMetadata(remote, GIT_CONTEXT_VALUE_LIMIT_CHARS)) {
    throw new TypeError("fetch_remote remote must be a safe configured remote name, not a URL, option, or local repository.");
  }
  if (typeof prune !== "boolean") throw new TypeError("fetch_remote prune must be a boolean.");
}

function requireSafeSymbolicDestination(ref: string, target: string, prefix: string): void {
  // Clones commonly have origin/HEAD -> origin/main. All other symbolic
  // destinations are refused to prevent wildcard fetch/prune following aliases.
  if (target && (ref !== `${prefix}HEAD` || !target.startsWith(prefix) ||
      target.length === prefix.length || target === `${prefix}HEAD`)) {
    throw new Error("fetch_remote refuses unsafe symbolic remote-tracking destinations; no fetch ran.");
  }
}

async function findLooseRemoteDirectory(commonGitDir: string, remote: string): Promise<string | undefined> {
  return inspectRemoteAncestors(commonGitDir, ["refs", "remotes", ...remote.split("/")]);
}

async function inspectRemoteAncestors(parent: string, segments: string[]): Promise<string | undefined> {
    if (segments.length === 0) return parent;
    const directory = join(parent, segments[0]);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("fetch_remote could not inspect its loose ref namespace; no fetch ran.");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("fetch_remote refuses non-directory or symlinked ref namespaces; no fetch ran.");
    }
    return inspectRemoteAncestors(directory, segments.slice(1));
}

async function inspectLooseRemoteFile(path: string, ref: string, prefix: string): Promise<void> {
  if ((await lstat(path)).size > GIT_CONTEXT_VALUE_LIMIT_CHARS + 64) {
    throw new Error("fetch_remote refuses unsafe loose ref files; no fetch ran.");
  }
  const content = (await readFile(path, "utf8")).trimEnd();
  if (content.startsWith("ref: ")) {
    requireSafeSymbolicDestination(ref, content.slice(5), prefix);
  } else if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(content)) {
    throw new Error("fetch_remote received malformed loose ref metadata; no fetch ran.");
  }
}

async function* looseRemoteEntries(
  directory: string,
  prefix: string,
): AsyncGenerator<{ entry: Dirent; ref: string; path: string }> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const ref = `${prefix}${entry.name}`;
      const path = join(directory, entry.name);
      yield { entry, ref, path };
      // Traverse only after the caller has checked the inventory budget.
      if (entry.isDirectory()) yield* looseRemoteEntries(path, `${ref}/`);
    }
}

async function inspectLooseRemoteRefs(commonGitDir: string, remote: string): Promise<void> {
  const prefix = `refs/remotes/${remote}/`;
  const directory = await findLooseRemoteDirectory(commonGitDir, remote);
  if (directory === undefined) return;
  // for-each-ref silently omits dangling symrefs. Inspect the files backend too,
  // so even an alias to an absent local branch cannot become a fetch destination.
  let inventoryBytes = 0;
  for await (const { entry, ref, path } of looseRemoteEntries(directory, prefix)) {
    inventoryBytes += Buffer.byteLength(ref, "utf8");
    if (inventoryBytes > GIT_BRANCH_RAW_OUTPUT_LIMIT_BYTES) {
      throw new Error("fetch_remote loose ref inventory exceeded the safety limit; no fetch ran.");
    }
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) {
      throw new Error("fetch_remote refuses unsafe loose ref files; no fetch ran.");
    }
    await inspectLooseRemoteFile(path, ref, prefix);
  }
}

async function requireUnambiguousRemoteNamespace(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  remote: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit(pi, ctx, ["remote"], { signal });
  if (Buffer.byteLength(result.stdout, "utf8") > GIT_BRANCH_RAW_OUTPUT_LIMIT_BYTES) {
    throw new Error("fetch_remote configured remote inventory exceeded the safety limit; no fetch ran.");
  }
  for (const other of result.stdout.trimEnd().split("\n")) {
    if (other !== remote && (other.startsWith(`${remote}/`) || remote.startsWith(`${other}/`))) {
      throw new Error("fetch_remote refuses overlapping configured remote namespaces; no fetch ran.");
    }
  }
}

async function requireSafeRemoteDestinations(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  remote: string,
  commonGitDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const prefix = `refs/remotes/${remote}/`;
  await runGit(pi, ctx, ["check-ref-format", `${prefix}branchme-validation`], { signal });
  const configured = await runGit(pi, ctx, ["remote", "get-url", remote], { signal, allowFailure: true });
  if (configured.code !== 0) throw new Error("fetch_remote remote is not a configured Git remote.");
  await requireUnambiguousRemoteNamespace(pi, ctx, remote, signal);
  const storage = await runGit(pi, ctx, ["config", "--get", "extensions.refStorage"], { signal, allowFailure: true });
  if ((storage.code !== 0 && storage.code !== 1) ||
      (storage.code === 0 && storage.stdout.trimEnd() !== "files")) {
    throw new Error("fetch_remote requires Git's files ref backend to verify dangling symbolic destinations; no fetch ran.");
  }
  await inspectLooseRemoteRefs(commonGitDir, remote);

  const result = await runGit(pi, ctx, [
    "for-each-ref", "--format=%(refname)%00%(symref)", prefix,
  ], { signal });
  if (Buffer.byteLength(result.stdout, "utf8") > GIT_BRANCH_RAW_OUTPUT_LIMIT_BYTES) {
    throw new Error("fetch_remote destination inventory exceeded the safety limit; no fetch ran.");
  }
  const records = result.stdout === "" ? [] : result.stdout.trimEnd().split("\n");
  for (const record of records) {
    const fields = record.split("\0");
    const [ref, target] = fields;
    if (fields.length !== 2 || !ref.startsWith(prefix) || ref.length === prefix.length) {
      throw new Error("fetch_remote received malformed destination metadata; no fetch ran.");
    }
    requireSafeSymbolicDestination(ref, target, prefix);
  }
}

async function fetchRemoteWithinQueue(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  remote: string,
  prune: boolean,
  commonGitDir: string,
  signal?: AbortSignal,
): Promise<FetchRemoteDetails> {
  try {
    await requireSafeRemoteDestinations(pi, ctx, remote, commonGitDir, signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(safeWorktreeValue(reason, MAX_SUMMARY_OUTPUT_CHARS));
  }
  const refspec = `+refs/heads/*:refs/remotes/${remote}/*`;
  let result;
  try {
    result = await runGit(pi, ctx, [
      "fetch", "--atomic", "--no-tags", "--no-prune-tags", "--no-recurse-submodules",
      "--no-auto-maintenance", "--refmap=", prune ? "--prune" : "--no-prune",
      "--", remote, refspec, "^refs/heads/HEAD",
    ], { signal, timeout: GIT_FETCH_TIMEOUT_MS });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const diagnostic = safeWorktreeValue(reason, MAX_SUMMARY_OUTPUT_CHARS - 200);
    throw new Error(
      `fetch_remote did not complete: ${diagnostic}. Remote-tracking refs may have changed; inspect before retrying. No rollback was attempted.`,
    );
  }
  return {
    action: "fetch_remote",
    repoRoot: safeWorktreeValue(ctx.cwd, GIT_WORKTREE_PATH_LIMIT_CHARS),
    remote,
    prune,
    refspec,
    output: safeWorktreeValue(result.stdout || result.stderr, MAX_SUMMARY_OUTPUT_CHARS),
  };
}

async function queueCommonRemoteFetch(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  remote: string,
  prune: boolean,
  commonGitDir: string,
  signal?: AbortSignal,
): Promise<FetchRemoteDetails> {
  if (commonGitDir === ctx.cwd) return fetchRemoteWithinQueue(pi, ctx, remote, prune, commonGitDir, signal);
  return withRepositoryMutationQueue(
    commonGitDir,
    fetchRemoteWithinQueue.bind(undefined, pi, ctx, remote, prune, commonGitDir, signal),
  );
}

export async function fetchRemote(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: GitCommandContext,
  remote: string = "origin",
  prune: boolean = false,
  signal?: AbortSignal,
): Promise<FetchRemoteDetails> {
  validateRemoteDiscoveryInput(remote, prune);
  const repoRoot = await getGitRoot(pi, ctx, signal);
  const rootCtx = { cwd: repoRoot };
  const commonGitDir = await getCanonicalCommonGitDirectory(pi, rootCtx, signal);
  // Retain the existing active-root lock for sibling BranchMe operations as well
  // as a shared ref-cache lock for concurrent fetch_remote calls in linked trees.
  return withRepositoryMutationQueue(
    repoRoot,
    queueCommonRemoteFetch.bind(undefined, pi, rootCtx, remote, prune, commonGitDir, signal),
  );
}
