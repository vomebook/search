import { spawnSync } from "node:child_process";

// Node 26/V8: independent floors for the network module and extracted cache,
// not the whole Reader. Extraction changes the denominators; these floors were
// measured from the same existing contracts (plus invalid cache inputs).
// Require exactly one row for each module: an empty report otherwise passes.
const minimum = [98.29, 85.25, 87.16];
const cacheMinimum = [100, 97.01, 100];
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/pdf/reader-pdf-network.mjs",
  "--test-coverage-include=**/static/reader/pdf/reader-pdf-range-cache.mjs",
  ...minimum.map((value,index)=>`--test-coverage-${["lines","branches","functions"][index]}=${value}`),
  "tests/reader/pdf-network/test_reader_pdf_backpressure.mjs", "tests/reader/pdf-network/test_reader_pdf_sparse_ranges.mjs",
  "tests/reader/pdf-network/test_reader_pdf_network_contract.mjs"
], { encoding: "utf8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-pdf-network\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const cacheRows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-pdf-range-cache\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const skipped = lines.filter(line => /^# skipped(?:\s|$)/.test(line));
const todo = lines.filter(line => /^# todo(?:\s|$)/.test(line));
const required = [
  ["tests/reader/pdf-network/test_reader_pdf_backpressure.mjs", "429 feedback, shared spacing, bounded retry, version consistency and cancellation passed"],
  ["tests/reader/pdf-network/test_reader_pdf_network_contract.mjs", "PDF network contracts: cache identity, safe revalidation and live cancellation passed"],
  ["tests/reader/pdf-network/test_reader_pdf_sparse_ranges.mjs", "Sparse PDF detection, exact demand ranges, bounded concurrency and disposal passed"]
];
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value,index)=>value < minimum[index]) ||
    cacheRows.length !== 1 || cacheRows[0].some((value,index)=>value < cacheMinimum[index]) ||
    skipped.length !== 1 || skipped[0] !== "# skipped 0" || todo.length !== 1 || todo[0] !== "# todo 0" ||
    required.some(([name, marker]) => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
        lines[index - 1] !== `# ${marker}` ||
        !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
    })) {
  console.error("PDF network coverage gate requires passing named tests and exactly one source coverage row per module");
  process.exitCode = 1;
}
