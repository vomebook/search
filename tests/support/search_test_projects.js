const fs = require("fs");
const path = require("path");

const NAMES = ["github-Search", "huggingface-Search"];

function searchTestProjects(env = process.env, repoRoot = path.resolve(__dirname, "../..")) {
  const name = env.SEARCH_TEST_PROJECT;
  const root = env.SEARCH_TEST_ROOT;
  let projects;
  if (name !== undefined || root !== undefined) {
    if (!NAMES.includes(name) || !root || !path.isAbsolute(root)) {
      throw new Error("SEARCH_TEST_PROJECT must name a site and SEARCH_TEST_ROOT must be its absolute path");
    }
    projects = [{ name, root }];
  } else {
    projects = NAMES.map((site) => ({ name: site, root: path.resolve(repoRoot, "..", site) }));
  }
  for (const project of projects) {
    const app = path.join(project.root, "static", "app.js");
    if (!fs.existsSync(app) || !fs.statSync(app).isFile()) {
      throw new Error(`Missing ${project.name} application: ${app}`);
    }
  }
  return projects;
}

module.exports = { searchTestProjects };
