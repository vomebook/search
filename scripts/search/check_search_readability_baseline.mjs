import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

// These contracts exercise the original inline fragments, not app.js coverage.
const result = spawnSync(process.execPath, [
  '--test', '--test-reporter=tap', 'tests/search/baselines/test_search_readability_baseline.mjs'
], {encoding: 'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const required = [
  'converted extension takes precedence while default uses the original extension',
  'docx without a converted link is rejected before capability lookup',
  'falsy converted extensions fall back to the original without normalizing the argument',
  'falsy records are forwarded unchanged to capability by both helpers',
  'capability article values are returned without coercion',
  'the real Reader contract retains native and converted format eligibility',
  'getter and coercion order includes a second extension read',
  'capability rebinding and errors remain observable',
  'the original global function bindings remain writable but not deletable'
].map(name => ({name}));
if (result.status !== 0 || !hasPassingTapContracts(result.stdout || '', required)) {
  console.error('Search readability requires all named baseline contracts with no skips or todos');
  process.exitCode = 1;
}
