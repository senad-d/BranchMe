export const EXTENSION_DISPLAY_NAME = "BranchMe";
export const BRANCHME_COMMAND_NAME = "branchme";

export const BRANCH_STATUS_TOOL_NAME = "branch_status";
export const GIT_DIFF_TOOL_NAME = "git_diff";
export const GIT_STATUS_TOOL_NAME = "git_status";
export const GIT_LOG_TOOL_NAME = "git_log";
export const GIT_SHOW_TOOL_NAME = "git_show";
export const GIT_CONFLICTS_TOOL_NAME = "git_conflicts";
export const LIST_REMOTES_TOOL_NAME = "list_remotes";
export const ADD_REMOTE_TOOL_NAME = "add_remote";
export const SET_UPSTREAM_TOOL_NAME = "set_upstream";
export const STAGE_CHANGES_TOOL_NAME = "stage_changes";
export const UNSTAGE_CHANGES_TOOL_NAME = "unstage_changes";
export const RESTORE_PATHS_TOOL_NAME = "restore_paths";
export const REVERT_CHANGES_TOOL_NAME = "revert_changes";
export const LIST_BRANCHES_TOOL_NAME = "list_branches";
export const TRACK_BRANCH_TOOL_NAME = "track_branch";
export const UPDATE_FROM_BASE_TOOL_NAME = "update_from_base";
export const CONCLUDE_MERGE_TOOL_NAME = "conclude_merge";
export const INIT_REPOSITORY_TOOL_NAME = "init_repository";
export const CREATE_BRANCH_TOOL_NAME = "create_branch";
export const CHANGE_BRANCH_TOOL_NAME = "change_branch";
export const FETCH_BRANCH_TOOL_NAME = "fetch_branch";
export const FETCH_REMOTE_TOOL_NAME = "fetch_remote";
export const PULL_BRANCH_TOOL_NAME = "pull_branch";
export const REBASE_BRANCH_TOOL_NAME = "rebase_branch";
export const PUSH_BRANCH_TOOL_NAME = "push_branch";
export const PULL_REQUEST_TOOL_NAME = "pull_request";
export const PULL_REQUEST_STATUS_TOOL_NAME = "pull_request_status";
export const PULL_REQUEST_CHECKS_TOOL_NAME = "pull_request_checks";
export const EDIT_PULL_REQUEST_TOOL_NAME = "edit_pull_request";
export const MERGE_PULL_REQUEST_TOOL_NAME = "merge_pull_request";
export const PULL_REQUEST_FEEDBACK_TOOL_NAME = "pull_request_feedback";
export const REPLY_PULL_REQUEST_FEEDBACK_TOOL_NAME = "reply_pull_request_feedback";
export const PULL_REQUEST_FILES_TOOL_NAME = "pull_request_files";
export const LABEL_PULL_REQUEST_TOOL_NAME = "label_pull_request";
export const LIST_WORKTREES_TOOL_NAME = "list_worktrees";
export const CREATE_WORKTREE_TOOL_NAME = "create_worktree";
export const REMOVE_WORKTREE_TOOL_NAME = "remove_worktree";
export const INTEGRATE_BRANCH_TOOL_NAME = "integrate_branch";
export const RETIRE_BRANCH_TOOL_NAME = "retire_branch";
export const LAND_BRANCH_TOOL_NAME = "land_branch";
export const PULL_REQUEST_AUTOFILL_ENV_NAME = "BRANCHME_PR_AUTOFILL";

export const BRANCHME_TOOL_NAMES = [
  BRANCH_STATUS_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_LOG_TOOL_NAME,
  GIT_SHOW_TOOL_NAME,
  GIT_CONFLICTS_TOOL_NAME,
  LIST_REMOTES_TOOL_NAME,
  ADD_REMOTE_TOOL_NAME,
  SET_UPSTREAM_TOOL_NAME,
  STAGE_CHANGES_TOOL_NAME,
  UNSTAGE_CHANGES_TOOL_NAME,
  RESTORE_PATHS_TOOL_NAME,
  REVERT_CHANGES_TOOL_NAME,
  LIST_BRANCHES_TOOL_NAME,
  TRACK_BRANCH_TOOL_NAME,
  UPDATE_FROM_BASE_TOOL_NAME,
  CONCLUDE_MERGE_TOOL_NAME,
  INIT_REPOSITORY_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  FETCH_BRANCH_TOOL_NAME,
  FETCH_REMOTE_TOOL_NAME,
  PULL_BRANCH_TOOL_NAME,
  REBASE_BRANCH_TOOL_NAME,
  INTEGRATE_BRANCH_TOOL_NAME,
  RETIRE_BRANCH_TOOL_NAME,
  LAND_BRANCH_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PULL_REQUEST_STATUS_TOOL_NAME,
  PULL_REQUEST_CHECKS_TOOL_NAME,
  EDIT_PULL_REQUEST_TOOL_NAME,
  MERGE_PULL_REQUEST_TOOL_NAME,
  PULL_REQUEST_FEEDBACK_TOOL_NAME,
  REPLY_PULL_REQUEST_FEEDBACK_TOOL_NAME,
  PULL_REQUEST_FILES_TOOL_NAME,
  LABEL_PULL_REQUEST_TOOL_NAME,
  LIST_WORKTREES_TOOL_NAME,
  CREATE_WORKTREE_TOOL_NAME,
  REMOVE_WORKTREE_TOOL_NAME,
] as const;

// Emulated git (e.g. Rosetta in a container) under parallel agents needs far more than 5 s for a status read.
export const GIT_STATUS_TIMEOUT_MS = 30_000;
// A mutation that finds another git process's *.lock retries every interval until the wait ends.
export const GIT_LOCK_RETRY_INTERVAL_MS = 250;
export const GIT_LOCK_WAIT_MS = 10_000;
export const GIT_MUTATION_TIMEOUT_MS = 30_000;
export const GIT_FETCH_TIMEOUT_MS = 120_000;
export const GIT_PULL_TIMEOUT_MS = 120_000;
export const GIT_REBASE_TIMEOUT_MS = 120_000;
export const GIT_PUSH_TIMEOUT_MS = 120_000;
export const GIT_WORKTREE_MUTATION_TIMEOUT_MS = 120_000;
export const GIT_INTEGRATION_TIMEOUT_MS = 120_000;
export const GIT_RETIREMENT_MUTATION_TIMEOUT_MS = 30_000;
export const GITHUB_RELATED_PR_TIMEOUT_MS = 4_000;

export const GIT_CONTEXT_RECENT_COMMIT_LIMIT = 5;
export const GIT_CONTEXT_CHANGE_LIMIT = 20;
export const GIT_CONTEXT_VALUE_LIMIT_CHARS = 512;
export const GIT_CONTEXT_SUMMARY_LIMIT_CHARS = 4_000;
export const PULL_REQUEST_AUTOFILL_COMMIT_LIMIT = 20;
export const PULL_REQUEST_AUTOFILL_SUBJECT_LIMIT_CHARS = 256;
export const GIT_DIFF_OUTPUT_LIMIT_BYTES = 32 * 1024;
export const GIT_DIFF_OUTPUT_LIMIT_LINES = 1_000;
export const GIT_DIFF_PATH_LIMIT = 25;
export const GIT_STATUS_PAGE_LIMIT = 50;
export const GIT_STATUS_PAGE_BYTES = 24 * 1024;
export const GIT_STATUS_RAW_LIMIT_BYTES = 4 * 1024 * 1024;
export const GIT_STATUS_FILE_LIMIT_BYTES = 8 * 1024 * 1024;
export const GIT_STATUS_CURSOR_LIMIT_CHARS = 100;
export const GIT_DIFF_CONTEXT_LIMIT = 20;
export const GIT_DIFF_CONTEXT_DEFAULT_LINES = 3;
export const GIT_DIFF_PATH_PREVIEW_LIMIT_CHARS = 128;
export const GIT_BRANCH_RAW_OUTPUT_LIMIT_BYTES = 128 * 1024;
export const GIT_BRANCH_ENTRY_LIMIT = 200;
export const GIT_BRANCH_PATTERN_LIMIT = 25;
export const GIT_BRANCH_SUMMARY_LIMIT_CHARS = 4_000;
export const GIT_WORKTREE_RAW_OUTPUT_LIMIT_BYTES = 128 * 1024;
export const GIT_WORKTREE_ENTRY_LIMIT = 100;
export const GIT_WORKTREE_PATH_LIMIT_CHARS = 4_096;
export const GIT_WORKTREE_REASON_LIMIT_CHARS = 512;
export const GIT_WORKTREE_SUMMARY_LIMIT_CHARS = 4_000;
export const GIT_INTEGRATION_CONFLICT_RAW_OUTPUT_LIMIT_BYTES = 128 * 1024;
export const GIT_INTEGRATION_CONFLICT_ENTRY_LIMIT = 100;
export const GIT_INTEGRATION_CONFLICT_PATH_LIMIT_CHARS = 4_096;
export const GIT_INTEGRATION_SUMMARY_LIMIT_CHARS = 4_000;
export const GIT_RETIREMENT_SUMMARY_LIMIT_CHARS = 4_000;

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "BranchMe Pi extension";

export const MAX_SUMMARY_OUTPUT_CHARS = 4_000;
export const GITHUB_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
export const PULL_REQUEST_FEEDBACK_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const PULL_REQUEST_FEEDBACK_LOG_TAIL_BYTES = 128 * 1024;
export const PULL_REQUEST_FEEDBACK_LOG_TAIL_LINES = 60;
export const PULL_REQUEST_FEEDBACK_LOG_JOB_LIMIT = 3;
export const PULL_REQUEST_FEEDBACK_BODY_LIMIT_CHARS = 2_000;
export const PULL_REQUEST_FEEDBACK_LOG_LIMIT_CHARS = 6_000;
export const PULL_REQUEST_FEEDBACK_SUMMARY_LIMIT_CHARS = 24_000;
export const PULL_REQUEST_REPLY_BODY_LIMIT_CHARS = 4_000;
export const PULL_REQUEST_LABEL_LIMIT = 5;
export const GITHUB_GRAPHQL_TIMEOUT_MS = 15_000;
export const GITHUB_JOB_LOG_TIMEOUT_MS = 30_000;
