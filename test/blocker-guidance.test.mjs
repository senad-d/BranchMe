import assert from "node:assert/strict";
import test from "node:test";
import { blockerGuidance, withBlockerGuidance } from "../src/blocker-guidance.ts";

test("known blockers name the cause and the resolving call", () => {
  assert.match(blockerGuidance("git push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled"), /^Blocked: .*credentials.*\nResolve: set GITHUB_TOKEN or GH_TOKEN/u);
  assert.match(blockerGuidance("Retiring local branch 'feature/x' is occupied by 1 registered worktree record(s)."), /Resolve: change_branch/u);
  assert.match(blockerGuidance("git push failed: ! [rejected] main -> main (fetch first)"), /Resolve: fetch_branch, then pull_branch/u);
  assert.match(blockerGuidance("git fetch failed: fatal: couldn't find remote ref refs/heads/main"), /Resolve: fetch_remote/u);
  assert.match(blockerGuidance("The target worktree has staged, unstaged, untracked, or unmerged changes; clean it before removal."), /possible untracked files.*\nResolve: .*explicit authorization/u);
  assert.equal(blockerGuidance("title is required."), null);
});

test("wrapped tools append guidance to errors once and pass results through", async () => {
  const failing = withBlockerGuidance({ name: "x", execute: async () => { throw new Error("Already on branch 'main'."); } });
  await assert.rejects(failing.execute("id", {}, undefined), (error) => {
    assert.equal(error.message.match(/\nResolve: /gu).length, 1);
    assert.match(error.message, /^Already on branch 'main'\.\nBlocked: /u);
    return true;
  });
  const passing = withBlockerGuidance({ name: "y", execute: async () => "ok" });
  assert.equal(await passing.execute("id", {}, undefined), "ok");
});

test("an aborted call rethrows the original error", async () => {
  const controller = new AbortController();
  controller.abort();
  const original = new Error("git fetch failed (killed): command was killed or timed out");
  const tool = withBlockerGuidance({ name: "z", execute: async () => { throw original; } });
  await assert.rejects(tool.execute("id", {}, controller.signal), (error) => error === original);
});
