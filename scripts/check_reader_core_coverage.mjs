import { spawnSync } from "node:child_process";

// Each run includes exactly one own-source file, so Node's aggregate
// thresholds cannot hide a regression in another file or in an empty report.
// Baseline measured 2026-11-03 on Node v26.11.1, using the named tests only.
const gates = [
  { source:"reader-section-virtualizer.js", directory:"formats", lines:100, branches:100, functions:100,
    tests:["tests/test_reader_section_virtualizer.js"] },
  { source:"reader-chapter-repository.js", directory:"formats", lines:100, branches:98.86, functions:100,
    tests:["tests/test_reader_chapter_repository.js", "tests/test_reader_chapter_scheduler.js", "tests/test_reader_chapter_preload.js"] },
  { source:"reader-scroll-anchor.js", directory:"ui", lines:100, branches:89.61, functions:100,
    tests:["tests/test_reader_scroll_anchor.js"] }
];

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
  if (result.status !== 0 || rows.length !== 1 ||
      values.some((value,index)=>value < [gate.lines,gate.branches,gate.functions][index])) {
    console.error(`Reader core coverage gate requires passing tests and exactly one source coverage row: ${gate.source}`);
    process.exitCode = 1;
  }
}
