// V8 coverage of bounded PDF partition lookahead and cache admission only.
import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';
const minimum=[100,100,100];
const test='tests/reader/pdf-search/test_pdf_partition_policy.mjs';
const required=[
  'network lookahead respects data-saver, speed and compressed byte cap',
  'verified page cache is bounded by UTF-16 and serialized UTF-8 sizes',
  'serialization failures are cache misses and do not fail search'
].map(name=>({name}));
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',
  '--experimental-test-coverage','--test-coverage-include=**/static/reader/search/reader-pdf-partition-policy.mjs',
  ...minimum.map((value,index)=>`--test-coverage-${['lines','branches','functions'][index]}=${value}`),test],
  {encoding:'utf8',timeout:45000,killSignal:'SIGKILL'});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
if(result.error)throw result.error;
const text=result.stdout||'',lines=text.split(/\r?\n/);
const rows=lines.flatMap(line=>{
  const match=/^\s*#\s*reader-pdf-partition-policy\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match?[match.slice(1).map(Number)]:[];
});
const summaries=['1..3','# tests 3','# pass 3','# fail 0','# cancelled 0','# skipped 0','# todo 0'];
if(result.status!==0||lines[0]!=='TAP version 13'||rows.length!==1||rows[0].some((value,index)=>value<minimum[index])||
   !hasPassingTapContracts(text,required)||!summaries.every(value=>lines.filter(line=>line===value).length===1)||
   ['# tests ','# pass ','# fail ','# cancelled ','# skipped ','# todo '].some(prefix=>lines.filter(line=>line.startsWith(prefix)).length!==1)||
   lines.filter(line=>/^# duration_ms \d+(?:\.\d+)?$/.test(line)).length!==1||
   ['# start of coverage report','# end of coverage report'].some(marker=>lines.filter(line=>line===marker).length!==1)){
  console.error('PDF partition policy requires named contracts and one coverage row above each minimum');process.exitCode=1;
}
