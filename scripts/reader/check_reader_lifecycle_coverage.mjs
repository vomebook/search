import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

// Node 26/V8, the lifecycle module only under synthetic contracts; excludes host.
const minimum = [100, 97.47, 100];
const result = spawnSync(process.execPath, [
  '--test', '--test-reporter=tap', '--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/core/reader-lifecycle.mjs',
  ...minimum.map((value, index) => `--test-coverage-${['lines', 'branches', 'functions'][index]}=${value}`),
  'tests/reader/lifecycle/test_reader_lifecycle.mjs'
], {encoding: 'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || '';
const rows = text.split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-lifecycle\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const required = [
  'resource ownership, once-only release, abort and throwing cleanup behavior',
  'awaitReader supports immediate values, thenables, cancellation and original errors',
  'generation ownership drains PDF text only for search and checks abort state',
  'error classification preserves dynamic getter access and uncoerced matching codes',
  'navigation warnings require a current generation and ignore aborts',
  'waitForReader rejects on cancellation and resolves on its timer',
  'reader readiness preserves Foliate anchor only when loading node is connected',
  'phase and stage forward return values unchanged',
  'dispose is idempotent, releases observer and clears all timer handles',
  'failure cleanup preserves message, lifecycle stage and retry control semantics',
  'retry click waits for progress and reloads only while reader remains live'
].map(name => ({name}));
const lines = text.split(/\r?\n/);
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required) ||
    ['# start of coverage report', '# end of coverage report'].some(marker => lines.filter(line => line === marker).length !== 1) ||
    lines.filter(line => /^# duration_ms \d+(?:\.\d+)?$/.test(line)).length !== 1 ||
    !['1..11', '# tests 11', '# pass 11', '# fail 0', '# cancelled 0'].every(summary =>
      lines.filter(line => line === summary).length === 1) ||
    ['# tests ', '# pass ', '# fail ', '# cancelled '].some(prefix => lines.filter(line => line.startsWith(prefix)).length !== 1)) {
  console.error('Reader lifecycle requires named contracts and exactly one source row above each minimum');
  process.exitCode = 1;
}
