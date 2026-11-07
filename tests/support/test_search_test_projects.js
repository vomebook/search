const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, run } = require("./test_harness");
const { searchTestProjects } = require("./search_test_projects");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-projects-"));
const workspace = path.join(dir, "repo");
const github = path.join(dir, "github-Search");
const hf = path.join(dir, "huggingface-Search");
for (const root of [github, hf]) {
  fs.mkdirSync(path.join(root, "static"), { recursive: true });
  fs.writeFileSync(path.join(root, "static", "app.js"), "// fixture");
}

test("default mode requires and selects both sibling sites", () => {
  assert.deepStrictEqual(searchTestProjects({}, workspace), [
    { name: "github-Search", root: github },
    { name: "huggingface-Search", root: hf },
  ]);
  fs.rmSync(path.join(hf, "static", "app.js"));
  try {
    assert.throws(() => searchTestProjects({}, workspace), /Missing huggingface-Search application/);
  } finally {
    fs.writeFileSync(path.join(hf, "static", "app.js"), "// fixture");
  }
});

test("explicit mode selects exactly the named root independent of cwd", () => {
  for (const [name, root] of [["github-Search", github], ["huggingface-Search", hf]]) {
    assert.deepStrictEqual(searchTestProjects({ SEARCH_TEST_PROJECT: name, SEARCH_TEST_ROOT: root }, "/unused"), [{ name, root }]);
  }
});

test("incomplete, invalid, relative or missing selections fail closed", () => {
  for (const env of [
    { SEARCH_TEST_PROJECT: "github-Search" },
    { SEARCH_TEST_ROOT: github },
    { SEARCH_TEST_PROJECT: "invalid", SEARCH_TEST_ROOT: github },
    { SEARCH_TEST_PROJECT: "github-Search", SEARCH_TEST_ROOT: "relative" },
    { SEARCH_TEST_PROJECT: "github-Search", SEARCH_TEST_ROOT: path.join(dir, "missing") },
    { SEARCH_TEST_PROJECT: "", SEARCH_TEST_ROOT: github },
  ]) {
    assert.throws(() => searchTestProjects(env, workspace));
  }
});

run("search project selection").finally(() => fs.rmSync(dir, { recursive: true, force: true }));
