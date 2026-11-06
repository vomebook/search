"""Disposable new-client-only v3→v4 experiment; never touches real profiles.

Backward compatibility with the old client is intentionally not a goal. This
tests an additive upgrade without creating record copies, deleting stores, or
guessing old positions. The v3 client must stop writing after an upgrade.
"""
import os
import unittest

from playwright.sync_api import sync_playwright

from tests import test_chm_stale_store_compat_20261105 as fixture


class NewClientUpgrade(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        engine = os.environ.get('CHM_STORE_BROWSER', 'chromium')
        if engine not in {'chromium', 'firefox', 'webkit'}:
            raise ValueError('unknown browser')
        cls.browser = getattr(cls.playwright, engine).launch(headless=True)
        cls.addClassCleanup(cls.browser.close)
        from contextlib import ExitStack
        cls.stack = ExitStack()
        cls.addClassCleanup(cls.stack.close)
        cls.origin = fixture.serve(cls.stack)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.addCleanup(self.context.close)
        self.external = []
        def route(request):
            if request.request.url.startswith(self.origin + '/'):
                request.continue_()
            else:
                self.external.append(request.request.url)
                request.abort()
        self.context.route('**/*', route)

    def page(self, script):
        page = self.context.new_page()
        page.goto(self.origin + '/fixture', wait_until='domcontentloaded')
        page.add_script_tag(content=script.decode('utf-8'))
        return page

    def test_upgrade_keeps_all_records_and_blocks_fixed_v3_writes(self):
        stale = self.page(fixture.OLD_SCRIPT)
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/source.chm'
        await_result = stale.evaluate('''async ({url,old})=>{
          await VoiceOfMLReaderStore.put({url,title:'synthetic old progress',lastReadAt:1,
            chapterManifest:old,chapterIndex:2,chapterOffset:123456,custom:{keep:true}});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-mark',url,label:'synthetic old bookmark',
            createdAt:1,chapterManifest:old,chapterOffset:123456,custom:{keep:true}});
          return {history:await VoiceOfMLReaderStore.get(url),bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)};
        }''', {'url': original, 'old': fixture.OLD_URL})
        current = self.page(fixture.CURRENT_SCRIPT)
        after = current.evaluate('''async url=>({version:VoiceOfMLReaderStore.DB_VERSION,
          history:await VoiceOfMLReaderStore.get(url),bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        self.assertEqual(after['version'], 4)
        self.assertEqual(after['history'], await_result['history'])
        self.assertEqual(after['bookmarks'], await_result['bookmarks'])
        stale_attempt = stale.evaluate('''async url=>{
          const errors=[];
          for(const call of [()=>VoiceOfMLReaderStore.put({url,lastReadAt:100,chapterOffset:7}),
              ()=>VoiceOfMLReaderStore.putBookmark({id:'synthetic-mark',url,label:'overwritten'}),
              ()=>VoiceOfMLReaderStore.clearHistory()]) {
            try {await call();errors.push('unexpected success');}catch(error){errors.push(error.name);}
          }
          return errors;
        }''', original)
        self.assertEqual(stale_attempt, ['VersionError'] * 3)
        self.assertEqual(current.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original), await_result)
        self.assertEqual(current.evaluate('''async()=>{const db=await new Promise((resolve,reject)=>{
          const req=indexedDB.open('voiceofml-reader');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
        });const names=Array.from(db.objectStoreNames);db.close();return names;}'''), ['bookmarks', 'entries'])
        current.evaluate('''url=>VoiceOfMLReaderStore.put({url,title:'independent new book',lastReadAt:20})''',
                         'https://example.invalid/independent-new')
        self.assertEqual(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', original), await_result['history'])
        self.assertEqual(self.external, [])

    def test_blocked_upgrade_fails_without_late_schema_change(self):
        stale = self.page(fixture.OLD_SCRIPT)
        stale.evaluate('''async()=>{
          await VoiceOfMLReaderStore.put({url:'synthetic-record',lastReadAt:1,scrollTop:4321});
          window.__heldDb=await new Promise((resolve,reject)=>{
            const req=indexedDB.open('voiceofml-reader',3);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });
          window.__heldDb.onversionchange=()=>{};
        }''')
        current = self.page(fixture.CURRENT_SCRIPT)
        result = current.evaluate('''async()=>{try{await VoiceOfMLReaderStore.list();return 'unexpected success';}
          catch(error){return error.message;}}''')
        self.assertIn('blocked', result.lower())
        stale.evaluate('()=>window.__heldDb.close()')
        # The failed request must be cancelled by the upgrader, not commit
        # later when the last old connection is eventually closed.
        current.wait_for_timeout(250)
        state = stale.evaluate('''()=>new Promise((resolve,reject)=>{
          const request=indexedDB.open('voiceofml-reader');request.onerror=()=>reject(request.error);
          request.onsuccess=()=>{const db=request.result,tx=db.transaction('entries');
            const entry=tx.objectStore('entries').get('synthetic-record');
            tx.oncomplete=()=>{resolve({version:db.version,entry:entry.result});db.close();};};
        })''')
        self.assertEqual(state['version'], 3)
        self.assertEqual(state['entry']['scrollTop'], 4321)
        self.assertEqual(self.external, [])

    def test_higher_database_version_still_fails_without_changing_data(self):
        page = self.context.new_page()
        page.goto(self.origin + '/fixture', wait_until='domcontentloaded')
        page.evaluate('''()=>new Promise((resolve,reject)=>{
          const req=indexedDB.open('voiceofml-reader',5);
          req.onupgradeneeded=()=>{const db=req.result;
            const h=db.createObjectStore('entries',{keyPath:'url'});h.createIndex('lastReadAt','lastReadAt');
            const b=db.createObjectStore('bookmarks',{keyPath:'id'});b.createIndex('url','url');b.createIndex('createdAt','createdAt');
            db.createObjectStore('foreign',{keyPath:'key'});
          };
          req.onsuccess=()=>{const db=req.result,tx=db.transaction(['entries','foreign'],'readwrite');
            tx.objectStore('entries').put({url:'synthetic-future',lastReadAt:1,scrollTop:42});
            tx.objectStore('foreign').put({key:'keep',value:'unchanged'});
            tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
          req.onerror=()=>reject(req.error);
        })''')
        page.add_script_tag(content=fixture.CURRENT_SCRIPT.decode('utf-8'))
        result = page.evaluate('''async()=>{
          let error='';try{await VoiceOfMLReaderStore.get('synthetic-future');}catch(ex){error=ex.name;}
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('voiceofml-reader');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const tx=db.transaction(['entries','foreign']),a=tx.objectStore('entries').getAll(),b=tx.objectStore('foreign').getAll();
          return await new Promise((resolve,reject)=>{tx.oncomplete=()=>{const out={version:db.version,error,
            entries:a.result,foreign:b.result};db.close();resolve(out)};tx.onabort=()=>reject(tx.error);});
        }''')
        self.assertEqual(result['version'], 5)
        self.assertEqual(result['error'], 'VersionError')
        self.assertEqual(result['entries'], [{'url': 'synthetic-future', 'lastReadAt': 1, 'scrollTop': 42}])
        self.assertEqual(result['foreign'], [{'key': 'keep', 'value': 'unchanged'}])
        self.assertEqual(self.external, [])

    def test_upgrade_timeout_must_not_write_after_old_lock_releases(self):
        """A general caller timeout is not an IndexedDB upgrade cancellation."""
        stale = self.page(fixture.OLD_SCRIPT)
        stale.evaluate('''async()=>{
          await VoiceOfMLReaderStore.put({url:'synthetic-record',lastReadAt:1,scrollTop:4321});
          window.__heldDb=await new Promise((resolve,reject)=>{
            const req=indexedDB.open('voiceofml-reader',3);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
          });window.__heldDb.onversionchange=()=>{};
        }''')
        current = self.page(fixture.CURRENT_SCRIPT)
        result = current.evaluate('''async()=>Promise.race([
          VoiceOfMLReaderStore.put({url:'synthetic-new',lastReadAt:2}).then(()=>'wrote',()=> 'rejected'),
          new Promise(resolve=>setTimeout(()=>resolve('timeout'),200))])''')
        self.assertIn(result, ('timeout', 'rejected'))
        stale.evaluate('()=>window.__heldDb.close()')
        current.wait_for_timeout(300)
        observed = current.evaluate('''()=>new Promise((resolve,reject)=>{
          const req=indexedDB.open('voiceofml-reader');req.onerror=()=>reject(req.error);
          req.onsuccess=()=>{const db=req.result,tx=db.transaction('entries');
            const a=tx.objectStore('entries').get('synthetic-new'),b=tx.objectStore('entries').get('synthetic-record');
            tx.oncomplete=()=>{const out={version:db.version,new:a.result||null,old:b.result};db.close();resolve(out)};};
        })''')
        self.assertIsNone(observed['new'])
        self.assertEqual(observed['old']['scrollTop'], 4321)
        self.assertEqual(self.external, [])


if __name__ == '__main__':
    unittest.main()
