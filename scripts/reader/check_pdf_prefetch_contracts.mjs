import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

const required = [
  'scheduled idle prefetch must not cancel a pending foreground PDF search',
  'background prefetch cannot reject an active search or lose progress/session',
  'background prefetch cannot reject an active page',
  'search cancels a prefetch held before worker delivery',
  'cancel still rejects an active search',
  'dispose still rejects an active search'
].map(name => ({name}));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
  'tests/reader/pdf-search/test_pdf_prefetch_schedule.mjs',
  'tests/reader/pdf-search/test_prefetch_priority.mjs'], {encoding: 'utf8', timeout: 45000});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);
const lines = (result.stdout || '').split(/\r?\n/);
const summaries = ['1..6', '# tests 6', '# pass 6', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'];
if (result.status !== 0 || result.error || !hasPassingTapContracts(result.stdout || '', required) ||
    !summaries.every(line => lines.filter(item => item === line).length === 1) ||
    ['# tests ', '# pass ', '# fail ', '# cancelled ', '# skipped ', '# todo '].some(prefix =>
      lines.filter(line => line.startsWith(prefix)).length !== 1) ||
    lines.filter(line => /^1\.\.\d+/.test(line)).length !== 1) {
  console.error('PDF prefetch requires six passing named contracts and complete TAP summary');
  process.exitCode = 1;
}
