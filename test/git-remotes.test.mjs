import assert from "node:assert/strict";
import test from "node:test";
import { addRemote, listRemotes, setUpstream } from "../src/git-remotes.ts";
import { checked, fixture, git, state } from "./helpers/git-fixture.mjs";

test("remote setup works on an unborn repo and refuses overwrite, unsafe URLs, stale config and rewrites", async (t) => {
  const f = await fixture(t, true);
  const empty = await listRemotes(f.pi, { cwd: f.root });
  assert.equal(empty.remotes.length, 0);
  await addRemote(f.pi, { cwd: f.root }, { name: "origin", url: "https://github.com/owner/repo.git", expectedConfig: empty.configuration });
  const listed = await listRemotes(f.pi, { cwd: f.root });
  assert.equal(listed.remotes[0].supported, true);
  assert.match(listed.remotes[0].effectiveFetch, /github.com/u);
  await assert.rejects(addRemote(f.pi, { cwd: f.root }, { name: "origin", url: "https://github.com/other/repo.git", expectedConfig: listed.configuration }), /exists/u);
  await assert.rejects(addRemote(f.pi, { cwd: f.root }, { name: "other", url: "https://github.com/owner/repo.git", expectedConfig: empty.configuration }), /changed/u);
  for (const url of ["ext::evil", "https://user:password@example.invalid/repo", "file:///tmp/repo", "ssh://user:password@host/repo"]) await assert.rejects(addRemote(f.pi, { cwd: f.root }, { name: "other", url, expectedConfig: listed.configuration }));
  await checked(f.root, ["config", "url.https://example.invalid/.insteadOf", "https://github.com/"]);
  const rewritten = await listRemotes(f.pi, { cwd: f.root });
  await assert.rejects(addRemote(f.pi, { cwd: f.root }, { name: "other", url: "git@github.com:owner/repo.git", expectedConfig: rewritten.configuration }), /rewriting/u);
});
test("list_remotes sorts mixed-case names alphabetically without changing repository state", async (t) => {
  const f = await fixture(t);
  for (const name of ["Zebra", "alpha", "Beta"]) await checked(f.root, ["remote", "add", name, "https://github.com/owner/repo.git"]);
  const before = await state(f.root);
  const listed = await listRemotes(f.pi, { cwd: f.root });
  assert.deepEqual(listed.remotes.map((remote) => remote.name), ["alpha", "Beta", "Zebra"]);
  assert.equal(listed.complete, true);
  assert.deepEqual(await state(f.root), before);
});

test("set_upstream only changes the named branch tracking settings and can unset them", async (t) => {
  const f = await fixture(t);
  await checked(f.root, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
  const head = await checked(f.root, ["rev-parse", "HEAD"]);
  await checked(f.root, ["update-ref", "refs/remotes/origin/topic", head]);
  const before = await state(f.root);
  let config = await listRemotes(f.pi, { cwd: f.root });
  await setUpstream(f.pi, { cwd: f.root }, { branchName: "main", upstream: "origin/topic", expectedConfig: config.configuration });
  assert.equal(await checked(f.root, ["rev-parse", "--abbrev-ref", "@{u}"]), "origin/topic");
  config = await listRemotes(f.pi, { cwd: f.root });
  await setUpstream(f.pi, { cwd: f.root }, { branchName: "main", unset: true, expectedConfig: config.configuration });
  assert.notEqual((await git(f.root, ["rev-parse", "@{u}"])).code, 0);
  const after = await state(f.root);
  assert.deepEqual(after.index, before.index);
  assert.equal(after.head, before.head);
  assert.equal(after.refs, before.refs);
  assert.deepEqual(after.file, before.file);
});
