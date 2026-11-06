import { spawnSync } from "node:child_process";

// Node 26/V8: preserve the old aggregate floors, and separately protect each
// extracted module. These are PDF network contracts, not the whole Reader.
// Extraction changes individual denominators; floors are measured separately.
const aggregateMinimum = [98.29, 85.25, 87.16];
const minimum = [97.86, 84.23, 86.27];
const cacheMinimum = [100, 97.01, 100];
const hintsMinimum = [100, 92.59, 100];
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/pdf/reader-pdf-network.mjs",
  "--test-coverage-include=**/static/reader/pdf/reader-pdf-range-cache.mjs",
  "--test-coverage-include=**/static/reader/pdf/reader-pdf-range-hints.mjs",
  ...aggregateMinimum.map((value,index)=>`--test-coverage-${["lines","branches","functions"][index]}=${value}`),
  "tests/reader/pdf-network/test_reader_pdf_backpressure.mjs", "tests/reader/pdf-network/test_reader_pdf_sparse_ranges.mjs",
  "tests/reader/pdf-network/test_reader_pdf_network_contract.mjs", "tests/reader/pdf-network/test_pdf_range_hints_contract.mjs"
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
const hintsRows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-pdf-range-hints\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const skipped = lines.filter(line => /^# skipped(?:\s|$)/.test(line));
const todo = lines.filter(line => /^# todo(?:\s|$)/.test(line));
const required = [
  ["tests/reader/pdf-network/test_reader_pdf_backpressure.mjs", "429 feedback, shared spacing, bounded retry, version consistency and cancellation passed"],
  ["tests/reader/pdf-network/test_reader_pdf_network_contract.mjs", "PDF network contracts: cache identity, safe revalidation and live cancellation passed"],
  ["tests/reader/pdf-network/test_pdf_range_hints_contract.mjs", "PDF range hints: bounded scheduling, malformed inputs and compatibility exports passed"],
  ["tests/reader/pdf-network/test_reader_pdf_sparse_ranges.mjs", "Sparse PDF detection, exact demand ranges, bounded concurrency and disposal passed"]
];
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value,index)=>value < minimum[index]) ||
    cacheRows.length !== 1 || cacheRows[0].some((value,index)=>value < cacheMinimum[index]) ||
    hintsRows.length !== 1 || hintsRows[0].some((value,index)=>value < hintsMinimum[index]) ||
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
