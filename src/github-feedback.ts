import {
  GITHUB_API_BASE_URL, GITHUB_GRAPHQL_TIMEOUT_MS, GITHUB_JOB_LOG_TIMEOUT_MS, PULL_REQUEST_FEEDBACK_BODY_LIMIT_CHARS,
  PULL_REQUEST_FEEDBACK_LOG_JOB_LIMIT, PULL_REQUEST_FEEDBACK_LOG_LIMIT_CHARS, PULL_REQUEST_FEEDBACK_LOG_TAIL_BYTES,
  PULL_REQUEST_FEEDBACK_LOG_TAIL_LINES, PULL_REQUEST_FEEDBACK_RESPONSE_LIMIT_BYTES, PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS,
} from "./constants.ts";
import {
  encodePathSegment, fetchGitHubResponse, gitHubJsonHeaders, isRecord, parseGitHubJson, pullRequestNumberField,
  readBoundedResponseText, requireFetchImplementation, requireGitHubResponseObject, validateGitHubRepository,
  type PullRequestFetchOptions,
} from "./github.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  GitHubRepository, PullRequestFeedbackCheck, PullRequestFeedbackComment, PullRequestFeedbackDetails,
  PullRequestFeedbackReview, PullRequestFeedbackThread,
} from "./types.ts";

// One GraphQL request reads review threads with their resolution state, review summaries, conversation
// comments and the head commit's check rollup; REST has no thread resolution state.
const FEEDBACK_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number url headRefOid
      reviewThreads(first: 100) { totalCount nodes { isResolved isOutdated path line comments(first: 20) { nodes { author { login } body url } } } }
      reviews(last: 50) { nodes { author { login } state body url } }
      comments(last: 50) { totalCount nodes { author { login } body url } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name conclusion databaseId detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

const FAILING_CHECK_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"]);
const FAILING_STATUS_STATES = new Set(["FAILURE", "ERROR"]);
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/gu;
const LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

function safeText(value: unknown, token: string, limit: number): string {
  if (typeof value !== "string") return "";
  const text = redactSecrets(value, [token]).replace(UNSAFE_TEXT_PATTERN, (character) => (character === "\n" ? "\n" : " ")).trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function nodes(connection: unknown): Record<string, unknown>[] {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return [];
  return connection.nodes.filter(isRecord);
}

function totalCount(connection: unknown): number {
  return isRecord(connection) && typeof connection.totalCount === "number" ? connection.totalCount : 0;
}

function parseComment(node: Record<string, unknown>, token: string): PullRequestFeedbackComment {
  const author = isRecord(node.author) ? safeText(node.author.login, token, 100) : "";
  return {
    author: author || "ghost",
    body: safeText(node.body, token, PULL_REQUEST_FEEDBACK_BODY_LIMIT_CHARS),
    url: safeText(node.url, token, 300),
  };
}

function parseThreads(connection: unknown, token: string): Pick<PullRequestFeedbackDetails, "unresolvedThreads" | "resolvedThreadCount" | "outdatedThreadCount"> {
  const unresolvedThreads: PullRequestFeedbackThread[] = [];
  let resolvedThreadCount = 0;
  let outdatedThreadCount = 0;
  for (const thread of nodes(connection)) {
    if (thread.isResolved === true) resolvedThreadCount += 1;
    else if (thread.isOutdated === true) outdatedThreadCount += 1;
    else {
      unresolvedThreads.push({
        path: safeText(thread.path, token, 300),
        line: typeof thread.line === "number" ? thread.line : null,
        comments: nodes(thread.comments).map((comment) => parseComment(comment, token)),
      });
    }
  }
  return { unresolvedThreads, resolvedThreadCount, outdatedThreadCount };
}

function parseReviews(connection: unknown, token: string): PullRequestFeedbackReview[] {
  return nodes(connection)
    .map((review) => ({ ...parseComment(review, token), state: safeText(review.state, token, 40) }))
    .filter((review) => review.body !== "" || review.state === "CHANGES_REQUESTED");
}

function parseCheck(node: Record<string, unknown>, token: string): PullRequestFeedbackCheck | null {
  if (node.__typename === "CheckRun") {
    const conclusion = typeof node.conclusion === "string" ? node.conclusion : "";
    if (!FAILING_CHECK_CONCLUSIONS.has(conclusion)) return null;
    const detailsUrl = safeText(node.detailsUrl, token, 300);
    const isActionsJob = detailsUrl.includes("/actions/runs/") && typeof node.databaseId === "number";
    return { name: safeText(node.name, token, 200), conclusion, url: detailsUrl, jobId: isActionsJob ? node.databaseId as number : null };
  }
  const state = typeof node.state === "string" ? node.state : "";
  if (!FAILING_STATUS_STATES.has(state)) return null;
  return { name: safeText(node.context, token, 200), conclusion: state, url: safeText(node.targetUrl, token, 300), jobId: null };
}

async function postFeedbackQuery(repository: GitHubRepository, number: number, token: string, options: PullRequestFetchOptions): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), GITHUB_GRAPHQL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchGitHubResponse(requireFetchImplementation(options.fetchImpl ?? globalThis.fetch), `${GITHUB_API_BASE_URL}/graphql`, {
      method: "POST",
      headers: gitHubJsonHeaders(token),
      body: JSON.stringify({ query: FEEDBACK_QUERY, variables: { owner: repository.owner, repo: repository.repo, number } }),
      signal,
    }, "GitHub pull request feedback lookup failed", token);
    if (!response.ok) throw new Error(`GitHub pull request feedback lookup returned HTTP ${response.status}.`);
    const body = await readBoundedResponseText(response, signal, PULL_REQUEST_FEEDBACK_RESPONSE_LIMIT_BYTES);
    if (body.truncated) throw new Error("GitHub pull request feedback exceeded the response byte limit.");
    const payload = requireGitHubResponseObject(parseGitHubJson(body.text, "GitHub pull request feedback response", token), "Pull request feedback");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((error) => (isRecord(error) ? safeText(error.message, token, 300) : "")).filter(Boolean);
      throw new Error(`GitHub pull request feedback query failed: ${messages.join("; ") || "unknown GraphQL error"}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTail(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let tail = Buffer.alloc(0);
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      tail = Buffer.concat([tail, Buffer.from(value)]);
      if (tail.byteLength > PULL_REQUEST_FEEDBACK_LOG_TAIL_BYTES) tail = tail.subarray(tail.byteLength - PULL_REQUEST_FEEDBACK_LOG_TAIL_BYTES);
    }
  } finally {
    reader.releaseLock();
  }
  return tail.toString("utf8");
}

// Keep the lines leading up to the last error annotation; without one, the end of the log.
export function extractLogTail(log: string, token: string): string {
  const lines = log.split(/\r?\n/u).map((line) => line.replace(ANSI_ESCAPE_PATTERN, "").replace(LOG_TIMESTAMP_PATTERN, "")).filter((line) => line.trim() !== "");
  let end = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes("##[error]")) {
      end = index + 1;
      break;
    }
  }
  const excerpt = lines.slice(Math.max(0, end - PULL_REQUEST_FEEDBACK_LOG_TAIL_LINES), end).join("\n");
  const text = safeText(excerpt, token, Number.MAX_SAFE_INTEGER);
  return text.length <= PULL_REQUEST_FEEDBACK_LOG_LIMIT_CHARS ? text : `…${text.slice(text.length - PULL_REQUEST_FEEDBACK_LOG_LIMIT_CHARS + 1)}`;
}

async function attachJobLog(repository: GitHubRepository, check: PullRequestFeedbackCheck, token: string, options: PullRequestFetchOptions): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), GITHUB_JOB_LOG_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const url = `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/actions/jobs/${check.jobId}/logs`;
    const response = await fetchGitHubResponse(requireFetchImplementation(options.fetchImpl ?? globalThis.fetch), url, {
      method: "GET", headers: gitHubJsonHeaders(token), signal,
    }, "GitHub job log lookup failed", token);
    if (!response.ok) {
      check.logError = `job log returned HTTP ${response.status}`;
      return;
    }
    check.logTail = extractLogTail(await readResponseTail(response, signal), token);
  } catch (error) {
    check.logError = safeText(error instanceof Error ? error.message : String(error), token, 300);
  } finally {
    clearTimeout(timer);
  }
}

export async function getPullRequestFeedback(repository: GitHubRepository, number: number, token: string, options: PullRequestFetchOptions = {}): Promise<PullRequestFeedbackDetails> {
  validateGitHubRepository(repository);
  pullRequestNumberField(number);
  const payload = await postFeedbackQuery(repository, number, token, options);
  const data = isRecord(payload.data) ? payload.data : {};
  const pullRequest = isRecord(data.repository) && isRecord(data.repository.pullRequest) ? data.repository.pullRequest : null;
  if (!pullRequest) throw new Error(`Pull request #${number} was not found in ${repository.owner}/${repository.repo}.`);
  if (pullRequestNumberField(pullRequest.number) !== number) throw new Error("GitHub returned a different pull request number.");

  const commit = nodes(pullRequest.commits)[0];
  const rollup = isRecord(commit?.commit) && isRecord(commit.commit.statusCheckRollup) ? commit.commit.statusCheckRollup : null;
  const contexts = rollup ? nodes(rollup.contexts) : [];
  const failingChecks = contexts.map((node) => parseCheck(node, token)).filter((check): check is PullRequestFeedbackCheck => check !== null);
  // ponytail: logs for the first few failing Actions jobs only; raise the limit if wide matrices hide the cause.
  const logChecks = failingChecks.filter((item) => item.jobId !== null).slice(0, PULL_REQUEST_FEEDBACK_LOG_JOB_LIMIT);
  await Promise.all(logChecks.map((check) => attachJobLog(repository, check, token, options)));

  const threadNodes = nodes(pullRequest.reviewThreads);
  const commentNodes = nodes(pullRequest.comments);
  return {
    repository,
    number,
    url: safeText(pullRequest.url, token, 300),
    headSha: safeText(pullRequest.headRefOid, token, 64),
    checksState: rollup ? safeText(rollup.state, token, 40) : null,
    ...parseThreads(pullRequest.reviewThreads, token),
    reviews: parseReviews(pullRequest.reviews, token),
    comments: commentNodes.map((comment) => parseComment(comment, token)).filter((comment) => comment.body !== ""),
    failingChecks,
    omitted: {
      threads: Math.max(0, totalCount(pullRequest.reviewThreads) - threadNodes.length),
      comments: Math.max(0, totalCount(pullRequest.comments) - commentNodes.length),
      checks: rollup ? Math.max(0, totalCount(rollup.contexts) - contexts.length) : 0,
    },
  };
}

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

function formatThread(thread: PullRequestFeedbackThread): string {
  const location = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  return [`- ${location}`, ...thread.comments.map((comment) => `  @${comment.author}: ${comment.body}`)].join("\n");
}

function formatCheck(check: PullRequestFeedbackCheck): string {
  const lines = [`- ${check.name}: ${check.conclusion} ${check.url}`.trimEnd()];
  if (check.logTail) lines.push(`  Log tail (job ${check.jobId}):`, indent(check.logTail));
  if (check.logError) lines.push(`  Log unavailable: ${check.logError}`);
  return lines.join("\n");
}

export function formatPullRequestFeedback(details: PullRequestFeedbackDetails): string {
  const omittedThreads = details.omitted.threads ? `; ${details.omitted.threads} beyond the first 100 not read` : "";
  const omittedComments = details.omitted.comments ? ` (latest 50; ${details.omitted.comments} older not read)` : "";
  const omittedChecks = details.omitted.checks ? ` (${details.omitted.checks} checks beyond the first 100 not read)` : "";
  const sections = [
    `PR #${details.number} feedback at head ${details.headSha.slice(0, 12)}; checks ${details.checksState ?? "not reported"}. ${details.url}`,
    `Unresolved review threads: ${details.unresolvedThreads.length} (${details.resolvedThreadCount} resolved and ${details.outdatedThreadCount} outdated not listed${omittedThreads}).`,
    ...details.unresolvedThreads.map(formatThread),
    `Reviews with a body or requested changes: ${details.reviews.length}.`,
    ...details.reviews.map((review) => `- @${review.author} ${review.state}: ${review.body}`),
    `Conversation comments: ${details.comments.length}${omittedComments}.`,
    ...details.comments.map((comment) => `- @${comment.author}: ${comment.body}`),
    `Failing checks: ${details.failingChecks.length}${omittedChecks}.`,
    ...details.failingChecks.map(formatCheck),
  ];
  const text = sections.join("\n");
  return text.length <= PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS ? text : `${text.slice(0, PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS - 40)}\n… [truncated; full data in details]`;
}
