import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IDBFactory, IDBDatabase, IDBTransaction, IDBObjectStore} from 'fake-indexeddb';
import {createPdfTextStore, pdfTextStoreKey} from '../../../static/reader/pdf/reader-pdf-text-store.mjs';

const key='a'.repeat(64), keyB='b'.repeat(64);
const limits={bytes:900,entries:3,entryBytes:600,ttl:1000};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const nativeIndexedDB=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
const useFactory=()=>Object.defineProperty(globalThis,'indexedDB',{configurable:true,writable:true,value:new IDBFactory()});
const restoreFactory=()=>nativeIndexedDB ? Object.defineProperty(globalThis,'indexedDB',nativeIndexedDB) : delete globalThis.indexedDB;
const openDatabase=()=>new Promise((resolve,reject)=>{
  const request=globalThis.indexedDB.open('voiceofml-pdf-search-text',1);
  request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);
});
const requestValue=request=>new Promise((resolve,reject)=>{
  request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);
});
const transactionDone=tx=>new Promise((resolve,reject)=>{
  tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
});
const seed=async (storeName,value)=>{
  const db=await openDatabase();
  try {const tx=db.transaction([storeName],'readwrite');const done=transactionDone(tx);tx.objectStore(storeName).put(value);await done;}
  finally {db.close();}
};

test('synchronous work throw aborts queued write before promise settles',async()=>{
  useFactory();let store;
  const original=IDBTransaction.prototype.objectStore, events=[];
  try {
    store=createPdfTextStore(key,{limits});
    IDBTransaction.prototype.objectStore=function(name){
      if (this.mode==='readwrite' && name==='budget') {
        const pages=original.call(this,'pages');
        pages.put({id:'queued'});
        this.addEventListener('abort',()=>events.push('abort'));
        throw new Error('synchronous work failure');
      }
      return original.call(this,name);
    };
    const result=store.put(1,'x').then(value=>{events.push('settled');return value;});
    assert.equal(await result,false);
    assert.deepEqual(events,['abort','settled'],'sync abort must precede settlement');
    IDBTransaction.prototype.objectStore=original;
    const db=await openDatabase();
    try {assert.equal(await requestValue(db.transaction('pages').objectStore('pages').get('queued')),undefined,'queued write must roll back');}
    finally {db.close();}
  } finally {IDBTransaction.prototype.objectStore=original;store?.dispose();restoreFactory();}
});

test('duplicate add defaults to abort before promise settles',async()=>{
  useFactory();let store;
  const original=IDBDatabase.prototype.transaction, events=[];
  try {
    store=createPdfTextStore(key,{limits});
    assert.equal(await store.put(1,'original'),true);
    IDBDatabase.prototype.transaction=function(names,mode,...rest){
      const tx=original.call(this,names,mode,...rest);
      if (mode==='readwrite') {
        const pages=tx.objectStore('pages');
        const duplicate=pages.add({id:key+':1'});
        duplicate.addEventListener('error',event=>{
          events.push('request error');
          assert.equal(event.defaultPrevented,false); // fake-indexeddb 6.2.7 does not reflect preventDefault here.
        });
        tx.addEventListener('error',event=>{if (event.target===duplicate) events.push('transaction error');});
        tx.addEventListener('abort',()=>events.push('abort'));
      }
      return tx;
    };
    const result=store.put(2,'new').then(value=>{events.push('settled');return value;});
    assert.equal(await result,false);
    assert.deepEqual(events,['request error','transaction error','abort','settled'],'default abort must precede settlement');
    IDBDatabase.prototype.transaction=original;
    assert.equal(await store.get(1),'original');assert.equal(await store.get(2),null);
  } finally {IDBDatabase.prototype.transaction=original;store?.dispose();restoreFactory();}
});

for (const prevented of [false,true]) test(`synthetic transaction error ${prevented ? 'aborts' : 'completes'} before settlement`,async()=>{
  useFactory();let store, hits=0;
  const original=IDBDatabase.prototype.transaction, events=[];
  try {
    store=createPdfTextStore(key,{limits});
    IDBDatabase.prototype.transaction=function(names,mode,...rest){
      const tx=original.call(this,names,mode,...rest);
      if (mode==='readwrite') {
        hits++;
        const pages=tx.objectStore('pages');
        pages.put({id:'queued'});
        const trigger=pages.get('queued');
        trigger.addEventListener('success',()=>{
          events.push('error');
          tx.onerror({defaultPrevented:prevented}); // Synthetic branch probe, not native event propagation.
        });
        tx.addEventListener('abort',()=>events.push('abort'));
        tx.addEventListener('complete',()=>events.push('complete'));
      }
      return tx;
    };
    const result=store.put(1,'x').then(value=>{events.push('settled');return value;});
    assert.equal(await result,false,'synthetic transaction error must fail');
    assert.equal(hits,1,'transaction hook must run once');
    assert.deepEqual(events,prevented ? ['error','abort','settled'] : ['error','complete','settled'],
      prevented ? 'prevented error must abort before settlement' : 'unprevented error must complete before settlement');
    IDBDatabase.prototype.transaction=original;
    if (prevented) {
      const db=await openDatabase();
      try {assert.equal(await requestValue(db.transaction('pages').objectStore('pages').get('queued')),undefined,'prevented abort must roll back');}
      finally {db.close();}
    }
  } finally {IDBDatabase.prototype.transaction=original;store?.dispose();restoreFactory();}
});

test('keys are stable, identity-bound and reject invalid inputs',async()=>{
  const data={source:'https://example.test/book.pdf',version:'"A"',pageCount:12,engine:'engine1'};
  const a=await pdfTextStoreKey(data);
  assert.match(a,/^[0-9a-f]{64}$/);assert.equal(await pdfTextStoreKey(data),a);
  for (const other of [{...data,source:'https://example.test/other.pdf'},{...data,version:'"B"'},
    {...data,pageCount:13},{...data,engine:'engine2'}]) assert.notEqual(await pdfTextStoreKey(other),a,'key must bind every identity field');
  for (const bad of [{...data,source:''},{...data,version:''},{...data,pageCount:0},
    {...data,pageCount:1.2},{...data,pageCount:Number.MAX_SAFE_INTEGER+1}]) assert.equal(await pdfTextStoreKey(bad),null);
});

test('writes, replacements and isolated keys survive reopen without leaking stats',async()=>{
  useFactory();let store,other,reopened;
  try {
    store=createPdfTextStore(key,{limits});other=createPdfTextStore(keyB,{limits});
    assert.equal(await store.get(1),null);
    assert.equal(await store.put(1,'手机 🍀'),true);assert.equal(await store.get(1),'手机 🍀');
    assert.equal(await store.put(1,''),true);assert.equal(await store.get(1),'');
    assert.equal(await other.get(1),null);assert.equal(await other.put(1,'other'),true);
    assert.deepEqual(store.stats,{hits:2,misses:1,writes:2,skipped:0});
    const copy=store.stats;copy.hits=100;assert.equal(store.stats.hits,2);
    store.dispose();other.dispose();reopened=createPdfTextStore(key,{limits});
    assert.equal(await reopened.get(1),'');assert.equal(await reopened.get(0),null);
  } finally {store?.dispose();other?.dispose();reopened?.dispose();restoreFactory();}
});

test('entry, age, time reversal and invalid arguments fail closed',async()=>{
  useFactory();let clock=10000,store;
  try {
    store=createPdfTextStore(key,{limits,now:()=>clock});
    assert.equal(await store.put(1,'first'),true);assert.equal(await store.put(2,'second'),true);
    assert.equal(await store.put(3,'third'),true);assert.equal(await store.put(4,'fourth'),true);
    assert.equal(await store.get(1),null);assert.equal(await store.get(2),'second');
    assert.equal(await store.put(0,'x'),false);assert.equal(await store.put(2,'x'.repeat(400)),false);
    assert.equal(await store.put(2,null),false);assert.equal(await store.get(1.5),null);
    clock=9999;assert.equal(await store.get(2),null,'future savedAt is not accepted');
    clock=11000;assert.equal(await store.get(2),null,'TTL is exclusive at the boundary');
    assert.equal(store.stats.skipped,3);
    store.dispose();assert.equal(await store.put(2,'x'),false);assert.equal(await store.get(2),null);
  } finally {store?.dispose();restoreFactory();}
});

test('corrupt records fail closed and a bad ledger resets the shared budget',async()=>{
  useFactory();let store;
  try {
    const clock=5000;store=createPdfTextStore(key,{limits,now:()=>clock});
    assert.equal(await store.put(1,'good'),true);
    const base={schema:1,id:key+':1',key,page:1,text:'bad',bytes:(key.length+2+3)*2+64,savedAt:clock};
    for (const corrupt of [{...base,schema:2},{...base,key:keyB},{...base,page:2},
      {...base,text:4},{...base,bytes:1},{...base,savedAt:NaN},{...base,savedAt:clock+1}]) {
      await seed('pages',corrupt);assert.equal(await store.get(1),null,'corrupt page must be rejected');
    }
    assert.equal(await store.put(1,'good'),true);
    await seed('budget',{id:'total',bytes:-1,count:2,prunedAt:clock});
    assert.equal(await store.put(2,'new'),true);
    assert.equal(await store.get(1),null,'corrupt ledger must purge old page');assert.equal(await store.get(2),'new');
  } finally {store?.dispose();restoreFactory();}
});

test('corrupt replacement and eviction reset accounting before committing new data',async()=>{
  for (const scenario of ['replacement','eviction']) {
    for (const invalid of ['not-a-number',-1000000,1.5,0,198]) {
      useFactory();let store;
      try {
        const bounded={bytes:650,entries:2,entryBytes:500,ttl:1000};
        store=createPdfTextStore(key,{limits:bounded,now:()=>10000});
        assert.equal(await store.put(1,'first'),true);
        assert.equal(await store.put(2,'second'),true);
        await seed('pages',{schema:1,id:key+':1',key,page:1,text:'first',bytes:invalid,savedAt:10000});
        assert.equal(await store.get(1),null);
        const target=scenario==='replacement'?1:3;
        assert.equal(await store.put(target,'fresh'),true,`${scenario} must recover from corrupt bytes`);
        assert.equal(await store.get(target),'fresh');
        assert.equal(await store.get(2),null,`${scenario} must purge untrusted accounting`);
        const db=await openDatabase();
        try {
          const tx=db.transaction(['pages','budget'],'readonly');
          const [pages,budget]=await Promise.all([requestValue(tx.objectStore('pages').getAll()),
            requestValue(tx.objectStore('budget').get('total'))]);
          assert.equal(pages.length,1);
          assert.equal(budget.count,pages.length,`${scenario} count must match retained records`);
          assert.equal(budget.bytes,pages[0].bytes,`${scenario} bytes must match retained records`);
          assert.ok(Number.isSafeInteger(budget.bytes));
        } finally {db.close();}
        assert.equal(await store.put(4,'later'),true);
        assert.equal(await store.get(target),'fresh','later writes must not clear the recovered ledger');
      } finally {store?.dispose();restoreFactory();}
    }
  }
});

test('full replacement rolls back when damaged rows are absent from the index',async()=>{
  useFactory();let store,db;
  try {
    store=createPdfTextStore(key,{limits:{bytes:520,entries:2,entryBytes:500,ttl:1000},now:()=>10000});
    assert.equal(await store.put(1,'x'.repeat(30)),true);
    assert.equal(await store.put(2,'y'.repeat(30)),true);
    db=await openDatabase();
    const beforeTx=db.transaction(['pages','budget'],'readonly');
    const [rows,budget]=await Promise.all([requestValue(beforeTx.objectStore('pages').getAll()),requestValue(beforeTx.objectStore('budget').get('total'))]);
    await seed('pages',{...rows[0],savedAt:null});
    assert.equal(await store.put(2,'z'.repeat(100)),false);
    assert.equal(await store.get(2),'y'.repeat(30),'failed replacement must preserve original page');
    const tx=db.transaction(['pages','budget'],'readonly');
    const [after,afterBudget]=await Promise.all([requestValue(tx.objectStore('pages').getAll()),requestValue(tx.objectStore('budget').get('total'))]);
    assert.deepEqual(after,[{...rows[0],savedAt:null},rows[1]]);
    assert.deepEqual(afterBudget,budget);
  } finally {db?.close();store?.dispose();restoreFactory();}
});

test('understated and overdrawn ledgers reset instead of drifting',async()=>{
  for (const count of [0,1]) {
    useFactory();let store;
    try {
      const bounded={bytes:900,entries:3,entryBytes:500,ttl:1000};
      store=createPdfTextStore(key,{limits:bounded,now:()=>10000});
      await store.put(1,'first');await store.put(2,'second');
      await seed('budget',{id:'total',bytes:count===0?500:1,count,prunedAt:10000});
      assert.equal(await store.put(1,'fresh'),true);
      assert.equal(await store.get(2),null);assert.equal(await store.get(1),'fresh');
      const db=await openDatabase();
      try {
        const tx=db.transaction(['pages','budget'],'readonly');
        const [pages,budget]=await Promise.all([requestValue(tx.objectStore('pages').getAll()),
          requestValue(tx.objectStore('budget').get('total'))]);
        assert.equal(pages.length,1);assert.equal(budget.count,1);assert.equal(budget.bytes,pages[0].bytes);
      } finally {db.close();}
    } finally {store?.dispose();restoreFactory();}
  }
});

test('zero ledger detects hidden pages and asymmetric counters',async()=>{
  for (const [bytes,count] of [[0,0],[0,2],[400,0]]) {
    useFactory();let store,other,db;
    try {
      const bounded={bytes:900,entries:4,entryBytes:210,ttl:1000};
      store=createPdfTextStore(key,{limits:bounded,now:()=>10000});
      other=createPdfTextStore(keyB,{limits:bounded,now:()=>10000});
      assert.equal(await store.put(1,'x'.repeat(7)),true);
      assert.equal(await store.put(2,'x'.repeat(8)),false);
      assert.equal(await store.put(2,'b'),true);
      await seed('budget',{id:'total',bytes,count,prunedAt:10000});
      assert.deepEqual(await Promise.all([store.put(3,'c'),other.put(4,'d')]),[true,true]);
      db=await openDatabase();
      const tx=db.transaction(['pages','budget']);
      const [pages,budget]=await Promise.all([requestValue(tx.objectStore('pages').getAll()),requestValue(tx.objectStore('budget').get('total'))]);
      assert.equal(await store.get(1),null,'zero ledger must purge hidden pages');
      assert.equal(await store.get(2),null,'zero ledger must purge hidden pages');
      assert.equal(pages.length,2);assert.equal(budget.count,pages.length);
      assert.equal(budget.bytes,pages.reduce((sum,row)=>sum+row.bytes,0));
      assert.ok(budget.bytes<=bounded.bytes && budget.count<=bounded.entries);
    } finally {db?.close();store?.dispose();other?.dispose();restoreFactory();}
  }
});

test('empty zero ledger counts without clearing',async()=>{
  useFactory();let store,counts=0,clears=0;
  const originalCount=IDBObjectStore.prototype.count, originalClear=IDBObjectStore.prototype.clear;
  try {
    store=createPdfTextStore(key,{limits,now:()=>10000});
    IDBObjectStore.prototype.count=function(...args){counts++;return originalCount.apply(this,args);};
    IDBObjectStore.prototype.clear=function(){clears++;return originalClear.call(this);};
    assert.equal(await store.put(1,'first'),true);
    assert.equal(counts,0);assert.equal(clears,1);
    await seed('budget',{id:'total',bytes:-1,count:0,prunedAt:10000});
    assert.equal(await store.put(1,'reset'),true);
    assert.equal(counts,0);assert.equal(clears,2);
    counts=0;clears=0;
    const db=await openDatabase();
    try {const tx=db.transaction(['pages','budget'],'readwrite');const done=transactionDone(tx);
      tx.objectStore('pages').clear();tx.objectStore('budget').put({id:'total',bytes:0,count:0,prunedAt:10000});await done;
    } finally {db.close();}
    counts=0;clears=0;
    assert.equal(await store.put(2,'new'),true);
    assert.equal(counts,1);assert.equal(clears,0);assert.equal(await store.get(2),'new');
  } finally {IDBObjectStore.prototype.count=originalCount;IDBObjectStore.prototype.clear=originalClear;store?.dispose();restoreFactory();}
});

test('zero ledger count handler throw aborts before settlement',async()=>{
  useFactory();let store,db;const events=[];
  const originalClear=IDBObjectStore.prototype.clear, originalTransaction=IDBDatabase.prototype.transaction;
  try {
    store=createPdfTextStore(key,{limits,now:()=>10000});
    assert.equal(await store.put(1,'original'),true);
    await seed('budget',{id:'total',bytes:0,count:0,prunedAt:10000});
    IDBObjectStore.prototype.clear=function(){throw new Error('injected clear failure');};
    IDBDatabase.prototype.transaction=function(names,mode,...rest){
      const tx=originalTransaction.call(this,names,mode,...rest);
      if (mode==='readwrite') tx.addEventListener('abort',()=>events.push('abort'));
      return tx;
    };
    assert.equal(await store.put(2,'new').then(value=>{events.push('settled');return value;}),false);
    assert.deepEqual(events,['abort','settled'],'count handler abort must precede settlement');
    IDBObjectStore.prototype.clear=originalClear;IDBDatabase.prototype.transaction=originalTransaction;
    db=await openDatabase();const tx=db.transaction(['pages','budget']);
    const [pages,budget]=await Promise.all([requestValue(tx.objectStore('pages').getAll()),requestValue(tx.objectStore('budget').get('total'))]);
    assert.equal(pages.length,1);assert.equal(pages[0].text,'original');assert.equal(budget.count,0);
  } finally {IDBObjectStore.prototype.clear=originalClear;IDBDatabase.prototype.transaction=originalTransaction;db?.close();store?.dispose();restoreFactory();}
});

test('zero ledger count sync failure rolls back before settlement',()=>countFailure('sync'));
test('zero ledger count request failure rolls back before settlement',()=>countFailure('request'));

async function countFailure(kind){
  useFactory();let store,db;const events=[];
  const count=IDBObjectStore.prototype.count, transaction=IDBDatabase.prototype.transaction;
  const snapshot=async()=>{const tx=db.transaction(['pages','budget']);return Promise.all([
    requestValue(tx.objectStore('pages').getAll()),requestValue(tx.objectStore('budget').getAll())]);};
  try {
    store=createPdfTextStore(key,{limits,now:()=>10000});
    assert.equal(await store.put(1,'original'),true);
    await seed('budget',{id:'total',bytes:0,count:0,prunedAt:10000});
    db=await openDatabase();const before=await snapshot();
    IDBDatabase.prototype.transaction=function(names,mode,...rest){
      const tx=transaction.call(this,names,mode,...rest);
      if(mode==='readwrite') for(const type of ['abort','complete']) tx.addEventListener(type,()=>events.push(type));
      return tx;
    };
    IDBObjectStore.prototype.count=function(){
      events.push('count');
      if(kind==='sync') throw Error('injected count throw');
      // A duplicate-add request simulates an error, not a native count failure.
      const request=this.add({id:key+':1'});
      request.addEventListener('error',()=>events.push('error '+request.error.name));
      return request;
    };
    assert.equal(await store.put(2,'new').then(value=>{events.push('settled');return value;}),false,'count failure must fail');
    assert.deepEqual(events,kind==='sync'?['count','abort','settled']:
      ['count','error ConstraintError','abort','settled'],'count failure must abort before settlement');
    IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.count=count;
    assert.deepEqual(await snapshot(),before,'count failure must preserve snapshot');
  } finally {IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.count=count;db?.close();store?.dispose();restoreFactory();}
}

test('expired entries are pruned and old records free budget for new pages',async()=>{
  useFactory();let now=1_000_000,store;
  try {
    const tight={bytes:500,entries:4,entryBytes:300,ttl:1000};
    store=createPdfTextStore(key,{limits:tight,now:()=>now});
    assert.equal(await store.put(1,'x'.repeat(30)),true);assert.equal(await store.put(2,'y'.repeat(30)),true);
    now+=3_600_001;
    assert.equal(await store.put(3,'z'.repeat(30)),true);
    assert.equal(await store.get(1),null);assert.equal(await store.get(2),null);assert.equal(await store.get(3),'z'.repeat(30));
    const db=await openDatabase();
    try {
      const tx=db.transaction(['pages','budget'],'readonly');const pages=await requestValue(tx.objectStore('pages').getAll());
      const budget=await requestValue(tx.objectStore('budget').get('total'));
      assert.equal(pages.length,1);assert.equal(budget.count,1);assert.equal(budget.bytes,pages[0].bytes);
    } finally {db.close();}
  } finally {store?.dispose();restoreFactory();}
});

test('concurrent writes share the ledger and bound in-flight writes',async()=>{
  useFactory();let first,second;
  try {
    first=createPdfTextStore(key,{limits});second=createPdfTextStore(keyB,{limits});
    const pending=[first.put(1,'one'),first.put(2,'two'),first.put(3,'overflow'),second.put(1,'other')];
    const values=await Promise.all(pending);
    assert.deepEqual(values,[true,true,false,true],'in-flight writes must be bounded');assert.equal(first.stats.skipped,1);
    const db=await openDatabase();
    try {
      const tx=db.transaction(['pages','budget'],'readonly');
      const [pages,budget]=await Promise.all([requestValue(tx.objectStore('pages').getAll()),requestValue(tx.objectStore('budget').get('total'))]);
      assert.equal(budget.count,pages.length);assert.equal(budget.bytes,pages.reduce((sum,row)=>sum+row.bytes,0));
      assert.ok(budget.count<=limits.entries);assert.ok(budget.bytes<=limits.bytes);
    } finally {db.close();}
  } finally {first?.dispose();second?.dispose();restoreFactory();}
});

test('open failure and a late successful connection do not publish data',async()=>{
  useFactory();let store;
  try {
    let closed=false;
    globalThis.indexedDB.open=()=>{const request={result:{close(){closed=true;}}};setImmediate(()=>{
      request.onblocked();request.onsuccess();
    });return request;};
    store=createPdfTextStore(key);assert.equal(await store.get(1),null);await tick();assert.equal(closed,true);
    store.dispose();
    globalThis.indexedDB.open=()=>{const request={error:new Error('failed')};setImmediate(()=>request.onerror());return request;};
    store=createPdfTextStore(key);assert.equal(await store.get(1),null);
  } finally {store?.dispose();restoreFactory();}
});

test('aborted or unavailable storage returns promptly and never commits late',async()=>{
  useFactory();let store;
  try {
    const aborter=new AbortController();store=createPdfTextStore(key,{signal:aborter.signal});
    const initial=store.put(1,'initial');aborter.abort();assert.equal(await initial,false);
    assert.equal(await store.get(1),null);assert.equal(await store.put(1,'late'),false);
    await tick();const check=createPdfTextStore(key);try {assert.equal(await check.get(1),null);} finally {check.dispose();}
    const original=globalThis.indexedDB.open;globalThis.indexedDB.open=()=>{throw new Error('denied');};
    const broken=createPdfTextStore(key);try {assert.equal(await broken.get(1),null);assert.equal(await broken.put(1,'x'),false);}
    finally {broken.dispose();globalThis.indexedDB.open=original;}
    const invalid=createPdfTextStore('wrong');try {assert.equal(await invalid.get(1),null);assert.equal(await invalid.put(1,'x'),false);}
    finally {invalid.dispose();}
  } finally {store?.dispose();restoreFactory();}
});
