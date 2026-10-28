import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { getGitConflicts } from "../src/git-conflicts.ts";
import { checked, fixture, git, state } from "./helpers/git-fixture.mjs";

async function conflictsFixture(t) {
  const f = await fixture(t);
  await checked(f.root, ["switch", "-c", "other"]);
  await writeFile(join(f.root, "file.txt"), "theirs\n");
  await writeFile(join(f.root, "added"), "their addition\n");
  await checked(f.root, ["add", "."]); await checked(f.root, ["commit", "-m", "other"]);
  await checked(f.root, ["switch", "main"]);
  await writeFile(join(f.root, "file.txt"), "ours\n");
  await writeFile(join(f.root, "added"), "our addition\n");
  await checked(f.root, ["add", "."]); await checked(f.root, ["commit", "-m", "main"]);
  assert.equal((await git(f.root, ["merge", "other"])).code, 1);
  return f;
}
test("git_conflicts exposes exact content and absent base stages without mutating kept merges", async (t) => {
  const f = await conflictsFixture(t);
  const before = await state(f.root);
  const listed = await getGitConflicts(f.pi, { cwd: f.root });
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.operations, ["merge"]);
  const inspected = await getGitConflicts(f.pi, { cwd: f.root }, { path: "file.txt", expectedIndex: listed.index });
  assert.deepEqual(inspected.inspected.stages.map((stage) => stage.text), ["initial\n", "ours\n", "theirs\n"]);
  const added = await getGitConflicts(f.pi, { cwd: f.root }, { path: "added", stage: 1 });
  assert.deepEqual(added.inspected.stages, [{ stage: 1, present: false }]);
  assert.deepEqual(await state(f.root), before);
  await checked(f.root, ["add", "added"]);
  await assert.rejects(getGitConflicts(f.pi, { cwd: f.root }, { path: "file.txt", expectedIndex: listed.index }), /changed/u);
});
test("git_conflicts handles modify/delete and binary stages, pagination and stale continuation", async (t) => {
  const f = await fixture(t);
  const blob = await checked(f.root, ["rev-parse", "HEAD:file.txt"]);
  // Build index conflicts directly to cover absent stages and >25 paths independently of merge drivers.
  const binary = await git(f.root, ["hash-object", "-w", "--stdin"], { input: Buffer.from([0, 255]) });
  assert.equal(binary.code, 0);
  const lines = ["0 " + "0".repeat(40) + "\tfile.txt"];
  for (let i = 0; i < 30; i++) {
    const path = `conflict-${i}`;
    lines.push(`100644 ${blob} 1\t${path}`, `100644 ${binary.stdout.trim()} 3\t${path}`);
  }
  assert.equal((await git(f.root, ["update-index", "--index-info"], { input: lines.join("\n") + "\n" })).code, 0);
  const first = await getGitConflicts(f.pi, { cwd: f.root });
  assert.equal(first.complete, false);
  assert.equal((await getGitConflicts(f.pi, { cwd: f.root }, { after: first.next })).entries.length, 5);
  const one = await getGitConflicts(f.pi, { cwd: f.root }, { path: "conflict-0" });
  assert.equal(one.inspected.stages[1].present, false);
  assert.equal(one.inspected.stages[2].binary, true);
  await checked(f.root, ["update-index", "--force-remove", "conflict-1"]);
  await assert.rejects(getGitConflicts(f.pi, { cwd: f.root }, { after: first.next }), /stale/u);
});
test("git_conflicts rejects malformed requests and supports clean worktrees", async (t) => {
  const f = await fixture(t);
  assert.equal((await getGitConflicts(f.pi, { cwd: f.root })).total, 0);
  for (const input of [{ path: "../x" }, { stage: 1 }, { expectedIndex: "bad" }, { path: "file.txt" }, { after: "bad" }, { force: true }]) await assert.rejects(getGitConflicts(f.pi, { cwd: f.root }, input));
});
