import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function readProjectFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("package metadata identifies BranchMe", async () => {
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

test("approved docs and specs exist", async () => {
  for (const path of [
    "docs/PROJECT_DEFINITION_BRIEF.md",
    "docs/STRUCTURE.md",
    "specs/spec-architecture.md",
    "specs/spec-guidelines.md",
    "specs/spec-tasks.md",
  ]) {
    await access(new URL(`../${path}`, import.meta.url));
  }
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
  assert.doesNotMatch(constants, /pi-extension-template/);
});

test("public documentation describes implemented behavior", async () => {
  for (const path of ["README.md", "SECURITY.md", "CHANGELOG.md", "docs/STRUCTURE.md"]) {
    const text = await readProjectFile(path);
    assert.doesNotMatch(text, /feature implementation is pending/i, `${path} still says implementation is pending`);
    assert.doesNotMatch(text, /planned \/branchme command and tools/i, `${path} still describes tools as planned`);
  }

  const readme = await readProjectFile("README.md");
  assert.match(readme, /branch_status/);
  assert.match(readme, /create_branch/);
  assert.match(readme, /push_branch/);
  assert.match(readme, /pull_request/);
  assert.match(readme, /GITHUB_TOKEN/);
  assert.match(readme, /GitHub Actions example/);
});
