// V8 coverage for the chapter-search URL/proxy boundary only.
import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';
const minimum = [100, 100, 100];
const test = 'tests/reader/chapter-search/test_reader_chapter_search.mjs';
const marker = 'chapter search: complete counts, paging, literal matches, Unicode boundaries, cancellation and index identity passed';
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
  '--experimental-test-coverage', '--test-coverage-include=**/static/reader/search/reader-chapter-search-proxy-url.mjs',
  ...minimum.map((value,index)=>`--test-coverage-${['lines','branches','functions'][index]}=${value}`),test], {encoding:'utf8'});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text=result.stdout||'', lines=text.split(/\r?\n/);
const rows=lines.flatMap(line=>{
  const match=/^\s*#\s*reader-chapter-search-proxy-url\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match?[match.slice(1).map(Number)]:[];
});
const summaries=['1..1','# tests 1','# pass 1','# fail 0','# cancelled 0','# skipped 0','# todo 0'];
if(result.status!==0 || !hasPassingTapContracts(text,[{name:test,marker}]) || rows.length!==1 ||
    rows[0].some((value,index)=>value<minimum[index]) ||
    !summaries.every(value=>lines.filter(line=>line===value).length===1) ||
    ['# tests ','# pass ','# fail ','# cancelled ','# skipped ','# todo '].some(prefix=>
      lines.filter(line=>line.startsWith(prefix)).length!==1) ||
    lines.filter(line=>/^# duration_ms \d+(?:\.\d+)?$/.test(line)).length!==1 ||
    ['# start of coverage report','# end of coverage report'].some(value=>lines.filter(line=>line===value).length!==1)) {
  console.error('Chapter search proxy requires its passing contract and exactly one source row above each minimum');
  process.exitCode=1;
}
