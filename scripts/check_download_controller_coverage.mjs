import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "./check_tap_contracts.mjs";

// Node 26/V8 scope: the download controller and its synthetic contract tests.
// A missing row, missing named test, skipped case, or fractional regression fails.
const minimum = [100, 87.74, 100];
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/download-controller.js",
  ...minimum.map((value, index) => `--test-coverage-${["lines", "branches", "functions"][index]}=${value}`),
  "tests/test_download_controller_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*download-controller\.js\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const required = [
  "shared checks preserve independent cancellation, cached success and expiration",
  "two active checks bound the queue and abandoned work never starts",
  "occupied queue starts the next live check only after a slot is released",
  "check failures report legacy messages and permit a retry",
  "a stalled response body times out, releases its slot and retries without caching failure",
  "an abandoned active check cannot evict a successful retry when its body resolves late",
  "successful check cache retains at most 64 entries in insertion order",
  "shared downloads retain other owners and restore button feedback",
  "download failures restore controls and emit the appropriate feedback",
  "a failed browser handoff does not strand later queued downloads",
  "handoffs are paced and a cancelled queued handoff never launches"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required)) {
  console.error("Download controller coverage requires passing named contracts and exactly one source row above each minimum");
  process.exitCode = 1;
}
