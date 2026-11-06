// Targeted cache safety mutants. The temporary fixture never edits production.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const source=readFileSync('static/reader/pdf/reader-pdf-text-store.mjs','utf8');
const contracts=readFileSync('tests/reader/pdf-search/test_pdf_text_store.mjs','utf8');
const probes=[
  {name:'cache key omits version',before:'["pdf-search-han-space-v1",source,version,pageCount,engine]',
    after:'["pdf-search-han-space-v1",source,pageCount,engine]',diagnostic:'Expected "actual" to be strictly unequal'},
  {name:'page identity not checked',before:'entry.key === key && entry.page === page &&',
    after:'entry.key === key && true &&',diagnostic:'null'},
  {name:'expired page accepted',before:'now()-entry.savedAt < limits.ttl',
    after:'true',diagnostic:'TTL is exclusive at the boundary'},
  {name:'future page accepted',before:'entry.savedAt <= now() &&',
    after:'true &&',diagnostic:'future savedAt is not accepted'},
  {name:'corrupt ledger retained',before:'!ledger || !Number.isSafeInteger(ledger.bytes) || !Number.isSafeInteger(ledger.count) || ledger.bytes < 0 || ledger.count < 0',
    after:'!ledger',diagnostic:'null'},
  {name:'in-flight limit removed',before:'writes >= 2 || pendingBytes+bytes > 1024*1024',
    after:'false',diagnostic:'Expected values to be strictly deep-equal'},
  {name:'stored byte count not validated',before:'entry.bytes === cost(entry.id,entry.text) &&',
    after:'true &&',diagnostic:'null'}
];
const originalImport='../../../static/reader/pdf/reader-pdf-text-store.mjs';
let killed=0,survived=0,errors=0;
for(const probe of probes){
  const pieces=source.split(probe.before);
  if(pieces.length!==2){errors++;console.error(`${probe.name}: expected exactly one target`);continue;}
  const temp=mkdtempSync(join(tmpdir(),'pdf-text-store-mutant-'));
  try{
    symlinkSync(resolve('node_modules'),join(temp,'node_modules'),'dir');
    writeFileSync(join(temp,'reader-pdf-text-store.mjs'),pieces.join(probe.after));
    if(contracts.split(originalImport).length!==2)throw new Error('expected exactly one text-store import');
    writeFileSync(join(temp,'test.mjs'),contracts.replace(originalImport,'./reader-pdf-text-store.mjs'));
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap',join(temp,'test.mjs')],
      {encoding:'utf8',timeout:15000});
    if(result.error||result.signal||result.status===null){errors++;console.error(`${probe.name}: timed out or failed to execute`);continue;}
    if(result.status===0){survived++;console.error(`${probe.name} mutant survived`);continue;}
    if(!(result.stdout||'').includes(probe.diagnostic)){errors++;console.error(`${probe.name}: unexpected failure`);continue;}
    killed++;
  } finally {rmSync(temp,{recursive:true,force:true});}
}
console.log(JSON.stringify({scope:'targeted PDF text-store safety mutations',total:probes.length,killed,survived,errors}));
if(killed!==probes.length||survived||errors)process.exitCode=1;
