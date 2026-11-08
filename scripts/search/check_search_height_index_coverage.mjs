import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Node 26/V8 scope: extracted Fenwick height index only, excluding the host app.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/height-index.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_height_index_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*height-index\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "prefix sums match the naive oracle for zero, missing and fractional heights",
  "indexAt returns the row containing an offset and clamps out-of-range probes",
  "dense builds use each row height or the estimate and stay cached until dirty",
  "sparse trees store per-row deltas over the shared base",
  "append extension is equivalent to a full rebuild for every growth pattern",
  "extension refuses stale or resized trees and marks them dirty",
  "fenwickAdd ignores zero deltas and creates missing sparse slots",
  "input exceptions and shared namespace identity propagate unchanged"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search height index coverage requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
