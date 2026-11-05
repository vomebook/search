import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from './check_tap_contracts.mjs';

// These are seven pre-existing file-level Node scripts, not seven unit cases
// or a claim of coverage over the complete DjVu implementation.
const contracts = [
  ['only', 'PDF and DjVu primary reading, no legacy image fallback, OCR retention passed'],
  ['png', 'Pages historical PNG metadata and zoom anchor passed'],
  ['range', 'DjVu range bounds, identity, retries, caching and cancellation passed'],
  ['range_fallback', 'ignored Range falls back to full original, never page images'],
  ['scheduler', 'DjVu scheduler cancellation, ordering, deduplication, LRU and closure passed'],
  ['source_integrity', 'DjVu dataset source size, hash, cancellation and map-failure guards passed'],
  ['worker', 'DjVu Worker bounds, errors, timeout, cancellation and geometry checks passed']
];
const required = contracts.map(([name]) => ({name: `tests/reader/djvu/test_reader_djvu_${name}.mjs`}));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
  ...required.map(({name}) => name)], {encoding: 'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const lines = (result.stdout || '').split(/\r?\n/);
const summaries = ['1..7', '# tests 7', '# pass 7', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'];
const complete = contracts.every(([name, marker]) => {
  const subtest = `# Subtest: tests/reader/djvu/test_reader_djvu_${name}.mjs`;
  const index = lines.indexOf(subtest);
  return index > 0 && lines[index - 1].startsWith('# ' + marker) &&
    (lines[index - 1] === '# ' + marker || lines[index - 1].startsWith('# ' + marker + ' '));
});
// Coverage is deliberately scoped to the range module, using its original
// synthetic transport regression plus the named boundary contract.
const minimum = [100, 86.81, 78.95];
const boundary = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/pdf/reader-djvu-range.mjs',
  ...minimum.map((value, index) => `--test-coverage-${['lines', 'branches', 'functions'][index]}=${value}`),
  'tests/reader/djvu/test_reader_djvu_range.mjs', 'tests/reader/djvu/test_reader_djvu_range_boundaries.mjs'], {encoding: 'utf8'});
if (boundary.stdout) process.stdout.write(boundary.stdout);
if (boundary.stderr) process.stderr.write(boundary.stderr);
if (boundary.error) throw boundary.error;
const boundaryName = 'reads reject invalid lengths and offsets without dispatching new windows';
const boundaryLines = (boundary.stdout || '').split(/\r?\n/);
const boundarySummaries = ['1..2', '# tests 2', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'];
const boundaryRequired = [{name: 'tests/reader/djvu/test_reader_djvu_range.mjs',
  marker: 'DjVu range bounds, identity, retries, caching and cancellation passed'}, {name: boundaryName}];
const coverageRows = boundaryLines.flatMap(line => {
  const match = /^\s*#\s*reader-djvu-range\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const boundaryComplete = boundary.status === 0 && hasPassingTapContracts(boundary.stdout || '', boundaryRequired) &&
  boundarySummaries.every(summary => boundaryLines.filter(line => line === summary).length === 1) &&
  ['# tests ', '# pass ', '# fail ', '# cancelled ', '# skipped ', '# todo '].every(prefix =>
    boundaryLines.filter(line => line.startsWith(prefix)).length === 1) &&
  boundaryLines.filter(line => /^# duration_ms \d+(?:\.\d+)?$/.test(line)).length === 1 &&
  ['# start of coverage report', '# end of coverage report'].every(marker => boundaryLines.filter(line => line === marker).length === 1) &&
  coverageRows.length === 1 && coverageRows[0].every((value, index) => value >= minimum[index]);
if (result.status !== 0 || !complete || !hasPassingTapContracts(result.stdout || '', required) ||
    !boundaryComplete ||
    !summaries.every(summary => lines.filter(line => line === summary).length === 1) ||
    ['# tests ', '# pass ', '# fail ', '# cancelled ', '# skipped ', '# todo '].some(prefix =>
      lines.filter(line => line.startsWith(prefix)).length !== 1) ||
    lines.filter(line => /^# duration_ms \d+(?:\.\d+)?$/.test(line)).length !== 1) {
  console.error('DjVu contracts require seven named scripts, completion markers and zero skipped/TODO');
  process.exitCode = 1;
}
