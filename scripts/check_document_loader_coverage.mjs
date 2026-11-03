import {spawnSync} from "node:child_process";

// Node 26/V8 scope: only reader-document-loader.mjs and the named tests.
// Baseline after adding failure-path contracts: 100% lines, 94.20% branches,
// 97.22% functions. Do not accept an unloaded file as an empty 100% report.
const minimum = [100, 94.20, 97.22];
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/core/reader-document-loader.mjs",
  ...minimum.map((value, index) => `--test-coverage-${["lines", "branches", "functions"][index]}=${value}`),
  "tests/test_reader_document_loader_contract.mjs", "tests/test_reader_pdf_rate_outer.mjs"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-document-loader\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index])) {
  console.error("Document loader coverage requires passing tests and exactly one source row above each minimum");
  process.exitCode = 1;
}
