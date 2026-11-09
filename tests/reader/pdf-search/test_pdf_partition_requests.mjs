import assert from 'node:assert/strict';import {test} from 'node:test';import {createPdfPartitionRequests} from '../../../static/reader/search/reader-pdf-partition-requests.mjs';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('idle wait resolves and stale request is not started',async()=>{
 const pool=createPdfPartitionRequests();await pool.wait();let called=false;
 await assert.rejects(pool.run(()=>false,null,async()=>{called=true}),{name:'AbortError'});assert.equal(called,false);
});
test('waiters drain only after all owned requests settle',async()=>{
 const pool=createPdfPartitionRequests(),owners=new Set();let resolveA,resolveB,signalA,signalB;
 const a=pool.run(()=>true,owners,signal=>{signalA=signal;return new Promise(resolve=>resolveA=resolve)});
 const b=pool.run(()=>true,owners,signal=>{signalB=signal;return new Promise(resolve=>resolveB=resolve)});
 assert.equal(owners.size,2);let drained=false;const done=pool.wait().then(()=>drained=true);
 resolveA('a');assert.equal(await a,'a');await turn();assert.equal(drained,false);assert.equal(owners.size,1);assert.equal(signalA.aborted,true);assert.equal(signalB.aborted,false);
 resolveB('b');assert.equal(await b,'b');await done;assert.equal(drained,true);assert.equal(owners.size,0);assert.equal(signalB.aborted,true);await pool.wait();
});
test('abort cancels all active signals but does not preempt actual settlement',async()=>{
 const pool=createPdfPartitionRequests(),owners=new Set();let signal,release;
 const p=pool.run(()=>true,owners,s=>{signal=s;return new Promise(resolve=>release=resolve)});
 let drained=false;const done=pool.wait().then(()=>drained=true);
 try {pool.abort();assert.equal(signal.aborted,true);await turn();assert.equal(drained,false);}
 finally {release(42);}
 assert.equal(await p,42);await done;assert.equal(owners.size,0);
});
test('failure propagates and ownership drains even when action rejects',async()=>{
 const pool=createPdfPartitionRequests(),owners=new Set();let signal;
 const p=pool.run(()=>true,owners,async s=>{signal=s;throw new Error('network failed')});const drained=pool.wait();
 await assert.rejects(p,/network failed/);await drained;assert.equal(signal.aborted,true);assert.equal(owners.size,0);
});
test('the deadline aborts only its own request',async()=>{
 const real=globalThis.setTimeout;let deadline,release,signal;
 globalThis.setTimeout=(fn,ms,...args)=>{if(ms===120000)deadline=fn;return real(fn,ms,...args)};
 try{const pool=createPdfPartitionRequests();const p=pool.run(()=>true,null,s=>{signal=s;return new Promise(resolve=>release=resolve)});assert.equal(typeof deadline,'function');deadline();assert.equal(signal.aborted,true);release('done');assert.equal(await p,'done');await pool.wait()}finally{globalThis.setTimeout=real}
});
