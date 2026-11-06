import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

const minimum = [98.13, 87.50, 100];
const names = ['resource paths use the real contract and reject JSON coercion', 'manifest preview null partition', 'page map null entry',
  'text index, partition and layer positive chain', 'text layer null entry', 'text index root null', 'text index part null',
  'text index search part null', 'text partition root null', 'text partition entry null',
  'parse errors and unrelated repository error remain distinct'];
const scripts = [
  ['tests/test_dataset_primary_policy.mjs', 'fixed dataset primary validation and URL encoding passed'],
  ['tests/test_reader_v3_ocr_retained.mjs', 'Independent OCR text, accepted corrections and SHA-256 checks remain available'],
  ['tests/reader/djvu/test_reader_djvu_only.mjs', 'PDF and DjVu primary reading, no legacy image fallback, OCR retention passed']
];
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
  '--experimental-test-coverage', '--test-coverage-include=**/static/reader/pdf/reader-v3.mjs',
  ...minimum.map((n, i) => `--test-coverage-${['lines', 'branches', 'functions'][i]}=${n}`),
  'tests/reader/pdf-v3/test_reader_v3_untrusted.mjs', ...scripts.map(([path]) => path)], {encoding:'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || '', lines = text.split(/\r?\n/);
const rows = lines.flatMap(line => {
  const match = /^\s*#\s*reader-v3\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const markers = scripts.every(([path, marker]) => {
  const index = lines.indexOf(`# Subtest: ${path}`), preceding = lines[index - 1] || '';
  return preceding === `# ${marker}` || preceding.startsWith(`# ${marker} `);
});
const summaries = ['1..14', '# tests 14', '# pass 14', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
  '# start of coverage report', '# end of coverage report'];
if (result.status !== 0 || !hasPassingTapContracts(text, [...names.map(name => ({name})), ...scripts.map(([name]) => ({name}))]) ||
    !markers || summaries.some(s => lines.filter(line => line === s).length !== 1) ||
    ['# tests ', '# pass ', '# fail ', '# cancelled ', '# skipped ', '# todo '].some(prefix => lines.filter(line => line.startsWith(prefix)).length !== 1) ||
    lines.filter(line => /^# duration_ms \d+(?:\.\d+)?$/.test(line)).length !== 1 ||
    rows.length !== 1 || rows[0].some((value, i) => value < minimum[i])) {
  console.error('reader-v3 coverage requires named contracts, completion markers, summaries and one coverage row');
  process.exitCode = 1;
}
