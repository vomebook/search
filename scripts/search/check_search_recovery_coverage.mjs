import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--test-isolation=none", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/domain/search-recovery.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_recovery_baseline.mjs", "tests/search/baselines/test_search_recovery_module.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*search-recovery\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "recovery status precedence and exact membership match the old host",
  "recovery messages and abort precedence match the old host",
  "recovery getter reads and error propagation remain observable",
  "shared recovery rule covers abort, HTTP status and transport messages",
  "shared recovery rule reads repeated getters without swallowing exceptions"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search recovery requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
