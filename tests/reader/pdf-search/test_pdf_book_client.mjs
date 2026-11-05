// Synthetic Worker contracts. The real client module is loaded unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createPdfBookSearch} from '../../../static/reader/search/reader-pdf-book-search.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
  const previous=globalThis.Worker, workers=[];
  globalThis.Worker=class {
    constructor(url,options) {this.url=url;this.options=options;this.messages=[];this.terminated=0;workers.push(this);}
    postMessage(message) {this.messages.push(message);}
    terminate() {this.terminated++;}
    send(data) {this.onmessage({data});}
    error() {let prevented=0;this.onerror({preventDefault(){prevented++;}});return prevented;}
  };
  const configuration={fixture:'synthetic OCR index'},client=createPdfBookSearch(configuration);
  return {client,configuration,workers,restore(){client.dispose();globalThis.Worker=previous;}};
}

test('worker starts with module URL and forwards the unchanged configuration',()=>{
  const f=fixture();try {
    const worker=f.workers[0];
    assert.equal(f.workers.length,1);assert.equal(worker.options.type,'module');
    assert.match(worker.url.href,/\/workers\/reader-pdf-book-search-worker\.mjs$/);
    assert.deepEqual(worker.messages,[{type:'init',configuration:f.configuration}]);
    assert.strictEqual(worker.messages[0].configuration,f.configuration);assert.equal(f.client.failed,false);
  } finally {f.restore();}
});

test('search progress and page requests preserve request and session identity',async()=>{
  const f=fixture();try {
    const w=f.workers[0], progress=[],search=f.client.search('query',value=>progress.push(value));
    const first=w.messages.at(-1);assert.deepEqual(first,{type:'search',id:1,query:'query'});
    const update={id:first.id,progress:true,session:first.id,total:1,offset:0,pageSize:50,results:['hit'],scanned:2,pages:3};w.send(update);
    assert.deepEqual(progress,[update]);assert.strictEqual(progress[0],update);
    w.send({id:first.id,session:first.id,total:1,offset:0,pageSize:50,results:['hit']});
    assert.deepEqual(await search,{id:first.id,session:first.id,total:1,offset:0,pageSize:50,results:['hit']});
    const next=f.client.page(51), request=w.messages.at(-1);
    assert.deepEqual(request,{type:'page',id:2,offset:51,session:first.id});
    w.send({id:request.id,session:first.id,total:1,offset:50,pageSize:50,results:['page']});
    assert.deepEqual((await next).results,['page']);
  } finally {f.restore();}
});

test('a newer request rejects the previous one and ignores stale replies',async()=>{
  const f=fixture();try {
    const w=f.workers[0],first=f.client.prefetch();let outcome;
    first.then(()=>{outcome='resolved';},error=>{outcome=error;});
    const firstId=w.messages.at(-1).id,second=f.client.search('new');
    await tick();assert.equal(outcome?.name,'AbortError');
    const secondId=w.messages.at(-1).id;assert.equal(secondId,firstId+1);
    let settled=false;second.finally(()=>{settled=true;});
    w.send({id:firstId,total:99,session:'stale'});await Promise.resolve();assert.equal(settled,false);
    w.send({id:secondId,total:2,session:'current'});assert.equal((await second).total,2);
  } finally {f.restore();}
});

test('a page requested during progress uses the current partial session',async()=>{
  const f=fixture();try {
    const w=f.workers[0],first=f.client.search('query');let outcome;
    first.then(()=>{outcome='resolved';},error=>{outcome=error;});
    const id=w.messages.at(-1).id;w.send({id,progress:true,session:id,total:3,offset:0,pageSize:50,results:[],scanned:1,pages:2});
    const next=f.client.page(50),request=w.messages.at(-1);
    assert.deepEqual(request,{type:'page',id:id+1,offset:50,session:id});
    await tick();assert.equal(outcome?.name,'AbortError');
    w.send({id:request.id,session:id,total:3,offset:50,pageSize:50,results:['partial']});
    assert.deepEqual((await next).results,['partial']);
  } finally {f.restore();}
});

test('cancel before ready terminates the owner and retries with a fresh worker',async()=>{
  const f=fixture();try {
    const old=f.workers[0],first=f.client.search('first'),rejected=assert.rejects(first,{name:'AbortError'});
    f.client.cancel();await rejected;assert.equal(old.terminated,1);
    const second=f.client.search('retry'),current=f.workers[1],request=current.messages.at(-1);
    assert.notStrictEqual(old,current);assert.equal(current.messages[0].type,'init');
    old.send({bookReady:true});old.send({id:request.id,total:999});
    current.send({bookReady:true});current.send({id:request.id,session:request.id,total:1,offset:0,pageSize:50,results:[]});
    assert.equal((await second).total,1);assert.equal(f.client.failed,false);
  } finally {f.restore();}
});

test('cancel after ready keeps the owner and clears the page session',async()=>{
  const f=fixture();try {
    const w=f.workers[0];w.send({bookReady:true});
    const first=f.client.search('ready'),request=w.messages.at(-1);
    w.send({id:request.id,session:request.id,total:0,offset:0,pageSize:50,results:[]});await first;
    f.client.cancel();assert.equal(w.terminated,0);assert.deepEqual(w.messages.at(-1),{type:'cancel'});
    const next=f.client.page(5),page=w.messages.at(-1);
    assert.deepEqual(page,{type:'page',id:2,offset:5,session:null});
    w.send({id:page.id,session:page.id,total:0,offset:0,pageSize:50,results:[]});await next;
  } finally {f.restore();}
});

test('worker error rejects current and future requests until cancellation resets it',async()=>{
  const f=fixture();try {
    const w=f.workers[0],task=f.client.search('failing');
    let outcome;task.then(()=>{outcome='resolved';},error=>{outcome=error;});
    assert.equal(w.error(),1);await tick();assert.match(outcome?.message??'',/PDF 全文搜索组件加载失败/);
    assert.equal(f.client.failed,true);
    await assert.rejects(f.client.prefetch(),/PDF 全文搜索组件加载失败/);
    f.client.cancel();assert.equal(w.terminated,1);assert.equal(f.client.failed,false);
    const retry=f.client.prefetch(),fresh=f.workers[1],request=fresh.messages.at(-1);
    const existing={id:9,index:{fixture:true}};
    fresh.send({id:request.id,ready:true,session:existing});
    const result=await retry;assert.equal(result.ready,true);assert.strictEqual(result.session,existing);
    const next=f.client.page(0);assert.strictEqual(fresh.messages.at(-1).session,existing);
    fresh.send({id:fresh.messages.at(-1).id,error:'synthetic session mismatch'});
    await assert.rejects(next,/synthetic session mismatch/);
  } finally {f.restore();}
});

test('worker result errors reject once without permanently marking the client failed',async()=>{
  const f=fixture();try {
    const w=f.workers[0],first=f.client.search('bad'),request=w.messages.at(-1);
    const rejected=assert.rejects(first,/synthetic parse error/);
    w.send({id:request.id,error:'synthetic parse error'});await rejected;
    assert.equal(f.client.failed,false);
    const second=f.client.search('good'),next=w.messages.at(-1);
    w.send({id:next.id,total:0});await second;
  } finally {f.restore();}
});

test('dispose cancels the pending request, terminates the owner and rejects new work',async()=>{
  const f=fixture();try {
    const w=f.workers[0],task=f.client.prefetch(),rejected=assert.rejects(task,{name:'AbortError'});
    f.client.dispose();await rejected;assert.equal(w.terminated,1);
    w.send({bookReady:true});assert.equal(w.error(),0);
    let outcome;f.client.search('closed').then(()=>{outcome='resolved';},error=>{outcome=error;});
    await tick();assert.equal(outcome?.name,'AbortError');
    assert.equal(f.workers.length,1);
  } finally {f.restore();}
});
