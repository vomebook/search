import { spawnSync } from "node:child_process";

// Node's coverage thresholds alone accept an empty report as 100%. Require
// the exact source row as well as full coverage so an unloaded file fails.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/formats/reader-format-adapters.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_reader_adapter_registry.js"
], { encoding: "utf8", env: { ...process.env, READER_V8_COVERAGE: "1" } });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const rows = lines.filter(line =>
  /^\s*#?\s*reader-format-adapters\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const name = "reader adapter registry";
const index = lines.indexOf(`# Subtest: ${name}`);
const skipped = lines.filter(line => /^# skipped(?:\s|$)/.test(line));
const todo = lines.filter(line => /^# todo(?:\s|$)/.test(line));
if (result.status !== 0 || rows.length !== 1 || skipped.length !== 1 || skipped[0] !== "# skipped 0" ||
    todo.length !== 1 || todo[0] !== "# todo 0" ||
    index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
    lines[index - 1] !== "# reader adapter registry contracts passed" ||
    !/^ok \d+ - reader adapter registry$/.test(lines[index + 1] || "")) {
  console.error("Adapter coverage gate requires exactly one fully covered source row and the passing named contract");
  process.exitCode = 1;
}
