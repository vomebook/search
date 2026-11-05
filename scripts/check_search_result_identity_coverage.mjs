import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "./check_tap_contracts.mjs";

// Node 26/V8 scope: extracted identity module only, excluding host and path helper.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/result-identity.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_stable_id_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*result-identity\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "non-objects are empty while object fallbacks retain exact path spelling",
  "truthy Id precedes id and both retain original String conversion",
  "ID and path getter reads retain their original order and short-circuiting",
  "dependency lookup and exceptional values propagate unchanged",
  "path lookup remains lazy through early returns and Repo conversion",
  "host binding forwards the original result and uncoerced return value"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search result identity coverage requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
