import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "./check_tap_contracts.mjs";

// Require every original inline merge contract to finish without skips.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "tests/search/baselines/test_search_folder_merge_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const required = [
  "self paths retain order and duplicates while matching subtree paths are excluded",
  "falsy arguments use empty arrays without discarding truthy paths",
  "set membership uses SameValueZero and object identity",
  "sparse input holes follow Set, filter and concat semantics",
  "membership is captured before subtree filter access mutates the self array",
  "iterator, method lookup and membership calls keep their observable order",
  "iterator and getter failures propagate without later property reads",
  "rebound Set receives the original iterable without an intermediate copy",
  "custom filter can observe the original callback constructability",
  "the original global function binding remains writable but not deletable"
].map(name => ({name}));
if (result.status !== 0 || !hasPassingTapContracts(text, required)) {
  console.error("Search folder merge requires all named baseline contracts with no skips or todos");
  process.exitCode = 1;
}
