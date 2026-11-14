import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

// Node 26/V8: only this media-format source under synthetic host/DOM contracts.
const minimum = [100, 90.77, 100];
const required = [
  'time formatting preserves nonnumeric and coercion behavior',
  'image readiness and errors retain ordering',
  'media mode reaches document.createElement unchanged before element work',
  'Flash loader preserves byte values and script-before-fetch sequencing',
  'Flash renderer forwards the original data and reports unavailable engine',
  'media readiness waits for metadata and reports player timing',
  'media source retries only once and restores position on metadata',
  'resource cleanup rejects pending metadata and removes listeners',
  'metadata hard deadline rejects and exposes media retry without another source',
  'idle deadline retries original once and rearms without changing hard deadline',
  'video setup keeps native controls and inline playback until metadata arrives',
  'capability lookup receives uncoerced original extension metadata',
  'codec error reports a recoverable failure without retrying the same source',
  'retry restores playing state and tolerates a rejected play promise',
  'progress extends the idle deadline without extending the hard deadline'
].map(name => ({name}));
const result = spawnSync(process.execPath, [
  '--test', '--test-concurrency=1', '--test-reporter=tap', '--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/formats/reader-media-format.mjs',
  ...minimum.map((value, index) => `--test-coverage-${['lines', 'branches', 'functions'][index]}=${value}`),
  'tests/reader/media/test_reader_media_baseline.mjs', 'tests/reader/media/test_reader_media_metadata.mjs'
], {encoding: 'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || '', lines = text.split(/\r?\n/);
const rows = lines.flatMap(line => {
  const match = /^\s*#\s*reader-media-format\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required) ||
    ['# start of coverage report', '# end of coverage report'].some(marker => lines.filter(line => line === marker).length !== 1) ||
    lines.filter(line => /^# duration_ms \d+(?:\.\d+)?$/.test(line)).length !== 1 ||
    !['1..15', '# tests 15', '# pass 15', '# fail 0', '# cancelled 0'].every(summary =>
      lines.filter(line => line === summary).length === 1) ||
    ['# tests ', '# pass ', '# fail ', '# cancelled '].some(prefix => lines.filter(line => line.startsWith(prefix)).length !== 1)) {
  console.error('Reader media requires named contracts and exactly one source row above each minimum');
  process.exitCode = 1;
} else {
  // Keep these independent of the fixed TAP and coverage counts above.
  for (const args of [
    ['--test', '--test-concurrency=1', 'tests/reader/copy_reader_vendor.test.mjs', 'tests/reader/test_foliate_proxy.mjs'],
    ['tests/reader/media/test_ruffle_closure.mjs'],
    ['tests/service_worker/test_ruffle_retention.js']
  ]) {
    const extra = spawnSync(process.execPath, args, {stdio: 'inherit'});
    if (extra.error) throw extra.error;
    if (extra.status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
}
