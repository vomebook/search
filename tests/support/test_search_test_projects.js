const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, run } = require("./test_harness");
const { searchTestProjects, responseCacheTestProjects } = require("./search_test_projects");
const {spawnSync} = require("child_process");

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

test("response-cache entry selects its own checkout without another site's compiler", () => {
  const env = {...process.env};
  delete env.SEARCH_TEST_PROJECT;
  delete env.SEARCH_TEST_ROOT;
  const helper = path.resolve(__dirname, "search_test_projects.js");
  const source = `const {responseCacheTestProjects}=require(process.argv[1]);
    console.log(JSON.stringify(responseCacheTestProjects()));`;
  const result = spawnSync(process.execPath, ["-e", source, helper], {cwd: dir, env, encoding: "utf8", timeout: 30000});
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), [{name: "github-Search", root: path.resolve(__dirname, "../..")}]);
  assert.deepStrictEqual(responseCacheTestProjects({SEARCH_TEST_PROJECT: "huggingface-Search", SEARCH_TEST_ROOT: hf}),
    [{name: "huggingface-Search", root: hf}]);
  for (const selection of [{SEARCH_TEST_PROJECT: "github-Search"}, {SEARCH_TEST_ROOT: github}])
    assert.throws(() => responseCacheTestProjects(selection));
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
