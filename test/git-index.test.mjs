import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { changeIndex } from "../src/git-index.ts";
import { getGitStatus } from "../src/git-status.ts";
import { checked, fixture } from "./helpers/git-fixture.mjs";
async function input(f, paths) { const status = await getGitStatus(f.pi, { cwd: f.root }); return { paths, expectedHead: status.head, expectedIndex: status.index }; }

test("stage/unstage preserve partial working edits and unrelated index entries with expected-state checks", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "unrelated"), "staged only"); await checked(f.root, ["add", "unrelated"]);
  await writeFile(join(f.root, "file.txt"), "staged\n"); await checked(f.root, ["add", "file.txt"]);
  await writeFile(join(f.root, "file.txt"), "working\n");
  const args = await input(f, ["file.txt"]);
  const result = await changeIndex(f.pi, { cwd: f.root }, args, "unstage_changes");
  assert.equal(result.workingFilesPreserved, true);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "working\n");
  assert.equal(await checked(f.root, ["show", ":file.txt"]), "initial");
  assert.equal(await checked(f.root, ["show", ":unrelated"]), "staged only");
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, args, "stage_changes"), /changed/u);
  await changeIndex(f.pi, { cwd: f.root }, await input(f, ["file.txt"]), "stage_changes");
  assert.equal(await checked(f.root, ["show", ":file.txt"]), "working");
});
test("staging both approved rename sides updates content without re-adding a removed source", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["mv", "file.txt", "renamed"]);
  await writeFile(join(f.root, "renamed"), "updated rename\n");
  await changeIndex(f.pi, { cwd: f.root }, await input(f, ["file.txt", "renamed"]), "stage_changes");
  assert.equal(await checked(f.root, ["show", ":renamed"]), "updated rename");
  assert.equal(await checked(f.root, ["ls-files"]), "renamed");
});

test("stage/unstage additions and deletions work before the first commit and with literal paths", async (t) => {
  const f = await fixture(t, true);
  await writeFile(join(f.root, "*.txt"), "new");
  await changeIndex(f.pi, { cwd: f.root }, await input(f, ["*.txt"]), "stage_changes");
  await changeIndex(f.pi, { cwd: f.root }, await input(f, ["*.txt"]), "unstage_changes");
  assert.equal(await checked(f.root, ["ls-files"]), "");
  assert.equal(await readFile(join(f.root, "*.txt"), "utf8"), "new");
  const g = await fixture(t);
  await rm(join(g.root, "file.txt"));
  await changeIndex(g.pi, { cwd: g.root }, await input(g, ["file.txt"]), "stage_changes");
  assert.equal(await checked(g.root, ["ls-files"]), "");
  await changeIndex(g.pi, { cwd: g.root }, await input(g, ["file.txt"]), "unstage_changes");
  await assert.rejects(readFile(join(g.root, "file.txt")), { code: "ENOENT" });
});
test("index tools refuse directories, ignored files, unapproved rename sides and special indexes", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["mv", "file.txt", "renamed"]);
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, await input(f, ["renamed"]), "unstage_changes"), /Both sides/u);
  await changeIndex(f.pi, { cwd: f.root }, await input(f, ["file.txt", "renamed"]), "unstage_changes");
  await writeFile(join(f.root, ".gitignore"), "ignored\n"); await writeFile(join(f.root, "ignored"), "keep");
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, await input(f, ["ignored"]), "stage_changes"), /ignored/u);
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, await input(f, ["."]), "stage_changes"));
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, await input(f, ["FILE.TXT"]), "stage_changes"));
  await writeFile(join(f.root, "intent"), "intent"); await checked(f.root, ["add", "-N", "intent"]);
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, await input(f, ["file.txt"]), "stage_changes"), /Intent-to-add/u);
  await checked(f.root, ["update-index", "--force-remove", "intent"]);
  await checked(f.root, ["update-index", "--assume-unchanged", "file.txt"]);
  await assert.rejects(changeIndex(f.pi, { cwd: f.root }, await input(f, ["file.txt"]), "stage_changes"), /unsupported|assume/u);
});
