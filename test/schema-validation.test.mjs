import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import {
  BRANCH_STATUS_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  CREATE_WORKTREE_TOOL_NAME,
  FETCH_BRANCH_TOOL_NAME,
  INTEGRATE_BRANCH_TOOL_NAME,
  LAND_BRANCH_TOOL_NAME,
  LIST_WORKTREES_TOOL_NAME,
  PULL_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
  REBASE_BRANCH_TOOL_NAME,
  REMOVE_WORKTREE_TOOL_NAME,
  RETIRE_BRANCH_TOOL_NAME,
} from "../src/constants.ts";
import { registerBranchMeTools } from "../src/tools/branchme-tools.ts";

const validators = new WeakMap();

function makePi() {
  const tools = [];
  return {
    tools,
    registerTool(tool) {
      tools.push(tool);
    },
    async exec() {
      throw new Error("schema validation tests must not execute git");
    },
  };
}

function registeredTools() {
  const pi = makePi();
  registerBranchMeTools(pi);
  return new Map(pi.tools.map((tool) => [tool.name, tool]));
}

function validatorFor(schema) {
  const existing = validators.get(schema);
  if (existing) return existing;

  const validator = Compile(schema);
  validators.set(schema, validator);
  return validator;
}

function validateLikePiRuntime(tool, args) {
  // Mirrors Pi's TypeBox validation path for TypeBox schemas: clone arguments,
  // apply Value.Convert in place, then check with a compiled TypeBox validator.
  const cloned = structuredClone(args);
  Value.Convert(tool.parameters, cloned);
  const validator = validatorFor(tool.parameters);
  if (validator.Check(cloned)) return cloned;

  const errors = [...validator.Errors(cloned)].map((error) => `${error.instancePath || "/"}: ${error.message}`).join("\n");
  throw new Error(errors || "schema validation failed");
}

function assertValid(tool, args) {
  assert.doesNotThrow(() => validateLikePiRuntime(tool, args));
}

function assertInvalid(tool, args) {
  assert.throws(() => validateLikePiRuntime(tool, args));
}

test("BranchMe tool schemas accept valid runtime inputs without executing tools", () => {
  const tools = registeredTools();

  assertValid(tools.get(BRANCH_STATUS_TOOL_NAME), {});
  assertValid(tools.get(BRANCH_STATUS_TOOL_NAME), {
    ancestry: { sourceBranch: "feature/runtime-schema", targetBranch: "main" },
  });
  assertValid(tools.get(CREATE_BRANCH_TOOL_NAME), { branchName: "feature/runtime-schema" });
  assertValid(tools.get(CHANGE_BRANCH_TOOL_NAME), { branchName: "feature/runtime-schema" });
  assertValid(tools.get(FETCH_BRANCH_TOOL_NAME), {});
  assertValid(tools.get(FETCH_BRANCH_TOOL_NAME), { branch: "main" });
  assertValid(tools.get(FETCH_BRANCH_TOOL_NAME), { remote: "origin", branch: "main" });
  assertValid(tools.get(INTEGRATE_BRANCH_TOOL_NAME), {
    sourceBranch: "feature/runtime-schema",
    targetBranch: "main",
  });
  assertValid(tools.get(PULL_BRANCH_TOOL_NAME), {});
  assertValid(tools.get(REBASE_BRANCH_TOOL_NAME), {});
  assertValid(tools.get(RETIRE_BRANCH_TOOL_NAME), {
    branchName: "feature/runtime-schema",
    expectedHead: "a".repeat(40),
    targetBranch: "main",
    force: false,
  });
  assertValid(tools.get(RETIRE_BRANCH_TOOL_NAME), {
    branchName: "feature/runtime-schema-sha256",
    expectedHead: "B".repeat(64),
    targetBranch: "main",
    force: true,
  });
  assertValid(tools.get(PUSH_BRANCH_TOOL_NAME), {});
  assertValid(tools.get(LIST_WORKTREES_TOOL_NAME), {});
  assertValid(tools.get(CREATE_WORKTREE_TOOL_NAME), {
    worktreePath: "/tmp/branchme-runtime-schema",
    branchName: "feature/runtime-schema",
    branchMode: "new",
  });
  assertValid(tools.get(CREATE_WORKTREE_TOOL_NAME), {
    worktreePath: "/tmp/branchme-runtime-schema-existing",
    branchName: "feature/runtime-schema-existing",
    branchMode: "existing",
  });
  assertValid(tools.get(CREATE_WORKTREE_TOOL_NAME), {
    worktreePath: "/tmp/branchme-runtime-schema-base-ref",
    branchName: "feature/runtime-schema-base-ref",
    branchMode: "new",
    baseRef: "origin/main",
  });
  assertValid(tools.get(REMOVE_WORKTREE_TOOL_NAME), { worktreePath: "/tmp/branchme-runtime-schema" });
  assertValid(tools.get(PULL_REQUEST_TOOL_NAME), {
    headBranch: "feature/runtime-schema",
    baseBranch: "main",
    title: "Add runtime schema coverage",
    body: "",
    draft: false,
  });
});

test("runtime schema validation enforces exact land_branch inputs", () => {
  const tool = registeredTools().get(LAND_BRANCH_TOOL_NAME);
  const required = { sourceBranch: "feature/merged", targetBranch: "main" };
  assertValid(tool, required);
  assertValid(tool, { ...required, remote: "origin", worktreePath: "/tmp/linked" });
  for (const args of [{}, { sourceBranch: "feature/merged" }, { targetBranch: "main" },
    { ...required, sourceBranch: "" }, { ...required, targetBranch: "" },
    { ...required, remote: "" }, { ...required, worktreePath: "" }]) {
    assertInvalid(tool, args);
  }
  for (const key of ["force", "stash", "reset", "checkout", "prune", "expectedHead", "repo", "cwd"]) {
    assertInvalid(tool, { ...required, [key]: "forbidden" });
  }
});

test("runtime schema validation enforces strict optional branch_status ancestry", () => {
  const tool = registeredTools().get(BRANCH_STATUS_TOOL_NAME);
  const valid = { ancestry: { sourceBranch: "feature/runtime-schema", targetBranch: "main" } };

  assertValid(tool, {});
  assertValid(tool, valid);
  assertInvalid(tool, null);
  assertInvalid(tool, { branchName: "main" });
  assertInvalid(tool, { ...valid, extra: true });
  assertInvalid(tool, { ancestry: null });
  assertInvalid(tool, { ancestry: {} });
  assertInvalid(tool, { ancestry: { sourceBranch: "feature/runtime-schema" } });
  assertInvalid(tool, { ancestry: { targetBranch: "main" } });
  assertInvalid(tool, { ancestry: { ...valid.ancestry, extra: true } });
  assertInvalid(tool, { ancestry: { ...valid.ancestry, sourceBranch: "" } });
  assertInvalid(tool, { ancestry: { ...valid.ancestry, targetBranch: "" } });
});

test("runtime schema validation enforces exact integrate_branch inputs", () => {
  const tool = registeredTools().get(INTEGRATE_BRANCH_TOOL_NAME);
  const valid = { sourceBranch: "feature/runtime-schema", targetBranch: "main" };

  assertValid(tool, valid);
  assertInvalid(tool, null);
  assertInvalid(tool, {});
  assertInvalid(tool, { sourceBranch: "feature/runtime-schema" });
  assertInvalid(tool, { targetBranch: "main" });
  assertInvalid(tool, { ...valid, sourceBranch: "" });
  assertInvalid(tool, { ...valid, targetBranch: "" });
  assertInvalid(tool, { ...valid, sourceBranch: [] });
  assertInvalid(tool, { ...valid, targetBranch: {} });
  for (const forbidden of [
    "path",
    "repo",
    "remote",
    "refspec",
    "force",
    "switch",
    "strategy",
    "message",
    "squash",
    "commit",
    "continue",
    "abort",
    "delete",
    "push",
    "fetch",
    "worktreePath",
  ]) {
    assertInvalid(tool, { ...valid, [forbidden]: "forbidden" });
  }
});

test("runtime schema validation enforces exact retire_branch inputs", () => {
  const tool = registeredTools().get(RETIRE_BRANCH_TOOL_NAME);
  const valid = {
    branchName: "feature/runtime-schema",
    expectedHead: "a".repeat(40),
    targetBranch: "main",
    force: false,
  };

  assertValid(tool, valid);
  assertValid(tool, { ...valid, expectedHead: "B".repeat(64), force: true });
  assertInvalid(tool, null);
  assertInvalid(tool, {});
  for (const required of ["branchName", "expectedHead", "targetBranch", "force"]) {
    const missing = { ...valid };
    delete missing[required];
    assertInvalid(tool, missing);
  }
  assertInvalid(tool, { ...valid, branchName: "" });
  assertInvalid(tool, { ...valid, targetBranch: "" });
  assertInvalid(tool, { ...valid, expectedHead: "a".repeat(39) });
  assertInvalid(tool, { ...valid, expectedHead: "a".repeat(41) });
  assertInvalid(tool, { ...valid, expectedHead: "a".repeat(63) });
  assertInvalid(tool, { ...valid, expectedHead: "a".repeat(65) });
  assertInvalid(tool, { ...valid, expectedHead: `${"a".repeat(39)}g` });
  assertInvalid(tool, { ...valid, force: {} });
  for (const forbidden of [
    "path",
    "repo",
    "remote",
    "refspec",
    "pattern",
    "branches",
    "all",
    "prune",
    "deleteRemote",
    "push",
    "fetch",
    "worktreePath",
    "sourceBranch",
    "baseBranch",
  ]) {
    assertInvalid(tool, { ...valid, [forbidden]: "forbidden" });
  }
});

test("runtime schema validation rejects extra arguments for no-parameter tools", () => {
  const tools = registeredTools();

  assertInvalid(tools.get(LIST_WORKTREES_TOOL_NAME), { worktreePath: "/tmp/forbidden" });
  assertInvalid(tools.get(LIST_WORKTREES_TOOL_NAME), null);
  for (const forbidden of ["branchName", "force", "remote", "owner", "repo", "path", "rebase"]) {
    assertInvalid(tools.get(PULL_BRANCH_TOOL_NAME), { [forbidden]: "forbidden" });
    assertInvalid(tools.get(REBASE_BRANCH_TOOL_NAME), { [forbidden]: "forbidden" });
    assertInvalid(tools.get(PUSH_BRANCH_TOOL_NAME), { [forbidden]: "forbidden" });
  }
});

test("runtime schema validation enforces strict optional fetch_branch inputs", () => {
  const tool = registeredTools().get(FETCH_BRANCH_TOOL_NAME);

  assertValid(tool, {});
  assertValid(tool, { branch: "main" });
  assertValid(tool, { remote: "origin", branch: "main" });
  assertInvalid(tool, null);
  assertInvalid(tool, { remote: "", branch: "main" });
  assertInvalid(tool, { branch: "" });
  assertInvalid(tool, { remote: {}, branch: "main" });
  assertInvalid(tool, { branch: [] });
  for (const forbidden of ["branchName", "force", "owner", "repo", "path", "rebase", "refspec", "prune", "tags"]) {
    assertInvalid(tool, { branch: "main", [forbidden]: "forbidden" });
  }
});

test("runtime schema validation rejects invalid create_branch arguments and forbidden fields", () => {
  const tool = registeredTools().get(CREATE_BRANCH_TOOL_NAME);
  const valid = { branchName: "feature/runtime-schema" };

  assertInvalid(tool, {});
  assertInvalid(tool, { branchName: "" });
  assertInvalid(tool, { branchName: {} });
  for (const forbidden of ["baseRef", "force", "owner", "repo", "path"]) {
    assertInvalid(tool, { ...valid, [forbidden]: "forbidden" });
  }
});

test("runtime schema validation rejects invalid change_branch arguments and forbidden fields", () => {
  const tool = registeredTools().get(CHANGE_BRANCH_TOOL_NAME);
  const valid = { branchName: "feature/runtime-schema" };

  assertInvalid(tool, {});
  assertInvalid(tool, { branchName: "" });
  assertInvalid(tool, { branchName: [] });
  for (const forbidden of ["baseRef", "force", "stash", "discard", "create", "owner", "repo", "path"]) {
    assertInvalid(tool, { ...valid, [forbidden]: "forbidden" });
  }
});

test("runtime schema validation enforces strict create_worktree and remove_worktree inputs", () => {
  const tools = registeredTools();
  const createTool = tools.get(CREATE_WORKTREE_TOOL_NAME);
  const removeTool = tools.get(REMOVE_WORKTREE_TOOL_NAME);
  const validCreate = {
    worktreePath: "/tmp/branchme-runtime-schema",
    branchName: "feature/runtime-schema",
    branchMode: "new",
  };
  const validRemove = { worktreePath: "/tmp/branchme-runtime-schema" };

  assertInvalid(createTool, {});
  assertInvalid(createTool, { ...validCreate, worktreePath: "" });
  assertInvalid(createTool, { ...validCreate, branchName: "" });
  assertInvalid(createTool, { ...validCreate, branchMode: "detached" });
  assertInvalid(createTool, { ...validCreate, branchMode: true });
  assertInvalid(removeTool, {});
  assertInvalid(removeTool, { worktreePath: "" });
  assertInvalid(removeTool, { worktreePath: [] });

  assertValid(createTool, { ...validCreate, baseRef: "origin/main" });
  assertValid(createTool, { ...validCreate, baseRef: "a".repeat(40) });
  assertInvalid(createTool, { ...validCreate, baseRef: "" });
  assertInvalid(createTool, { ...validCreate, baseRef: [] });
  assertInvalid(removeTool, { ...validRemove, baseRef: "origin/main" });

  const forbiddenFields = [
    "force",
    "remote",
    "detach",
    "orphan",
    "move",
    "prune",
    "repair",
    "lock",
    "unlock",
  ];
  for (const forbidden of forbiddenFields) {
    assertInvalid(createTool, { ...validCreate, [forbidden]: "forbidden" });
    assertInvalid(removeTool, { ...validRemove, [forbidden]: "forbidden" });
  }
});

test("runtime schema validation accepts omitted pull_request fields and rejects invalid or forbidden fields", () => {
  const tool = registeredTools().get(PULL_REQUEST_TOOL_NAME);
  const valid = {
    headBranch: "feature/runtime-schema",
    baseBranch: "main",
    title: "Add runtime schema coverage",
    body: "Body",
    draft: false,
  };

  assertValid(tool, {});
  assertValid(tool, { title: "Generated branches and body", draft: true });
  assertInvalid(tool, { ...valid, headBranch: "" });
  assertInvalid(tool, { ...valid, baseBranch: "" });
  assertInvalid(tool, { ...valid, title: "" });
  assertInvalid(tool, { ...valid, body: {} });
  assertInvalid(tool, { ...valid, draft: "not-a-boolean" });

  for (const forbidden of ["owner", "repo", "head", "base", "path", "force"]) {
    assertInvalid(tool, { ...valid, [forbidden]: "forbidden" });
  }
});
