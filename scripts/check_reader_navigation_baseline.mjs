import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from './check_tap_contracts.mjs';

// Node 26/V8 scope: this single file under the synthetic URL/session contracts.
// This is a baseline, not a claim that iframe/speech behavior is covered.
const minimum = [31.96, 81.82, 27.27];
const result = spawnSync(process.execPath, [
  '--test', '--test-reporter=tap', '--experimental-test-coverage',
  '--test-coverage-include=**/static/search/reader-navigation.js',
  ...minimum.map((value, index) => `--test-coverage-${['lines', 'branches', 'functions'][index]}=${value}`),
  'tests/test_reader_navigation_baseline.mjs'
], {encoding: 'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || '';
const rows = text.split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*reader-navigation\.js\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const required = [
  'parse accepts only the same-origin reader pathname',
  'ordinary query merging replaces only selected keys and keeps repeated values',
  'hash query merging preserves route and unrelated query components',
  'merge without selected keys preserves existing query and returns a new URL',
  'prepare records the return location and removes the previous handoff',
  'prepare tolerates unavailable storage or token generation without skipping destination validation',
  'remember stores a private reader URL but exposes a sanitized history URL',
  'remember still updates history when storage fails and saved rejects malformed JSON',
  'clear removes only the matching session and selected return token',
  'messages are rejected when no reader iframe is active'
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required)) {
  console.error('Reader navigation requires all named baseline contracts and one source row above each minimum');
  process.exitCode = 1;
}
