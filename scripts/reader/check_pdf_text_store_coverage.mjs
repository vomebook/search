// Node 26/V8: synthetic IndexedDB contracts for the PDF text store only.
import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from '../check_tap_contracts.mjs';

// Branch coverage can vary slightly with Node/V8 and platform scheduling;
// this floor leaves a small margin from the measured local 95.16%.
const minimum=[100,94.50,89.19];
const required=[
  'keys are stable, identity-bound and reject invalid inputs',
  'writes, replacements and isolated keys survive reopen without leaking stats',
  'entry, age, time reversal and invalid arguments fail closed',
  'corrupt records fail closed and a bad ledger resets the shared budget',
  'corrupt replacement and eviction reset accounting before committing new data',
  'full replacement rolls back when damaged rows are absent from the index',
  'understated and overdrawn ledgers reset instead of drifting',
  'expired entries are pruned and old records free budget for new pages',
  'concurrent writes share the ledger and bound in-flight writes',
  'open failure and a late successful connection do not publish data',
  'aborted or unavailable storage returns promptly and never commits late'
].map(name=>({name}));
const result=spawnSync(process.execPath,[
  '--test','--test-concurrency=1','--test-reporter=tap','--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/pdf/reader-pdf-text-store.mjs',
  ...minimum.map((value,index)=>`--test-coverage-${['lines','branches','functions'][index]}=${value}`),
  'tests/reader/pdf-search/test_pdf_text_store.mjs'
],{encoding:'utf8'});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
if(result.error)throw result.error;
const text=result.stdout||'',lines=text.split(/\r?\n/);
const rows=lines.flatMap(line=>{
  const match=/^\s*#\s*reader-pdf-text-store\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match?[match.slice(1).map(Number)]:[];
});
if(result.status!==0||rows.length!==1||rows[0].some((value,index)=>value<minimum[index])||
    !hasPassingTapContracts(text,required)||
    ['# start of coverage report','# end of coverage report'].some(marker=>lines.filter(line=>line===marker).length!==1)||
    lines.filter(line=>/^# duration_ms \d+(?:\.\d+)?$/.test(line)).length!==1||
    !['1..11','# tests 11','# pass 11','# fail 0','# cancelled 0'].every(summary=>lines.filter(line=>line===summary).length===1)||
    ['# tests ','# pass ','# fail ','# cancelled '].some(prefix=>lines.filter(line=>line.startsWith(prefix)).length!==1)){
  console.error('PDF text-store coverage requires named contracts and exactly one source row above each minimum');
  process.exitCode=1;
}
