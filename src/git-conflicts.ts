import { getGitOperationState, type GitCommandContext } from "./git.ts";
import {
  boundedGitText, decodeReadCursor, encodeReadCursor, fingerprint, OBJECT_ID, openGitReader,
  readBlob, readGit, READ_PAGE_SIZE, safeGitText, validateKeys, validateReadPath, type GitAPI, type GitReader,
} from "./git-read.ts";

export interface GitConflictsInput { path?: string; stage?: number; expectedIndex?: string; after?: string; worktreePath?: string }
interface ConflictStage { stage: number; mode: string; blob: string }
interface ConflictPath { path: string; stages: ConflictStage[] }
function parseConflicts(raw: string): ConflictPath[] {
  if (raw && !raw.endsWith("\0")) throw new Error("Incomplete conflict index output.");
  const paths = new Map<string, ConflictPath>();
  for (const record of raw ? raw.slice(0, -1).split("\0") : []) {
    const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([^\0]+)$/u.exec(record);
    if (!match) throw new Error("Malformed conflict index output.");
    const path = match[4];
    const entry = paths.get(path) ?? { path, stages: [] };
    if (entry.stages.some((stage) => stage.stage === Number(match[3]))) throw new Error("Duplicate conflict stage.");
    entry.stages.push({ stage: Number(match[3]), mode: match[1], blob: match[2] });
    paths.set(path, entry);
  }
  return [...paths.values()];
}
function displayConflict(entry: ConflictPath, tokens: readonly string[]) {
  const path = boundedGitText(entry.path, tokens, 512, 1).text;
  let reusablePath = path === entry.path;
  try { validateReadPath(entry.path); } catch { reusablePath = false; }
  return { path, reusablePath, stages: entry.stages };
}
function validateConflictInput(input: GitConflictsInput): void {
  validateKeys(input, ["path", "stage", "expectedIndex", "after", "worktreePath"]);
  if (input.path !== undefined) validateReadPath(input.path);
  if (input.stage !== undefined && (input.path === undefined || ![1, 2, 3].includes(input.stage))) throw new TypeError("stage requires path and must be 1 (base), 2 (ours), or 3 (theirs).");
  if (input.path !== undefined && input.after !== undefined) throw new TypeError("after is for listing, not path inspection.");
  if (input.expectedIndex !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedIndex)) throw new TypeError("expectedIndex must be an index fingerprint from inspection.");
}

function conflictOffset(after: string | undefined, binding: string, total: number): number {
  if (after === undefined) return 0;
  const fields = decodeReadCursor(after);
  if (fields.length !== 3 || fields[0] !== "conflicts1" || fields[1] !== binding || !Number.isSafeInteger(fields[2]) || Number(fields[2]) < 1 || Number(fields[2]) >= total) throw new Error("Conflict continuation is stale; restart git_conflicts without after.");
  return Number(fields[2]);
}

async function inspectConflictStage(reader: GitReader, entry: ConflictPath, number: number) {
  const stage = entry.stages.find((candidate) => candidate.stage === number);
  if (!stage) return { stage: number, present: false };
  if (stage.mode === "160000") return { ...stage, present: true, text: "Gitlink commit; no blob preview." };
  if (!OBJECT_ID.test(stage.blob)) throw new Error("Invalid conflict blob.");
  const blob = await readBlob(reader, stage.blob);
  const preview = boundedGitText(blob.text, [], 6 * 1024, 200);
  return { ...stage, ...blob, ...preview, truncated: blob.truncated || preview.truncated, present: true };
}

export async function getGitConflicts(host: GitAPI, ctx: GitCommandContext, input: GitConflictsInput = {}, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateConflictInput(input);
  const reader = await openGitReader(host, ctx, input.worktreePath, signal, tokens);
  const before = (await readGit(reader, ["ls-files", "--stage", "-v", "-z"])).stdout;
  const index = fingerprint(before);
  if (input.expectedIndex !== undefined && index !== input.expectedIndex) throw new Error("Conflict index changed. Inspect git_conflicts again before using a version.");
  const operation = await getGitOperationState(reader.pi, reader.ctx, signal);
  const conflicts = parseConflicts((await readGit(reader, ["ls-files", "--unmerged", "-z"])).stdout);
  const binding = fingerprint(JSON.stringify([reader.ctx.cwd, index, operation]));
  const offset = conflictOffset(input.after, binding, conflicts.length);
  let inspected;
  if (input.path !== undefined) {
    const entry = conflicts.find((entry) => entry.path === input.path);
    if (!entry) throw new Error("Path is not currently unmerged; inspect git_status or git_conflicts again.");
    const stages = await Promise.all((input.stage === undefined ? [1, 2, 3] : [input.stage]).map(inspectConflictStage.bind(undefined, reader, entry)));
    inspected = { path: safeGitText(input.path, tokens), stages };
  }
  const entries = input.path === undefined ? conflicts.slice(offset, offset + READ_PAGE_SIZE).map((entry) => displayConflict(entry, tokens)) : [];
  const complete = input.path !== undefined || offset + entries.length === conflicts.length;
  const after = (await readGit(reader, ["ls-files", "--stage", "-v", "-z"])).stdout;
  if (before !== after || JSON.stringify(operation) !== JSON.stringify(await getGitOperationState(reader.pi, reader.ctx, signal))) throw new Error("Conflict state changed during inspection; retry git_conflicts.");
  return { action: "git_conflicts", repoRoot: safeGitText(reader.ctx.cwd, tokens), index, operations: operation.active, stageMeaning: "1=base, 2=ours, 3=theirs. These are index-stage terms; ours/theirs depend on the current operation, especially rebase.", total: conflicts.length, entries, inspected, complete, next: complete ? null : encodeReadCursor(["conflicts1", binding, offset + entries.length]) };
}
