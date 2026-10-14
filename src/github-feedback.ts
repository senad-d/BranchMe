import {
  GITHUB_API_BASE_URL, GITHUB_GRAPHQL_TIMEOUT_MS, GITHUB_JOB_LOG_TIMEOUT_MS, PULL_REQUEST_FEEDBACK_BODY_LIMIT_CHARS,
  PULL_REQUEST_FEEDBACK_LOG_JOB_LIMIT, PULL_REQUEST_FEEDBACK_LOG_LIMIT_CHARS, PULL_REQUEST_FEEDBACK_LOG_TAIL_BYTES,
  PULL_REQUEST_FEEDBACK_LOG_TAIL_LINES, PULL_REQUEST_FEEDBACK_RESPONSE_LIMIT_BYTES, PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS,
  PULL_REQUEST_REPLY_BODY_LIMIT_CHARS,
} from "./constants.ts";
import {
  encodePathSegment, fetchGitHubResponse, gitHubJsonHeaders, isRecord, parseGitHubJson, pullRequestNumberField,
  readBoundedResponseText, requireFetchImplementation, requireGitHubResponseObject, validateGitHubRepository,
  type PullRequestFetchOptions,
} from "./github.ts";
import { redactSecrets } from "./redaction.ts";
import type {
  GitHubRepository, PullRequestFeedbackAnnotation, PullRequestFeedbackCheck, PullRequestFeedbackComment, PullRequestFeedbackDetails,
  PullRequestFeedbackReview, PullRequestFeedbackThread, PullRequestReplyDetails, PullRequestReplyInput,
} from "./types.ts";

// One GraphQL request reads review threads with their resolution state, review summaries, conversation
// comments and the head commit's check rollup; REST has no thread resolution state.
// Ids, times and the viewer let an agent reply to a thread and skip its own earlier replies.
const FEEDBACK_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id number url headRefOid
      reviewThreads(first: 100) { totalCount nodes { id isResolved isOutdated path line comments(first: 20) { nodes { id author { login } createdAt body url } } } }
      reviews(last: 50) { nodes { id author { login } submittedAt state body url } }
      comments(last: 50) { totalCount nodes { id author { login } createdAt body url } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name conclusion databaseId detailsUrl annotations(first: 20) { nodes { path location { start { line } } annotationLevel message } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

const FAILING_CHECK_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"]);
const FAILING_STATUS_STATES = new Set(["FAILURE", "ERROR"]);
const REPORTED_ANNOTATION_LEVELS = new Set(["FAILURE", "WARNING"]);
const ANNOTATION_MESSAGE_LIMIT_CHARS = 500;
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

function parseComment(viewer: string | null, token: string, node: Record<string, unknown>): PullRequestFeedbackComment {
  const author = isRecord(node.author) ? safeText(node.author.login, token, 100) : "";
  return {
    id: safeText(node.id, token, 200),
    author: author || "ghost",
    byViewer: viewer !== null && author === viewer,
    createdAt: safeText(node.createdAt ?? node.submittedAt, token, 40),
    body: safeText(node.body, token, PULL_REQUEST_FEEDBACK_BODY_LIMIT_CHARS),
    url: safeText(node.url, token, 300),
  };
}

function parseThreads(connection: unknown, viewer: string | null, token: string): Pick<PullRequestFeedbackDetails, "unresolvedThreads" | "resolvedThreadCount" | "outdatedThreadCount"> {
  const unresolvedThreads: PullRequestFeedbackThread[] = [];
  let resolvedThreadCount = 0;
  let outdatedThreadCount = 0;
  for (const thread of nodes(connection)) {
    if (thread.isResolved === true) resolvedThreadCount += 1;
    else if (thread.isOutdated === true) outdatedThreadCount += 1;
    else {
      unresolvedThreads.push({
        id: safeText(thread.id, token, 200),
        path: safeText(thread.path, token, 300),
        line: typeof thread.line === "number" ? thread.line : null,
        comments: nodes(thread.comments).map(parseComment.bind(undefined, viewer, token)),
      });
    }
  }
  return { unresolvedThreads, resolvedThreadCount, outdatedThreadCount };
}

function parseReviews(connection: unknown, viewer: string | null, token: string): PullRequestFeedbackReview[] {
  return nodes(connection)
    .map((review) => ({ ...parseComment(viewer, token, review), state: safeText(review.state, token, 40) }))
    .filter((review) => review.body !== "" || review.state === "CHANGES_REQUESTED");
}

function parseAnnotation(token: string, node: Record<string, unknown>): PullRequestFeedbackAnnotation | null {
  const level = typeof node.annotationLevel === "string" ? node.annotationLevel : "";
  if (!REPORTED_ANNOTATION_LEVELS.has(level)) return null;
  const start = isRecord(node.location) && isRecord(node.location.start) ? node.location.start : null;
  return {
    path: safeText(node.path, token, 300),
    line: typeof start?.line === "number" ? start.line : null,
    level,
    message: safeText(node.message, token, ANNOTATION_MESSAGE_LIMIT_CHARS),
  };
}

function parseCheck(node: Record<string, unknown>, token: string): PullRequestFeedbackCheck | null {
  if (node.__typename === "CheckRun") {
    const conclusion = typeof node.conclusion === "string" ? node.conclusion : "";
    if (!FAILING_CHECK_CONCLUSIONS.has(conclusion)) return null;
    const detailsUrl = safeText(node.detailsUrl, token, 300);
    const isActionsJob = detailsUrl.includes("/actions/runs/") && typeof node.databaseId === "number";
    const annotations = nodes(node.annotations)
      .map(parseAnnotation.bind(undefined, token))
      .filter((annotation): annotation is PullRequestFeedbackAnnotation => annotation !== null);
    return { name: safeText(node.name, token, 200), conclusion, url: detailsUrl, jobId: isActionsJob ? node.databaseId as number : null, annotations };
  }
  const state = typeof node.state === "string" ? node.state : "";
  if (!FAILING_STATUS_STATES.has(state)) return null;
  return { name: safeText(node.context, token, 200), conclusion: state, url: safeText(node.targetUrl, token, 300), jobId: null, annotations: [] };
}

async function postFeedbackQuery(repository: GitHubRepository, number: number, token: string, options: PullRequestFetchOptions): Promise<Record<string, unknown>> {
  return postGraphQL(FEEDBACK_QUERY, { owner: repository.owner, repo: repository.repo, number }, token, options, "GitHub pull request feedback");
}

async function postGraphQL(query: string, variables: Record<string, unknown>, token: string, options: PullRequestFetchOptions, label: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), GITHUB_GRAPHQL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchGitHubResponse(requireFetchImplementation(options.fetchImpl ?? globalThis.fetch), `${GITHUB_API_BASE_URL}/graphql`, {
      method: "POST",
      headers: gitHubJsonHeaders(token),
      body: JSON.stringify({ query, variables }),
      signal,
    }, `${label} lookup failed`, token);
    if (!response.ok) throw new Error(`${label} lookup returned HTTP ${response.status}.`);
    const body = await readBoundedResponseText(response, signal, PULL_REQUEST_FEEDBACK_RESPONSE_LIMIT_BYTES);
    if (body.truncated) throw new Error(`${label} exceeded the response byte limit.`);
    const payload = requireGitHubResponseObject(parseGitHubJson(body.text, `${label} response`, token), label);
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((error) => (isRecord(error) ? safeText(error.message, token, 300) : "")).filter(Boolean);
      throw new Error(`${label} query failed: ${messages.join("; ") || "unknown GraphQL error"}`);
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
  const viewer = isRecord(data.viewer) ? safeText(data.viewer.login, token, 100) || null : null;
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
    id: safeText(pullRequest.id, token, 200),
    viewer,
    url: safeText(pullRequest.url, token, 300),
    headSha: safeText(pullRequest.headRefOid, token, 64),
    checksState: rollup ? safeText(rollup.state, token, 40) : null,
    ...parseThreads(pullRequest.reviewThreads, viewer, token),
    reviews: parseReviews(pullRequest.reviews, viewer, token),
    comments: commentNodes.map(parseComment.bind(undefined, viewer, token)).filter((comment) => comment.body !== ""),
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

function location(path: string, line: number | null): string {
  return line === null ? path : `${path}:${line}`;
}

// "@alice (you) 2026-10-14T19:50:15Z" — the marker and time decide what is new.
function byline(comment: PullRequestFeedbackComment): string {
  return [`@${comment.author}`, comment.byViewer ? "(you)" : "", comment.createdAt].filter(Boolean).join(" ");
}

function idTag(kind: string, id: string): string {
  return id ? `[${kind} ${id}] ` : "";
}

function formatThread(thread: PullRequestFeedbackThread): string {
  return [
    `- ${idTag("thread", thread.id)}${location(thread.path, thread.line)}`,
    ...thread.comments.map((comment) => `  ${byline(comment)}: ${comment.body}`),
  ].join("\n");
}

function formatCheck(check: PullRequestFeedbackCheck): string {
  const lines = [`- ${check.name}: ${check.conclusion} ${check.url}`.trimEnd()];
  if (check.annotations.length > 0) {
    lines.push("  Annotations:", ...check.annotations.map((item) => `    ${location(item.path, item.line)} ${item.level}: ${item.message}`));
  }
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
    ...(details.viewer ? [`Token user: @${details.viewer}; comments marked (you) are its own earlier replies.`] : []),
    `Unresolved review threads: ${details.unresolvedThreads.length} (${details.resolvedThreadCount} resolved and ${details.outdatedThreadCount} outdated not listed${omittedThreads}).`,
    ...details.unresolvedThreads.map(formatThread),
    `Reviews with a body or requested changes: ${details.reviews.length}.`,
    ...details.reviews.map((review) => `- ${byline(review)} ${review.state}: ${review.body}`),
    `Conversation comments: ${details.comments.length}${omittedComments}.`,
    ...details.comments.map((comment) => `- ${idTag("comment", comment.id)}${byline(comment)}: ${comment.body}`),
    `Failing checks: ${details.failingChecks.length}${omittedChecks}.`,
    ...details.failingChecks.map(formatCheck),
  ];
  const text = sections.join("\n");
  return text.length <= PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS ? text : `${text.slice(0, PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS - 40)}\n… [truncated; full data in details]`;
}

const THREAD_OWNER_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { id isResolved pullRequest { number repository { name owner { login } } } } }
}`;
const PULL_REQUEST_EXISTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { number } }
}`;
const THREAD_REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { url } }
}`;
const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

function validateReplyInput(input: PullRequestReplyInput): string {
  pullRequestNumberField(input.number);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body === "") throw new Error("body is required and cannot be blank.");
  if (body.length > PULL_REQUEST_REPLY_BODY_LIMIT_CHARS) throw new Error(`body exceeds ${PULL_REQUEST_REPLY_BODY_LIMIT_CHARS} characters.`);
  if (input.resolve === true && !input.threadId) throw new Error("resolve requires threadId; conversation comments cannot be resolved.");
  return body;
}

// The thread must belong to this pull request of this repository before anything is posted.
async function requireThreadOfPullRequest(repository: GitHubRepository, input: PullRequestReplyInput, token: string, options: PullRequestFetchOptions): Promise<boolean> {
  const payload = await postGraphQL(THREAD_OWNER_QUERY, { id: input.threadId }, token, options, "GitHub review thread");
  const node = isRecord(payload.data) && isRecord(payload.data.node) ? payload.data.node : null;
  const pullRequest = node && isRecord(node.pullRequest) ? node.pullRequest : null;
  const owner = pullRequest && isRecord(pullRequest.repository) ? pullRequest.repository : null;
  const ownerLogin = owner && isRecord(owner.owner) ? owner.owner.login : null;
  if (!node || node.id !== input.threadId || pullRequest?.number !== input.number ||
      typeof ownerLogin !== "string" || ownerLogin.toLowerCase() !== repository.owner.toLowerCase() ||
      typeof owner?.name !== "string" || owner.name.toLowerCase() !== repository.repo.toLowerCase()) {
    throw new Error(`Review thread ${safeText(input.threadId, token, 200)} is not a thread of pull request #${input.number} in ${repository.owner}/${repository.repo}; nothing was posted.`);
  }
  return node.isResolved === true;
}

async function replyToThread(repository: GitHubRepository, input: PullRequestReplyInput, body: string, token: string, options: PullRequestFetchOptions): Promise<PullRequestReplyDetails> {
  const alreadyResolved = await requireThreadOfPullRequest(repository, input, token, options);
  const reply = await postGraphQL(THREAD_REPLY_MUTATION, { threadId: input.threadId, body }, token, options, "GitHub review thread reply");
  const added = isRecord(reply.data) && isRecord(reply.data.addPullRequestReviewThreadReply) ? reply.data.addPullRequestReviewThreadReply : null;
  const commentUrl = added && isRecord(added.comment) ? safeText(added.comment.url, token, 300) : "";
  if (!commentUrl) throw new Error("GitHub did not confirm the review thread reply.");
  let resolved: boolean | null = null;
  if (input.resolve === true) {
    resolved = alreadyResolved;
    if (!alreadyResolved) {
      const result = await postGraphQL(RESOLVE_THREAD_MUTATION, { threadId: input.threadId }, token, options, "GitHub review thread resolution");
      const thread = isRecord(result.data) && isRecord(result.data.resolveReviewThread) && isRecord(result.data.resolveReviewThread.thread)
        ? result.data.resolveReviewThread.thread : null;
      resolved = thread?.isResolved === true;
    }
  }
  return { action: "reply_pull_request_feedback", repository, number: input.number, threadId: input.threadId ?? null, commentUrl, resolved };
}

async function commentOnPullRequest(repository: GitHubRepository, input: PullRequestReplyInput, body: string, token: string, options: PullRequestFetchOptions): Promise<PullRequestReplyDetails> {
  // Issues and pull requests share numbers; confirming a pull request first keeps the comment off an issue.
  // GraphQL, not the REST status read: a pull request from a fork is still this repository's pull request.
  const found = await postGraphQL(PULL_REQUEST_EXISTS_QUERY, { owner: repository.owner, repo: repository.repo, number: input.number }, token, options, "GitHub pull request");
  const pullRequest = isRecord(found.data) && isRecord(found.data.repository) ? found.data.repository.pullRequest : null;
  if (!isRecord(pullRequest) || pullRequest.number !== input.number) {
    throw new Error(`Pull request #${input.number} was not found in ${repository.owner}/${repository.repo}; nothing was posted.`);
  }
  const url = `${GITHUB_API_BASE_URL}/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}/issues/${input.number}/comments`;
  const response = await fetchGitHubResponse(requireFetchImplementation(options.fetchImpl ?? globalThis.fetch), url, {
    method: "POST", headers: gitHubJsonHeaders(token), body: JSON.stringify({ body }), signal: options.signal,
  }, "GitHub pull request comment failed", token);
  if (!response.ok) throw new Error(`GitHub pull request comment returned HTTP ${response.status}.`);
  const text = await readBoundedResponseText(response, options.signal, PULL_REQUEST_FEEDBACK_RESPONSE_LIMIT_BYTES);
  const payload = requireGitHubResponseObject(parseGitHubJson(text.text, "GitHub pull request comment response", token), "Pull request comment");
  const commentUrl = safeText(payload.html_url, token, 300);
  if (!commentUrl) throw new Error("GitHub did not confirm the pull request comment.");
  return { action: "reply_pull_request_feedback", repository, number: input.number, threadId: null, commentUrl, resolved: null };
}

/** Replies to one review thread (and optionally resolves it), or posts one conversation comment. */
export async function replyPullRequestFeedback(repository: GitHubRepository, input: PullRequestReplyInput, token: string, options: PullRequestFetchOptions = {}): Promise<PullRequestReplyDetails> {
  validateGitHubRepository(repository);
  const body = validateReplyInput(input);
  return input.threadId
    ? replyToThread(repository, input, body, token, options)
    : commentOnPullRequest(repository, input, body, token, options);
}

export function formatPullRequestReply(details: PullRequestReplyDetails): string {
  if (details.threadId === null) return `Commented on PR #${details.number}: ${details.commentUrl}`;
  let resolution = "";
  if (details.resolved !== null) resolution = details.resolved ? "; thread resolved" : "; thread NOT resolved";
  return `Replied to thread ${details.threadId} on PR #${details.number}${resolution}: ${details.commentUrl}`;
}
