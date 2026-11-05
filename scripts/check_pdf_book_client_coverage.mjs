// Node 26/V8: the PDF book-search client under synthetic Worker contracts only.
import {spawnSync} from 'node:child_process';
import {hasPassingTapContracts} from './check_tap_contracts.mjs';

const minimum=[100,100,100];
const required=[
  'worker starts with module URL and forwards the unchanged configuration',
  'search progress and page requests preserve request and session identity',
  'a newer request rejects the previous one and ignores stale replies',
  'a page requested during progress uses the current partial session',
  'cancel before ready terminates the owner and retries with a fresh worker',
  'cancel after ready keeps the owner and clears the page session',
  'worker error rejects current and future requests until cancellation resets it',
  'worker result errors reject once without permanently marking the client failed',
  'dispose cancels the pending request, terminates the owner and rejects new work'
].map(name=>({name}));
const result=spawnSync(process.execPath,[
  '--test','--test-concurrency=1','--test-reporter=tap','--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/search/reader-pdf-book-search.mjs',
  ...minimum.map((value,index)=>`--test-coverage-${['lines','branches','functions'][index]}=${value}`),
  'tests/reader/pdf-search/test_pdf_book_client.mjs'
],{encoding:'utf8'});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
if(result.error)throw result.error;
const text=result.stdout||'',lines=text.split(/\r?\n/);
const rows=lines.flatMap(line=>{
  const match=/^\s*#\s*reader-pdf-book-search\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match?[match.slice(1).map(Number)]:[];
});
if(result.status!==0||rows.length!==1||rows[0].some((value,index)=>value<minimum[index])||
    !hasPassingTapContracts(text,required)||
    ['# start of coverage report','# end of coverage report'].some(marker=>lines.filter(line=>line===marker).length!==1)||
    lines.filter(line=>/^# duration_ms \d+(?:\.\d+)?$/.test(line)).length!==1||
    !['1..9','# tests 9','# pass 9','# fail 0','# cancelled 0'].every(summary=>lines.filter(line=>line===summary).length===1)||
    ['# tests ','# pass ','# fail ','# cancelled '].some(prefix=>lines.filter(line=>line.startsWith(prefix)).length!==1)){
  console.error('PDF book-search client requires named contracts and exactly one source row above each minimum');
  process.exitCode=1;
}
