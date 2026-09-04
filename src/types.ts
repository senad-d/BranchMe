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

export interface IntegrateBranchToolInput {
  sourceBranch: string;
  targetBranch: string;
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
}

export interface ChangeBranchDetails {
  repoRoot: string;
  previousBranch: string | null;
  previousDetached: boolean;
  currentBranch: string;
  hasChangesBeforeSwitch: false;
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
}

export type IntegrateBranchStatus = "already_integrated" | "fast_forward" | "merge_commit" | "conflict";

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

export type IntegrateBranchDetails =
  | IntegrateBranchAlreadyIntegratedDetails
  | IntegrateBranchFastForwardDetails
  | IntegrateBranchMergeCommitDetails
  | IntegrateBranchConflictDetails;

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
  autofilledFields?: PullRequestInputField[];
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
