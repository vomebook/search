import {spawnSync} from 'node:child_process';
import {hasCompleteFlatTapReport, hasPassingTapContracts} from '../check_tap_contracts.mjs';

const required = [
  'missing OCR manifest reports no concentrated text',
  'missing OCR source rejects before constructing a search client',
  'scheduled idle prefetch must not cancel a pending foreground PDF search',
  'background prefetch cannot reject an active search or lose progress/session',
  'background prefetch cannot reject an active page',
  'search cancels a prefetch held before worker delivery',
  'cancel still rejects an active search',
  'dispose still rejects an active search'
].map(name => ({name}));
// Run the tests in the spawned process so a timeout cannot orphan a test-runner worker.
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-concurrency=1', '--test-reporter=tap',
  'tests/reader/pdf-search/test_pdf_prefetch_schedule.mjs',
  'tests/reader/pdf-search/test_prefetch_priority.mjs'], {encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);
const text = result.stdout || '';
if (result.status !== 0 || result.error || !hasPassingTapContracts(text, required) || !hasCompleteFlatTapReport(text)) {
  console.error('PDF prefetch requires eight passing named contracts and complete TAP summary');
  process.exitCode = 1;
}
