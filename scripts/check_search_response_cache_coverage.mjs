import {spawnSync} from "node:child_process";

// Node 26/V8 scope: the extracted response cache and its contract vectors.
// A missing source row or a failed test must never pass as empty coverage.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/response-cache.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_search_response_cache_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).filter(line =>
  /^\s*#\s*response-cache\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
if (result.status !== 0 || rows.length !== 1) {
  console.error("Search response cache coverage requires passing tests and exactly one fully covered source row");
  process.exitCode = 1;
}
