import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";
import { checked, fixture } from "./helpers/git-fixture.mjs";

function toolsFor(pi, options) { const tools = []; registerBranchMeTools({ exec: pi.exec, registerTool: tools.push.bind(tools) }, options); return new Map(tools.map((tool) => [tool.name, tool])); }
async function call(tools, cwd, name, params) { return tools.get(name).execute(name, params, undefined, undefined, { cwd }); }
function json(body) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }

test("a coordinator switches/creates, fetches/pulls/pushes and creates a PR in another checkout without moving its own HEAD", async (t) => {
  const f = await fixture(t);
  const bare = join(f.temp, "remote.git");
  await checked(f.temp, ["init", "--bare", bare]);
  await checked(f.root, ["remote", "add", "origin", bare]); await checked(f.root, ["push", "-u", "origin", "main"]);
  const linked = join(f.temp, "linked"); await checked(f.root, ["worktree", "add", "-b", "feature", linked]);
  await checked(f.root, ["branch", "spare"]);
  const head = await checked(f.root, ["rev-parse", "HEAD"]);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([url, init.method]);
    if (url.includes("/branches/")) return json({ name: "topic", commit: { sha: head } });
    if (init.method === "GET") return json([]);
    return json({ number: 7, html_url: "https://github.com/owner/repo/pull/7", state: "open", draft: false, head: { ref: "topic" }, base: { ref: "main" } });
  };
  const tools = toolsFor(f.pi, { env: { GH_TOKEN: "private-test-token", GITHUB_REPOSITORY: "owner/repo" }, fetchImpl });
  await call(tools, f.root, "change_branch", { branchName: "spare", worktreePath: linked });
  await call(tools, f.root, "create_branch", { branchName: "topic", worktreePath: linked });
  await call(tools, f.root, "push_branch", { worktreePath: linked });
  await call(tools, f.root, "fetch_branch", { worktreePath: linked });
  await call(tools, f.root, "pull_branch", { worktreePath: linked });
  const pr = await call(tools, f.root, "pull_request", { headBranch: "topic", baseBranch: "main", title: "Title", body: "", draft: false, worktreePath: linked });
  assert.equal(pr.details.number, 7);
  assert.equal(await checked(f.root, ["branch", "--show-current"]), "main");
  assert.equal(await checked(f.root, ["rev-parse", "HEAD"]), head);
  assert.equal(await checked(linked, ["branch", "--show-current"]), "topic");
  assert.ok(requests.some((request) => request[1] === "POST"));
  const foreign = await fixture(t);
  for (const name of ["push_branch", "pull_branch", "create_branch", "update_from_base"]) await assert.rejects(call(tools, f.root, name, { branchName: "unused", baseBranch: "main", worktreePath: foreign.root }));
  await assert.rejects(call(tools, f.root, "pull_request_status", { number: 7, worktreePath: linked }), /branch-inferred/u);
});

test("mutation tools in different checkouts share an outer coordinator without blocking reads", async (t) => {
  const f = await fixture(t);
  const linked = join(f.temp, "linked"); await checked(f.root, ["worktree", "add", "-b", "linked", linked]);
  let active = 0; let peak = 0;
  const pi = { async exec(command, args, options) {
    if (args[0] === "switch") { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 30)); }
    try { return await f.pi.exec(command, args, options); }
    finally { if (args[0] === "switch") active--; }
  } };
  const tools = toolsFor(pi, {});
  await Promise.all([call(tools, f.root, "create_branch", { branchName: "one" }), call(tools, f.root, "create_branch", { branchName: "two", worktreePath: linked })]);
  assert.equal(peak, 1);
});
