import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { restorePaths } from "../src/git-restore.ts";
import { revertChanges } from "../src/git-revert.ts";
import { getGitStatus } from "../src/git-status.ts";
import { checked, fixture, state } from "./helpers/git-fixture.mjs";
async function expectations(f, paths) { const status = await getGitStatus(f.pi, { cwd: f.root }); return { ...(paths ? { paths } : {}), expectedHead: status.head, expectedIndex: status.index }; }

test("restore preview/apply preserves partial staging and unrelated files; stale previews and untracked files refuse mutation", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file.txt"), "staged\n"); await checked(f.root, ["add", "file.txt"]);
  await writeFile(join(f.root, "file.txt"), "discard this\n");
  await writeFile(join(f.root, "unrelated"), "keep me");
  const args = await expectations(f, ["file.txt"]);
  const preview = await restorePaths(f.pi, { cwd: f.root }, { ...args, preview: true });
  assert.equal(preview.applied, false);
  const before = await state(f.root);
  await assert.rejects(restorePaths(f.pi, { cwd: f.root }, { ...args, expectedFiles: preview.expectedFiles }), /discardChanges/u);
  await restorePaths(f.pi, { cwd: f.root }, { ...args, expectedFiles: preview.expectedFiles, discardChanges: true });
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "staged\n");
  const after = await state(f.root); assert.equal((await getGitStatus(f.pi, { cwd: f.root })).index, args.expectedIndex); assert.equal(after.head, before.head);
  // Git may refresh raw stat-cache bytes while preserving every staged entry.
  assert.equal(await readFile(join(f.root, "unrelated"), "utf8"), "keep me");
  await writeFile(join(f.root, "file.txt"), "newer\n");
  await assert.rejects(restorePaths(f.pi, { cwd: f.root }, { ...args, expectedFiles: preview.expectedFiles, discardChanges: true }), /changed/u);
  await assert.rejects(restorePaths(f.pi, { cwd: f.root }, { ...await expectations(f, ["unrelated"]), preview: true }), /untracked/u);
});

test("no-commit revert ignores unrelated ignored files and refuses an ignored file at a path the commit touches", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".gitignore"), "deps/\n.env\n"); await checked(f.root, ["add", ".gitignore"]); await checked(f.root, ["commit", "-m", "ignore"]);
  await mkdir(join(f.root, "deps"), { recursive: true }); await writeFile(join(f.root, "deps", "lib.js"), "x"); await writeFile(join(f.root, ".env"), "TOKEN=1\n");
  await writeFile(join(f.root, "file.txt"), "changed\n"); await checked(f.root, ["commit", "-am", "change"]);
  const commit = await checked(f.root, ["rev-parse", "HEAD"]);
  const result = await revertChanges(f.pi, { cwd: f.root }, { ...await expectations(f), commit });
  assert.deepEqual(result.stagedPaths, ["file.txt"]);
  assert.equal(await readFile(join(f.root, ".env"), "utf8"), "TOKEN=1\n");
  const g = await fixture(t);
  await writeFile(join(g.root, "secret.env"), "tracked\n"); await checked(g.root, ["add", "secret.env"]); await checked(g.root, ["commit", "-m", "add"]);
  await checked(g.root, ["rm", "-q", "secret.env"]); await writeFile(join(g.root, ".gitignore"), "secret.env\n"); await checked(g.root, ["add", ".gitignore"]); await checked(g.root, ["commit", "-m", "drop"]);
  const drop = await checked(g.root, ["rev-parse", "HEAD"]);
  await writeFile(join(g.root, "secret.env"), "local only\n");
  await assert.rejects(revertChanges(g.pi, { cwd: g.root }, { ...await expectations(g), commit: drop }), /ignored local-only files at paths the commit touches \(secret\.env\)/u);
  assert.equal(await readFile(join(g.root, "secret.env"), "utf8"), "local only\n");
});

test("explicit-source restore pins commits and can delete only an approved tracked path absent from source", async (t) => {
  const f = await fixture(t);
  const original = await checked(f.root, ["rev-parse", "HEAD"]);
  await writeFile(join(f.root, "new-file"), "new"); await checked(f.root, ["add", "."]); await checked(f.root, ["commit", "-m", "added"]);
  const args = await expectations(f, ["new-file"]);
  const preview = await restorePaths(f.pi, { cwd: f.root }, { ...args, preview: true, sourceRef: original });
  assert.equal(preview.preview[0].operation, "delete");
  await restorePaths(f.pi, { cwd: f.root }, { ...args, sourceRef: preview.sourceCommit, expectedFiles: preview.expectedFiles, discardChanges: true });
  await assert.rejects(readFile(join(f.root, "new-file")), { code: "ENOENT" });
});

test("no-commit revert stages an inverse without moving HEAD and conflicting reverts restore verified clean state", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file.txt"), "changed\n"); await checked(f.root, ["commit", "-am", "change"]);
  const commit = await checked(f.root, ["rev-parse", "HEAD"]);
  const result = await revertChanges(f.pi, { cwd: f.root }, { ...await expectations(f), commit });
  assert.equal(result.committed, false); assert.equal(result.head, commit);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "initial\n");
  const g = await fixture(t);
  await writeFile(join(g.root, "file.txt"), "change\n"); await checked(g.root, ["commit", "-am", "change"]);
  const undo = await checked(g.root, ["rev-parse", "HEAD"]);
  await writeFile(join(g.root, "file.txt"), "later\n"); await checked(g.root, ["commit", "-am", "later"]);
  const before = await expectations(g);
  await assert.rejects(revertChanges(g.pi, { cwd: g.root }, { ...before, commit: undo }), /restoration was verified/u);
  const status = await getGitStatus(g.pi, { cwd: g.root });
  assert.equal(status.head, before.expectedHead); assert.equal(status.index, before.expectedIndex); assert.equal(status.hasChanges, false); assert.equal(status.operations.length, 0);
});
