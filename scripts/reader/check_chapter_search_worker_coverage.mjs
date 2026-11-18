// V8 coverage for chapter-search Worker protocol and loader, not complete Reader coverage.
import {spawnSync} from 'node:child_process';
import {hasCompleteFlatTapReport, hasPassingTapContracts} from '../check_tap_contracts.mjs';
const minimum = [100, 92, 100];
const test = 'tests/reader/chapter-search/test_reader_chapter_worker.mjs';
const marker = 'chapter Worker: transport, integrity, cancellation, retry and paging passed';
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
  '--experimental-test-coverage', '--test-coverage-include=**/static/reader/search/workers/reader-chapter-search-worker.mjs',
  ...minimum.map((value,index)=>`--test-coverage-${['lines','branches','functions'][index]}=${value}`),test], {encoding:'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text=result.stdout||'', lines=text.split(/\r?\n/);
const rows=lines.flatMap(line=>{
  const match=/^\s*#\s*reader-chapter-search-worker\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match?[match.slice(1).map(Number)]:[];
});
if(result.status!==0 || !hasPassingTapContracts(text,[{name:test,marker}]) || rows.length!==1 ||
    rows[0].some((value,index)=>value<minimum[index]) ||
    !hasCompleteFlatTapReport(text) ||
    ['# start of coverage report','# end of coverage report'].some(value=>lines.filter(line=>line===value).length!==1)) {
  console.error('Chapter search Worker requires its passing contract and exactly one source row above each minimum');
  process.exitCode=1;
}
