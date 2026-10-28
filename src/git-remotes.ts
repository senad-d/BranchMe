import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCanonicalCommonGitDirectory, inspectDirectLocalBranchRef, inspectDirectRemoteTrackingRef, runGit, validateBranchName, withRepositoryMutationQueue } from "./git.ts";
import { boundedGitText, fingerprint, openGitReader, readGit, safeGitText, validateKeys, type GitAPI, type GitReader } from "./git-read.ts";
import type { GitCommandContext } from "./git.ts";

interface ConfigEntry { scope: string; origin: string; key: string; value: string }
async function configuration(reader: GitReader): Promise<ConfigEntry[]> {
  const raw = (await readGit(reader, ["config", "--null", "--show-scope", "--show-origin", "--list"])).stdout;
  const fields = raw ? raw.slice(0, -1).split("\0") : [];
  if ((raw && !raw.endsWith("\0")) || fields.length % 3) throw new Error("Malformed Git configuration inspection.");
  const entries = [];
  for (let i = 0; i < fields.length; i += 3) {
    const separator = fields[i + 2].indexOf("\n");
    if (separator < 0) throw new Error("Malformed Git configuration entry.");
    entries.push({ scope: fields[i], origin: fields[i + 1], key: fields[i + 2].slice(0, separator), value: fields[i + 2].slice(separator + 1) });
  }
  return entries;
}
function configIdentity(entries: ConfigEntry[]): string { return fingerprint(JSON.stringify(entries)); }
function remoteNames(entries: ConfigEntry[]): string[] {
  return [...new Set(entries.map(remoteName).filter((name): name is string => name !== undefined))].sort((a, b) => a.localeCompare(b));
}
function remoteName(entry: ConfigEntry): string | undefined { return /^remote\.(.+)\.[^.]+$/u.exec(entry.key)?.[1]; }
function values(entries: ConfigEntry[], key: string): string[] { return entries.filter((entry) => entry.key === key).map((entry) => entry.value); }
function safeName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(name) || name === "." || name.includes("..") || name.endsWith("/") || name.includes("//")) throw new TypeError("Expected a safe configured remote name, not a URL or option.");
}
function safeDestination(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(value) || safeGitText(value) !== value) throw new TypeError("Remote destination must be credential-free HTTPS or SSH.");
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/u.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("Remote destination must be an explicit HTTPS or SSH URL."); }
  if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/" || url.password || url.search || url.hash || (url.protocol === "https:" && url.username) || (url.username && !/^[a-zA-Z0-9._-]+$/u.test(url.username))) throw new TypeError("Unsupported remote transport or embedded credentials.");
}
export async function listRemotes(host: GitAPI, ctx: GitCommandContext, signal?: AbortSignal, tokens: readonly string[] = []) {
  const reader = await openGitReader(host, ctx, undefined, signal, tokens);
  const entries = await configuration(reader);
  const names = remoteNames(entries);
  if (names.length > 100) throw new Error("Remote inventory exceeds the 100-remote safety limit.");
  const remotes = await Promise.all(names.slice(0, 25).map(inspectRemote.bind(undefined, reader, entries, tokens)));
  return { action: "list_remotes", configuration: configIdentity(entries), remotes, omitted: Math.max(0, names.length - 25), complete: names.length <= 25 };
}
async function inspectRemote(reader: GitReader, entries: ConfigEntry[], tokens: readonly string[], name: string) {
  const configured = values(entries, `remote.${name}.url`);
  const push = values(entries, `remote.${name}.pushurl`);
  let validName = true;
  try { safeName(name); } catch { validName = false; }
  let supported = validName && configured.length === 1 && push.length <= 1;
  try { for (const url of [...configured, ...push]) safeDestination(url); } catch { supported = false; }
  const effectiveFetch = validName ? await readGit(reader, ["remote", "get-url", "--all", "--", name], true) : { stdout: "Unsupported remote name." };
  const effectivePush = validName ? await readGit(reader, ["remote", "get-url", "--push", "--all", "--", name], true) : { stdout: "Unsupported remote name." };
  return { name: boundedGitText(name, tokens, 128, 1).text, reusableName: validName && safeGitText(name, tokens) === name && name.length <= 128, supported, configuredFetch: configured.slice(0, 2).map((url) => boundedGitText(url, tokens, 128, 1).text), configuredPush: push.slice(0, 2).map((url) => boundedGitText(url, tokens, 128, 1).text), omittedUrls: Math.max(0, configured.length - 2) + Math.max(0, push.length - 2), effectiveFetch: boundedGitText(effectiveFetch.stdout, tokens, 256, 2).text, effectivePush: boundedGitText(effectivePush.stdout, tokens, 256, 2).text };
}
async function requireWritableConfiguration(reader: GitReader, entries: ConfigEntry[], expected: string): Promise<string> {
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG"]) if (process.env[key] !== undefined) throw new Error("Git path/config environment overrides must be unset for guarded repository configuration writes.");
  if (!/^[a-f0-9]{64}$/u.test(expected) || configIdentity(entries) !== expected) throw new Error("Configuration changed; call list_remotes again and use its configuration fingerprint.");
  if (entries.some((entry) => entry.key === "extensions.worktreeconfig" && entry.value !== "false")) throw new Error("Configuration mutations do not support worktree-specific config.");
  const common = await getCanonicalCommonGitDirectory(reader.pi, reader.ctx, reader.signal);
  const path = join(common, "config");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Repository config must be a regular non-symlink file.");
  return `file:${path}`;
}
export interface AddRemoteInput { name: string; url: string; expectedConfig: string }
export async function addRemote(host: GitAPI, ctx: GitCommandContext, input: AddRemoteInput, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateKeys(input, ["name", "url", "expectedConfig"]); safeName(input.name); safeDestination(input.url);
  if (safeGitText(input.name, tokens) !== input.name) throw new Error("Remote name is not a reusable safe identity.");
  if (safeGitText(input.url, tokens) !== input.url) throw new Error("Credentials must not be stored in remote URLs.");
  const reader = await openGitReader(host, ctx, undefined, signal, tokens);
  const common = await getCanonicalCommonGitDirectory(reader.pi, reader.ctx, signal);
  return withRepositoryMutationQueue(common, addRemoteInside.bind(undefined, host, reader, input));
}
async function addRemoteInside(host: GitAPI, reader: GitReader, input: AddRemoteInput) {
  const { signal, tokens } = reader;
  const before = await configuration(reader);
  await requireWritableConfiguration(reader, before, input.expectedConfig);
  if (before.some((entry) => entry.key.startsWith("url."))) throw new Error("URL rewriting configuration is unsupported for add_remote; no configuration changed.");
  const names = remoteNames(before);
  if (names.some((name) => name.toLowerCase() === input.name.toLowerCase() || name.toLowerCase().startsWith(`${input.name.toLowerCase()}/`) || input.name.toLowerCase().startsWith(`${name.toLowerCase()}/`))) throw new Error("Remote exists or overlaps another remote namespace.");
  if (configIdentity(await configuration(reader)) !== input.expectedConfig) throw new Error("Configuration changed during preparation; retry list_remotes.");
  try {
    await runGit(host, reader.ctx, ["remote", "add", "--", input.name, input.url], { signal, tokens });
    const after = await configuration({ ...reader, signal: undefined });
    const unrelated = after.filter((entry) => !entry.key.startsWith(`remote.${input.name}.`));
    if (JSON.stringify(unrelated) !== JSON.stringify(before) || values(after, `remote.${input.name}.url`).join() !== input.url || values(after, `remote.${input.name}.fetch`).join() !== `+refs/heads/*:refs/remotes/${input.name}/*`) throw new Error("Remote configuration did not match the requested state.");
    return { action: "add_remote", name: input.name, configuration: configIdentity(after), fetched: false };
  } catch (error) { throw new Error(`Remote setup outcome requires inspection with list_remotes; no rollback attempted. ${boundedGitText(String(error), tokens, 2000).text}`); }
}
export interface SetUpstreamInput { branchName: string; upstream?: string; unset?: boolean; expectedConfig: string }
export async function setUpstream(host: GitAPI, ctx: GitCommandContext, input: SetUpstreamInput, signal?: AbortSignal, tokens: readonly string[] = []) {
  validateKeys(input, ["branchName", "upstream", "unset", "expectedConfig"]);
  if ((input.upstream === undefined) === (input.unset !== true) || (input.unset !== undefined && input.unset !== true)) throw new TypeError("Supply exactly upstream or unset: true.");
  const reader = await openGitReader(host, ctx, undefined, signal, tokens);
  const common = await getCanonicalCommonGitDirectory(reader.pi, reader.ctx, signal);
  return withRepositoryMutationQueue(common, setUpstreamInside.bind(undefined, host, reader, input));
}
function requireSafeTrackingIdentities(input: SetUpstreamInput, tokens: readonly string[]): void {
  if (safeGitText(input.branchName, tokens) !== input.branchName || (input.upstream !== undefined && safeGitText(input.upstream, tokens) !== input.upstream)) throw new Error("Tracking identities cannot be safely reused.");
}
async function setUpstreamInside(host: GitAPI, reader: GitReader, input: SetUpstreamInput) {
  const { signal, tokens } = reader;
  await validateBranchName(reader.pi, reader.ctx, input.branchName, signal);
  requireSafeTrackingIdentities(input, tokens);
  if ((await inspectDirectLocalBranchRef(reader.pi, reader.ctx, input.branchName, signal)).status !== "present") throw new Error("Local branch does not exist.");
  const before = await configuration(reader);
  const origin = await requireWritableConfiguration(reader, before, input.expectedConfig);
  const keys = [`branch.${input.branchName}.remote`, `branch.${input.branchName}.merge`];
  const owned = before.filter((entry) => keys.includes(entry.key));
  if (owned.some((entry) => entry.scope !== "local" || !entry.origin.startsWith("file:") || resolve(reader.ctx.cwd, entry.origin.slice(5)) !== origin.slice(5)) || keys.some((key) => values(before, key).length > 1)) throw new Error("Upstream settings are inherited, included, or ambiguous; no configuration changed.");
  let remote: string | undefined;
  let merge: string | undefined;
  if (input.upstream !== undefined) {
    await validateBranchName(reader.pi, reader.ctx, input.upstream, signal);
    const candidates = remoteNames(before).filter((name) => input.upstream!.startsWith(`${name}/`));
    if (candidates.length !== 1) throw new Error("Upstream must name one existing configured remote-tracking branch.");
    remote = candidates[0]; safeName(remote);
    merge = `refs/heads/${input.upstream.slice(remote.length + 1)}`;
    if ((await inspectDirectRemoteTrackingRef(reader.pi, reader.ctx, input.upstream, signal)).status !== "present") throw new Error("Upstream tracking ref is missing or symbolic; fetch separately first.");
  }
  if (configIdentity(await configuration(reader)) !== input.expectedConfig) throw new Error("Configuration changed during preparation; call list_remotes again.");
  if (!input.upstream && !owned.length) return { action: "set_upstream", branchName: input.branchName, upstream: null, configuration: input.expectedConfig, changed: false };
  try {
    await runGit(host, reader.ctx, ["branch", ...(input.upstream ? [`--set-upstream-to=refs/remotes/${input.upstream}`] : ["--unset-upstream"]), "--", input.branchName], { signal, tokens });
    const after = await configuration({ ...reader, signal: undefined });
    if (JSON.stringify(before.filter((entry) => !keys.includes(entry.key))) !== JSON.stringify(after.filter((entry) => !keys.includes(entry.key))) || values(after, keys[0]).join() !== (remote ?? "") || values(after, keys[1]).join() !== (merge ?? "")) throw new Error("Upstream postconditions were not verified.");
    return { action: "set_upstream", branchName: safeGitText(input.branchName, tokens), upstream: input.upstream ? safeGitText(input.upstream, tokens) : null, configuration: configIdentity(after), changed: true };
  } catch (error) { throw new Error(`Upstream outcome requires inspection with list_remotes; no rollback attempted. ${boundedGitText(String(error), tokens, 2000).text}`); }
}
