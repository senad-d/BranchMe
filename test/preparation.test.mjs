import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  BRANCHME_TOOL_NAMES,
  GIT_INTEGRATION_CONFLICT_ENTRY_LIMIT,
  GIT_INTEGRATION_CONFLICT_PATH_LIMIT_CHARS,
  GIT_INTEGRATION_CONFLICT_RAW_OUTPUT_LIMIT_BYTES,
  GIT_INTEGRATION_SUMMARY_LIMIT_CHARS,
  GIT_INTEGRATION_TIMEOUT_MS,
  GIT_RETIREMENT_MUTATION_TIMEOUT_MS,
  GIT_RETIREMENT_SUMMARY_LIMIT_CHARS,
  INTEGRATE_BRANCH_TOOL_NAME,
  RETIRE_BRANCH_TOOL_NAME,
} from "../src/constants.ts";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function readProjectFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("package metadata identifies BranchMe", async () => {
  assert.equal(packageJson.name, "@senad-d/branchme");
  assert.match(packageJson.description, /branch/i);
  assert.match(packageJson.description, /integration/i);
  assert.match(packageJson.description, /retirement/i);
  assert.equal(packageJson.repository.url, "git+https://github.com/senad-d/branchme.git");
  assert.equal(packageJson.bugs.url, "https://github.com/senad-d/branchme/issues");
  assert.equal(packageJson.homepage, "https://github.com/senad-d/branchme#readme");
  assert.deepEqual(packageJson.pi?.extensions, ["./src/extension.ts"]);
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.ok(packageJson.keywords.includes("branchme"));
  assert.ok(packageJson.files.includes(".env.example"));
  await access(new URL("../src/extension.ts", import.meta.url));
});

test("environment token template is safe and packaged", async () => {
  const envExample = await readProjectFile(".env.example");

  assert.match(envExample, /^GITHUB_TOKEN=$/m);
  assert.match(envExample, /^GH_TOKEN=$/m);
  assert.match(envExample, /^BRANCHME_PR_AUTOFILL=false$/m);
  assert.doesNotMatch(envExample, /^(?:GITHUB_TOKEN|GH_TOKEN)=.+$/m);
  assert.doesNotMatch(envExample, /ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Authorization:\s*Bearer/iu);
  assert.ok(packageJson.files.includes(".env.example"));
});

test("approved docs and specs exist", async () => {
  for (const path of [
    "docs/PROJECT_DEFINITION_BRIEF.md",
    "docs/STRUCTURE.md",
    "specs/spec-architecture.md",
    "specs/spec-guidelines.md",
    "specs/spec-tasks.md",
  ]) {
    const contents = await readProjectFile(path);
    assert.ok(contents.length > 0, `${path} should not be empty`);
  }
});

test("packaged project brief describes current worktree behavior", async () => {
  const projectBrief = await readProjectFile("docs/PROJECT_DEFINITION_BRIEF.md");

  assert.ok(packageJson.files.includes("docs/**/*.md"));
  assert.match(projectBrief, /thirteen strict agent-callable tools/i);
  for (const toolName of ["list_worktrees", "create_worktree", "remove_worktree", "retire_branch"]) {
    assert.match(projectBrief, new RegExp(`\\b${toolName}\\b`, "u"));
  }
  assert.match(projectBrief, /create a checkout directory outside the active checkout/i);
  assert.match(projectBrief, /ignored entries all block removal/i);
  assert.match(projectBrief, /exact canonical absolute cwd/i);
  assert.match(projectBrief, /expected-`HEAD` lease/i);
  assert.match(projectBrief, /branch\.<branchName>\.\*/u);
  assert.doesNotMatch(projectBrief, /files written:\s*none/i);
  assert.doesNotMatch(projectBrief, /minimal pi tools for changing\/creating current-repo branches/i);
});

test("active changelog heading matches the unreleased package version", async () => {
  const changelog = await readProjectFile("CHANGELOG.md");
  const activeHeading = changelog.match(/^##\s+(.+)$/mu)?.[1];

  assert.equal(activeHeading, `${packageJson.version} - Unreleased`);
});

test("source tree registers BranchMe behavior and no template leftovers", async () => {
  const extension = await readProjectFile("src/extension.ts");
  assert.match(extension, /branchMeExtension/);
  assert.match(extension, /registerBranchMeCommand/);
  assert.match(extension, /registerBranchMeTools/);
  assert.doesNotMatch(extension, /template-hello|template_greet|registerExample/);

  const constants = await readProjectFile("src/constants.ts");
  assert.match(constants, /BranchMe/);
  assert.match(constants, /branch_status/);
  assert.match(constants, /list_worktrees/);
  assert.match(constants, /create_worktree/);
  assert.match(constants, /remove_worktree/);
  assert.doesNotMatch(constants, /pi-extension-template/);
});

test("branch integration contracts and runtime registration stay atomic", async () => {
  const constants = await readProjectFile("src/constants.ts");
  const types = await readProjectFile("src/types.ts");
  const tools = await readProjectFile("src/tools/branchme-tools.ts");

  assert.equal(INTEGRATE_BRANCH_TOOL_NAME, "integrate_branch");
  assert.equal(BRANCHME_TOOL_NAMES.includes(INTEGRATE_BRANCH_TOOL_NAME), true);
  assert.equal(BRANCHME_TOOL_NAMES.filter((name) => name === INTEGRATE_BRANCH_TOOL_NAME).length, 1);
  assert.equal(constants.match(/export const INTEGRATE_BRANCH_TOOL_NAME\b/gu)?.length, 1);
  assert.match(tools, /\bINTEGRATE_BRANCH_TOOL_NAME\b/u);
  assert.doesNotMatch(tools, /\bcontinue_merge\b|\babort_merge\b/u);

  for (const limit of [
    GIT_INTEGRATION_TIMEOUT_MS,
    GIT_INTEGRATION_CONFLICT_RAW_OUTPUT_LIMIT_BYTES,
    GIT_INTEGRATION_CONFLICT_ENTRY_LIMIT,
    GIT_INTEGRATION_CONFLICT_PATH_LIMIT_CHARS,
    GIT_INTEGRATION_SUMMARY_LIMIT_CHARS,
  ]) {
    assert.ok(Number.isSafeInteger(limit));
    assert.ok(limit > 0);
  }

  assert.match(types, /interface BranchStatusAncestryQuery[\s\S]*sourceBranch: string;[\s\S]*targetBranch: string;/u);
  assert.match(types, /interface BranchAncestryDetails[\s\S]*sourceHead: string;[\s\S]*targetHead: string;[\s\S]*isAncestor: boolean;/u);
  assert.match(types, /interface IntegrateBranchToolInput[\s\S]*sourceBranch: string;[\s\S]*targetBranch: string;/u);
  assert.match(types, /status: "already_integrated";/u);
  assert.match(types, /status: "fast_forward";/u);
  assert.match(types, /status: "merge_commit";/u);
  assert.match(types, /status: "conflict";/u);
  assert.match(types, /before: IntegrateBranchHeads;[\s\S]*after: IntegrateBranchHeads;/u);
  assert.match(types, /paths: IntegrateBranchConflictPathEntry\[\];[\s\S]*omitted: number;/u);
  assert.match(types, /abort:[\s\S]*succeeded: true;[\s\S]*restoration:[\s\S]*verified: true;/u);
});

test("branch retirement contracts are bounded and registered atomically", async () => {
  const constants = await readProjectFile("src/constants.ts");
  const types = await readProjectFile("src/types.ts");
  const tools = await readProjectFile("src/tools/branchme-tools.ts");

  assert.equal(RETIRE_BRANCH_TOOL_NAME, "retire_branch");
  assert.equal(BRANCHME_TOOL_NAMES.length, 13);
  assert.equal(BRANCHME_TOOL_NAMES.includes(RETIRE_BRANCH_TOOL_NAME), true);
  assert.equal(constants.match(/export const RETIRE_BRANCH_TOOL_NAME\b/gu)?.length, 1);
  assert.match(tools, /name: RETIRE_BRANCH_TOOL_NAME,/u);
  assert.match(tools, /await retireBranch\(pi, ctx, params, signal\)/u);

  for (const limit of [GIT_RETIREMENT_MUTATION_TIMEOUT_MS, GIT_RETIREMENT_SUMMARY_LIMIT_CHARS]) {
    assert.ok(Number.isSafeInteger(limit));
    assert.ok(limit > 0);
  }

  const input = types.match(/export interface RetireBranchToolInput \{(?<body>[^}]+)\}/u)?.groups?.body;
  assert.ok(input);
  assert.deepEqual(
    [...input.matchAll(/^\s*(\w+):\s*([^;]+);$/gmu)].map((match) => [match[1], match[2]]),
    [
      ["branchName", "string"],
      ["expectedHead", "string"],
      ["targetBranch", "string"],
      ["force", "boolean"],
    ],
  );

  const details = types.slice(
    types.indexOf("export type RetireBranchMode"),
    types.indexOf("export interface PullRequestDetails"),
  );
  assert.match(details, /"merged" \| "forced_unmerged"/u);
  assert.match(details, /action: "retire_branch";[\s\S]*status: "retired";/u);
  assert.match(details, /request: RetireBranchToolInput;/u);
  assert.match(details, /repository:[\s\S]*before:[\s\S]*after:[\s\S]*identityPreserved: true;/u);
  assert.match(details, /refs:[\s\S]*expectedHeadMatches: true;[\s\S]*retiring: RetireBranchAbsentRefProof;/u);
  assert.match(details, /interface RetireBranchAbsentRefProof[\s\S]*absent: true;/u);
  assert.match(details, /ancestry:[\s\S]*retiringIsAncestorOfTarget: boolean;/u);
  assert.match(details, /worktreeOccupancy:[\s\S]*before:[\s\S]*after:/u);
  assert.match(details, /localBranchAbsentAfterDeletion: true;/u);
  assert.match(details, /directRemoteDeletionAttempted: false;/u);
  assert.doesNotMatch(details, /AbortSignal|GitExecResult|WorktreeEntry\[\]|rawOutput|stdout|stderr/u);
});

test("public documentation describes implemented behavior", async () => {
  for (const path of ["README.md", "SECURITY.md", "CHANGELOG.md", "docs/STRUCTURE.md"]) {
    const text = await readProjectFile(path);
    assert.doesNotMatch(text, /feature implementation is pending/i, `${path} still says implementation is pending`);
    assert.doesNotMatch(text, /planned \/branchme command and tools/i, `${path} still describes tools as planned`);
    assert.match(text, /integrate_branch/u, `${path} should document integrate_branch`);
    assert.doesNotMatch(
      text,
      /BranchMe (?:never|does not|doesn't)[^.\n]*create merge commits/iu,
      `${path} still claims BranchMe cannot create merge commits`,
    );
  }

  const activeDocs = await Promise.all(
    [
      "README.md",
      "SECURITY.md",
      "CHANGELOG.md",
      "docs/STRUCTURE.md",
      "docs/PROJECT_DEFINITION_BRIEF.md",
      "docs/SMOKE_TEST.md",
    ].map(readProjectFile),
  );
  const activeDocumentation = activeDocs.join("\n");
  assert.doesNotMatch(
    activeDocumentation,
    /BranchMe (?:never|does not|doesn't)[^.\n]*delete (?:local )?branches/iu,
    "active documentation still makes a blanket no-local-branch-deletion claim",
  );
  assert.match(activeDocumentation, /thirteen (?:agent-callable )?tools/iu);
  assert.match(activeDocumentation, /git update-ref --no-deref -d/iu);
  assert.match(activeDocumentation, /branch\.<(?:branchName|name)>\.\*/u);
  assert.match(activeDocumentation, /remote-tracking refs? (?:are|remain) untouched/iu);

  const readme = activeDocs[0];
  assert.match(readme, /branch_status/);
  assert.match(readme, /change_branch/);
  assert.match(readme, /create_branch/);
  assert.match(readme, /fetch_branch/);
  assert.match(readme, /pull_branch/);
  assert.match(readme, /rebase_branch/);
  assert.match(readme, /integrate_branch/);
  assert.match(readme, /retire_branch/);
  assert.match(readme, /branch_status\.ancestry/);
  assert.match(readme, /already_integrated/);
  assert.match(readme, /fast_forward/);
  assert.match(readme, /merge_commit/);
  assert.match(readme, /continue_merge/);
  assert.match(readme, /rerere\.enabled=false/);
  assert.match(readme, /push_branch/);
  assert.match(readme, /pull_request/);
  assert.match(readme, /GITHUB_TOKEN/);
  assert.match(readme, /GitHub Actions example/);

  const security = activeDocs[1];
  assert.match(security, /expected-old-value/iu);
  assert.match(security, /complete bounded[^.\n]*worktree inventory/iu);
  assert.match(security, /(?:force[^.\n]*unmerged|unmerged[^.\n]*force)/iu);
  assert.match(security, /process-local queue/iu);
  assert.match(security, /retirement may have completed/iu);
  assert.match(security, /reference-transaction/u);
});
