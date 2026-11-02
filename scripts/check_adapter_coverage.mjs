import { spawnSync } from "node:child_process";

// Node's coverage thresholds alone accept an empty report as 100%. Require
// the exact source row as well as full coverage so an unloaded file fails.
const result = spawnSync(process.execPath, [
  "--test", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/formats/reader-format-adapters.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_reader_adapter_registry.js"
], { encoding: "utf8", env: { ...process.env, READER_V8_COVERAGE: "1" } });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).filter(line =>
  /^\s*#?\s*reader-format-adapters\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
if (result.status !== 0 || rows.length !== 1) {
  console.error("Adapter coverage gate requires exactly one fully covered source row");
  process.exitCode = 1;
}
