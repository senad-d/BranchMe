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

export interface BranchStatusDetails {
  repoRoot: string;
  currentBranch: string | null;
  detached: boolean;
  upstream: string | null;
  hasChanges: boolean;
  ahead: number | null;
  behind: number | null;
  warnings?: string[];
  githubRepository?: GitHubRepository;
}

export interface GitContextDetails extends BranchStatusDetails {
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

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
