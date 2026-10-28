import { getGitDiff } from "./git-diff.ts";
import {
  boundedGitText, decodeReadCursor, encodeReadCursor, fingerprint, OBJECT_ID, openGitReader,
  readBlob, readGit, READ_PAGE_SIZE, resolveReadCommit, safeGitText, validateKeys,
  validateReadPath, validateReadPaths, validateReadRef, type GitAPI, type GitReader,
} from "./git-read.ts";
import type { GitCommandContext } from "./git.ts";

export interface GitLogInput { ref?: string; excludeRef?: string; paths?: string[]; after?: string; worktreePath?: string }
export interface GitShowInput { ref?: string; output?: "summary" | "patch" | "file"; path?: string; parent?: number; worktreePath?: string }
export interface HistoryCommit { head: string; parents: string[]; date: string; subject: string; subjectTruncated?: boolean; message?: string; messageTruncated?: boolean }
const LOG_FORMAT = "%H%x00%P%x00%aI%x00%s";

function parseCommits(raw: string, reader: GitReader): HistoryCommit[] {
  if (!raw) return [];
  const fields = raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : [];
  if (fields.length % 4 || !fields.length) throw new Error("Malformed history output.");
  const commits: HistoryCommit[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    const [head, parentText, date, subject] = fields.slice(i, i + 4);
    const parents = parentText ? parentText.split(" ") : [];
    if (!OBJECT_ID.test(head) || !parents.every(isOid) || parents.length > 16 || date.length > 40 || !/^\d{4}-\d\d-\d\dT/u.test(date) || !Number.isFinite(Date.parse(date))) throw new Error("Malformed history identities/date.");
    const preview = boundedGitText(subject, reader.tokens, 512, 1);
    commits.push({ head, parents, date, subject: preview.text, subjectTruncated: preview.truncated });
  }
  return commits;
}
function isOid(value: string): boolean { return OBJECT_ID.test(value); }
async function unbornHead(reader: GitReader): Promise<boolean> {
  const head = await readGit(reader, ["rev-parse", "--verify", "--quiet", "HEAD"], true);
  if (head.code === 0) return false;
  const symbolic = await readGit(reader, ["symbolic-ref", "--quiet", "HEAD"], true);
  if (head.code !== 1 || symbolic.code !== 0 || !symbolic.stdout.startsWith("refs/heads/")) return false;
  const ref = symbolic.stdout.trimEnd();
  const present = await readGit(reader, ["show-ref", "--verify", "--quiet", ref], true);
  return present.code === 1;
}
export async function getGitLog(host: GitAPI, ctx: GitCommandContext, input: GitLogInput = {}, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateKeys(input, ["ref", "excludeRef", "paths", "after", "worktreePath"]);
  validateReadRef(input.ref ?? "HEAD");
  if (input.excludeRef !== undefined) validateReadRef(input.excludeRef);
  validateReadPaths(input.paths);
  const reader = await openGitReader(host, ctx, input.worktreePath, signal, tokens);
  const shallow = (await readGit(reader, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
  const query = fingerprint(JSON.stringify([reader.ctx.cwd, input.ref ?? "HEAD", input.excludeRef ?? null, input.paths ?? []]));
  let start: string;
  let exclude: string | null;
  let offset = 0;
  if (input.after !== undefined) {
    const fields = decodeReadCursor(input.after);
    if (fields.length !== 5 || fields[0] !== "log1" || fields[1] !== query || typeof fields[2] !== "string" || !OBJECT_ID.test(fields[2]) || (fields[3] !== null && (typeof fields[3] !== "string" || !OBJECT_ID.test(fields[3]))) || !Number.isSafeInteger(fields[4]) || Number(fields[4]) < 1 || Number(fields[4]) > 100000) throw new Error("History continuation belongs to another query or is invalid; restart without after.");
    start = await resolveReadCommit(reader, fields[2]);
    exclude = fields[3] === null ? null : await resolveReadCommit(reader, fields[3] as string);
    offset = fields[4] as number;
  } else {
    if ((input.ref ?? "HEAD") === "HEAD" && await unbornHead(reader)) return { action: "git_log", repoRoot: safeGitText(reader.ctx.cwd, tokens), start: null, exclude: null, unborn: true, shallow, commits: [], complete: true, next: null };
    start = await resolveReadCommit(reader, input.ref ?? "HEAD");
    exclude = input.excludeRef === undefined ? null : await resolveReadCommit(reader, input.excludeRef);
  }
  const result = await readGit(reader, ["--literal-pathspecs", "log", "-z", `--format=${LOG_FORMAT}`, "--no-show-signature", "--no-decorate", "--no-notes", "--topo-order", `--skip=${offset}`, `--max-count=${READ_PAGE_SIZE + 1}`, start, ...(exclude ? [`^${exclude}`] : []), "--", ...(input.paths ?? [])]);
  const all = parseCommits(result.stdout, reader);
  const commits = all.slice(0, READ_PAGE_SIZE);
  const complete = all.length <= READ_PAGE_SIZE;
  return { action: "git_log", repoRoot: safeGitText(reader.ctx.cwd, tokens), start, exclude, unborn: false, shallow, commits, complete, next: complete ? null : encodeReadCursor(["log1", query, start, exclude, offset + commits.length]) };
}

function validateShowInput(input: GitShowInput): void {
  validateKeys(input, ["ref", "output", "path", "parent", "worktreePath"]);
  validateReadRef(input.ref ?? "HEAD");
  const output = input.output ?? "summary";
  if (!["summary", "patch", "file"].includes(output)) throw new TypeError("Unknown git_show output.");
  if (input.path !== undefined) validateReadPath(input.path);
  if (input.parent !== undefined && (!Number.isInteger(input.parent) || input.parent < 1 || input.parent > 100 || output === "file")) throw new TypeError("parent must select a 1-based commit parent for summary/patch output.");
  if (output === "file" && input.path === undefined) throw new TypeError("git_show file output requires one literal path.");
}

async function showFile(reader: GitReader, commit: HistoryCommit, path: string) {
  const tree = await readGit(reader, ["--literal-pathspecs", "ls-tree", "-z", commit.head, "--", path]);
  const match = /^([0-7]{6}) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(tree.stdout);
  if (match?.[3] !== path) throw new Error("Path does not name one blob at the captured commit (directories/gitlinks are unsupported).");
  return { action: "git_show", commit, output: "file", path: safeGitText(path, reader.tokens), mode: match[1], blob: match[2], ...await readBlob(reader, match[2]) };
}

function validateShowParent(commit: HistoryCommit, parent: number | undefined): void {
  if (commit.parents.length > 1 && parent === undefined) throw new Error("Merge commit inspection requires an explicit 1-based parent comparison.");
  if (parent !== undefined && parent > commit.parents.length) throw new Error("Requested commit parent does not exist.");
}

export async function getGitShow(host: GitAPI, ctx: GitCommandContext, input: GitShowInput = {}, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateShowInput(input);
  const output = input.output ?? "summary";
  const reader = await openGitReader(host, ctx, input.worktreePath, signal, tokens);
  const head = await resolveReadCommit(reader, input.ref ?? "HEAD");
  const metadata = await readGit(reader, ["log", "-z", "-1", `--format=${LOG_FORMAT}`, "--no-show-signature", "--no-notes", head, "--"]);
  const commit = parseCommits(metadata.stdout, reader)[0];
  if (commit?.head !== head) throw new Error("Commit metadata did not match captured identity.");
  const message = boundedGitText((await readGit(reader, ["log", "-1", "--format=%B", "--no-show-signature", "--no-notes", head, "--"])).stdout, tokens, 4096, 100);
  commit.message = message.text;
  commit.messageTruncated = message.truncated;
  if (output === "file") return showFile(reader, commit, input.path!);
  validateShowParent(commit, input.parent);
  const base = commit.parents[(input.parent ?? 1) - 1] ?? null;
  let comparison;
  if (base) {
    const diff = await getGitDiff(host, reader.ctx, { mode: "range", baseRef: base, targetRef: head, output: output === "patch" ? "patch" : "name-status", ...(input.path ? { paths: [input.path] } : {}) }, signal, tokens);
    comparison = { text: diff.diff, truncated: diff.truncated };
  } else {
    const diff = await readGit(reader, ["--literal-pathspecs", "-c", "diff.noprefix=false", "diff-tree", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--root", "--no-commit-id", "-r", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=dirty", output === "patch" ? "--patch" : "--name-status", head, "--", ...(input.path ? [input.path] : [])]);
    comparison = boundedGitText(diff.stdout, tokens);
  }
  return { action: "git_show", commit, output, comparisonBase: base, ...comparison };
}
