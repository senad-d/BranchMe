import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function readProjectFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("package metadata is prepared for BranchMe", async () => {
  assert.equal(packageJson.name, "@senad-d/branchme");
  assert.match(packageJson.description, /branch/i);
  assert.equal(packageJson.repository.url, "git+https://github.com/senad-d/branchme.git");
  assert.equal(packageJson.bugs.url, "https://github.com/senad-d/branchme/issues");
  assert.equal(packageJson.homepage, "https://github.com/senad-d/branchme#readme");
  assert.deepEqual(packageJson.pi?.extensions, ["./src/extension.ts"]);
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.ok(packageJson.keywords.includes("branchme"));
  await access(new URL("../src/extension.ts", import.meta.url));
});

test("approved preparation docs and specs exist", async () => {
  for (const path of [
    "docs/PROJECT_DEFINITION_BRIEF.md",
    "specs/spec-architecture.md",
    "specs/spec-guidelines.md",
    "specs/spec-tasks.md",
  ]) {
    await access(new URL(`../${path}`, import.meta.url));
  }
});

test("task spec remains unchecked during preparation", async () => {
  const taskSpec = await readProjectFile("specs/spec-tasks.md");
  assert.match(taskSpec, /- \[ \] Register `pull_request`/);
  assert.doesNotMatch(taskSpec, /- \[[xX]\]/);
});

test("source tree contains no registered template behavior", async () => {
  const extension = await readProjectFile("src/extension.ts");
  assert.match(extension, /branchMeExtension/);
  assert.doesNotMatch(extension, /template-hello|template_greet|registerExample/);

  const constants = await readProjectFile("src/constants.ts");
  assert.match(constants, /BranchMe/);
  assert.doesNotMatch(constants, /pi-extension-template/);
});
