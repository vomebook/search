import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "./check_tap_contracts.mjs";

// Node 26/V8 scope: only the extracted inventory, not the host app.js.
// This data-only source executes on load, so full coverage alone is vacuous:
// also require every named behavioral contract to actually run.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/file-types.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_extension_inventory_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).filter(line =>
  /^\s*#\s*file-types\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "all 67 ordered filter extensions are pinned, including case-sensitive lookup",
  "all 77 icon mappings and their case-insensitive lookup are pinned",
  "fallback, inherited keys, errors and lowercase invocation match the original",
  "original lexical inventories cannot be reassigned or shadowed through global properties",
  "const bindings retain their original mutable array and map contents",
  "inventory data is isolated between script evaluations"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(result.stdout || "", required)) {
  console.error("Search file types coverage requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
