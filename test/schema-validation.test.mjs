import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import {
  BRANCH_STATUS_TOOL_NAME,
  CHANGE_BRANCH_TOOL_NAME,
  CREATE_BRANCH_TOOL_NAME,
  PULL_REQUEST_TOOL_NAME,
  PUSH_BRANCH_TOOL_NAME,
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

function withoutField(value, field) {
  const clone = { ...value };
  delete clone[field];
  return clone;
}

test("BranchMe tool schemas accept valid runtime inputs without executing tools", () => {
  const tools = registeredTools();

  assertValid(tools.get(BRANCH_STATUS_TOOL_NAME), {});
  assertValid(tools.get(CREATE_BRANCH_TOOL_NAME), { branchName: "feature/runtime-schema" });
  assertValid(tools.get(CHANGE_BRANCH_TOOL_NAME), { branchName: "feature/runtime-schema" });
  assertValid(tools.get(PUSH_BRANCH_TOOL_NAME), {});
  assertValid(tools.get(PULL_REQUEST_TOOL_NAME), {
    headBranch: "feature/runtime-schema",
    baseBranch: "main",
    title: "Add runtime schema coverage",
    body: "",
    draft: false,
  });
});

test("runtime schema validation rejects extra arguments for no-parameter tools", () => {
  const tools = registeredTools();

  assertInvalid(tools.get(BRANCH_STATUS_TOOL_NAME), { branchName: "main" });
  assertInvalid(tools.get(BRANCH_STATUS_TOOL_NAME), null);
  for (const forbidden of ["branchName", "force", "remote", "owner", "repo", "path"]) {
    assertInvalid(tools.get(PUSH_BRANCH_TOOL_NAME), { [forbidden]: "forbidden" });
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

test("runtime schema validation rejects invalid pull_request arguments and forbidden repository fields", () => {
  const tool = registeredTools().get(PULL_REQUEST_TOOL_NAME);
  const valid = {
    headBranch: "feature/runtime-schema",
    baseBranch: "main",
    title: "Add runtime schema coverage",
    body: "Body",
    draft: false,
  };

  for (const required of ["headBranch", "baseBranch", "title", "body", "draft"]) {
    assertInvalid(tool, withoutField(valid, required));
  }

  assertInvalid(tool, { ...valid, headBranch: "" });
  assertInvalid(tool, { ...valid, baseBranch: "" });
  assertInvalid(tool, { ...valid, title: "" });
  assertInvalid(tool, { ...valid, body: {} });
  assertInvalid(tool, { ...valid, draft: "not-a-boolean" });

  for (const forbidden of ["owner", "repo", "head", "base", "path", "force"]) {
    assertInvalid(tool, { ...valid, [forbidden]: "forbidden" });
  }
});
