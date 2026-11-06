import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Require the original inline helper contracts to run, rather than merely load.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "tests/search/baselines/test_search_filter_equality_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const required = [
  "falsy saved values short-circuit before inspecting current",
  "length and elements use strict equality in order",
  "sparse arrays and array-like objects retain indexed property semantics",
  "length and element getters preserve their read order and early exit",
  "the current length is re-read after indexed getters mutate it",
  "getter exceptions propagate without later property reads",
  "the original global function binding remains writable but not deletable"
].map(name => ({name}));
if (result.status !== 0 || !hasPassingTapContracts(text, required)) {
  console.error("Search filter equality requires all named baseline contracts with no skips or todos");
  process.exitCode = 1;
}
