import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--test-isolation=none", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/domain/search-window-page.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_window_page_baseline.mjs", "tests/search/baselines/test_search_window_page_module.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*search-window-page\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "page validation preserves shape, lengths, generation and exact failure",
  "page validation preserves getter, array and coercion evaluation order",
  "window page rejects each inconsistent shape and mismatched generation",
  "window page propagates getter and array callback failures"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search window page requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
