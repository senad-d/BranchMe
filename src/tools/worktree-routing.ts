import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveRepositoryWorktreeCwd, withRepositoryMutationQueue } from "../git.ts";

const ROUTED = new Set(["create_branch", "change_branch", "track_branch", "fetch_branch", "pull_branch", "rebase_branch", "push_branch", "update_from_base", "pull_request", "pull_request_status", "pull_request_feedback"]);
const READ_ONLY = new Set(["branch_status", "list_branches", "list_worktrees", "git_status", "git_diff", "git_log", "git_show", "git_conflicts", "pull_request_status", "pull_request_feedback", "pull_request_files", "list_remotes", "pull_request_checks"]);
type Tool = { name: string; parameters: unknown; execute: (...args: never[]) => Promise<unknown> };

async function invokeRouted(pi: Pick<ExtensionAPI, "exec">, name: string, execute: (...args: unknown[]) => Promise<unknown>, args: unknown[]): Promise<unknown> {
  const input = args[1] as { worktreePath?: string; number?: number };
  if (ROUTED.has(name) && input.worktreePath !== undefined) {
    if (["pull_request_status", "pull_request_feedback"].includes(name) && input.number !== undefined) throw new Error("worktreePath is only for branch-inferred PR lookup; omit it with an exact PR number.");
    const ctx = args[4] as { cwd: string };
    const cwd = await resolveRepositoryWorktreeCwd(pi, ctx, input.worktreePath, args[2] as AbortSignal | undefined);
    args = [...args];
    args[4] = { ...ctx, cwd };
  }
  return execute(...args);
}
async function executeCoordinated(pi: Pick<ExtensionAPI, "exec">, name: string, execute: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]): Promise<unknown> {
  if (READ_ONLY.has(name)) return invokeRouted(pi, name, execute, args);
  // A process-wide outer tool queue protects shared refs/config across worktrees.
  // Lock order: tool coordinator -> existing root queue -> existing common-dir queue.
  // Direct helper callers retain their existing queues; no tool calls another tool.
  return withRepositoryMutationQueue("BranchMe:tool-mutation-coordinator", invokeRouted.bind(undefined, pi, name, execute, args));
}
export function withWorktreeRouting<T extends Tool>(pi: Pick<ExtensionAPI, "exec">, tool: T): T {
  const parameters = tool.parameters as { properties: Record<string, unknown> };
  return {
    ...tool,
    ...(ROUTED.has(tool.name) ? { parameters: { ...parameters, properties: { ...parameters.properties, worktreePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute root of another live worktree of this repository; branch-dependent operations use that checkout, not Pi's cwd." })) } } } : {}),
    execute: executeCoordinated.bind(undefined, pi, tool.name, tool.execute as unknown as (...args: unknown[]) => Promise<unknown>) as unknown as T["execute"],
  } as T;
}
