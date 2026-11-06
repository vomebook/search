import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Worker as NodeWorker} from 'node:worker_threads';

import {createPdfBookSearch} from '../../../static/reader/search/reader-pdf-book-search.mjs';
const sha='a'.repeat(64), generation='c'.repeat(64), textGeneration='d'.repeat(64);
const base=`objects/aa/${sha}/bbbbbbbbbbbbbbbb/text/`;
const url=p=>`https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${base}${p}`;
const resources={}, partitions=[];
for (let page=1; page<=2; page++) {
  const u=url(`search-00000${page}-00000${page}.json.gz`);
  const bytes=gzipSync(JSON.stringify({version:1,kind:'pdf-search-text-partition',source_sha256:sha,generation,offset_unit:'unicode-codepoint',start:page,end:page,pages:[{page,text:'alpha '.repeat(60),text_generation:textGeneration}]}));
  resources[u]=bytes;
  partitions.push({start:page,end:page,url:u,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const configuration={url:url('book-text.json.gz'),bytes:1,sha256:'0'.repeat(64),pageCount:2,sourceSha:sha,generation,partitions};

async function fixture(fn, options={}) {
  const previous=globalThis.Worker, events=[], waiters=new Set();
  let instance, client;
  const record=e=>{events.push(e); for (const w of waiters) if(w.predicate(e)) {waiters.delete(w); clearTimeout(w.timer); w.resolve(e);}};
  const wait=predicate=>{
    const found=events.find(predicate);
    if(found) return Promise.resolve(found);
    return new Promise((resolve,reject)=>{const w={predicate,resolve,reject}; w.timer=setTimeout(()=>{waiters.delete(w); reject(new Error('handshake timeout; events: '+JSON.stringify(events)));},3000); waiters.add(w);});
  };
  globalThis.Worker=class {
    constructor(workerUrl) {
      instance=this;
      this.worker=new NodeWorker(new URL('./handshake-bootstrap.mjs',import.meta.url),{workerData:{workerUrl:workerUrl.href,resources,block:partitions[1].url,...options}});
      this.worker.on('message',m=>{record(m); if(m.wire) this.onmessage?.({data:m.wire});});
      this.worker.on('error',e=>{record({event:'error',error:String(e)}); this.onerror?.({preventDefault(){}});});
    }
    postMessage(m){this.worker.postMessage(m);}
    terminate(){return this.worker.terminate();}
  };
  try {
    client=createPdfBookSearch(configuration);
    await fn({client,wait,events,send:m=>instance.worker.postMessage(m)});
  } finally {
    if (instance) {
      instance.worker.postMessage({fixture:'release-prefetch'});
      instance.worker.postMessage({fixture:'release'});
    }
    client?.dispose();
    for(const w of waiters) {clearTimeout(w.timer); w.reject(new Error('fixture closed'));}
    if(instance) await instance.worker.terminate();
    globalThis.Worker=previous;
  }
}
const outcome=p=>new Promise(resolve=>{
  const timer=setTimeout(()=>resolve({error:new Error('request timeout')}),3000);
  p.then(value=>{clearTimeout(timer); resolve({value});},error=>{clearTimeout(timer); resolve({error});});
});
const aborted=o=>assert.equal(o.error?.name,'AbortError',`expected AbortError, got ${JSON.stringify(o)}`);
const release=send=>send({fixture:'release'});

test('background prefetch cannot reject an active search or lose progress/session', {timeout:10000}, async()=>fixture(async({client,wait,send})=>{
  const progress=[];
  const search=outcome(client.search('alpha',p=>progress.push(p)));
  await wait(e=>e.event==='fetch' && e.url===partitions[1].url);
  assert.equal(progress.length,1);
  const prefetch=outcome(client.prefetch());
  release(send);
  const result=await search;
  assert.ifError(result.error); // Old client rejects the pending search here.
  aborted(await prefetch);
  assert.equal(result.value.total,120);
  assert.equal(result.value.session,progress[0].session);
  assert.equal(structuredClone(result.value).session,result.value.session);
  const page=await outcome(client.page(0)); assert.ifError(page.error);
  assert.equal(page.value.session,result.value.session);
}));

test('background prefetch cannot reject an active page', {timeout:10000}, async()=>fixture(async({client,wait,send,events})=>{
  const search=outcome(client.search('alpha'));
  await wait(e=>e.event==='fetch' && e.url===partitions[1].url); release(send);
  const completed=await search; assert.ifError(completed.error);
  const result=completed.value;
  const page=outcome(client.page(50));
  await wait(e=>e.event==='fetch' && e.url===partitions[1].url && events.filter(x=>x.event==='fetch' && x.url===partitions[1].url).length>=2);
  const prefetch=outcome(client.prefetch()); release(send);
  const got=await page;
  assert.ifError(got.error);
  aborted(await prefetch);
  assert.equal(got.value.session,result.session); assert.equal(got.value.offset,50);
  assert.equal(structuredClone(got.value).results.length,50);
}));

test('search cancels a prefetch held before worker delivery', {timeout:10000}, async()=>fixture(async({client,wait,send})=>{
  const prefetch=outcome(client.prefetch());
  await wait(e=>e.event==='prefetch-held');
  const search=outcome(client.search('alpha'));
  aborted(await prefetch);
  await wait(e=>e.event==='fetch' && e.url===partitions[1].url);
  send({fixture:'release-prefetch'}); release(send);
  const result=await search; assert.ifError(result.error);
  assert.equal(result.value.total,120);
  assert.equal(structuredClone(result.value).session,result.value.session);
}, {holdPrefetch:true}));

for (const action of ['cancel','dispose']) test(`${action} still rejects an active search`, {timeout:10000}, async()=>fixture(async({client,wait})=>{
  const search=outcome(client.search('alpha'));
  await wait(e=>e.event==='fetch' && e.url===partitions[1].url);
  client[action](); aborted(await search);
  if(action==='dispose') aborted(await outcome(client.search('alpha')));
}));
