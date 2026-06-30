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

export interface BranchStatusDetails {
  repoRoot: string;
  currentBranch: string | null;
  detached: boolean;
  upstream: string | null;
  hasChanges: boolean;
  ahead: number | null;
  behind: number | null;
  githubRepository?: GitHubRepository;
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
