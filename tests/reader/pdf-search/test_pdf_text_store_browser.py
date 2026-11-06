"""Native IndexedDB contracts for the PDF search text cache in Chromium/Firefox."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class PdfTextStoreBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server_thread.join, timeout=5)
        cls.addClassCleanup(cls.server.shutdown)
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        browser = getattr(cls.playwright, os.environ.get('PDF_TEXT_STORE_TEST_BROWSER', 'chromium'))
        cls.browser = browser.launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    def test_failed_write_waits_for_abort_and_rolls_back(self):
        for kind, cancel in [('async', False), ('async', True), ('sync', False)]:
            with self.subTest(kind=kind, cancel=cancel):
                context = self.browser.new_context()
                try:
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(self.origin + '/static/reader.html?ext=txt', wait_until='domcontentloaded')
                    result = page.evaluate('''async ({kind,cancel}) => {
                      const {createPdfTextStore}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
                      const name='voiceofml-pdf-search-text', log=[];
                      let target, injected=0, resolveDone, timer, wrapped=0;
                      const done=new Promise(resolve=>resolveDone=resolve);
                      const transaction=IDBDatabase.prototype.transaction;
                      const put=IDBObjectStore.prototype.put, get=IDBObjectStore.prototype.get;
                      const store=createPdfTextStore('a'.repeat(64),{now:()=>10000});
                      const timeout=p=>Promise.race([p,new Promise((_,reject)=>
                        timer=setTimeout(()=>reject(Error('transaction timeout')),4000))])
                        .finally(()=>clearTimeout(timer));
                      const snapshot=async()=>{
                        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);
                          r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
                        try {return await new Promise((resolve,reject)=>{
                          const tx=db.transaction(['pages','budget']);
                          const pages=tx.objectStore('pages').getAll(),budget=tx.objectStore('budget').getAll();
                          tx.oncomplete=()=>resolve({pages:pages.result,budget:budget.result});
                          tx.onabort=()=>reject(tx.error);
                        });} finally {db.close();}
                      };
                      const wrapHandler=()=>{
                        const handler=target.onerror;
                        if(typeof handler!=='function') throw Error('production onerror not bound');
                        const wrapper=function(e) {
                          if(e.target===badRequest) log.push('handler '+e.defaultPrevented);
                          return handler.call(this,e);
                        };
                        target.onerror=wrapper;
                        if(target.onerror!==wrapper) throw Error('wrapper not bound');
                        wrapped++;
                      };
                      let badRequest;
                      try {
                        if(!await store.put(1,'seed text')) throw Error('seed failed');
                        const before=await snapshot();
                        IDBDatabase.prototype.transaction=function(...args) {
                          const tx=transaction.apply(this,args);
                          if(this.name===name && args[1]==='readwrite' && !target) {
                            target=tx;
                            for(const type of ['error','abort','complete']) tx.addEventListener(type,e=>{
                              log.push('tx '+type+(type==='error'?' '+e.target.error?.name:''));
                              if(type==='abort'||type==='complete') resolveDone(type);
                            });
                          }
                          return tx;
                        };
                        IDBObjectStore.prototype.put=function(...args) {
                          const r=put.apply(this,args);
                          if(kind==='async' && this.transaction===target && this.name==='pages' && !injected) {
                            injected++;
                            wrapHandler();
                            const row={id:'fixture-duplicate'};
                            this.add(row);
                            const bad=badRequest=this.add(row);
                            bad.addEventListener('error',e=>{
                              log.push('request error '+bad.error.name);
                              if(cancel) e.preventDefault();
                            });
                          }
                          return r;
                        };
                        IDBObjectStore.prototype.get=function(...args) {
                          if(kind==='sync' && this.transaction===target && this.name==='budget' && !injected) {
                            injected++;
                            wrapHandler();
                            target.objectStore('pages').put({id:'fixture-sync'});
                            log.push('sync throw');
                            throw Error('fixture synchronous get');
                          }
                          return get.apply(this,args);
                        };
                        const pending=store.put(2,'hello').then(value=>{
                          log.push('promise '+value);return value;
                        },error=>{log.push('promise reject '+error.name);return 'reject';});
                        const result=await timeout(pending), terminal=await timeout(done);
                        const after=await snapshot();
                        return {result,terminal,log,injected,wrapped,before,after};
                      } finally {
                        clearTimeout(timer);
                        try { target?.abort(); } catch (_) {}
                        store.dispose();
                        IDBDatabase.prototype.transaction=transaction;
                        IDBObjectStore.prototype.put=put;
                        IDBObjectStore.prototype.get=get;
                      }
                    }''', {'kind': kind, 'cancel': cancel})
                    self.assertEqual(result['injected'], 1, result)
                    self.assertEqual(result['result'], False, result)
                    self.assertEqual(result['terminal'], 'abort', result)
                    self.assertEqual(result['wrapped'], 1, result)
                    log = result['log']
                    self.assertNotIn('tx complete', log, result)
                    self.assertLess(log.index('tx abort'), log.index('promise false'), result)
                    if kind == 'sync':
                        self.assertLess(log.index('sync throw'), log.index('tx abort'), result)
                    else:
                        request = log.index('request error ConstraintError')
                        tx_error = log.index('tx error ConstraintError')
                        handler = log.index('handler ' + str(cancel).lower())
                        self.assertLess(request, tx_error, result)
                        self.assertLess(tx_error, handler, result)
                        self.assertLess(handler, log.index('tx abort'), result)
                    self.assertEqual(len(result['before']['pages']), 1, result)
                    self.assertEqual(len(result['before']['budget']), 1, result)
                    self.assertEqual(result['after'], result['before'])
                    self.assertFalse(any(row['id'] == 'a' * 64 + ':2' for row in result['after']['pages']))
                    self.assertEqual(errors, [])
                finally:
                    context.close()

    def test_native_indexeddb_isolation_expiry_and_concurrent_budget(self):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        first, second = context.new_page(), context.new_page()
        errors = []
        for page in (first, second):
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(self.origin + '/static/reader.html?ext=txt', wait_until='domcontentloaded')
        result = first.evaluate('''async () => {
          const {createPdfTextStore,pdfTextStoreKey}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
          const key=await pdfTextStoreKey({source:'fixture',version:'"A"',pageCount:5,engine:'engine'});
          const other=await pdfTextStoreKey({source:'fixture',version:'"B"',pageCount:5,engine:'engine'});
          window.__key=key;
          const options={limits:{bytes:650,entries:2,entryBytes:500,ttl:1000},now:()=>10000};
          const store=createPdfTextStore(key,options);window.__store=store;
          const a=await store.put(1,'手机 🍀'),b=await store.put(2,''),overwrite=await store.put(1,'replaced');
          return {a,b,overwrite,value:await store.get(1),empty:await store.get(2),other};
        }''')
        self.assertEqual({key: result[key] for key in ('a', 'b', 'overwrite', 'value', 'empty')},
                         {'a': True, 'b': True, 'overwrite': True, 'value': 'replaced', 'empty': ''})
        second_result = second.evaluate('''async ({key,other}) => {
          const {createPdfTextStore}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
          const options={limits:{bytes:650,entries:2,entryBytes:500,ttl:1000},now:()=>10000};
          const same=createPdfTextStore(key,options),different=createPdfTextStore(other,options);
          try { return {shared:await same.get(1),isolated:await different.get(1)}; }
          finally {same.dispose();different.dispose();}
        }''', {'key': first.evaluate('window.__key'), 'other': result['other']})
        self.assertEqual(second_result, {'shared': 'replaced', 'isolated': None})
        # Keep one transaction open in the first tab, queue the second tab's
        # write, then release the first; both must use the shared ledger.
        first.evaluate('''async () => {
          window.__heldDb=await new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-pdf-search-text',1);
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          window.__releaseLock=false;
          window.__heldTx=window.__heldDb.transaction(['pages','budget'],'readwrite');
          const keepAlive=()=>{if(!window.__releaseLock){const r=window.__heldTx.objectStore('budget').get('total');r.onsuccess=keepAlive;}};
          keepAlive();
        }''')
        second.evaluate('''async () => {
          const {createPdfTextStore}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
          const options={limits:{bytes:650,entries:2,entryBytes:500,ttl:1000},now:()=>10000};
          window.__other=createPdfTextStore('b'.repeat(64),options);
          window.__pending=window.__other.put(1,'other');
        }''')
        first.evaluate('''() => {
          window.__pending=window.__store.put(3,'third');
          window.__lockDone=new Promise(resolve=>window.__heldTx.oncomplete=resolve);
          window.__releaseLock=true;
        }''')
        first.evaluate('window.__lockDone')
        first.evaluate('window.__heldDb.close()')
        concurrent = [second.evaluate('window.__pending'), first.evaluate('window.__pending')]
        second.evaluate('window.__other.dispose()')
        self.assertEqual(concurrent, [True, True])
        state = first.evaluate('''async () => {
          window.__store.dispose();
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-pdf-search-text',1);
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          try {
            const tx=db.transaction(['pages','budget'],'readonly');
            const get=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
            const [pages,budget]=await Promise.all([get(tx.objectStore('pages').getAll()),get(tx.objectStore('budget').get('total'))]);
            return {pages,budget};
          } finally {db.close();}
        }''')
        self.assertLessEqual(len(state['pages']), 2)
        self.assertEqual(state['budget']['count'], len(state['pages']))
        self.assertEqual(state['budget']['bytes'], sum(row['bytes'] for row in state['pages']))
        self.assertLessEqual(state['budget']['bytes'], 650)
        expired = second.evaluate('''async key=>{
          const {createPdfTextStore}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
          const store=createPdfTextStore(key,{limits:{bytes:650,entries:2,entryBytes:500,ttl:1000},now:()=>11000});
          try {return await store.get(3);} finally {store.dispose();}
        }''', first.evaluate('window.__key'))
        self.assertIsNone(expired)
        self.assertEqual(errors, [])

    def test_full_replacement_rolls_back_with_unindexed_corrupt_row(self):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(self.origin + '/static/reader.html?ext=txt', wait_until='domcontentloaded')
        result = page.evaluate('''async () => {
          const {createPdfTextStore}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
          const key='a'.repeat(64);
          const store=createPdfTextStore(key,{limits:{bytes:520,entries:2,entryBytes:500,ttl:1000},now:()=>10000});
          const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          let db;
          try {
            const first=await store.put(1,'x'.repeat(30)),second=await store.put(2,'y'.repeat(30));
            db=await request(indexedDB.open('voiceofml-pdf-search-text',1));
            const snapshot=async()=>{const tx=db.transaction(['pages','budget'],'readonly');
              const [pages,budget]=await Promise.all([request(tx.objectStore('pages').getAll()),request(tx.objectStore('budget').get('total'))]);
              return {pages,budget};};
            const initial=await snapshot();
            await new Promise((resolve,reject)=>{const tx=db.transaction('pages','readwrite');
              tx.objectStore('pages').put({...initial.pages[0],savedAt:null});
              tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});
            const before=await snapshot(),saved=await store.put(2,'z'.repeat(100));
            return {first,second,before,saved,value:await store.get(2),after:await snapshot()};
          } finally {db?.close();store.dispose();}
        }''')
        self.assertTrue(result['first'])
        self.assertTrue(result['second'])
        self.assertFalse(result['saved'])
        self.assertEqual(result['value'], 'y' * 30)
        self.assertEqual(result['after'], result['before'])
        self.assertEqual(result['after']['budget']['count'], 2)
        self.assertEqual(result['after']['budget']['bytes'], 512)
        self.assertEqual(errors, [])

    def test_corrupt_replacement_and_eviction_recover_native_ledger(self):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(self.origin + '/static/reader.html?ext=txt', wait_until='domcontentloaded')
        result = page.evaluate('''async () => {
          const {createPdfTextStore}=await import('/static/reader/pdf/reader-pdf-text-store.mjs');
          const key='a'.repeat(64),options={limits:{bytes:650,entries:2,entryBytes:500,ttl:1000},now:()=>10000};
          const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-pdf-search-text',1);
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const write=(db,name,value)=>new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');
            tx.objectStore(name).put(value);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});
          const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const store=createPdfTextStore(key,options);let db;
          try {
            const rows=[];
            for (const mode of ['replacement','eviction']) {
              if(db){db.close();db=null;}
              await store.put(1,'first');await store.put(2,'second');db=await open();
              await write(db,'pages',{schema:1,id:key+':1',key,page:1,text:'first',bytes:'bad',savedAt:10000});
              const invalid=await store.get(1),target=mode==='replacement'?1:3;
              const saved=await store.put(target,'fresh'),value=await store.get(target),old=await store.get(2);
              const tx=db.transaction(['pages','budget'],'readonly');
              const [pages,budget]=await Promise.all([request(tx.objectStore('pages').getAll()),request(tx.objectStore('budget').get('total'))]);
              rows.push({mode,invalid,saved,value,old,count:budget.count,bytes:budget.bytes,
                actualCount:pages.length,actualBytes:pages.reduce((sum,row)=>sum+row.bytes,0)});
            }
            return rows;
          } finally {db?.close();store.dispose();}
        }''')
        for row in result:
            with self.subTest(mode=row['mode']):
                self.assertIsNone(row['invalid'])
                self.assertTrue(row['saved'])
                self.assertEqual(row['value'], 'fresh')
                self.assertIsNone(row['old'])
                self.assertEqual(row['count'], row['actualCount'])
                self.assertEqual(row['bytes'], row['actualBytes'])
                self.assertEqual(row['count'], 1)
        self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
