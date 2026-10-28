import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  GIT_CONTEXT_VALUE_LIMIT_CHARS,
  GIT_DIFF_CONTEXT_DEFAULT_LINES,
  GIT_DIFF_CONTEXT_LIMIT,
  GIT_DIFF_OUTPUT_LIMIT_BYTES,
  GIT_DIFF_OUTPUT_LIMIT_LINES,
  GIT_DIFF_PATH_LIMIT,
  GIT_DIFF_PATH_PREVIEW_LIMIT_CHARS,
} from "../src/constants.ts";
import { formatGitDiff, getGitDiff } from "../src/git-diff.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const exec = promisify(execFile);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "Diff Test", GIT_COMMITTER_NAME: "Diff Test",
  GIT_AUTHOR_EMAIL: "diff@example.invalid", GIT_COMMITTER_EMAIL: "diff@example.invalid",
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd, args, options = {}) {
  try {
    return { ...await exec("git", args, { cwd, env, encoding: "utf8", timeout: 30_000, ...options }), code: 0, killed: false };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, code: error.code ?? 1, killed: Boolean(error.killed) };
  }
}

async function checked(cwd, args) {
  const result = await git(cwd, args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trimEnd();
}

async function fixture(t, unborn = false) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "branchme-diff-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  await mkdir(root);
  await checked(root, ["init", "--initial-branch=main"]);
  await checked(root, ["config", "commit.gpgsign", "false"]);
  if (!unborn) {
    await writeFile(join(root, "file.txt"), "initial\n");
    await checked(root, ["add", "."]);
    await checked(root, ["commit", "-m", "initial"]);
  }
  const calls = [];
  const pi = { async exec(command, args, options) {
    assert.equal(command, "git");
    calls.push({ args: [...args], options });
    return git(options.cwd, args, { signal: options.signal, timeout: options.timeout });
  } };
  return { temp, root, calls, pi };
}

function registered(pi, options = {}) {
  const tools = [];
  registerBranchMeTools({ exec: pi.exec, registerTool: tools.push.bind(tools) }, options);
  return tools.find((tool) => tool.name === "git_diff");
}

async function snapshot(root) {
  return {
    index: await readFile(join(root, ".git", "index")),
    config: await readFile(join(root, ".git", "config")),
    head: await readFile(join(root, ".git", "HEAD")),
    refs: await checked(root, ["show-ref"]),
    file: await readFile(join(root, "file.txt")),
  };
}

function noExec() {
  throw new Error("Unexpected Git execution");
}

test("git_diff separates unstaged and staged changes without touching index, refs, config or files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file.txt"), "staged version\n");
  await checked(f.root, ["add", "file.txt"]);
  await writeFile(join(f.root, "file.txt"), "unstaged version\n");
  await writeFile(join(f.root, "untracked.txt"), "never included\n");
  const before = await snapshot(f.root);
  const tool = registered(f.pi);
  const unstaged = await tool.execute("diff", {}, undefined, undefined, { cwd: f.root });
  assert.equal(unstaged.details.action, "git_diff");
  assert.equal(unstaged.details.mode, "unstaged");
  assert.equal(unstaged.details.truncated, false);
  assert.match(unstaged.details.diff, /-staged version\n\+unstaged version/u);
  assert.doesNotMatch(unstaged.details.diff, /never included|untracked.txt/u);
  assert.match(unstaged.content[0].text, /untrusted/u);
  assert.match(unstaged.content[0].text, /Comparison: index -> working tree/u);
  assert.match(unstaged.content[0].text, /Output: complete/u);
  assert.ok(f.calls.some((call) => call.args.includes(`--unified=${GIT_DIFF_CONTEXT_DEFAULT_LINES}`)));
  const staged = await getGitDiff(f.pi, { cwd: f.root }, { mode: "staged", contextLines: 0 });
  assert.match(staged.diff, /-initial\n\+staged version/u);
  assert.doesNotMatch(staged.diff, /unstaged version/u);
  assert.deepEqual(await snapshot(f.root), before);
  for (const call of f.calls) {
    assert.deepEqual(call.args.slice(0, 4), ["--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false"]);
    assert.equal(call.options.timeout, 30_000);
    assert.equal(call.options.cwd, f.root);
  }
  assert.ok(f.calls.filter((call) => call.args.includes("diff")).every((call) => call.args.includes("--no-ext-diff") && call.args.includes("--no-textconv")));
});

test("git_diff handles clean trees, unborn staged additions, detached HEAD, binary files and deletions", async (t) => {
  const f = await fixture(t);
  const clean = await getGitDiff(f.pi, { cwd: f.root });
  assert.equal(clean.hasDifferences, false);
  assert.equal(clean.diff, "");
  assert.equal(clean.totalLines, 0);
  assert.match(formatGitDiff(clean), /No differences/u);
  await checked(f.root, ["switch", "--detach"]);
  await rm(join(f.root, "file.txt"));
  const deleted = await getGitDiff(f.pi, { cwd: f.root });
  assert.match(deleted.diff, /deleted file mode/u);
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await checked(f.root, ["add", "binary.bin"]);
  const binary = await getGitDiff(f.pi, { cwd: f.root }, { mode: "staged" });
  assert.match(binary.diff, /Binary files .* differ/u);
  assert.doesNotMatch(binary.diff, /GIT binary patch/u);
  const unborn = await fixture(t, true);
  await writeFile(join(unborn.root, "new.txt"), "first staged file\n");
  await checked(unborn.root, ["add", "new.txt"]);
  const first = await getGitDiff(unborn.pi, { cwd: unborn.root }, { mode: "staged" });
  assert.match(first.diff, /\+first staged file/u);
});

test("git_diff captures range commits and distinguishes direct from merge-base comparisons", async (t) => {
  const f = await fixture(t);
  const initial = await checked(f.root, ["rev-parse", "HEAD"]);
  await writeFile(join(f.root, "base-only.txt"), "base\n");
  await checked(f.root, ["add", "."]);
  await checked(f.root, ["commit", "-m", "base change"]);
  const baseHead = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["switch", "-c", "feature", initial]);
  await writeFile(join(f.root, "feature-only.txt"), "feature\n");
  await checked(f.root, ["add", "."]);
  await checked(f.root, ["commit", "-m", "feature change"]);
  const targetHead = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["tag", "feature-tag"]);
  await writeFile(join(f.root, "file.txt"), "not committed\n");
  const direct = await getGitDiff(f.pi, { cwd: f.root }, { mode: "range", baseRef: "main", output: "name-status" });
  assert.deepEqual(direct.comparison, { baseHead, targetHead, diffBaseHead: baseHead });
  assert.match(direct.diff, /D\tbase-only.txt/u);
  assert.match(direct.diff, /A\tfeature-only.txt/u);
  assert.doesNotMatch(direct.diff, /file.txt/u);
  const merged = await getGitDiff(f.pi, { cwd: f.root }, { mode: "range", baseRef: "refs/heads/main", targetRef: "feature-tag", mergeBase: true, output: "stat" });
  assert.deepEqual(merged.comparison, { baseHead, targetHead, diffBaseHead: initial });
  assert.match(merged.diff, /feature-only.txt/u);
  assert.doesNotMatch(merged.diff, /base-only.txt/u);
  const exact = await getGitDiff(f.pi, { cwd: f.root }, { mode: "range", baseRef: initial, targetRef: "HEAD~1" });
  assert.equal(exact.hasDifferences, false);
  const ranges = f.calls.filter((call) => call.args.includes("diff"));
  for (const call of ranges) {
    const revisions = call.args.filter((value) => /^[a-f0-9]{40}$/u.test(value));
    assert.equal(revisions.length, 2);
    assert.ok(!call.args.includes("main") && !call.args.includes("HEAD"));
  }
});

test("git_diff refuses missing or ambiguous merge bases", async (t) => {
  const f = await fixture(t);
  const main = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["switch", "--orphan", "unrelated"]);
  await writeFile(join(f.root, "other.txt"), "other history\n");
  await checked(f.root, ["add", "."]);
  await checked(f.root, ["commit", "-m", "unrelated"]);
  await assert.rejects(getGitDiff(f.pi, { cwd: f.root }, { mode: "range", baseRef: "main", mergeBase: true }), /no merge base.*\nResolve: Choose related refs/u);
  const ambiguous = { async exec(command, args, options) {
    if (args.includes("merge-base")) return { stdout: `${main}\n${main}\n`, stderr: "", code: 0, killed: false };
    return f.pi.exec(command, args, options);
  } };
  await assert.rejects(getGitDiff(ambiguous, { cwd: f.root }, { mode: "range", baseRef: "main", mergeBase: true }), /unique merge base/u);
});

test("git_diff literal filters are root-relative from subdirectories and do not expand globs or pathspec magic", async (t) => {
  const f = await fixture(t);
  for (const name of ["*.txt", ":(glob)*.txt", "-option.txt", "with space.txt"]) await writeFile(join(f.root, name), "original\n");
  await checked(f.root, ["add", "."]);
  await checked(f.root, ["commit", "-m", "literal files"]);
  for (const name of ["*.txt", ":(glob)*.txt", "-option.txt", "with space.txt", "file.txt"]) await writeFile(join(f.root, name), "changed\n");
  const subdir = join(f.root, "subdir");
  await mkdir(subdir);
  for (const name of ["*.txt", ":(glob)*.txt", "-option.txt", "with space.txt"]) {
    const details = await getGitDiff(f.pi, { cwd: subdir }, { paths: [name], output: "name-status" });
    assert.equal(details.diff, `M\t${name}\n`);
    assert.equal(details.repoRoot, f.root);
  }
});

test("git_diff disables external diff, textconv, color, fsmonitor, rename expansion and submodule traversal", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".gitattributes"), "file.txt diff=custom\n");
  await checked(f.root, ["config", "diff.external", "sh -c 'exit 87'"]);
  await checked(f.root, ["config", "diff.custom.textconv", "sh -c 'exit 88'"]);
  await checked(f.root, ["config", "core.fsmonitor", "sh -c 'exit 89'"]);
  await checked(f.root, ["config", "color.ui", "always"]);
  await checked(f.root, ["config", "diff.noprefix", "true"]);
  await writeFile(join(f.root, "file.txt"), "changed\n");
  const details = await getGitDiff(f.pi, { cwd: f.root });
  assert.match(details.diff, /diff --git a\/file.txt b\/file.txt/u);
  assert.match(details.diff, /\+changed/u);
  assert.doesNotMatch(details.diff, /\u001b/u);
  const diffCall = f.calls.find((call) => call.args.includes("diff"));
  for (const flag of ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=dirty", "--submodule=short"]) assert.ok(diffCall.args.includes(flag));
});

test("git_diff targets another live same-repository worktree and rejects foreign or subdirectory roots", async (t) => {
  const f = await fixture(t);
  const linked = join(f.temp, "linked");
  await checked(f.root, ["worktree", "add", "-b", "linked-branch", linked]);
  await writeFile(join(linked, "file.txt"), "linked-only change\n");
  const details = await getGitDiff(f.pi, { cwd: f.root }, { worktreePath: linked });
  assert.equal(details.repoRoot, linked);
  assert.match(details.diff, /linked-only change/u);
  assert.equal((await getGitDiff(f.pi, { cwd: f.root })).hasDifferences, false);
  const foreign = join(f.temp, "foreign");
  await mkdir(foreign);
  await checked(foreign, ["init"]);
  await assert.rejects(getGitDiff(f.pi, { cwd: f.root }, { worktreePath: foreign }));
  const subdir = join(linked, "subdir");
  await mkdir(subdir);
  await assert.rejects(getGitDiff(f.pi, { cwd: f.root }, { worktreePath: subdir }));
});

test("git_diff redacts secrets and terminal controls before bounding both content and details", async (t) => {
  const f = await fixture(t);
  const secret = "custom-secret-from-environment";
  const text = `+Bearer abcdef\n+ghp_exampleSecret\n+https://user:password@example.invalid/x\n+${secret}\n+\u001b[31mred\r\u202e\n` + "+😀😀\n".repeat(2_000);
  const pi = { async exec(command, args, options) {
    if (args.includes("diff")) return { stdout: text, stderr: "", code: 0, killed: false };
    return f.pi.exec(command, args, options);
  } };
  const tool = registered(pi, { env: { GH_TOKEN: secret } });
  const result = await tool.execute("bounded", {}, undefined, undefined, { cwd: f.root });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /abcdef|ghp_exampleSecret|user:password|custom-secret-from-environment/u);
  assert.match(result.details.diff, /\[REDACTED\]/u);
  assert.match(result.details.diff, /\\u001b\[31mred\\u000d\\u202e/u);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.diff.split(/(?<=\n)/u).length, GIT_DIFF_OUTPUT_LIMIT_LINES);
  assert.match(result.content[0].text, /Output: truncated/u);
  assert.match(result.content[0].text, /Next: Narrow paths, reduce contextLines/u);
  assert.ok(result.content[0].text.indexOf("Output: truncated") < result.content[0].text.indexOf(result.details.diff));
  assert.ok(Buffer.byteLength(result.details.diff) <= GIT_DIFF_OUTPUT_LIMIT_BYTES);
  const huge = { ...pi, async exec(command, args, options) {
    if (args.includes("diff")) return { stdout: "+" + "😀".repeat(20_000), stderr: "", code: 0, killed: false };
    return f.pi.exec(command, args, options);
  } };
  const bytes = await getGitDiff(huge, { cwd: f.root });
  assert.equal(bytes.truncated, true);
  assert.ok(Buffer.byteLength(bytes.diff) <= GIT_DIFF_OUTPUT_LIMIT_BYTES);
  assert.doesNotMatch(bytes.diff, /[\uD800-\uDFFF]/u);
});

test("git_diff rejects malformed and contradictory inputs before running Git", async () => {
  for (const input of [
    null, [], { extra: true }, { mode: "all" }, { mode: null }, { output: "binary" },
    { baseRef: "main" }, { targetRef: "HEAD" }, { mergeBase: false }, { mode: "range" },
    { mode: "range", baseRef: "--output=/tmp/escape" }, { mode: "range", baseRef: "main..HEAD" },
    { mode: "range", baseRef: "HEAD:file.txt" }, { mode: "range", baseRef: "HEAD\n" },
    { mode: "range", baseRef: "main", targetRef: "--help" }, { mode: "range", baseRef: "main", mergeBase: "yes" },
    { paths: [] }, { paths: Array(GIT_DIFF_PATH_LIMIT + 1).fill("file.txt") }, { paths: ["../outside"] }, { paths: ["/absolute"] },
    { paths: ["C:\\absolute"] }, { paths: ["a/../../b"] }, { paths: [".git/config"] }, { paths: ["a/.GiT/config"] },
    { paths: ["file\nname"] }, { contextLines: -1 }, { contextLines: GIT_DIFF_CONTEXT_LIMIT + 1 }, { contextLines: 0.5 },
    { worktreePath: "relative" },
  ]) await assert.rejects(getGitDiff({ exec: noExec }, { cwd: "/unused" }, input), /git_diff/u);
});

test("git_diff schema is strict, bounded, and has concise prompt metadata", () => {
  const tool = registered({ exec: noExec });
  const validator = Compile(tool.parameters);
  for (const input of [{}, { mode: "staged" }, { mode: "range", baseRef: "main", mergeBase: true }, { paths: ["src"], contextLines: GIT_DIFF_CONTEXT_LIMIT, output: "stat", worktreePath: "/tmp/linked" }]) assert.equal(validator.Check(input), true);
  for (const input of [{ extra: true }, { mode: "all" }, { paths: [] }, { paths: Array(GIT_DIFF_PATH_LIMIT + 1).fill("x") }, { contextLines: GIT_DIFF_CONTEXT_LIMIT + 1 }, { contextLines: -1 }, { contextLines: 0.5 }, { baseRef: "" }, { targetRef: "x".repeat(GIT_CONTEXT_VALUE_LIMIT_CHARS + 1) }, { output: "binary" }, { mergeBase: "true" }]) assert.equal(validator.Check(input), false);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required ?? [], []);
  assert.ok(Number.isInteger(GIT_DIFF_CONTEXT_DEFAULT_LINES) && GIT_DIFF_CONTEXT_DEFAULT_LINES >= 0 && GIT_DIFF_CONTEXT_DEFAULT_LINES <= GIT_DIFF_CONTEXT_LIMIT);
  assert.match(tool.description, /tracked-file diffs.*never stages or fetches/u);
  assert.match(tool.promptSnippet, /Inspect tracked-file diffs/u);
  assert.equal(tool.promptSnippet.startsWith("git_diff:"), false);
  assert.ok(tool.promptGuidelines.length > 0);
  assert.ok(tool.promptGuidelines.every((line) => line.includes("git_diff")));
});

test("git_diff empty filters report their scope instead of claiming the checkout is clean", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file.txt"), "real change outside the filters\n");
  const details = await getGitDiff(f.pi, { cwd: f.root }, { paths: ["does-not-exist"] });
  assert.equal(details.hasDifferences, false);
  const text = formatGitDiff(details);
  assert.match(text, /git_diff: no differences \(unstaged, patch\)/u);
  assert.ok(text.includes(`Repository: ${JSON.stringify(f.root)}`));
  assert.match(text, /Paths: "does-not-exist" \(literal filter previews\)/u);
  assert.match(text, /Filters may also match no tracked paths; this does not establish a clean checkout/u);
  assert.match(text, /excludes untracked files and submodule working-tree changes/u);
  assert.equal((await getGitDiff(f.pi, { cwd: f.root })).hasDifferences, true);
});

test("git_diff range output includes captured comparison identities in model-visible text", async (t) => {
  const f = await fixture(t);
  const head = await checked(f.root, ["rev-parse", "HEAD"]);
  const result = await registered(f.pi).execute("range", { mode: "range", baseRef: "main" }, undefined, undefined, { cwd: f.root });
  assert.ok(result.content[0].text.includes(`Comparison: ${head} -> ${head}`));
  const mergeBase = "c".repeat(40);
  const text = formatGitDiff({ ...result.details, comparison: { baseHead: head, targetHead: head, diffBaseHead: mergeBase } });
  assert.ok(text.includes(`Comparison: ${mergeBase} -> ${head} (merge base; requested base commit ${head})`));
});

test("git_diff filter previews are redacted and bounded without splitting Unicode", async (t) => {
  const f = await fixture(t);
  const secret = "custom-path-secret";
  const path = `ghp_filterSecret-${secret}-` + "😀".repeat(GIT_DIFF_PATH_PREVIEW_LIMIT_CHARS);
  const details = await getGitDiff(f.pi, { cwd: f.root }, { paths: [path] }, undefined, [secret]);
  assert.equal(details.pathFilters.length, 1);
  assert.ok(details.pathFilters[0].length <= GIT_DIFF_PATH_PREVIEW_LIMIT_CHARS);
  assert.match(details.pathFilters[0], /\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(details), /ghp_filterSecret|custom-path-secret/u);
  assert.doesNotMatch(details.pathFilters[0], /[\uD800-\uDFFF]/u);
});

test("git_diff unsupported Git and timeouts give local, actionable errors rather than empty output", async () => {
  const unsupported = { async exec() { return { stdout: "", stderr: "unknown option: --no-lazy-fetch", code: 129, killed: false }; } };
  await assert.rejects(getGitDiff(unsupported, { cwd: "/unused" }), /Git version does not support --no-lazy-fetch.*\nResolve: Update Git/su);
  const killed = { async exec() { return { stdout: "", stderr: "", code: 1, killed: true }; } };
  await assert.rejects(getGitDiff(killed, { cwd: "/unused" }), (error) => {
    assert.match(error.message, /local Git read was killed or timed out/u);
    assert.match(error.message, /Resolve: Retry once with narrower paths/u);
    assert.doesNotMatch(error.message, /report the remote as unreachable/u);
    return true;
  });
});

test("git_diff fails for missing revisions/non-repositories and propagates cancellation, timeout and redacted errors", async (t) => {
  const f = await fixture(t);
  await assert.rejects(getGitDiff(f.pi, { cwd: f.root }, { mode: "range", baseRef: "missing" }), /baseRef.*locally available commit.*\nResolve: Check the ref with list_branches/su);
  await assert.rejects(getGitDiff(f.pi, { cwd: f.temp }), /Not a git repository/u);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getGitDiff({ exec: noExec }, { cwd: f.root }, {}, controller.signal), { name: "AbortError" });
  const reason = new Error("cancelled during diff");
  reason.name = "AbortError";
  const cancelled = { async exec(command, args, options) {
    if (args.includes("diff")) throw reason;
    return f.pi.exec(command, args, options);
  } };
  await assert.rejects(getGitDiff(cancelled, { cwd: f.root }), (error) => error === reason);
  const failed = { async exec(command, args, options) {
    if (args.includes("diff")) return { stdout: "", stderr: "Bearer secret-value\n\u001b[31mcustom-env-secret", code: 128, killed: false };
    return f.pi.exec(command, args, options);
  } };
  await assert.rejects(getGitDiff(failed, { cwd: f.root }, {}, undefined, ["custom-env-secret"]), (error) =>
    /REDACTED/u.test(error.message) && /\\u001b/u.test(error.message) && !/secret-value|custom-env-secret|\u001b/u.test(error.message));
  const killed = { async exec() { return { stdout: "", stderr: "", code: 1, killed: true }; } };
  await assert.rejects(getGitDiff(killed, { cwd: f.root }), /killed/u);
  await assert.rejects(access(join(f.root, "diff.patch")));
});
