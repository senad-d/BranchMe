import type { CONVENTIONAL_COMMIT_TYPES } from "./constants.ts";

export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface CurrentBranchInfo {
  currentBranch: string | null;
  detached: boolean;
}

export interface AheadBehindCount {
  ahead: number | null;
  behind: number | null;
}

export interface WorkingTreeDetails {
  state: "clean" | "dirty";
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface BranchStatusAncestryQuery {
  sourceBranch: string;
  targetBranch: string;
}

export interface BranchStatusToolInput {
  ancestry?: BranchStatusAncestryQuery;
}

export interface ListBranchesToolInput {
  kind?: "local" | "remote-tracking";
  /** Git branch-list glob patterns on names, including the remote prefix for remote-tracking refs. */
  patterns?: string[];
}

export interface GitStatusToolInput {
  paths?: string[];
  worktreePath?: string;
  after?: string;
}

export interface GitStatusEntry {
  kind: "tracked" | "untracked" | "conflict";
  /** Display only unless reusablePath is true. */
  path: string;
  originalPath?: string;
  reusablePath: boolean;
  indexStatus: string;
  worktreeStatus: string;
  submodule: string;
  /** Present only for explicitly filtered, reusable paths. No file content is returned. */
  worktreeExpectation?: { fingerprint: string | null; reason?: string };
}

export interface GitStatusDetails {
  action: "git_status";
  repoRoot: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  index: string;
  snapshot: string;
  operations: string[];
  filtered: boolean;
  pathFilters: string[];
  hasChanges: boolean;
  total: number;
  entries: GitStatusEntry[];
  offset: number;
  complete: boolean;
  next: string | null;
}

export type GitDiffMode = "unstaged" | "staged" | "range";
export type GitDiffOutput = "patch" | "stat" | "name-status";

export interface GitDiffToolInput {
  mode?: GitDiffMode;
  baseRef?: string;
  targetRef?: string;
  mergeBase?: boolean;
  output?: GitDiffOutput;
  paths?: string[];
  contextLines?: number;
  worktreePath?: string;
}

export interface GitDiffDetails {
  action: "git_diff";
  repoRoot: string;
  mode: GitDiffMode;
  output: GitDiffOutput;
  /** Redacted/abbreviated literal filter previews, not reusable path identities. */
  pathFilters: string[];
  comparison?: {
    baseHead: string;
    targetHead: string;
    /** The captured base commit, or the unique merge base when requested. */
    diffBaseHead: string;
  };
  hasDifferences: boolean;
  /** Redacted, control-escaped, bounded display text, not an apply-ready patch. */
  diff: string;
  truncated: boolean;
  /** Counts after redaction/control escaping, before truncation. */
  totalBytes: number;
  totalLines: number;
}

export interface FetchRemoteToolInput {
  remote?: string;
  prune?: boolean;
}

export interface FetchRemoteDetails {
  action: "fetch_remote";
  repoRoot: string;
  remote: string;
  prune: boolean;
  refspec: string;
  output: string;
}

export interface BranchEntry {
  name: string;
  fullRef: string;
  kind: "local" | "remote-tracking";
  head: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  symbolicTarget: string | null;
  worktreePaths: string[];
}

export interface ListBranchesDetails {
  action: "list_branches";
  repoRoot: string;
  branches: BranchEntry[];
  omitted: number;
}

export interface InitRepositoryToolInput {
  initialBranch?: string;
}

export interface InitRepositoryDetails {
  action: "init_repository";
  request: InitRepositoryToolInput;
  repoRoot: string;
  gitDirectory: string;
  initialBranch: string;
  bare: false;
  unborn: true;
}

export interface IntegrateBranchToolInput {
  sourceBranch: string;
  targetBranch: string;
  /** Leave a conflicted merge in progress for conclude_merge instead of aborting it. */
  keepConflicts?: boolean;
  /** Absolute root of another worktree of the same repository; omitted means the current one. */
  worktreePath?: string;
}

export interface RetireBranchToolInput {
  branchName: string;
  expectedHead: string;
  targetBranch: string;
  force: boolean;
}

export type CreateWorktreeMode = "new" | "existing";

export type ListWorktreesToolInput = Record<string, never>;

export interface CreateWorktreeToolInput {
  worktreePath: string;
  branchName: string;
  branchMode: CreateWorktreeMode;
  /** Optional read-only start point for branchMode "new": local branch, remote-tracking ref, or full commit. */
  baseRef?: string;
}

export interface RemoveWorktreeToolInput {
  worktreePath: string;
  /** Explicitly authorizes deleting ignored files and directories with the worktree. */
  deleteIgnored?: boolean;
  /** Explicitly authorizes discarding staged, unstaged, untracked and unmerged changes with the worktree. */
  discardChanges?: boolean;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
  main: boolean;
  current: boolean;
}

export interface VerifiedLinkedWorktreeEntry extends Omit<WorktreeEntry, "path" | "branch"> {
  /** Exact machine-readable identity validated to require no BranchMe display transformation. */
  path: string;
  head: string;
  /** Exact machine-readable identity validated to require no BranchMe display transformation. */
  branch: string;
  detached: false;
  bare: false;
  locked: false;
  lockReason: null;
  prunable: false;
  pruneReason: null;
  main: false;
  current: false;
}

export interface ListWorktreesDetails {
  action: "list_worktrees";
  repoRoot: string;
  worktrees: WorktreeEntry[];
  omitted: number;
}

export interface ReadyWorktreeHandoffDetails {
  cwd: string;
  branch: string;
  head: string;
  ready: true;
  summary: string;
}

export interface RetainedBranchHandoffDetails {
  cwd: null;
  branch: string;
  head: string;
  ready: false;
  summary: string;
}

export type WorktreeHandoffDetails = ReadyWorktreeHandoffDetails | RetainedBranchHandoffDetails;

export interface CreateWorktreeDetails {
  action: "create_worktree";
  repoRoot: string;
  request: CreateWorktreeToolInput;
  verified: {
    before: {
      sourcePath: string;
      sourceBranch: string | null;
      sourceDetached: boolean;
      sourceHead: string;
      canonicalWorktreePath: string;
      branchExisted: boolean;
      destinationRegistered: false;
    };
    after: {
      worktreePresent: true;
      worktree: VerifiedLinkedWorktreeEntry;
      workingTree: WorkingTreeDetails;
    };
  };
  handoff: ReadyWorktreeHandoffDetails;
}

export interface RemoveWorktreeDetails {
  action: "remove_worktree";
  deletedIgnoredPaths: string[];
  /** Changed paths discarded under discardChanges; empty for a clean worktree. */
  discardedPaths: string[];
  repoRoot: string;
  request: RemoveWorktreeToolInput;
  verified: {
    before: {
      worktree: VerifiedLinkedWorktreeEntry;
      workingTree: WorkingTreeDetails;
    };
    after: {
      worktreePresent: false;
      branchRetained: true;
      branch: string;
      head: string;
    };
  };
  handoff: RetainedBranchHandoffDetails;
}

export interface GitFileChange {
  status: string;
  path: string;
  originalPath?: string;
}

export interface GitFileChangeSummary {
  entries: GitFileChange[];
  omitted: number;
}

export interface RecentCommit {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
}

export interface RelatedPullRequestDetails {
  repository: GitHubRepository;
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  head: string;
  base: string;
}

export type RelatedPullRequest =
  | { status: "found"; pullRequest: RelatedPullRequestDetails }
  | { status: "none" }
  | { status: "unavailable"; reason: string };

export interface BranchAncestryDetails extends BranchStatusAncestryQuery {
  sourceHead: string;
  targetHead: string;
  isAncestor: boolean;
}

export interface BranchStatusDetails {
  repoRoot: string;
  currentBranch: string | null;
  detached: boolean;
  upstream: string | null;
  hasChanges: boolean;
  ahead: number | null;
  behind: number | null;
  ancestry?: BranchAncestryDetails;
  warnings?: string[];
  githubRepository?: GitHubRepository;
}

export interface GitContextDetails extends BranchStatusDetails {
  pullRequestAutofill: boolean | null;
  workingTree: WorkingTreeDetails;
  unstagedChanges: GitFileChangeSummary;
  relatedPullRequest: RelatedPullRequest;
  recentCommits: RecentCommit[];
}

export interface CreateBranchDetails {
  repoRoot: string;
  previousBranch: string;
  newBranch: string;
  /** Full commit identity the new branch starts at (HEAD after the switch). */
  head: string;
}

export interface ChangeBranchDetails {
  repoRoot: string;
  previousBranch: string | null;
  previousDetached: boolean;
  currentBranch: string;
  hasChangesBeforeSwitch: false;
  /** Full commit identity of HEAD after the switch. */
  head: string;
}

export interface FetchBranchDetails {
  repoRoot: string;
  currentBranch: string;
  upstream: string;
  remote: string;
  remoteRef: string;
  remoteTrackingRef: string;
  refspec: string;
  output: string;
}

export interface FetchRemoteBranchDetails {
  repoRoot: string;
  remote: string;
  branch: string;
  remoteRef: string;
  remoteTrackingRef: string;
  refspec: string;
  output: string;
}

export interface PullBranchDetails {
  repoRoot: string;
  currentBranch: string;
  upstream: string;
  remote: string;
  remoteRef: string;
  output: string;
  /** Full commit identity of HEAD after the fast-forward. */
  head: string;
}

export interface RebaseBranchDetails {
  repoRoot: string;
  currentBranch: string;
  upstream: string;
  remote: string;
  remoteRef: string;
  output: string;
}

export interface PushBranchDetails {
  repoRoot: string;
  currentBranch: string;
  upstream: string | null;
  mode: "push" | "publish";
  remote: string;
  remoteRef: string;
  refspec: string;
  output: string;
  /** Full commit identity of the local HEAD that was pushed. */
  head: string;
  /** Remote-tracking ref updated by the push, for example origin/feature/x. */
  remoteTrackingRef: string;
  /** Full commit identity of that remote-tracking ref after the push: the remote-visible HEAD. */
  remoteHead: string;
}

export type IntegrateBranchStatus = "already_integrated" | "fast_forward" | "merge_commit" | "conflict" | "conflict_kept";

export interface IntegrateBranchHeads {
  sourceHead: string;
  targetHead: string;
}

export interface IntegrateBranchRepositoryVerification {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
  identityPreserved: true;
}

export interface IntegrateBranchControlWorktreeVerification {
  targetBranch: string;
  currentBranchPreserved: true;
  cleanBefore: true;
  cleanAfter: true;
  operationStateAbsentBefore: true;
  operationStateAbsentAfter: true;
}

export interface IntegrateBranchFinalAncestryProof {
  sourceHead: string;
  previousTargetHead: string;
  targetHead: string;
  sourceIsAncestorOfTarget: boolean;
  previousTargetIsAncestorOfTarget: boolean;
}

export interface IntegrateBranchVerification {
  repository: IntegrateBranchRepositoryVerification;
  controlWorktree: IntegrateBranchControlWorktreeVerification;
  heads: {
    before: IntegrateBranchHeads;
    after: IntegrateBranchHeads;
  };
  finalAncestry: IntegrateBranchFinalAncestryProof;
}

export interface IntegrateBranchDetailsBase {
  action: "integrate_branch";
  request: IntegrateBranchToolInput;
  verified: IntegrateBranchVerification;
}

export interface IntegrateBranchAlreadyIntegratedDetails extends IntegrateBranchDetailsBase {
  status: "already_integrated";
  mergeExecuted: false;
}

export interface IntegrateBranchFastForwardDetails extends IntegrateBranchDetailsBase {
  status: "fast_forward";
  mergeExecuted: true;
}

export interface IntegrateBranchMergeCommitDetails extends IntegrateBranchDetailsBase {
  status: "merge_commit";
  mergeExecuted: true;
}

export interface IntegrateBranchConflictPathEntry {
  /** Exact repository-relative identity; human-readable renderers must sanitize a separate display copy. */
  path: string;
}

export interface IntegrateBranchConflictDetails extends IntegrateBranchDetailsBase {
  status: "conflict";
  mergeExecuted: true;
  conflict: {
    paths: IntegrateBranchConflictPathEntry[];
    omitted: number;
    abort: {
      attempted: true;
      succeeded: true;
    };
    restoration: {
      verified: true;
      repositoryIdentityPreserved: true;
      controlWorktreeBranchPreserved: true;
      sourceHeadPreserved: true;
      targetHeadRestored: true;
      operationStateCleared: true;
      cleanControlWorktree: true;
    };
  };
}

/** A conflicted merge deliberately left in progress (integrate_branch or update_from_base keepConflicts); conclude_merge finishes or abandons it. */
export interface IntegrateBranchConflictKeptDetails {
  action: "integrate_branch";
  status: "conflict_kept";
  mergeExecuted: true;
  request: IntegrateBranchToolInput;
  /** Canonical root of the worktree holding the kept merge. */
  worktreeRoot: string;
  /** targetHead is the unchanged HEAD; sourceHead is the commit recorded in MERGE_HEAD. */
  heads: IntegrateBranchHeads;
  conflict: {
    paths: IntegrateBranchConflictPathEntry[];
    omitted: number;
    kept: true;
    mergeInProgress: true;
  };
}

export type IntegrateBranchDetails =
  | IntegrateBranchAlreadyIntegratedDetails
  | IntegrateBranchFastForwardDetails
  | IntegrateBranchMergeCommitDetails
  | IntegrateBranchConflictDetails
  | IntegrateBranchConflictKeptDetails;

export type ConcludeMergeAction = "conclude" | "abort";

export interface ConcludeMergeToolInput {
  action: ConcludeMergeAction;
  /** Absolute root of another worktree of the same repository; omitted means the current one. */
  worktreePath?: string;
}

export interface ConcludeMergeConcludedDetails {
  action: "conclude_merge";
  status: "concluded";
  request: ConcludeMergeToolInput;
  repoRoot: string;
  branch: string;
  heads: {
    before: string;
    after: string;
  };
  parents: {
    first: string;
    second: string;
  };
  mergeHead: string;
  /** Exactly the formerly unmerged paths that were staged for the merge commit. */
  resolvedPaths: IntegrateBranchConflictPathEntry[];
}

export interface ConcludeMergeAbortedDetails {
  action: "conclude_merge";
  status: "aborted";
  request: ConcludeMergeToolInput;
  repoRoot: string;
  branch: string;
  head: string;
  mergeHead: string;
  restoration: {
    verified: true;
    headRestored: true;
    branchPreserved: true;
    operationStateCleared: true;
    cleanWorktree: true;
  };
}

export type ConcludeMergeDetails = ConcludeMergeConcludedDetails | ConcludeMergeAbortedDetails;

export type RetireBranchMode = "merged" | "forced_unmerged";

export interface RetireBranchRepositoryIdentity {
  worktreeRoot: string;
  canonicalCommonGitDirectory: string;
}

export interface RetireBranchRefIdentity {
  branchName: string;
  fullRef: string;
  head: string;
}

export interface RetireBranchAbsentRefProof {
  branchName: string;
  fullRef: string;
  absent: true;
}

export interface RetireBranchWorktreeOccupancyProof {
  branchName: string;
  completeInventoryInspected: true;
  occupied: false;
  matchingWorktreeCount: 0;
}

export interface RetireBranchDetails {
  action: "retire_branch";
  status: "retired";
  mode: RetireBranchMode;
  /** Exact normalized request values used for the verified retirement. */
  request: RetireBranchToolInput;
  verified: {
    repository: {
      before: RetireBranchRepositoryIdentity;
      after: RetireBranchRepositoryIdentity;
      identityPreserved: true;
    };
    refs: {
      before: {
        retiring: RetireBranchRefIdentity;
        target: RetireBranchRefIdentity;
        expectedHead: string;
        expectedHeadMatches: true;
      };
      after: {
        retiring: RetireBranchAbsentRefProof;
        target: RetireBranchRefIdentity;
        targetHeadPreserved: true;
      };
    };
    ancestry: {
      retiringHead: string;
      targetHead: string;
      retiringIsAncestorOfTarget: boolean;
    };
    worktreeOccupancy: {
      before: RetireBranchWorktreeOccupancyProof;
      after: RetireBranchWorktreeOccupancyProof;
    };
    mutation: {
      exactLocalRefDeletionAttempted: true;
      localBranchAbsentAfterDeletion: true;
      directRemoteDeletionAttempted: false;
      remoteTrackingRefDeletionAttempted: false;
    };
  };
}

export interface PullRequestDetails {
  repository: GitHubRepository;
  number: number;
  url: string;
  state: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface PullRequestStatusInput {
  number?: number;
  headBranch?: string;
}

export interface PullRequestStatusDetails extends PullRequestDetails {
  title: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
}

export interface PullRequestFeedbackComment {
  /** GraphQL node id; empty when GitHub did not return one. */
  id: string;
  author: string;
  /** True when the token's own user wrote it (Mission's earlier replies). */
  byViewer: boolean;
  createdAt: string;
  body: string;
  url: string;
}

export interface PullRequestFeedbackThread {
  /** Review thread node id, the target for replies and resolution. */
  id: string;
  path: string;
  line: number | null;
  comments: PullRequestFeedbackComment[];
}

export interface PullRequestFeedbackReview extends PullRequestFeedbackComment {
  state: string;
}

export interface PullRequestFeedbackCheck {
  name: string;
  conclusion: string;
  url: string;
  jobId: number | null;
  annotations: PullRequestFeedbackAnnotation[];
  logTail?: string;
  logError?: string;
}

export interface PullRequestFeedbackAnnotation {
  path: string;
  line: number | null;
  level: string;
  message: string;
}

export interface PullRequestFeedbackDetails {
  repository: GitHubRepository;
  number: number;
  /** Pull request node id. */
  id: string;
  /** Login of the token's user; null when GitHub did not return it. */
  viewer: string | null;
  url: string;
  headSha: string;
  checksState: string | null;
  unresolvedThreads: PullRequestFeedbackThread[];
  resolvedThreadCount: number;
  outdatedThreadCount: number;
  reviews: PullRequestFeedbackReview[];
  comments: PullRequestFeedbackComment[];
  failingChecks: PullRequestFeedbackCheck[];
  omitted: { threads: number; comments: number; checks: number };
}

export interface PullRequestFilesDetails {
  action: "pull_request_files";
  repository: GitHubRepository;
  number: number;
  labels: string[];
  files: { path: string; change: string; additions: number; deletions: number }[];
  omitted: number;
}

export interface PullRequestLabelDetails {
  action: "label_pull_request";
  repository: GitHubRepository;
  number: number;
  added: string[];
  /** Every label on the pull request after the call. */
  labels: string[];
}

export interface PullRequestReplyInput {
  number: number;
  body: string;
  threadId?: string;
  resolve?: boolean;
}

export interface PullRequestReplyDetails {
  action: "reply_pull_request_feedback";
  repository: GitHubRepository;
  number: number;
  threadId: string | null;
  commentUrl: string;
  /** Thread state after the call; null when resolution was not requested or this was a conversation comment. */
  resolved: boolean | null;
}

export interface PullRequestInput {
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
}

export type PullRequestInputField = keyof PullRequestInput;

export type PullRequestToolInput = Partial<PullRequestInput>;

export interface PullRequestToolDetails extends PullRequestDetails {
  outcome?: "created" | "existing";
  autofilledFields?: PullRequestInputField[];
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number];
export type GitChangeScope = "staged" | "unstaged";
export type TruncationStrategy = "head" | "tail";
export type ProjectContextEntryKind = "metadata" | "changed-file-snippet";
export type SkippedContextReason =
  | "sensitive"
  | "generated"
  | "binary"
  | "symlink"
  | "missing"
  | "too-large"
  | "unreadable"
  | "outside-repository";

export interface CommitGitOptions {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface TruncationMetadata {
  truncated: boolean;
  strategy: TruncationStrategy;
  originalBytes: number;
  outputBytes: number;
  originalLines: number;
  outputLines: number;
  label?: string;
}

export interface TruncatedText {
  text: string;
  metadata: TruncationMetadata;
  notice?: string;
}

export interface PromptSectionBudget {
  maxBytes: number;
  maxLines: number;
}

export interface CommitPromptBudget {
  profile: "compact" | "default" | "large";
  maxBytes: number;
  maxLines: number;
  sections: Record<
    | "steeringPrompt"
    | "repositorySummary"
    | "changedFiles"
    | "diffStats"
    | "changedFileSnippets"
    | "diffExcerpts"
    | "omittedContext"
    | "projectMetadata",
    PromptSectionBudget
  >;
}

export interface CommitPromptDiagnostics {
  budgetProfile: CommitPromptBudget["profile"];
  maxBytes: number;
  maxLines: number;
  systemPromptBytes: number;
  userPromptBytes: number;
  textBytes: number;
  truncationCount: number;
}

export interface CommitPromptPayload {
  systemPrompt: string;
  userPrompt: string;
  summaryPrompt: string;
  text: string;
  truncation: TruncationMetadata[];
  diagnostics: CommitPromptDiagnostics;
}

export interface DraftUsageDiagnostics {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface DraftResponseDiagnostics {
  stopReason?: string;
  contentTypeCounts: Record<string, number>;
  contentTypes: string[];
  textCharacterCount: number;
  usableTextCharacterCount: number;
  empty: boolean;
  thinkingOnly: boolean;
  lengthStopped: boolean;
  usage?: DraftUsageDiagnostics;
}

export interface DraftAttemptDiagnostics {
  attempt: number;
  purpose: "draft" | "retry" | "repair";
  maxTokens: number;
  response?: DraftResponseDiagnostics;
  validationError?: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  scope: GitChangeScope;
  sensitive: boolean;
  generated: boolean;
  binary: boolean;
  relatedPaths?: string[];
  secretContent?: boolean;
  unreadable?: boolean;
}

export interface GitDiffSummary {
  scope: GitChangeScope;
  stat: string;
  excerpt: string;
  truncation: TruncationMetadata;
}

export interface ProjectContextEntry {
  path: string;
  kind: ProjectContextEntryKind;
  content: string;
  truncation: TruncationMetadata;
}

export interface SkippedProjectContextEntry {
  path: string;
  reason: SkippedContextReason;
}

export interface ProjectContext {
  root: string;
  metadata: ProjectContextEntry[];
  changedFileSnippets: ProjectContextEntry[];
  skipped: SkippedProjectContextEntry[];
}

export interface GitContext {
  repositoryRoot: string;
  branch: string;
  isDetachedHead: boolean;
  statusPorcelain: string;
  staged: GitDiffSummary;
  unstaged: GitDiffSummary;
  changedFiles: ChangedFile[];
  project: ProjectContext;
  hasChanges: boolean;
  warnings: string[];
}

export interface CommitMessageValidationOk {
  ok: true;
  subject: string;
  body: string;
  message: string;
}

export type CommitMessageValidationResult =
  | CommitMessageValidationOk
  | { ok: false; error: string };

export interface CommitResult {
  commitHash: string;
  subject: string;
  body: string;
  stdout: string;
  stderr: string;
}

export interface UnsafeCommitFileApprovalRequest {
  files: ChangedFile[];
  context: GitContext;
}

export type UnsafeCommitFileApproval = (request: UnsafeCommitFileApprovalRequest) => Promise<boolean>;

export interface CommitChangesDetails {
  action: "gather" | "commit" | "help";
  steeringPrompt?: string;
  repositoryRoot?: string;
  branch?: string;
  statusPorcelain?: string;
  hasChanges?: boolean;
  changedFiles?: ChangedFile[];
  truncation?: TruncationMetadata[];
  prompt?: CommitPromptDiagnostics;
  draft?: DraftAttemptDiagnostics[];
  warnings?: string[];
  committed?: CommitResult;
}
