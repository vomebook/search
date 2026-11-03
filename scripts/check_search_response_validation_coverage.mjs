import {spawnSync} from "node:child_process";

// Node 26/V8 scope: extracted response validator only, excluding the host.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/response-validation.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_search_response_validation_baseline.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).filter(line =>
  /^\s*#\s*response-validation\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const lines = text.split(/\r?\n/);
const required = [
  "complete, final, empty and past-end pages preserve exact cardinality",
  "response shape, safe total and requested page fields are strictly checked",
  "record elements accept objects only, preserving sparse-array every semantics",
  "legacy boundary values and getter evaluation order remain unchanged",
  "host function remains replaceable while forwarding the exact arguments and return value"
];
if (result.status !== 0 || rows.length !== 1 || !/^# skipped 0$/m.test(text) || !/^# todo 0$/m.test(text) ||
  required.some(name => {
    const index = lines.indexOf(`# Subtest: ${name}`);
    return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
      !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
  })) {
  console.error("Search response validation coverage requires passing named contracts and exactly one fully covered source row");
  process.exitCode = 1;
}
