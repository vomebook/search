import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Node 26/V8 scope: the download controller and its synthetic contract tests.
// A missing row, missing named test, skipped case, or fractional regression fails.
const minimum = [100, 88.89, 100];
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/downloads/application/controller.js",
  ...minimum.map((value, index) => `--test-coverage-${["lines", "branches", "functions"][index]}=${value}`),
  "tests/search/download/test_download_controller_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const rows = text.split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*controller\.js\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const required = [
  "shared checks preserve independent cancellation, cached success and expiration",
  "two active checks bound the queue and abandoned work never starts",
  "occupied queue starts the next live check only after a slot is released",
  "check failures report legacy messages and permit a retry",
  "truthy rejection messages retain their original non-string values",
  "mutated native lookups retain their existing unchecked failure behavior",
  "generic signal option is ignored but batch abort owns cancellation",
  "a stalled response body times out, releases its slot and retries without caching failure",
  "an abandoned active check cannot evict a successful retry when its body resolves late",
  "successful check cache retains at most 64 entries in insertion order",
  "shared downloads retain other owners and restore button feedback",
  "download failures restore controls and emit the appropriate feedback",
  "a throwing success toast does not turn a shared launched download into failure",
  "a throwing triggerDownload still reports failure",
  "a failed browser handoff does not strand later queued downloads",
  "handoffs are paced and a cancelled queued handoff never launches",
  "detailed results distinguish pre-handoff failure, uncertain handoff and cancellation",
  "detailed shared callers cancel independently and handoff attempts remain paced",
  "batch retries only definite failures and reports uncertainty",
  "abort during browser handoff cannot erase the shared uncertain result",
  "uncertain feedback belongs to each live non-quiet shared subscriber",
  "single uncertain handoff is retained and a later batch failure is visible but not retried",
  "retry workers recheck uncertainty when consuming queued items, unlike explicit batches",
  "legacy launch scheduler preserves pacing, cancellation and recovery after throws",
  "batch owns two quiet workers, deduplicates in order and cancels queued work",
  "ledger restore filters records, tolerates storage failure and preserves acknowledgement order"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required)) {
  console.error("Download controller coverage requires passing named contracts and exactly one source row above each minimum");
  process.exitCode = 1;
}
