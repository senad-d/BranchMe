import assert from "node:assert/strict";
import test from "node:test";
import { BRANCHME_TOOL_NAMES } from "../src/constants.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

function unexpectedExec() {
  throw new Error("Metadata inspection must not execute Git or contact GitHub");
}

function registeredTools() {
  const tools = [];
  registerBranchMeTools({ registerTool: tools.push.bind(tools), exec: unexpectedExec });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

// Check essential scope/effects, not exhaustive manuals or LLM selection accuracy.
const scopeCases = [
  ["create_branch", /create and switch.*current HEAD/iu],
  ["change_branch", /existing local branch.*refuses uncommitted tracked changes/iu],
  ["fetch_branch", /one remote branch.*without updating local branches/iu],
  ["fetch_remote", /all branch heads.*pruning.*never server branches/iu],
  ["track_branch", /fetch.*new local tracking branch.*switch/iu],
  ["pull_branch", /fetch and fast-forward.*configured upstream.*divergence/iu],
  ["rebase_branch", /configured upstream.*rewriting local commits.*does not fetch/iu],
  ["update_from_base", /remote base.*current branch.*without rewriting history.*conflicts abort/iu],
  ["integrate_branch", /local source.*already-checked-out local target.*merge commit.*conflicts abort/iu],
  ["conclude_merge", /existing merge.*entire index.*does not resolve conflicts/iu],
  ["retire_branch", /unoccupied local branch.*expected commit.*explicit authorization.*remote branches and worktrees remain untouched/iu],
  ["land_branch", /after a verified merge.*delete.*branch and linked worktree, including ignored files.*does not merge PRs/iu],
  ["remove_worktree", /delete.*checkout but keep.*branch.*explicit authorization/iu],
  ["pull_request_status", /open, closed, or merged.*does not certify CI success or review approval/iu],
  ["label_pull_request", /add existing.*preserving.*current labels.*refuses unknown/iu],
];

for (const [name, pattern] of scopeCases) {
  test(`${name} description retains essential scope and effects`, () => {
    assert.match(registeredTools().get(name).description, pattern);
  });
}

test("tool prose is compact without repeated names or mandatory extra rules", () => {
  const tools = registeredTools();
  assert.deepEqual([...tools.keys()].sort(), [...BRANCHME_TOOL_NAMES].sort());
  const prose = [];
  for (const tool of tools.values()) {
    for (const text of [tool.description, tool.promptSnippet]) {
      assert.ok(text.trim().length > 0, tool.name);
      assert.equal(text, text.trim(), tool.name);
      assert.doesNotMatch(text, /[\r\n]/u, tool.name);
      assert.equal(text.startsWith(tool.name), false, tool.name);
    }
    assert.ok(tool.promptGuidelines.every((line) => line.includes(tool.name)), tool.name);
    prose.push(tool.description, tool.promptSnippet, ...tool.promptGuidelines);
  }
  assert.deepEqual(tools.get("pull_request_files").promptGuidelines, []);
  assert.deepEqual(tools.get("list_worktrees").promptGuidelines, []);
  const previousProseCharacters = 29_518;
  assert.ok(prose.join("\n").length <= previousProseCharacters / 2, "keep prose at least 50% smaller than the verbose first pass");
});

test("guidance keeps authorization, freshness, and merge lifecycle safeguards", () => {
  const tools = registeredTools();
  const ancestry = tools.get("branch_status").promptGuidelines.join(" ");
  assert.match(ancestry, /independent.*ancestry checks are allowed/iu);
  assert.match(ancestry, /wait for preceding integrate_branch or fetch_branch/iu);
  for (const name of ["integrate_branch", "update_from_base"]) {
    const guidance = tools.get(name).promptGuidelines.join(" ");
    assert.match(guidance, /planned editing step/iu);
    assert.match(guidance, /conflict_kept.*conclude_merge to commit or abort before another Git mutation/iu);
  }
  const completion = tools.get("conclude_merge").promptGuidelines.join(" ");
  assert.match(completion, /all marker lines.*diff3\/custom-sized/iu);
  assert.match(completion, /working-tree and index/iu);
  assert.match(completion, /does not apply to abort/iu);
  assert.match(completion, /entire index, including previously staged entries.*do not stage unrelated edits/iu);
  assert.match(tools.get("retire_branch").promptGuidelines.join(" "), /force requires explicit authorization for unmerged data loss/iu);
  assert.match(tools.get("rebase_branch").promptGuidelines.join(" "), /explicit authorization to rewrite local history/iu);
  const removal = tools.get("remove_worktree").promptGuidelines.join(" ");
  assert.match(removal, /separate explicit authorization for discardChanges and deleteIgnored/iu);
  assert.match(removal, /all ignored content.*\.env and \.pi\//iu);
  const landing = tools.get("land_branch").promptGuidelines.join(" ");
  assert.match(landing, /squash\/rebase merges supply pullRequestNumber/iu);
  assert.match(landing, /preserve needed ignored files.*\.env and \.pi\//iu);
  assert.match(landing, /inspect each receipt/iu);
  assert.match(landing, /never switches a dirty checkout or discards uncommitted changes/iu);
});

test("schemas retain parameter usage instead of duplicating it in descriptions", () => {
  const tools = registeredTools();
  const fetch = tools.get("fetch_branch").parameters.properties;
  assert.match(fetch.remote.description, /requires branch.*omit together.*configured upstream/iu);
  const ancestry = tools.get("branch_status").parameters.properties.ancestry.properties;
  assert.match(ancestry.sourceBranch.description, /contained in targetBranch/iu);
  assert.match(ancestry.targetBranch.description, /containing sourceBranch/iu);
  assert.match(tools.get("update_from_base").parameters.properties.baseBranch.description, /main, not origin\/main/iu);
  assert.match(tools.get("track_branch").parameters.properties.remoteBranch.description, /topic, not origin\/topic/iu);
  const retire = tools.get("retire_branch").parameters.properties;
  assert.match(retire.expectedHead.description, /refuses if the branch has moved/iu);
  assert.match(retire.force.description, /false requires merged history.*true permits.*explicit user authorization/iu);
  assert.match(tools.get("conclude_merge").parameters.properties.action.description, /commit the entire index/iu);
  assert.match(tools.get("git_diff").parameters.properties.mode.description, /unstaged:.*staged:.*range:/u);
});
