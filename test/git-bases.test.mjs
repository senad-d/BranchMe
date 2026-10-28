import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createLocalBranch } from "../src/git.ts";
import { rebaseOntoBase } from "../src/git-rebase.ts";
import { checked, fixture } from "./helpers/git-fixture.mjs";

test("create_branch captures exact local, remote-tracking and full-commit bases without tracking or moving the base", async (t) => {
  const f = await fixture(t);
  const base = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["branch", "base"]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/main", base]);
  await checked(f.root, ["commit", "--allow-empty", "-m", "ahead"]);
  for (const [index, ref] of ["base", "origin/main", base].entries()) {
    const result = await createLocalBranch(f.pi, { cwd: f.root }, `topic-${index}`, undefined, ref);
    assert.equal(result.head, base);
    assert.equal(await checked(f.root, ["rev-parse", "base"]), base);
    assert.equal(await checked(f.root, ["config", "--get-regexp", "branch.*", "never-match"] ).catch(() => ""), "");
  }
});
test("explicit branch bases refuse dirt, missing/unsafe bases and operations before switching", async (t) => {
  const f = await fixture(t);
  for (const ref of ["missing", "--all", "HEAD~1", "HEAD:file"]) await assert.rejects(createLocalBranch(f.pi, { cwd: f.root }, "new", undefined, ref));
  await writeFile(join(f.root, "file.txt"), "dirty");
  await assert.rejects(createLocalBranch(f.pi, { cwd: f.root }, "new", undefined, "main"));
  assert.equal(await checked(f.root, ["branch", "--show-current"]), "main");
});

test("explicit-base rebase works without an upstream and verifies conflict restoration", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["branch", "base"]);
  await checked(f.root, ["commit", "--allow-empty", "-m", "feature"]);
  const result = await rebaseOntoBase(f.pi, { cwd: f.root }, "base");
  assert.equal(result.base, await checked(f.root, ["rev-parse", "base"]));
  await checked(f.root, ["switch", "base"]);
  await writeFile(join(f.root, "file.txt"), "base\n"); await checked(f.root, ["commit", "-am", "base"]);
  await checked(f.root, ["switch", "main"]);
  await writeFile(join(f.root, "file.txt"), "feature\n"); await checked(f.root, ["commit", "-am", "feature content"]);
  const before = await checked(f.root, ["rev-parse", "HEAD"]);
  await assert.rejects(rebaseOntoBase(f.pi, { cwd: f.root }, "base"), /restoration was verified/u);
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), before);
  assert.equal(await checked(f.root, ["status", "--porcelain=v1"]), "");
});
