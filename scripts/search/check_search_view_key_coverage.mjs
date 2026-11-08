import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Require both site host contracts and the exact shared domain rule.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--test-isolation=none", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/domain/search-view-key.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_search_view_key_baseline.mjs", "tests/search/baselines/test_search_view_key_module.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*search-view-key\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "site key projection preserves native sorting and site-specific fields",
  "memo stays identical for unchanged inputs and invalidates aliased edits",
  "explicit folders hide legacy folders without overwriting their state",
  "site-specific sort defaults and missing sort control retain original bytes",
  "sparse arrays and custom iterators keep each site copy semantics",
  "encoder failures do not replace a previously usable memo",
  "a reentrant filter getter cannot make an old memo a hit",
  "a comparator that clears memo still raises the original TypeError",
  "filter and scalar getters are observed in their original order",
  "both site projections use exact field order, defaults and filtering",
  "projection preserves per-site iterator and sparse-array copy behavior",
  "cache hits retain identity and invalidations never reuse stale snapshots",
  "both explicit-folder paths hide legacy values and preserve identity",
  "explicit callbacks preserve evaluation order and failures propagate"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text, required)) {
  console.error("Search view key requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
