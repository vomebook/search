import {spawnSync} from "node:child_process";

// Node 26 V8 report, one source only. Measured with the three named tests:
// 100.00% lines, 95.24% branches, 95.12% functions after strict annotations.
// Compare the printed decimals explicitly: Node floors CLI thresholds, and an
// empty report otherwise passes as 100%. This is not whole-Reader coverage.
const minimum = [100, 95.24, 95.12];
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/core/reader-request-manager.js",
  ...minimum.map((value, index) => `--test-coverage-${["lines", "branches", "functions"][index]}=${value}`),
  "tests/test_reader_request_manager.js", "tests/test_reader_initial_recovery.js",
  "tests/test_reader_request_manager_edges.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-request-manager\.js\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const required = ["reader request manager behavior", "reader initial response recovery", "reader request manager edge behavior"];
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !/^# skipped 0$/m.test(text) || !/^# todo 0$/m.test(text) || required.some(name => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
        !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
    })) {
  console.error("Request manager coverage gate requires passing named tests and exactly one source coverage row above each minimum");
  process.exitCode = 1;
}
