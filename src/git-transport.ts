import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveGitHubToken } from "./github.ts";

type ExecOptions = Parameters<ExtensionAPI["exec"]>[2];
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

const NETWORK_GIT_COMMANDS = new Set(["fetch", "pull", "push", "ls-remote"]);
const KILL_GRACE_MS = 5000;
const GIT_EXECUTABLE_CANDIDATES = process.platform === "win32"
  ? [String.raw`C:\Program Files\Git\cmd\git.exe`, String.raw`C:\Program Files\Git\bin\git.exe`]
  : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"];

// Answers github.com HTTPS credential requests from the token BranchMe already uses
// for the GitHub API. The token stays in the child environment, never in argv.
// Git queries this after the user's own helpers, so an existing login still wins.
// printf emits Git's credential protocol fields; no credential is stored in source.
export const TOKEN_CREDENTIAL_HELPER = String.raw`!f() { test "$1" = get || exit 0; printf '%s=%s\n' username x-access-token password "$BRANCHME_GIT_TOKEN"; }; f`;

/** The git subcommand after leading `-c <config>` and `-C <dir>` options. */
export function gitSubcommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c" || args[index] === "-C") index += 2;
  return args[index];
}

/** Network commands use a fixed system-install location, never a PATH lookup. */
export async function resolveGitExecutable(): Promise<string> {
  for (const candidate of GIT_EXECUTABLE_CANDIDATES) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed installation location.
    }
  }
  throw new Error("Git was not found in a supported system installation directory; install Git before retrying.");
}

async function resolveTransportToken(env: NodeJS.ProcessEnv, cwd: string | undefined, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await resolveGitHubToken(env, { cwd, signal })).token;
  } catch {
    return null;
  }
}

interface GitProcessState {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  killed: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
}

function forceKillGit(state: GitProcessState): void {
  if (!state.closed) state.child.kill("SIGKILL");
}

function killGit(state: GitProcessState): void {
  if (state.killed || state.closed) return;
  state.killed = true;
  state.child.kill("SIGTERM");
  state.killTimer = setTimeout(forceKillGit, KILL_GRACE_MS, state);
  state.killTimer.unref();
}

function appendGitOutput(state: GitProcessState, stream: "stdout" | "stderr", data: string): void {
  state[stream] += data;
}

function appendGitError(state: GitProcessState, error: Error): void {
  state.stderr += error.message;
}

function finishGit(state: GitProcessState, resolve: (result: ExecResult) => void, code: number | null): void {
  state.closed = true;
  clearTimeout(state.timer);
  clearTimeout(state.killTimer);
  state.signal?.removeEventListener("abort", state.onAbort);
  resolve({ stdout: state.stdout, stderr: state.stderr, code: code ?? 1, killed: state.killed });
}

function startGit(binary: string, args: string[], env: NodeJS.ProcessEnv, options: ExecOptions, resolve: (result: ExecResult) => void): void {
  const child = spawn(binary, args, { cwd: options?.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const state: GitProcessState = { child, stdout: "", stderr: "", killed: false, closed: false, signal: options?.signal, onAbort: () => undefined };
  state.onAbort = killGit.bind(undefined, state);
  state.timer = options?.timeout ? setTimeout(killGit, options.timeout, state) : undefined;
  state.signal?.addEventListener("abort", state.onAbort, { once: true });
  child.stdout!.setEncoding("utf8").on("data", appendGitOutput.bind(undefined, state, "stdout"));
  child.stderr!.setEncoding("utf8").on("data", appendGitOutput.bind(undefined, state, "stderr"));
  child.on("error", appendGitError.bind(undefined, state));
  child.on("close", finishGit.bind(undefined, state, resolve));
}

function spawnGit(binary: string, args: string[], env: NodeJS.ProcessEnv, options: ExecOptions): Promise<ExecResult> {
  if (options?.signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", code: 1, killed: true });
  return new Promise(startGit.bind(undefined, binary, args, env, options));
}

async function execGit(
  pi: Pick<ExtensionAPI, "exec">,
  env: NodeJS.ProcessEnv,
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  if (command !== "git" || !NETWORK_GIT_COMMANDS.has(gitSubcommand(args) ?? "")) return pi.exec(command, args, options);
  // An agent cannot answer a credential prompt: without this git waits on the
  // terminal until the timeout and reports only "killed".
  const childEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  const token = await resolveTransportToken(env, options?.cwd, options?.signal);
  const binary = await resolveGitExecutable();
  if (token === null) return spawnGit(binary, args, childEnv, options);
  childEnv.BRANCHME_GIT_TOKEN = token;
  return spawnGit(binary, ["-c", `credential.https://github.com.helper=${TOKEN_CREDENTIAL_HELPER}`, ...args], childEnv, options);
}

/**
 * Pi's exec cannot set a child environment. Network git commands (fetch, pull,
 * push, ls-remote) spawn git directly without a terminal prompt and with the
 * GitHub token available to git; every other command goes to Pi's exec.
 */
export function withGitTransport(pi: Pick<ExtensionAPI, "exec">, env: NodeJS.ProcessEnv = process.env): Pick<ExtensionAPI, "exec"> {
  return { exec: execGit.bind(undefined, pi, env) };
}
