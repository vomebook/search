import { spawnSync } from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Each run includes exactly one own-source file, so Node's aggregate
// thresholds cannot hide a regression in another file or in an empty report.
// Baseline measured 2026-11-03 on Node v26.11.1, using the named tests only.
const gates = [
  { source:"reader-section-virtualizer.js", directory:"formats", lines:100, branches:100, functions:100,
    tests:["tests/reader/layout/test_reader_section_virtualizer.js"] },
  { source:"reader-chapter-repository.js", directory:"formats", lines:100, branches:98.86, functions:100,
    tests:["tests/reader/chapters/test_reader_chapter_repository.js", "tests/reader/chapters/test_reader_chapter_scheduler.js", "tests/reader/chapters/test_reader_chapter_preload.js"] },
  { source:"reader-scroll-anchor.js", directory:"ui", lines:100, branches:89.61, functions:100,
    tests:["tests/reader/layout/test_reader_scroll_anchor.js"] }
];

// Run boundary regressions separately so they cannot change the coverage gates below.
const boundaryTests = [
  {file: "tests/reader/chapters/test_chapter_format_validation.mjs", names: ["tests/reader/chapters/test_chapter_format_validation.mjs"], marker: "chapter metadata validation and prefetch sizes passed"},
  {file: "tests/reader/core/test_pdf_text_context.js", names: ["tests/reader/core/test_pdf_text_context.js"]},
  {file: "tests/reader/core/test_reader_contract_pdf_document.js", names: ["tests/reader/core/test_reader_contract_pdf_document.js"]},
  {file: "tests/reader/core/test_reader_format_controller_boundary.mjs", names: [
    "DjVu loader remains a separate module at the Pages runtime URL",
    "resolution ignores non-string extensions and preserves the existing extension",
    "resolution retains string and legacy DJVU semantics",
    "classification is narrowed at the fail boundary without coercion",
    "dynamic lifecycle code remains uncoerced and is narrowed by the controller",
    "image fallback only accepts a string original extension"]},
  {file: "tests/reader/core/test_reader_source_boundary.mjs", names: [
    "download validates unknown JSON and preserves server messages",
    "download handles null, primitive and abort errors without losing cleanup",
    "a derived text preview still downloads the original VCF with its exact filename",
    "normal and early resolution validate metadata while retaining extra fields",
    "non-record metadata is rejected before use in both resolution paths and application",
    "optional nulls and mixed folders survive resolution and application",
    "early lookup retries timeout and rethrows null rejection"]},
  {file: "tests/reader/security/test_reader_security_boundary.js", names: ["tests/reader/security/test_reader_security_boundary.js"]}
];
for (const {file, names, marker} of boundaryTests) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", file], {encoding: "utf8"});
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const lines = (result.stdout || "").split(/\r?\n/);
  const summaries = [`1..${names.length}`, `# tests ${names.length}`, `# pass ${names.length}`,
    "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"];
  if (result.status !== 0 || !hasPassingTapContracts(result.stdout || "", names.map(name => marker ? {name, marker} : {name})) ||
      !summaries.every(line => lines.filter(item => item === line).length === 1)) {
    console.error(`Reader boundary gate requires all named tests to pass: ${file}`);
    process.exitCode = 1;
  }
}

for (const gate of gates) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-concurrency=1", "--test-reporter=tap", "--experimental-test-coverage",
    `--test-coverage-include=**/static/reader/${gate.directory}/${gate.source}`,
    `--test-coverage-lines=${gate.lines}`, `--test-coverage-branches=${gate.branches}`,
    `--test-coverage-functions=${gate.functions}`, ...gate.tests
  ], { encoding:"utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const rows = (result.stdout || "").split(/\r?\n/).filter(line => {
    const columns = line.split("|").map(value => value.trim());
    return columns[0].replace(/^#\s*/, "") === gate.source && columns.length >= 4 &&
      columns.slice(1,4).every(value => /^\d+(?:\.\d+)?$/.test(value));
  });
  const values = rows.length === 1 ? rows[0].split("|").slice(1,4).map(value=>Number(value.trim())) : [];
  const text = result.stdout || "";
  const expected = {"tests/reader/layout/test_reader_section_virtualizer.js": "reader section virtualizer contracts passed",
    "tests/reader/chapters/test_reader_chapter_repository.js": "reader chapter repository contracts passed",
    "tests/reader/chapters/test_reader_chapter_scheduler.js": "reader chapter scheduler contracts passed",
    "tests/reader/chapters/test_reader_chapter_preload.js": "chapter manifest preload validation, reuse, body deadline and disposal passed",
    "tests/reader/layout/test_reader_scroll_anchor.js": "reader scroll anchor contracts passed"};
  const missingTests = gate.tests.some(name => typeof expected[name] !== "string") ||
    !hasPassingTapContracts(text, gate.tests.map(name => ({name, marker: expected[name]})));
  if (result.status !== 0 || rows.length !== 1 ||
      values.some((value,index)=>value < [gate.lines,gate.branches,gate.functions][index]) || missingTests) {
    console.error(`Reader core coverage gate requires passing named tests and exactly one source coverage row: ${gate.source}`);
    process.exitCode = 1;
  }
}
