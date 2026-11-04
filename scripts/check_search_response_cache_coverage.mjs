import {spawnSync} from "node:child_process";

// Node 26/V8 scope: the extracted response cache and its contract vectors.
// A missing source row or a failed test must never pass as empty coverage.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/response-cache.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_search_response_cache_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const rows = lines.filter(line =>
  /^\s*#\s*response-cache\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = [
  "cache preserves LRU access order and exact expiration boundary",
  "has promotes live entries and undefined values throw without insertion",
  "byte accounting bounds entries and bypasses oversize without corrupting survivors",
  "replacement resets TTL, byte count and LRU position",
  "oversize replacement and serialization errors retire the previous key",
  "the independent one-MiB entry cap rejects larger entries even with a larger total budget"
];
const skipped = lines.filter(line => /^# skipped(?:\s|$)/.test(line));
const todo = lines.filter(line => /^# todo(?:\s|$)/.test(line));
if (result.status !== 0 || rows.length !== 1 || skipped.length !== 1 || skipped[0] !== "# skipped 0" ||
    todo.length !== 1 || todo[0] !== "# todo 0" ||
    required.some(name => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
        !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
    })) {
  console.error("Search response cache coverage requires passing named tests and exactly one fully covered source row");
  process.exitCode = 1;
}
