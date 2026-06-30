export const EXTENSION_DISPLAY_NAME = "BranchMe";
export const BRANCHME_COMMAND_NAME = "branchme";

export const BRANCH_STATUS_TOOL_NAME = "branch_status";
export const CREATE_BRANCH_TOOL_NAME = "create_branch";
export const CHANGE_BRANCH_TOOL_NAME = "change_branch";
export const PUSH_BRANCH_TOOL_NAME = "push_branch";
export const PULL_REQUEST_TOOL_NAME = "pull_request";

export const BRANCHME_TOOL_NAMES = [
  BRANCH_STATUS_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
] as const;

export const GIT_STATUS_TIMEOUT_MS = 5_000;
export const GIT_MUTATION_TIMEOUT_MS = 30_000;
export const GIT_PUSH_TIMEOUT_MS = 120_000;

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "BranchMe Pi extension";

export const MAX_SUMMARY_OUTPUT_CHARS = 4_000;
