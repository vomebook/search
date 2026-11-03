import {spawnSync} from "node:child_process";

// Node 26/V8: only the extracted path module and its compatibility vectors.
// Require a real source row as well as passing tests and full coverage.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/record-path.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_search_record_path.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).filter(line =>
  /^\s*#\s*record-path\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
if (result.status !== 0 || rows.length !== 1) {
  console.error("Search record path coverage gate requires passing tests and exactly one fully covered source row");
  process.exitCode = 1;
}
