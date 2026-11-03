import {spawnSync} from "node:child_process";

// Require the original inline helper contracts to run, rather than merely load.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "tests/test_search_filter_equality_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const required = [
  "falsy saved values short-circuit before inspecting current",
  "length and elements use strict equality in order",
  "sparse arrays and array-like objects retain indexed property semantics",
  "length and element getters preserve their read order and early exit",
  "the current length is re-read after indexed getters mutate it",
  "getter exceptions propagate without later property reads",
  "the original global function binding remains writable but not deletable"
];
if (result.status !== 0 || !/^# skipped 0$/m.test(text) || !/^# todo 0$/m.test(text) ||
    required.some(name => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
        !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
    })) {
  console.error("Search filter equality requires all named baseline contracts with no skips or todos");
  process.exitCode = 1;
}
