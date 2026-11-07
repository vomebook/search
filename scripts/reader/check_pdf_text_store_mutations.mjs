// Targeted cache safety mutants. The temporary fixture never edits production.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const source=readFileSync('static/reader/pdf/reader-pdf-text-store.mjs','utf8');
let contracts=readFileSync('tests/reader/pdf-search/test_pdf_text_store.mjs','utf8');
// Add assertion labels only in the temporary fixture; retain every original assertion.
for (const [before,after] of [
  ["assert.notEqual(await pdfTextStoreKey(other),a)","assert.notEqual(await pdfTextStoreKey(other),a,'key must bind every identity field')"],
  ["assert.equal(await store.get(1),null);\n    }", "assert.equal(await store.get(1),null,'corrupt page must be rejected');\n    }"],
  ["assert.equal(await store.get(1),null);assert.equal(await store.get(2),'new');", "assert.equal(await store.get(1),null,'corrupt ledger must purge old page');assert.equal(await store.get(2),'new');"],
  ["assert.deepEqual(values,[true,true,false,true])", "assert.deepEqual(values,[true,true,false,true],'in-flight writes must be bounded')"]
]) {
  if(contracts.split(before).length!==2) throw new Error('expected exactly one fixture assertion');
  contracts=contracts.replace(before,after);
}

const probes=[
  {name:'sync throw does not abort',before:'catch (_) { fail(); }\n        }).catch(reject);',
    after:'catch (_) {}\n        }).catch(reject);',diagnostic:'sync abort must precede settlement',test:'synchronous work throw aborts queued write before promise settles'},
  {name:'transaction error handler removed',before:'tx.onerror = event => { failed = true; if (event.defaultPrevented) fail(); };',
    after:'tx.onerror = () => {};',diagnostic:'synthetic transaction error must fail',test:'synthetic transaction error completes before settlement'},
  {name:'prevented error does not abort',before:'tx.onerror = event => { failed = true; if (event.defaultPrevented) fail(); };',
    after:'tx.onerror = event => { failed = true; };',diagnostic:'prevented error must abort before settlement',test:'synthetic transaction error aborts before settlement'},
  {name:'transaction error resolves early',before:'tx.onerror = event => { failed = true; if (event.defaultPrevented) fail(); };',
    after:'tx.onerror = event => { resolve(null); };',diagnostic:'default abort must precede settlement',test:'duplicate add defaults to abort before promise settles'},
  {name:'cache key omits version',before:'["pdf-search-han-space-v1",source,version,pageCount,engine]',
    after:'["pdf-search-han-space-v1",source,pageCount,engine]',diagnostic:'key must bind every identity field',test:'keys are stable, identity-bound and reject invalid inputs'},
  {name:'page identity not checked',before:'entry.key === key && entry.page === page &&',
    after:'entry.key === key && true &&',diagnostic:'corrupt page must be rejected',test:'corrupt records fail closed and a bad ledger resets the shared budget'},
  {name:'expired page accepted',before:'now()-entry.savedAt < limits.ttl',
    after:'true',diagnostic:'TTL is exclusive at the boundary',test:'entry, age, time reversal and invalid arguments fail closed'},
  {name:'future page accepted',before:'entry.savedAt <= now() &&',
    after:'true &&',diagnostic:'future savedAt is not accepted',test:'entry, age, time reversal and invalid arguments fail closed'},
  {name:'corrupt ledger retained',before:'!ledger || !Number.isSafeInteger(ledger.bytes) || !Number.isSafeInteger(ledger.count) || ledger.bytes < 0 || ledger.count < 0',
    after:'!ledger',diagnostic:'corrupt ledger must purge old page',test:'corrupt records fail closed and a bad ledger resets the shared budget'},
  {name:'in-flight limit removed',before:'writes >= 2 || pendingBytes+bytes > 1024*1024',
    after:'false',diagnostic:'in-flight writes must be bounded',test:'concurrent writes share the ledger and bound in-flight writes'},
  {name:'stored byte count not validated',before:'entry.bytes === cost(entry.id,entry.text) &&',
    after:'true &&',diagnostic:'corrupt page must be rejected',test:'corrupt records fail closed and a bad ledger resets the shared budget'},
  {name:'corrupt replacement accounting',before:'if (!validStoredCost(previous.result) || previous.result.bytes > ledger.bytes || ledger.count < 1) return reset();',
    after:'if (false) return reset();',diagnostic:'replacement must purge untrusted accounting',test:'corrupt replacement and eviction reset accounting before committing new data'},
  {name:'full replacement commits deletion',before:'if (!full()) commit(); else tx.abort();',
    after:'if (!full()) commit();',diagnostic:'failed replacement must preserve original page',test:'full replacement rolls back when damaged rows are absent from the index'},
  {name:'corrupt eviction accounting',before:'if (!validStoredCost(row.value) || row.value.bytes > ledger.bytes || ledger.count < 1) return reset();',
    after:'if (false) return reset();',diagnostic:'eviction must purge untrusted accounting',test:'corrupt replacement and eviction reset accounting before committing new data'}
];
function validTap(text,target,passing,diagnostic){
  const lines=(text||'').replace(/\r\n/g,'\n').split('\n');
  const results=lines.filter(line=>/^(?:not )?ok \d+ - /.test(line));
  const active=results.filter(line=>!/# SKIP(?: |$)/.test(line));
  const skipped=results.length-active.length;
  const summary={tests:results.length,pass:passing?1:0,fail:passing?0:1,skipped,cancelled:0,todo:0,suites:0};
  const start=lines.indexOf(`not ok 1 - ${target}`);
  const end=lines.findIndex((line,i)=>i>start && (/^# Subtest: /.test(line)||/^1\.\.\d+$/.test(line)));
  const failure=lines.slice(start,end<0?undefined:end).join('\n');
  return lines[0]==='TAP version 13' && active.length===1 && active[0]===`${passing?'ok':'not ok'} 1 - ${target}` &&
    lines.filter(line=>line===`# Subtest: ${target}`).length===1 &&
    lines.filter(line=>/^# Subtest: /.test(line)).length===results.length &&
    lines.filter(line=>/^1\.\.\d+$/.test(line)).length===1 && lines.includes(`1..${results.length}`) &&
    Object.entries(summary).every(([k,v])=>lines.filter(line=>line.startsWith(`# ${k} `)).length===1 && lines.includes(`# ${k} ${v}`)) &&
    (passing || ((failure.includes(`  error: '${diagnostic}'`) || failure.includes(`  error: |-\n    ${diagnostic}\n`)) && /^  code: 'ERR_ASSERTION'$/m.test(failure) && /^  name: 'AssertionError'$/m.test(failure)));
}
const originalImport='../../../static/reader/pdf/reader-pdf-text-store.mjs';
let killed=0,survived=0,errors=0;
const mutants=new Set();
for(const probe of probes){
  const pieces=source.split(probe.before);
  if(pieces.length!==2){errors++;console.error(`${probe.name}: expected exactly one target`);continue;}
  const mutant=pieces.join(probe.after);
  if(mutant===source || mutants.has(mutant)){errors++;console.error(`${probe.name}: unchanged or duplicate mutant`);continue;}
  mutants.add(mutant);
  const temp=mkdtempSync(join(tmpdir(),'pdf-text-store-mutant-'));
  try{
    symlinkSync(resolve('node_modules'),join(temp,'node_modules'),'dir');
    const target=join(temp,'reader-pdf-text-store.mjs');
    if(contracts.split(originalImport).length!==2)throw new Error('expected exactly one text-store import');
    writeFileSync(join(temp,'test.mjs'),contracts.replace(originalImport,'./reader-pdf-text-store.mjs'));
    // Node's in-process runner can swallow module evaluation errors; report
    // them outside TAP so they cannot masquerade as a valid mutant kill.
    const runner=join(temp,'runner.mjs');
    writeFileSync(runner, "try { await import('./test.mjs'); } catch (error) { console.error('fixture import failure', error); process.exitCode = 1; }\n");
    // Run the fixture in the directly spawned process so the timeout cannot orphan
    // a test-runner worker. SIGKILL also handles a blocked event loop or handler.
    const args=['--test','--test-isolation=none','--test-reporter=tap',`--test-name-pattern=^${probe.test.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,runner];
    const run=()=>spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000,killSignal:'SIGKILL'});
    {
      writeFileSync(target,source);
      const baseline=run();
      if(baseline.error||baseline.signal||baseline.stderr||baseline.status!==0||!validTap(baseline.stdout,probe.test,true)){
        errors++;console.error(`${probe.name}: baseline failed`);break;
      }
    }
    writeFileSync(target,mutant);
    const result=run();
    if(result.error||result.signal||result.stderr||result.status===null){errors++;console.error(`${probe.name}: timed out or failed to execute`);break;}
    if(result.status===0){
      if(!validTap(result.stdout,probe.test,true)){errors++;console.error(`${probe.name}: unexpected passing output`);continue;}
      survived++;console.error(`${probe.name} mutant survived`);continue;
    }
    if(!validTap(result.stdout,probe.test,false,probe.diagnostic)){errors++;console.error(`${probe.name}: unexpected failure\n${result.stdout||''}`);continue;}
    killed++;
  } finally {rmSync(temp,{recursive:true,force:true});}
}
console.log(JSON.stringify({scope:'targeted PDF text-store safety mutations',total:probes.length,killed,survived,errors}));
if(killed!==probes.length||survived||errors)process.exitCode=1;
