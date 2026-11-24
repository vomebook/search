// Node 26/V8: only this text-format source under synthetic host/DOM contracts.
import {spawnSync} from 'node:child_process';
import {hasCompleteFlatTapReport, hasPassingTapContracts} from '../check_tap_contracts.mjs';

const minimum = [100, 91.89, 90.91];
const required = [
  'large TXT keeps streaming and builds exact chapter anchors across packet and storage boundaries',
  'large TXT outline caps entries without clipping the body',
  'TXT layout retains raw text across streaming chunks, including hidden whitespace and chapters',
  'TXT layout leaves ordinary indents and one or two blank lines alone, and caps decoration',
  'encoding detection handles BOMs, valid UTF-8, UTF-16 heuristics and legacy hints',
  'plain fallback preserves Unicode replacement characters and enforces actual byte limit',
  'stream handles split UTF-8 BOM and codepoints and releases its resource',
  'stream rejects an oversized body and cancels its reader',
  'TXT entry streams the prepared response and completes only after EOF',
  'TXT entry retries a non-OK response once and leaves failed reads unfinished',
  'split UTF-16 prefix clears an early ASCII preview before publishing final text',
  'block boundaries preserve surrogate pairs and CRLF without creating oversized blocks',
  'resource cleanup cancels an outstanding stream and always releases ownership',
  'large samples select the decoder before EOF and retain all streamed text',
  'Chinese UTF-8 preview is bounded and keeps authoritative stream text exact',
  'long text yields to the host before completing subsequent blocks',
  'host abort while yielding stops future blocks without swallowing the error',
  'reader errors preserve the original reason and release the reader lock',
  'decoder detection preserves observable indexed getter order',
  'buffered header limit fails before accessing the response body'
].map(name=>({name}));
const result=spawnSync(process.execPath,[
  '--test','--test-concurrency=1','--test-reporter=tap','--experimental-test-coverage',
  '--test-coverage-include=**/static/reader/formats/reader-text-format.mjs',
  ...minimum.map((value,index)=>`--test-coverage-${['lines','branches','functions'][index]}=${value}`),
  'tests/reader/text/test_reader_text_baseline.mjs','tests/reader/text/test_reader_text_faults.mjs'
],{encoding:'utf8'});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
if(result.error)throw result.error;
const text=result.stdout||'',lines=text.split(/\r?\n/);
const rows=lines.flatMap(line=>{
  const match=/^\s*#\s*reader-text-format\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match?[match.slice(1).map(Number)]:[];
});
if(result.status!==0||rows.length!==1||rows[0].some((value,index)=>value<minimum[index])||
    !hasPassingTapContracts(text,required)||
    ['# start of coverage report','# end of coverage report'].some(marker=>lines.filter(line=>line===marker).length!==1)||
    !hasCompleteFlatTapReport(text)){
  console.error('Reader text requires named contracts and exactly one source row above each minimum');
  process.exitCode=1;
}
