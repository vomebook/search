import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Node 26/V8 scope: the extracted response cache and its contract vectors.
// A missing source row or a failed test must never pass as empty coverage.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/response-cache.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/response-cache/test_search_response_cache_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const rows = lines.flatMap(line => {
  const match = /^\s*#\s*response-cache\.js\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const required = [
  "cache preserves LRU access order and exact expiration boundary",
  "has promotes live entries and undefined values throw without insertion",
  "byte accounting bounds entries and bypasses oversize without corrupting survivors",
  "replacement resets TTL, byte count and LRU position",
  "oversize replacement and serialization errors retire the previous key",
  "the independent one-MiB entry cap rejects larger entries even with a larger total budget"
].map(name => ({name}));
const summaries = ["1..6", "# tests 6", "# pass 6", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"];
const complete = summaries.every(summary => lines.filter(line => line === summary).length === 1) &&
  lines.filter(line => /^(?:# )?1\.\.\d+$/.test(line)).length === 1 &&
  ["# tests ", "# pass ", "# fail ", "# cancelled ", "# skipped ", "# todo "].every(prefix =>
    lines.filter(line => line.startsWith(prefix)).length === 1) &&
  lines.filter(line => /^# duration_ms \d+(?:\.\d+)?$/.test(line)).length === 1 &&
  ["# start of coverage report", "# end of coverage report"].every(marker => lines.filter(line => line === marker).length === 1);
if (result.status !== 0 || rows.length !== 1 || rows[0].some(value => value !== 100) ||
    !hasPassingTapContracts(text, required) || !complete) {
  console.error("Search response cache coverage requires passing named tests and exactly one fully covered source row");
  process.exitCode = 1;
}
