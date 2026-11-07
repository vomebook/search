import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Node 26/V8 scope: extracted folder selection module only, excluding the host app.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/folder-selection.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_folder_selection_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*folder-selection\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "covered paths match exact ancestors in their original probe order",
  "lookup projects full and partial states for every node kind",
  "lookup visits each node once in original post-order without recursion",
  "selection state keeps null handling, supplied lookups and missing entries",
  "checkbox projection writes checked, indeterminate and self toggle state",
  "input exceptions and missing child states propagate unchanged",
  "namespace exposes the four functions on a mutable global object"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search folder selection coverage requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
