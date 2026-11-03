"""Isolated browser tests for preserving existing Reader IndexedDB records."""
import os
from pathlib import Path
import unittest

from tests.browser_support import local_server

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    PlaywrightError = Exception
    sync_playwright = None


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipIf(sync_playwright is None, 'Playwright is unavailable')
class ReaderStorePreservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, _state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        browser_type = getattr(cls.playwright, os.environ.get('READER_STORE_TEST_BROWSER', 'chromium'))
        options = {'headless': True}
        if browser_type == cls.playwright.chromium:
            options['args'] = ['--no-sandbox']
        if os.environ.get('CHROMIUM_PATH'):
            options['executable_path'] = os.environ['CHROMIUM_PATH']
        try:
            cls.browser = browser_type.launch(**options)
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(str(error))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context()
        self.context.route('**/*', lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + '/') else route.abort())
        self.page = self.context.new_page()
        self.page.route('**/store-preservation-fixture', lambda route: route.fulfill(
            status=200, content_type='text/html', body='<!doctype html><title>isolated fixture</title>'))
        self.page.goto(self.origin + '/store-preservation-fixture', wait_until='domcontentloaded')

    def tearDown(self):
        self.context.close()

    def seed(self, version):
        self.page.evaluate('''async version => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('voiceofml-reader', version);
            request.onupgradeneeded = () => {
              const db = request.result;
              const entries = db.createObjectStore('entries', { keyPath: 'url' });
              entries.createIndex('lastReadAt', 'lastReadAt');
              if (version >= 2) {
                const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
                bookmarks.createIndex('url', 'url');
                bookmarks.createIndex('createdAt', 'createdAt');
              }
              db.createObjectStore('foreign', { keyPath: 'key' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const names = version >= 2 ? ['entries', 'bookmarks', 'foreign'] : ['entries', 'foreign'];
          await new Promise((resolve, reject) => {
            const tx = db.transaction(names, 'readwrite');
            tx.objectStore('entries').put({url: 'legacy-book', lastReadAt: 1,
              scrollTop: 987, page: 7, title: 'old title', extension: 'chm', custom: {keep: true}});
            tx.objectStore('entries').put({url: 'future-book', lastReadAt: 2,
              schemaVersion: 9, payload: 'preserve'});
            tx.objectStore('entries').put({url: 'unindexed-book', scrollTop: 77, payload: 'preserve'});
            if (version >= 2) {
              tx.objectStore('bookmarks').put({id: 'legacy-mark', url: 'legacy-book',
                createdAt: 3, label: 'old label', page: 7, custom: {keep: true}});
              tx.objectStore('bookmarks').put({id: 'future-mark', url: 'legacy-book',
                createdAt: 4, schemaVersion: 9, payload: 'preserve'});
            }
            tx.objectStore('foreign').put({key: 'unrelated', value: 'preserve'});
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
          });
          db.close();
        }''', version)

    def load_store(self):
        self.page.add_script_tag(path=str(ROOT / 'static/reader/core/reader-store.js'))

    def test_v1_and_v2_upgrade_preserves_raw_history_bookmarks_and_unknown_store(self):
        for version in (1, 2):
            with self.subTest(version=version):
                self.seed(version)
                self.load_store()
                result = self.page.evaluate('''async () => {
                  const store = VoiceOfMLReaderStore;
                  const history = await store.get('legacy-book');
                  const allHistory = await store.list();
                  const bookmarks = await store.listBookmarks('legacy-book');
                  let historyRefused = false, bookmarkRefused = false;
                  try { await store.put({url:'future-book', lastReadAt:50}); }
                  catch (_) { historyRefused = true; }
                  if (bookmarks.length) {
                    try { await store.putBookmark({id:'future-mark', url:'legacy-book', createdAt:9}); }
                    catch (_) { bookmarkRefused = true; }
                  }
                  const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open(store.DB_NAME, store.DB_VERSION);
                    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
                  });
                  const raw = await new Promise((resolve, reject) => {
                    const tx = db.transaction(['entries', 'bookmarks', 'foreign']);
                    const historyReq = tx.objectStore('entries').getAll();
                    const bookmarkReq = tx.objectStore('bookmarks').getAll();
                    const foreignReq = tx.objectStore('foreign').getAll();
                    tx.oncomplete = () => resolve({history: historyReq.result, bookmarks: bookmarkReq.result,
                                                   foreign: foreignReq.result});
                    tx.onerror = () => reject(tx.error);
                  });
                  const names = Array.from(db.objectStoreNames); db.close();
                  return {history, allHistory, bookmarks, raw, names, historyRefused, bookmarkRefused};
                }''')
                self.assertEqual(result['history']['scrollTop'], 987)
                self.assertEqual(result['history']['page'], 7)
                self.assertEqual(result['history']['custom'], {'keep': True})
                self.assertEqual([item['url'] for item in result['allHistory']], ['legacy-book'])
                self.assertTrue(result['historyRefused'])
                self.assertEqual(result['raw']['foreign'], [{'key': 'unrelated', 'value': 'preserve'}])
                raw_history = {item['url']: item for item in result['raw']['history']}
                self.assertNotIn('schemaVersion', raw_history['legacy-book'])
                self.assertEqual(raw_history['future-book']['payload'], 'preserve')
                self.assertEqual(set(result['names']), {'entries', 'bookmarks', 'foreign'})
                if version == 2:
                    self.assertEqual(result['bookmarks'][0]['page'], 7)
                    raw_marks = {item['id']: item for item in result['raw']['bookmarks']}
                    self.assertNotIn('schemaVersion', raw_marks['legacy-mark'])
                    self.assertEqual(raw_marks['future-mark']['payload'], 'preserve')
                    self.assertTrue(result['bookmarkRefused'])
                else:
                    self.assertEqual(result['bookmarks'], [])
                self.context.close()
                if version == 1:
                    self.context = self.browser.new_context()
                    self.context.route('**/*', lambda route: route.continue_()
                                       if route.request.url.startswith(self.origin + '/') else route.abort())
                    self.page = self.context.new_page()
                    self.page.route('**/store-preservation-fixture', lambda route: route.fulfill(
                        status=200, content_type='text/html', body='<!doctype html><title>isolated fixture</title>'))
                    self.page.goto(self.origin + '/store-preservation-fixture', wait_until='domcontentloaded')

    def test_history_capacity_refuses_new_entry_without_evicting_existing(self):
        self.load_store()
        result = self.page.evaluate('''async () => {
          const store = VoiceOfMLReaderStore;
          for (let i=0; i<store.MAX_ENTRIES; i++) await store.put({url:'book-'+i, lastReadAt:i+1});
          let refused=false, reason='';
          try { await store.put({url:'extra-book', lastReadAt:1000}); } catch (error) { refused=true; reason=error?.name; }
          const all=await store.list(store.MAX_ENTRIES+1);
          return {refused, reason, count:all.length, oldest:!!(await store.get('book-0')),
                  newest:!!(await store.get('book-199')), extra:!!(await store.get('extra-book'))};
        }''')
        self.assertEqual(result, {'refused': True, 'reason': 'ReaderHistoryFullError',
                                  'count': 200, 'oldest': True, 'newest': True, 'extra': False})

    def test_unknown_key_layout_aborts_upgrade_without_erasing_data(self):
        self.page.evaluate('''async () => {
          const req=indexedDB.open('voiceofml-reader', 1);
          await new Promise((resolve,reject) => {
            req.onupgradeneeded=()=>req.result.createObjectStore('entries',{keyPath:'foreignKey'});
            req.onsuccess=()=>{const db=req.result, tx=db.transaction('entries','readwrite');
              tx.objectStore('entries').put({foreignKey:'keep',payload:'untouched'});
              tx.oncomplete=()=>{db.close();resolve();};};
            req.onerror=()=>reject(req.error);
          });
        }''')
        self.load_store()
        result = self.page.evaluate('''async () => {
          let refused=false; try { await VoiceOfMLReaderStore.get('book'); } catch (_) { refused=true; }
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('voiceofml-reader');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const raw=await new Promise((resolve,reject)=>{const tx=db.transaction('entries'), req=tx.objectStore('entries').get('keep');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const version=db.version;db.close();return {refused,version,raw};
        }''')
        self.assertEqual(result, {'refused': True, 'version': 1,
                                  'raw': {'foreignKey': 'keep', 'payload': 'untouched'}})

    def test_unknown_records_in_already_current_database_are_never_deleted(self):
        self.seed(3)
        self.load_store()
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;
          const history=await store.get('legacy-book'), marks=await store.listBookmarks('legacy-book');
          await store.get('future-book'); await store.list(200); await store.listAllBookmarks();
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(store.DB_NAME,store.DB_VERSION);
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const raw=await new Promise((resolve,reject)=>{const tx=db.transaction(['entries','bookmarks','foreign']);
            const a=tx.objectStore('entries').getAll(),b=tx.objectStore('bookmarks').getAll(),
                  c=tx.objectStore('foreign').getAll();
            tx.oncomplete=()=>resolve({history:a.result,bookmarks:b.result,foreign:c.result});
            tx.onerror=()=>reject(tx.error);});db.close();return {history,marks,raw};
        }''')
        self.assertEqual(result['history']['scrollTop'], 987)
        self.assertEqual([x['id'] for x in result['marks']], ['legacy-mark'])
        self.assertEqual({x['url'] for x in result['raw']['history']}, {'legacy-book', 'future-book', 'unindexed-book'})
        self.assertEqual({x['id'] for x in result['raw']['bookmarks']}, {'legacy-mark', 'future-mark'})
        self.assertEqual(result['raw']['foreign'], [{'key': 'unrelated', 'value': 'preserve'}])

    def test_updating_legacy_entries_preserves_unmentioned_fields(self):
        self.seed(2)
        self.load_store()
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;
          await store.put({url:'legacy-book',lastReadAt:8,title:'new title'});
          await store.putBookmark({id:'legacy-mark',url:'legacy-book',createdAt:9,label:'renamed'});
          await store.putBookmark({id:'legacy-mark',url:'legacy-book',excerpt:'new excerpt'});
          let foreignRejected=false;
          try { await store.putBookmark({id:'legacy-mark',url:'different-book',createdAt:10}); }
          catch (_) { foreignRejected=true; }
          return {history:await store.get('legacy-book'), marks:await store.listBookmarks('legacy-book'), foreignRejected};
        }''')
        self.assertEqual(result['history']['scrollTop'], 987)
        self.assertEqual(result['history']['page'], 7)
        self.assertEqual(result['history']['custom'], {'keep': True})
        self.assertEqual(result['history']['title'], 'new title')
        self.assertEqual(result['history']['extension'], 'chm')
        self.assertEqual(result['marks'][0]['page'], 7)
        self.assertEqual(result['marks'][0]['custom'], {'keep': True})
        self.assertEqual(result['marks'][0]['label'], 'renamed')
        self.assertEqual(result['marks'][0]['createdAt'], 9)
        self.assertEqual(result['marks'][0]['excerpt'], 'new excerpt')
        self.assertTrue(result['foreignRejected'])

    def test_explicit_deletions_preserve_future_records_and_other_stores(self):
        self.seed(3)
        self.load_store()
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;const errors=[];
          for (const action of [() => store.remove('future-book'), () => store.removeBookmark('future-mark')]) {
            try { await action(); } catch (_) { errors.push(true); }
          }
          await store.removeBookmark('legacy-mark');
          await store.clearHistory();
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open(store.DB_NAME);
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const raw=await new Promise((resolve,reject)=>{const tx=db.transaction(['entries','bookmarks','foreign']);
            const a=tx.objectStore('entries').getAll(),b=tx.objectStore('bookmarks').getAll(),c=tx.objectStore('foreign').getAll();
            tx.oncomplete=()=>resolve({history:a.result,bookmarks:b.result,foreign:c.result});
            tx.onerror=()=>reject(tx.error);});db.close();return {errors,raw};
        }''')
        self.assertEqual(result['errors'], [True, True])
        self.assertEqual({x['url'] for x in result['raw']['history']}, {'future-book', 'unindexed-book'})
        self.assertEqual([x['id'] for x in result['raw']['bookmarks']], ['future-mark'])
        self.assertEqual(result['raw']['foreign'], [{'key': 'unrelated', 'value': 'preserve'}])

    def test_current_database_with_incompatible_indexes_fails_closed(self):
        self.page.evaluate('''async () => {
          const req=indexedDB.open('voiceofml-reader', 3);
          await new Promise((resolve,reject)=>{
            req.onupgradeneeded=()=>{
              const s=req.result.createObjectStore('entries',{keyPath:'url'});
              s.createIndex('lastReadAt','lastReadAt',{unique:true});
              const b=req.result.createObjectStore('bookmarks',{keyPath:'id'});
              b.createIndex('url','url');b.createIndex('createdAt','createdAt');
            };
            req.onsuccess=()=>{const db=req.result,tx=db.transaction('entries','readwrite');
              tx.objectStore('entries').put({url:'keep',lastReadAt:8,scrollTop:500});
              tx.oncomplete=()=>{db.close();resolve();};};req.onerror=()=>reject(req.error);
          });
        }''')
        self.load_store()
        result = self.page.evaluate('''async () => {
          const errors=[];
          for(const action of [()=>VoiceOfMLReaderStore.get('keep'),
              ()=>VoiceOfMLReaderStore.put({url:'keep',lastReadAt:10}),
              ()=>VoiceOfMLReaderStore.clearHistory()]) {
            try { await action(); } catch (_) { errors.push(true); }
          }
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-reader');
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const record=await new Promise((resolve,reject)=>{const tx=db.transaction('entries'),r=tx.objectStore('entries').get('keep');
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const version=db.version;db.close();return {errors,version,record};
        }''')
        self.assertEqual(result, {'errors': [True, True, True], 'version': 3,
                                  'record': {'url': 'keep', 'lastReadAt': 8, 'scrollTop': 500}})

    def test_capacity_race_allows_one_new_entry_and_preserves_existing_progress(self):
        self.load_store()
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;
          for (let i=0; i<199; i++) await store.put({url:'book-'+i,lastReadAt:i+1});
          const writes=await Promise.allSettled([
            store.put({url:'first-new',lastReadAt:1000}), store.put({url:'second-new',lastReadAt:1001})]);
          const all=await store.list(201);
          return {statuses:writes.map(x=>x.status).sort(), count:all.length,
            oldest:!!(await store.get('book-0')),
            newCount:Number(!!(await store.get('first-new')))+Number(!!(await store.get('second-new')))};
        }''')
        self.assertEqual(result, {'statuses': ['fulfilled', 'rejected'], 'count': 200,
                                  'oldest': True, 'newCount': 1})

    def test_newer_database_version_is_never_downgraded_or_cleared(self):
        self.seed(4)
        self.load_store()
        result = self.page.evaluate('''async () => {
          let errorName='';try { await VoiceOfMLReaderStore.get('legacy-book'); }
          catch (error) { errorName=error.name; }
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-reader');
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const tx=db.transaction(['entries','bookmarks','foreign']);
          const history=tx.objectStore('entries').getAll(),marks=tx.objectStore('bookmarks').getAll(),
            foreign=tx.objectStore('foreign').getAll();
          const raw=await new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve({history:history.result,marks:marks.result,foreign:foreign.result});
            tx.onerror=()=>reject(tx.error);});const version=db.version;db.close();return {version,errorName,raw};
        }''')
        self.assertEqual(result['version'], 4)
        self.assertEqual(result['errorName'], 'VersionError')
        self.assertEqual({x['url'] for x in result['raw']['history']}, {'legacy-book', 'future-book', 'unindexed-book'})
        self.assertEqual({x['id'] for x in result['raw']['marks']}, {'legacy-mark', 'future-mark'})
        self.assertEqual(result['raw']['foreign'], [{'key': 'unrelated', 'value': 'preserve'}])

    def test_existing_book_updates_even_when_at_capacity(self):
        self.load_store()
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;
          for (let i=0; i<200; i++) await store.put({url:'book-'+i,lastReadAt:i+1,scrollTop:i});
          await store.put({url:'book-0',lastReadAt:201,scrollTop:999});
          await store.put({url:'book-0',lastReadAt:100,scrollTop:50});
          return {count:(await store.list(201)).length,first:await store.get('book-0'),last:await store.get('book-199')};
        }''')
        self.assertEqual(result['count'], 200)
        self.assertEqual(result['first']['scrollTop'], 999)
        self.assertEqual(result['last']['scrollTop'], 199)

    def test_incompatible_index_aborts_without_removing_existing_records(self):
        self.page.evaluate('''async () => {
          const req=indexedDB.open('voiceofml-reader', 1);
          await new Promise((resolve,reject)=>{
            req.onupgradeneeded=()=>{const s=req.result.createObjectStore('entries',{keyPath:'url'});
              s.createIndex('lastReadAt','wrongField');};
            req.onsuccess=()=>{const db=req.result,tx=db.transaction('entries','readwrite');
              tx.objectStore('entries').put({url:'keep',lastReadAt:8,wrongField:1,scrollTop:500});
              tx.oncomplete=()=>{db.close();resolve();};};req.onerror=()=>reject(req.error);
          });
        }''')
        self.load_store()
        result = self.page.evaluate('''async () => {
          let refused=false;try{await VoiceOfMLReaderStore.get('keep');}catch(_){refused=true;}
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-reader');
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const record=await new Promise((resolve,reject)=>{const tx=db.transaction('entries'),r=tx.objectStore('entries').get('keep');
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const version=db.version;db.close();return {refused,version,record};
        }''')
        self.assertEqual(result, {'refused': True, 'version': 1,
                                  'record': {'url': 'keep', 'lastReadAt': 8, 'wrongField': 1, 'scrollTop': 500}})

    def test_incompatible_upgrade_rolls_back_all_new_indexes_and_bookmark_store(self):
        self.page.evaluate('''async () => {
          const req=indexedDB.open('voiceofml-reader', 1);
          await new Promise((resolve,reject)=>{
            req.onupgradeneeded=()=>{
              req.result.createObjectStore('entries',{keyPath:'url'});
              const bookmarks=req.result.createObjectStore('bookmarks',{keyPath:'id'});
              bookmarks.createIndex('createdAt','wrongField');
            };
            req.onsuccess=()=>{const db=req.result,tx=db.transaction(['entries','bookmarks'],'readwrite');
              tx.objectStore('entries').put({url:'keep',scrollTop:500});
              tx.objectStore('bookmarks').put({id:'bookmark',url:'keep',wrongField:1});
              tx.oncomplete=()=>{db.close();resolve();};};req.onerror=()=>reject(req.error);
          });
        }''')
        self.load_store()
        result = self.page.evaluate('''async () => {
          let refused=false;try{await VoiceOfMLReaderStore.get('keep');}catch(_){refused=true;}
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('voiceofml-reader');
            r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const tx=db.transaction(['entries','bookmarks']);
          const history=tx.objectStore('entries'), marks=tx.objectStore('bookmarks');
          const a=history.getAll(),b=marks.getAll();
          const raw=await new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve({history:a.result,bookmarks:b.result});
            tx.onerror=()=>reject(tx.error);});
          const result={refused,version:db.version,historyIndexes:Array.from(history.indexNames),
            bookmarkIndexes:Array.from(marks.indexNames),raw};db.close();return result;
        }''')
        self.assertEqual(result, {'refused': True, 'version': 1, 'historyIndexes': [],
                                  'bookmarkIndexes': ['createdAt'],
                                  'raw': {'history': [{'url': 'keep', 'scrollTop': 500}],
                                          'bookmarks': [{'id': 'bookmark', 'url': 'keep', 'wrongField': 1}]}})


if __name__ == '__main__':
    unittest.main()
