import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Only the extracted size-format module, as exercised by the compatibility
// vectors; an unloaded file must not be accepted as an empty 100% report.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/size-format.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/size/test_search_size_format.js", "tests/search/size/test_search_size_render_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const rows = lines.filter(line =>
  /^\s*#\s*size-format\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  {name: "tests/search/size/test_search_size_format.js", marker: "search size formatting, parser compatibility and URL round trips passed"},
  ...["display preserves binary boundaries and historical precision", "display retains original coercion and empty-value behavior",
    "display retains prototype and normalized cache behavior"].map(name => ({name}))
];
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search size coverage gate requires passing named tests and exactly one fully covered source row");
  process.exitCode = 1;
}
