"""Test current and older Reader stores on disposable loopback browser data.

This deliberately demonstrates the residual stale-tab race. It does not modify
the Reader store implementation, open a user's profile, access production, or
claim that storage, deployment, publishing or deletion is safe.
"""
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import json
import os
import subprocess
import threading
import unittest

from playwright.sync_api import sync_playwright


HERE = Path(__file__).resolve().parents[1]
OLD_REPO = Path('/tmp/opencode/chm-legacy-compat-pages-20261101')
OLD_REVISION = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=OLD_REPO, text=True).strip()
OLD_SCRIPT = subprocess.check_output(['git', 'show', OLD_REVISION + ':static/reader/core/reader-store.js'], cwd=OLD_REPO)
CURRENT_SCRIPT = (HERE / 'static/reader/core/reader-store.js').read_bytes()
OLD_PATH = ('chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/'
            'bc50c5be8c985411/chapter-manifest.json')
OLD_URL = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + OLD_PATH
OLD_ENCODED = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + OLD_PATH.replace('/', '%2F')
NEW_URL = OLD_URL.replace('bc50c5be8c985411', '18ba3952389e349e')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        raw = b'<!doctype html><meta charset="utf-8"><title>local synthetic store test</title>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_):
        pass


def serve(stack):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def close():
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)

    stack.callback(close)
    return 'http://127.0.0.1:' + str(server.server_port)


class StaleStoreCompatibility(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = ExitStack()
        cls.addClassCleanup(cls.stack.close)
        cls.origin = serve(cls.stack)
        cls.other_origin = serve(cls.stack)
        cls.playwright = cls.stack.enter_context(sync_playwright())
        engine = os.environ.get('CHM_STORE_BROWSER', 'chromium')
        if engine not in {'chromium', 'firefox', 'webkit'}:
            raise ValueError('unsupported browser')
        cls.browser = getattr(cls.playwright, engine).launch(headless=True)
        cls.stack.callback(cls.browser.close)
        print('local-store-inputs', engine, OLD_REVISION,
              hashlib.sha256(OLD_SCRIPT).hexdigest(), hashlib.sha256(CURRENT_SCRIPT).hexdigest(), flush=True)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.addCleanup(self.context.close)
        self.external = []

        def restrict(route):
            if route.request.url.startswith((self.origin + '/', self.other_origin + '/')):
                route.continue_()
            else:
                self.external.append(route.request.url)
                route.abort()

        self.context.route('**/*', restrict)

    def page(self, *, old=False, origin=None):
        page = self.context.new_page()
        page.goto((origin or self.origin) + '/fixture', wait_until='domcontentloaded')
        page.add_script_tag(content=(OLD_SCRIPT if old else CURRENT_SCRIPT).decode('utf-8'))
        return page

    def seed(self, page, fillers=0):
        page.evaluate('''async ({url,fillers}) => {
          // The real Reader lazily creates its stores on first use. Opening
          // the DB directly first would create an empty v3 database instead.
          await VoiceOfMLReaderStore.list();
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('voiceofml-reader',3);
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const tx=db.transaction(['entries','bookmarks'],'readwrite'), histories=tx.objectStore('entries');
          histories.put({url, schemaVersion:1, title:'synthetic old history', lastReadAt:1,
            chapterIndex:2,chapterOffset:123456,custom:{keep:true}});
          for(let i=0;i<fillers;i++) histories.put({url:`https://example.invalid/filler-${i}`,
            schemaVersion:1,title:'synthetic filler',lastReadAt:2+i});
          tx.objectStore('bookmarks').put({id:'synthetic-mark',url,schemaVersion:1,
            label:'synthetic old mark',createdAt:1,chapterIndex:2,chapterOffset:123456,custom:{keep:true}});
          await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);});
          db.close();
        }''', {'url': OLD_URL, 'fillers': fillers})

    def test_current_store_refuses_extra_at_capacity_but_old_tab_can_evict(self):
        stale, current = self.page(old=True), self.page()
        self.seed(current, 199)
        before = current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL)
        refused = current.evaluate('''async url=>{try{await VoiceOfMLReaderStore.put({url,lastReadAt:10000});
          return ''; }catch(error){return error.name;}}''', NEW_URL)
        self.assertEqual(refused, 'ReaderHistoryFullError')
        self.assertEqual(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL), before)
        self.assertIsNone(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', NEW_URL))
        stale.evaluate('url=>VoiceOfMLReaderStore.put({url,title:"synthetic new",lastReadAt:10000})', NEW_URL)
        self.assertIsNone(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL))
        self.assertIsNotNone(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', NEW_URL))
        self.assertEqual(self.external, [])

    def test_old_tab_can_change_existing_history_and_bookmark(self):
        stale, current = self.page(old=True), self.page()
        self.seed(current)
        before = current.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          marks:await VoiceOfMLReaderStore.listBookmarks(url)})''', OLD_URL)
        self.assertEqual(before['history']['chapterOffset'], 123456)
        self.assertEqual(before['marks'][0]['label'], 'synthetic old mark')
        stale.evaluate('''async url=>{
          await VoiceOfMLReaderStore.put({url,title:'synthetic stale update',lastReadAt:9999,chapterOffset:5});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-mark',url,label:'synthetic stale mark',createdAt:1});
        }''', OLD_URL)
        after = current.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          marks:await VoiceOfMLReaderStore.listBookmarks(url)})''', OLD_URL)
        self.assertEqual(after['history']['chapterOffset'], 5)
        self.assertEqual(after['marks'][0]['label'], 'synthetic stale mark')
        self.assertEqual(self.external, [])

    def test_local_readonly_warning_does_not_fence_an_old_tab(self):
        stale, current = self.page(old=True), self.page()
        self.seed(current)
        previous = current.evaluate('url=>VoiceOfMLReaderStore.localLegacyRecords(url)', OLD_URL)
        self.assertEqual(previous['history'][0]['chapterOffset'], 123456)
        self.assertEqual(previous['bookmarks'][0]['label'], 'synthetic old mark')
        stale.evaluate('''async url=>{
          await VoiceOfMLReaderStore.put({url,title:'synthetic stale update',lastReadAt:9999,chapterOffset:5});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-mark',url,label:'synthetic stale mark',createdAt:1});
        }''', OLD_URL)
        observed = current.evaluate('url=>VoiceOfMLReaderStore.localLegacyRecords(url)', OLD_URL)
        self.assertEqual(observed['history'][0]['chapterOffset'], 5)
        self.assertEqual(observed['bookmarks'][0]['label'], 'synthetic stale mark')
        self.assertEqual(self.external, [])

    def test_local_transaction_refuses_overwriting_late_old_history(self):
        """Two-tab local candidate checks the existing row in the write tx."""
        stale, current = self.page(old=True), self.page()
        current.evaluate('''async ({old,neo})=>{
          window.__legacyBefore=await VoiceOfMLReaderStore.localLegacyRecords(old);
          window.__oldUrl=old;window.__newUrl=neo;
        }''', {'old': OLD_URL, 'neo': NEW_URL})
        self.assertEqual(current.evaluate('window.__legacyBefore'), {'history': [], 'bookmarks': []})
        self.seed(stale)
        before = current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL)
        error = current.evaluate('''async ({old,neo})=>{
          try { await VoiceOfMLReaderStore.put({url:old,title:'synthetic new version',lastReadAt:10000,
            chapterManifest:neo,chapterIndex:2,chapterOffset:7}); return ''; }
          catch(error){return error.name;}
        }''', {'old': OLD_URL, 'neo': NEW_URL})
        after = current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL)
        self.assertEqual(before['chapterOffset'], 123456)
        self.assertEqual(error, 'LocalLegacyHistoryError')
        self.assertEqual(after, before)
        self.assertEqual(self.external, [])

    def test_local_transaction_refuses_old_foliate_records_and_allows_same_split(self):
        current = self.page()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        current.evaluate('''url=>VoiceOfMLReaderStore.put({url,title:'synthetic Foliate',lastReadAt:1,
          extension:'epub',cfi:'epubcfi(/6/4!/4/2:5)',foliateSection:2,foliateOffset:1234})''', original)
        before = current.evaluate('url=>VoiceOfMLReaderStore.get(url)', original)
        error = current.evaluate('''async ({url,neo})=>{
          try {await VoiceOfMLReaderStore.put({url,lastReadAt:2,chapterManifest:neo,chapterIndex:2,chapterOffset:7});return '';}
          catch(error){return error.name;}
        }''', {'url': original, 'neo': NEW_URL})
        self.assertEqual(error, 'LocalLegacyHistoryError')
        self.assertEqual(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', original), before)
        current.evaluate('''async ({url,neo})=>{
          await VoiceOfMLReaderStore.put({url,lastReadAt:1,chapterManifest:neo,chapterIndex:2,chapterOffset:7});
          await VoiceOfMLReaderStore.put({url,lastReadAt:2,chapterManifest:neo,chapterIndex:2,chapterOffset:8});
        }''', {'url': NEW_URL, 'neo': NEW_URL})
        self.assertEqual(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', NEW_URL)['chapterOffset'], 8)
        self.assertEqual(self.external, [])

    def test_local_transaction_refuses_overwriting_late_old_bookmark(self):
        """Existing bookmark ID is checked in the same local write tx."""
        stale, current = self.page(old=True), self.page()
        self.assertEqual(current.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', OLD_URL), [])
        stale.evaluate('''url=>VoiceOfMLReaderStore.putBookmark({id:url+'\\0chapter:2:123456',url,
          label:'synthetic old',createdAt:1,chapterManifest:url,chapterIndex:2,chapterOffset:123456})''', OLD_URL)
        error = current.evaluate('''async ({old,neo})=>{
          try { await VoiceOfMLReaderStore.putBookmark({id:old+'\\0chapter:2:123456',url:old,
            label:'synthetic new',createdAt:2,chapterManifest:neo,chapterIndex:2,chapterOffset:123456}); return ''; }
          catch(error){return error.name;}
        }''', {'old': OLD_URL, 'neo': NEW_URL})
        marks = current.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', OLD_URL)
        self.assertEqual(len(marks), 1)
        self.assertEqual(error, 'LocalLegacyBookmarkError')
        self.assertEqual(marks[0]['label'], 'synthetic old')
        self.assertEqual(marks[0]['chapterManifest'], OLD_URL)
        self.assertEqual(self.external, [])

    def test_new_bookmark_before_late_old_bookmark_still_gets_replaced(self):
        """An old writer is not fenced when it commits after the new writer."""
        stale, current = self.page(old=True), self.page()
        current.evaluate('''({old,neo})=>VoiceOfMLReaderStore.putBookmark({id:old+'\\0chapter:2:123456',url:old,
          label:'synthetic new',createdAt:2,chapterManifest:neo,chapterIndex:2,chapterOffset:123456})''',
                         {'old': OLD_URL, 'neo': NEW_URL})
        stale.evaluate('''url=>VoiceOfMLReaderStore.putBookmark({id:url+'\\0chapter:2:123456',url,
          label:'synthetic stale overwrite',createdAt:3,chapterManifest:url,chapterIndex:2,chapterOffset:123456})''', OLD_URL)
        marks = current.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', OLD_URL)
        self.assertEqual(len(marks), 1)
        self.assertEqual(marks[0]['label'], 'synthetic stale overwrite')
        self.assertEqual(marks[0]['chapterManifest'], OLD_URL)
        self.assertEqual(self.external, [])

    def test_history_arriving_between_clear_check_and_clear_aborts_local_transaction(self):
        """The local guarded clear must include check and writes in one tx."""
        stale, current = self.page(old=True), self.page()
        self.assertEqual(current.evaluate('()=>VoiceOfMLReaderStore.localLegacyHistoryCount()'), 0)
        self.seed(stale)
        before = current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL)
        self.assertIsNotNone(before)
        error = current.evaluate('''async()=>{try{await VoiceOfMLReaderStore.localClearHistoryIfNoLegacy();return '';}
          catch(error){return error.name;}}''')
        self.assertEqual(error, 'LocalLegacyHistoryError')
        self.assertEqual(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL), before)
        self.assertEqual(len(current.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', OLD_URL)), 1)
        self.assertEqual(self.external, [])

    def test_guarded_clear_rolls_back_earlier_deletes_and_allows_normal_clear(self):
        current = self.page()
        earlier = 'https://example.invalid/a-synthetic-history'
        current.evaluate('''async ({old,earlier})=>{
          await VoiceOfMLReaderStore.put({url:earlier,title:'synthetic unrelated',lastReadAt:1});
          await VoiceOfMLReaderStore.put({url:old,title:'synthetic old',lastReadAt:2});
        }''', {'old': OLD_URL, 'earlier': earlier})
        before = current.evaluate('''async ({old,earlier})=>({old:await VoiceOfMLReaderStore.get(old),
          other:await VoiceOfMLReaderStore.get(earlier)})''', {'old': OLD_URL, 'earlier': earlier})
        error = current.evaluate('''async()=>{try{await VoiceOfMLReaderStore.localClearHistoryIfNoLegacy();return '';}
          catch(error){return error.name;}}''')
        self.assertEqual(error, 'LocalLegacyHistoryError')
        after = current.evaluate('''async ({old,earlier})=>({old:await VoiceOfMLReaderStore.get(old),
          other:await VoiceOfMLReaderStore.get(earlier)})''', {'old': OLD_URL, 'earlier': earlier})
        self.assertEqual(after, before)
        # Remove only this disposable fixture's old row, then confirm ordinary
        # history still clears when no reviewed legacy record exists.
        current.evaluate('url=>VoiceOfMLReaderStore.remove(url)', OLD_URL)
        current.evaluate('()=>VoiceOfMLReaderStore.localClearHistoryIfNoLegacy()')
        self.assertIsNone(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', earlier))
        self.assertEqual(self.external, [])

    def test_guarded_clear_cannot_recognize_legacy_foliate_without_manifest(self):
        """The experimental clear still cannot identify an unbound old CFI."""
        current = self.page()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        current.evaluate('''url=>VoiceOfMLReaderStore.put({url,title:'synthetic old Foliate',extension:'epub',
          lastReadAt:1,cfi:'epubcfi(/6/4!/4/2:5)',foliateSection:2,foliateOffset:1234})''', original)
        self.assertIsNotNone(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', original))
        self.assertEqual(current.evaluate('()=>VoiceOfMLReaderStore.localLegacyHistoryCount()'), 0)
        current.evaluate('()=>VoiceOfMLReaderStore.localClearHistoryIfNoLegacy()')
        self.assertIsNone(current.evaluate('url=>VoiceOfMLReaderStore.get(url)', original))
        self.assertEqual(self.external, [])

    def test_old_version_fence_does_not_capture_original_source_manifest_record(self):
        """A previous isolated v4 fence excludes valid old-manifest identities."""
        experiment = Path('/tmp/opencode/reader-jxl-gc-20261025/chm-idb-fence-experiment.mjs').read_bytes()
        self.context.route('**/chm-idb-fence-experiment.mjs', lambda route: route.fulfill(
            status=200, content_type='text/javascript', body=experiment))
        stale, current = self.page(old=True), self.page()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        current.evaluate('''async ({url,old})=>{
          await VoiceOfMLReaderStore.put({url,title:'synthetic old source',extension:'epub-chapters',
            lastReadAt:100,chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-fenced-mark',url,label:'synthetic old mark',
            createdAt:100,chapterManifest:old,chapterIndex:2,chapterOffset:123456});
        }''', {'url': original, 'old': OLD_URL})
        before = current.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        result = current.evaluate('''async()=>{
          const mod=await import('/chm-idb-fence-experiment.mjs');
          try{return {ok:true,value:await mod.installFence()};}
          catch(error){return {ok:false,error:error.message};}
        }''')
        self.assertTrue(result['ok'], result)
        self.assertEqual((result['value']['historyCount'], result['value']['bookmarkCount']), (0, 0))
        state = current.evaluate('''async url=>{
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('voiceofml-reader');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const tx=db.transaction(['entries','bookmarks','chm-legacy-fence-experiment'],'readonly');
          const history=tx.objectStore('entries').get(url),marks=tx.objectStore('bookmarks').getAll();
          const snapshot=tx.objectStore('chm-legacy-fence-experiment').getAll();
          await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
          const out={version:db.version,history:history.result,marks:marks.result,snapshot:snapshot.result};
          db.close();return out;
        }''', original)
        self.assertEqual(state['version'], 4)
        self.assertEqual(state['history'], before['history'])
        self.assertEqual(state['marks'], before['bookmarks'])
        self.assertFalse(any(row.get('kind') in {'history', 'bookmark'} for row in state['snapshot']))
        old_reader = stale.evaluate('''async()=>{try{await VoiceOfMLReaderStore.list();return 'unexpected';}
          catch(error){return error.name;}}''')
        self.assertEqual(old_reader, 'VersionError')
        self.assertEqual(self.external, [])
        print(json.dumps({'event': 'local-fence-unmatched-record', 'old_reader': old_reader,
                          'history_captured': 0, 'bookmarks_captured': 0, 'remote_mutations': 0}), flush=True)

    def test_same_url_records_are_separate_between_origins(self):
        first, second = self.page(), self.page(origin=self.other_origin)
        self.seed(first)
        self.assertIsNotNone(first.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL))
        self.assertIsNone(second.evaluate('url=>VoiceOfMLReaderStore.get(url)', OLD_URL))
        self.assertEqual(second.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', OLD_URL), [])
        self.assertEqual(self.external, [])

    def test_url_encodings_are_distinct_idb_keys_even_with_same_path(self):
        page = self.page()
        self.seed(page)
        result = page.evaluate('''async ({old,encoded})=>({
          samePath:new URL(old).searchParams.get('path') === new URL(encoded).searchParams.get('path'),
          old:await VoiceOfMLReaderStore.get(old), encoded:await VoiceOfMLReaderStore.get(encoded),
          oldBookmarks:await VoiceOfMLReaderStore.listBookmarks(old),
          encodedBookmarks:await VoiceOfMLReaderStore.listBookmarks(encoded)})''',
                               {'old': OLD_URL, 'encoded': OLD_ENCODED})
        self.assertTrue(result['samePath'])
        self.assertEqual(result['old']['chapterOffset'], 123456)
        self.assertEqual(len(result['oldBookmarks']), 1)
        self.assertIsNone(result['encoded'])
        self.assertEqual(result['encodedBookmarks'], [])
        self.assertEqual(self.external, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
