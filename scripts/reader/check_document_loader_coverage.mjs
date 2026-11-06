import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Node 26/V8 scope: only reader-document-loader.mjs and the named tests.
// Baseline after adding failure-path contracts: 100% lines, 94.20% branches,
// 97.22% functions. Do not accept an unloaded file as an empty 100% report.
const minimum = [100, 94.20, 97.22];
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/core/reader-document-loader.mjs",
  ...minimum.map((value, index) => `--test-coverage-${["lines", "branches", "functions"][index]}=${value}`),
  "tests/reader/transport/test_reader_document_loader_contract.mjs", "tests/reader/transport/test_reader_pdf_rate_outer.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-document-loader\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const text = result.stdout || "";
const required = [
  "retry policy keeps bounded delay and never retries rate-limited or aborted work",
  "proxy fallback respects response ownership, cancellation and bucket routing",
  "preloads are single-owner and fall back on failure or mismatched identity",
  "document preparation preserves failure and byte-limit ownership",
  "script load releases timers, handlers and resources on success, error and close",
  "image fallback is not used for budget failures or closed readers"
].map(name => ({name}));
required.push({name: "tests/reader/transport/test_reader_pdf_rate_outer.mjs",
  marker: "PDF rate-limit retry boundary and generic retry preserved"});
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required)) {
  console.error("Document loader coverage requires passing named tests and exactly one source row above each minimum");
  process.exitCode = 1;
}
