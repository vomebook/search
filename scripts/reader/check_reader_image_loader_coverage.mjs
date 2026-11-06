import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

// Node 26/V8, this module only, under the synthetic contracts below.
const minimum = [100, 87.18, 91.67];
const result = spawnSync(process.execPath, [
  '--test', '--test-concurrency=1', '--test-reporter=tap', '--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/formats/reader-image-loader.mjs',
  ...minimum.map((value, index) => `--test-coverage-${['lines', 'branches', 'functions'][index]}=${value}`),
  'tests/reader/images/test_reader_image_loader.mjs', 'tests/reader/images/test_reader_image_loader_contract.mjs'
], {encoding: 'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || '';
const rows = text.split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-image-loader\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const required = [
  {name: 'tests/reader/images/test_reader_image_loader.mjs', marker: 'Reader image loader: direct load, cleanup, cancellation, HTTP errors and bounded fallback passed'},
  {name: 'direct image success clears handlers and the tracked resource'},
  {name: 'image cancellation settles immediately even when the reader stays active'},
  {name: 'resource disposal settles without retaining handlers or starting fallback'}
];
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required)) {
  console.error('Reader image loader requires named contracts and exactly one source row above each minimum');
  process.exitCode = 1;
}
