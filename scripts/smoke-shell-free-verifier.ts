// Test-only deterministic model: no Bash, file tools, other extensions, or live HTTP.
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { BRANCHME_TOOL_NAMES } from "../src/constants.ts";

const scenario = process.env.BRANCHME_WORKFLOW_SCENARIO;
const mockHead = "a".repeat(40);
const mockBase = "b".repeat(40);
const mockMerge = "c".repeat(40);
const repo = { name: "branchme-smoke", owner: { login: "senad-d" }, full_name: "senad-d/branchme-smoke" };
const pr = { number: 7, node_id: "PR_smoke", title: "Initial", body: "Body", draft: false, state: "open", merged: false, merged_at: null, merge_commit_sha: null, html_url: "https://github.com/senad-d/branchme-smoke/pull/7", head: { ref: "feature/smoke", sha: mockHead, repo }, base: { ref: "main", sha: mockBase, repo } };
let forbidden = 0;
function json(value) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
async function mockedFetch(url, init = {}) {
  if (scenario !== "github" || !String(url).startsWith("https://api.github.com/")) throw new Error("Live network access is forbidden in workflow smoke");
  if (String(url).includes("/pulls?")) return json([]);
  if (String(url).endsWith("/graphql")) return json({ data: { repository: { pullRequest: { headRefOid: mockHead, baseRefOid: mockBase, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } } } } });
  if (String(url).includes("/check-runs?")) return json({ total_count: 1, check_runs: [{ id: 1, app: { id: 1 }, name: "test", status: "completed", conclusion: "success", html_url: "https://github.com/senad-d/branchme-smoke/runs/1" }] });
  if (String(url).includes("/status?")) return json({ total_count: 0, statuses: [] });
  if (String(url).endsWith("/pulls/7/merge")) {
    const body = JSON.parse(init.body);
    if (body.sha !== mockHead || body.merge_method !== "squash" || Object.keys(body).length !== 2) throw new Error("Incorrect merge lease/body");
    pr.merged = true; pr.state = "closed"; pr.merged_at = "2026-10-23T10:00:00Z"; pr.merge_commit_sha = mockMerge;
    return json({ merged: true, sha: mockMerge });
  }
  if (String(url).endsWith("/pulls/7")) { if (init.method === "PATCH") Object.assign(pr, JSON.parse(init.body)); return json(pr); }
  if (String(url).endsWith("/repos/senad-d/branchme-smoke")) return json({ allow_squash_merge: true });
  throw new Error("Unexpected mock API request");
}
globalThis.fetch = mockedFetch;
function assistant(model) { return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }; }
function emit(model, name, args, text) {
  const stream = createAssistantMessageEventStream(); const output = assistant(model);
  const item = name ? { type: "toolCall", id: "workflow-" + name + "-" + Date.now(), name, arguments: args } : { type: "text", text };
  output.content.push(item); output.stopReason = name ? "toolUse" : "stop";
  stream.push({ type: "start", partial: output });
  if (name) {
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: item, partial: output });
  } else {
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  }
  stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end(); return stream;
}
function textOf(result) { return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"); }
function data(result) { const text = textOf(result); return JSON.parse(text.slice(text.indexOf("{"))); }
function status(result) { const text = textOf(result); return { expectedHead: /HEAD: ([a-f0-9]{40,64})/u.exec(text)[1], expectedIndex: /index expectation: ([a-f0-9]{64})/u.exec(text)[1] }; }
const allowed = {
  local: ["git_log", "git_show", "git_status", "stage_changes", "unstage_changes", "restore_paths", "list_remotes", "add_remote", "set_upstream", "create_branch", "rebase_branch", "revert_changes"],
  conflicts: ["git_conflicts"], github: ["pull_request_checks", "edit_pull_request", "merge_pull_request"],
};
function localStep(results) {
  const paths = ["tracked.txt"];
  switch (results.length) {
    case 0: return ["git_log", {}];
    case 1: return ["git_show", { ref: data(results[0]).commits[0].head, output: "file", path: "tracked.txt" }];
    case 2: return ["git_status", { paths }];
    case 3: return ["stage_changes", { paths, ...status(results[2]) }];
    case 4: return ["git_status", { paths }];
    case 5: return ["unstage_changes", { paths, ...status(results[4]) }];
    case 6: return ["git_status", { paths }];
    case 7: return ["restore_paths", { paths, ...status(results[6]), preview: true }];
    case 8: return ["restore_paths", { paths, ...status(results[6]), expectedFiles: data(results[7]).expectedFiles, discardChanges: true }];
    case 9: return ["list_remotes", {}];
    case 10: return ["add_remote", { name: "secondary", url: "git@github.com:senad-d/smoke-secondary.git", expectedConfig: data(results[9]).configuration }];
    case 11: return ["set_upstream", { branchName: "feature/smoke", upstream: "origin/feature/smoke", expectedConfig: data(results[10]).configuration }];
    case 12: return ["create_branch", { branchName: "coordinated-topic", baseRef: "origin/feature/smoke", worktreePath: process.env.BRANCHME_WORKFLOW_LINKED }];
    case 13: return ["rebase_branch", { baseRef: "origin/feature/smoke", worktreePath: process.env.BRANCHME_WORKFLOW_LINKED }];
    case 14: return ["revert_changes", { commit: process.env.BRANCHME_WORKFLOW_COMMIT, ...status(results[6]) }];
    default:
      if (!data(results[8]).applied || data(results[14]).committed !== false || !data(results[14]).stagedPaths.includes("revertable.txt")) throw new Error("Local workflow postconditions missing");
      return null;
  }
}
function scenarioStep(results) {
  if (scenario === "local") return localStep(results);
  if (scenario === "conflicts") {
    if (!results.length) return ["git_conflicts", {}];
    if (results.length === 1) return ["git_conflicts", { path: "tracked.txt", expectedIndex: data(results[0]).index }];
    if (data(results[1]).inspected.stages.some((stage) => !stage.present || !stage.text)) throw new Error("Conflict stages missing");
    return null;
  }
  if (scenario === "github") {
    if (!results.length) return ["pull_request_checks", { number: 7 }];
    if (results.length === 1) { if (data(results[0]).verdict !== "passed") throw new Error("Checks missing"); return ["edit_pull_request", { number: 7, title: "Explicit update" }]; }
    if (results.length === 2) return ["merge_pull_request", { number: 7, expectedHead: mockHead, mergeMethod: "squash" }];
    if (data(results[2]).pullRequest.mergeCommitSha !== mockMerge || data(results[2]).cleanupPerformed !== false) throw new Error("Merge proof missing");
    return null;
  }
  throw new Error("Unknown workflow scenario");
}
function streamModel(model, context) {
  try {
    const names = getCurrentTools(context.messages).map((tool) => tool.name);
    if (names.some((name) => !allowed[scenario].includes(name)) || names.includes("bash") || forbidden) throw new Error("Non-allowlisted tool available/called");
    const results = context.messages.filter((message) => message.role === "toolResult");
    if (results.some((result) => result.isError)) throw new Error("Workflow tool failed: " + textOf(results.find((result) => result.isError)));
    const step = scenarioStep(results);
    return step ? emit(model, step[0], step[1]) : emit(model, null, null, `BRANCHME_SHELL_FREE:${scenario}:ok`);
  } catch (error) { return emit(model, null, null, "BRANCHME_SHELL_FREE:failed " + String(error)); }
}
export default function verifyShellFree(pi) {
  pi.on("session_start", () => pi.setActiveTools(allowed[scenario]));
  pi.on("tool_call", (event) => { if (!allowed[scenario].includes(event.toolName)) { forbidden++; return { block: true, reason: "Only scenario BranchMe tools are authorized" }; } });
  pi.registerProvider("branchme-workflow-smoke", { name: "Workflow Smoke", api: "branchme-workflow-api", apiKey: "smoke-key", baseUrl: "http://127.0.0.1.invalid", models: [{ id: "workflow", name: "Workflow", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }], streamSimple: streamModel });
  if (allowed[scenario].some((name) => !BRANCHME_TOOL_NAMES.includes(name))) throw new Error("Unknown smoke tool");
}
