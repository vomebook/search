import { spawnSync } from "node:child_process";

// V8/Node v26 coverage is scoped to this one own-source module, not the
// entire Reader. Node v26 floors fractional CLI thresholds to integers;
// enforce the printed two-decimal values ourselves too. The initial measured
// baseline was 98.31% lines, 85.35% branches and 88.43% functions; an added
// deterministic deadline case raised the repeatedly observed branch floor to 85.65%.
// Explicitly require its row: Node otherwise treats an empty report as 100%.
const minimum = [98.31, 85.65, 88.43];
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/reader/pdf/reader-pdf-network.mjs",
  ...minimum.map((value,index)=>`--test-coverage-${["lines","branches","functions"][index]}=${value}`),
  "tests/test_reader_pdf_backpressure.mjs", "tests/test_reader_pdf_sparse_ranges.mjs",
  "tests/test_reader_pdf_network_contract.mjs"
], { encoding: "utf8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-pdf-network\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const required = [
  ["tests/test_reader_pdf_backpressure.mjs", "429 feedback, shared spacing, bounded retry, version consistency and cancellation passed"],
  ["tests/test_reader_pdf_network_contract.mjs", "PDF network contracts: cache identity, safe revalidation and live cancellation passed"],
  ["tests/test_reader_pdf_sparse_ranges.mjs", "Sparse PDF detection, exact demand ranges, bounded concurrency and disposal passed"]
];
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value,index)=>value < minimum[index]) ||
    !/^# skipped 0$/m.test(text) || !/^# todo 0$/m.test(text) || required.some(([name, marker]) => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
        lines[index - 1] !== `# ${marker}` ||
        !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
    })) {
  console.error("PDF network coverage gate requires passing named tests and exactly one source coverage row");
  process.exitCode = 1;
}
