"""New-client-only CHM shared-resource isolation, disposable browser profile."""
import unittest
from urllib.parse import urlencode

from tests import test_chm_history_retarget_diagnostic_20261105 as history
from tests import test_chm_local_search_compat_20261105 as compat


class NewClientBooks(unittest.TestCase):
    setUpClass = classmethod(compat.LocalChmSearchIntegration.setUpClass.__func__)
    tearDownClass = classmethod(compat.LocalChmSearchIntegration.tearDownClass.__func__)
    setUp = compat.LocalChmSearchIntegration.setUp
    tearDown = compat.LocalChmSearchIntegration.tearDown
    local_only = compat.LocalChmSearchIntegration.local_only
    bucket = compat.LocalChmSearchIntegration.bucket

    @staticmethod
    def paths(index=0):
        row = compat.fixture.PROOF['bundles'][index]
        source = row['source_root'].split('/')[3]
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': path})
        return (url(row['source_root'] + '/chapter-manifest.json'),
                url(f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"))

    def seed_store(self):
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))

    def open_url(self, **params):
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode(params)
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        return self.page.locator('html').get_attribute('data-reader-phase')

    def open_panel(self, tab):
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#' + tab + '-tab').evaluate('node=>node.click()')

    def test_legacy_direct_manifest_opens_without_reusing_old_or_shared_records(self):
        old, new = self.paths()
        self.seed_store()
        self.page.evaluate('''async ({old,neo})=>{
          await VoiceOfMLReaderStore.put({url:old,title:'old direct history',lastReadAt:10,
            chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'old direct mark',url:old,label:'old direct mark',createdAt:10,
            chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.put({url:neo,title:'unknown shared history',lastReadAt:11,
            chapterManifest:neo,chapterIndex:3,chapterOffset:200});
        }''', {'old': old, 'neo': new})
        before = self.page.evaluate('''async ({old,neo})=>({old:await VoiceOfMLReaderStore.get(old),
          marks:await VoiceOfMLReaderStore.listBookmarks(old),shared:await VoiceOfMLReaderStore.get(neo)})''',
                                    {'old': old, 'neo': new})
        self.assertEqual(self.open_url(url=old, ext='epub-chapters'), 'ready')
        key = self.page.evaluate('url=>VoiceOfMLReaderStore.localBookRecordKey("",url)', old)
        self.assertNotIn(key, (old, new))
        self.page.evaluate('''key=>{window.__directBookSaved=false;window.__directBookTimer=setInterval(async()=>{
          if(await VoiceOfMLReaderStore.get(key)) window.__directBookSaved=true;
        },50)}''', key)
        try:
            self.page.wait_for_function('()=>window.__directBookSaved === true', timeout=30000)
        finally:
            self.page.evaluate('()=>clearInterval(window.__directBookTimer)')
        self.assertIsNotNone(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key))
        self.page.locator('#bookmark-ribbon').evaluate('node=>node.click()')
        self.page.locator('#bookmark-add').evaluate('node=>node.click()')
        self.page.wait_for_function("()=>document.querySelector('#bookmark-popover').hidden", timeout=30000)
        marks = self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key)
        self.assertEqual(len(marks), 1)
        self.assertEqual(marks[0]['chapterManifest'], new)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.localBookRecordKey("",url)', new), key)
        self.assertEqual(self.page.evaluate('''async ({old,neo})=>({old:await VoiceOfMLReaderStore.get(old),
          marks:await VoiceOfMLReaderStore.listBookmarks(old),shared:await VoiceOfMLReaderStore.get(neo)})''',
                                            {'old': old, 'neo': new}), before)
        self.assertEqual(self.open_url(url=new, ext='epub-chapters'), 'ready')
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key), marks)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', new), before['shared'])
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_legacy_source_with_unrelated_new_manifest_does_not_share_direct_history(self):
        old, _ = self.paths()
        _, other = self.paths(1)
        self.seed_store()
        self.page.evaluate('''async old=>VoiceOfMLReaderStore.put({url:old,title:'old history',lastReadAt:1,
          chapterManifest:old,chapterIndex:2,chapterOffset:123456})''', old)
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
        self.assertEqual(self.open_url(url=old, chapter_manifest=other, ext='epub-chapters'), 'failed')
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
        self.assertEqual(self.external, [])

    def test_shared_legacy_rows_are_ambiguous_in_all_books_view(self):
        old, shared = self.paths()
        _, unrelated = self.paths(1)
        self.seed_store()
        self.page.evaluate('''async ({old,shared})=>{
          await VoiceOfMLReaderStore.put({url:shared,title:'unknown shared history',lastReadAt:10,
            chapterManifest:shared,readerUrl:location.href});
          await VoiceOfMLReaderStore.putBookmark({id:'shared mark',url:shared,label:'unknown shared mark',
            createdAt:10,chapterManifest:shared,readerUrl:location.href});
          await VoiceOfMLReaderStore.put({url:old,title:'old history',lastReadAt:11,chapterManifest:old});
        }''', {'old': old, 'shared': shared})
        before = self.page.evaluate('''async ({old,shared})=>({old:await VoiceOfMLReaderStore.get(old),
          shared:await VoiceOfMLReaderStore.get(shared),marks:await VoiceOfMLReaderStore.listBookmarks(shared)})''',
                                    {'old': old, 'shared': shared})
        self.assertEqual(self.open_url(url=unrelated, ext='epub-chapters'), 'ready')
        self.open_panel('bookmarks')
        self.page.locator('#bookmarks-all').evaluate('node=>node.click()')
        row = self.page.locator('#bookmarks-list .panel-item').filter(has_text='unknown shared mark')
        row.wait_for()
        self.assertIn('来源未确认', row.inner_text())
        self.assertEqual(row.locator('.panel-item-edit').count(), 0)
        self.assertEqual(row.locator('.panel-item-remove').count(), 0)
        row.locator('.panel-item-main').evaluate('node=>node.click()')
        self.assertIn('旧书签位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        self.open_panel('history')
        row = self.page.locator('#history-list .panel-item').filter(has_text='unknown shared history')
        row.wait_for()
        self.assertIn('来源未确认', row.inner_text())
        self.assertEqual(row.locator('.panel-item-remove').count(), 0)
        self.assertEqual(self.page.evaluate('''async ({old,shared})=>({old:await VoiceOfMLReaderStore.get(old),
          shared:await VoiceOfMLReaderStore.get(shared),marks:await VoiceOfMLReaderStore.listBookmarks(shared)})''',
                                            {'old': old, 'shared': shared}), before)
        self.assertEqual(self.external, [])

    def test_clear_history_requires_confirmation_and_keeps_bookmarks(self):
        old, shared = self.paths()
        _, current = self.paths(1)
        self.seed_store()
        self.page.evaluate('''async ({old,shared})=>{
          await VoiceOfMLReaderStore.put({url:old,title:'old history',lastReadAt:10,chapterManifest:old});
          await VoiceOfMLReaderStore.put({url:shared,title:'unknown shared history',lastReadAt:11,chapterManifest:shared});
          await VoiceOfMLReaderStore.putBookmark({id:'old mark',url:old,label:'keep mark',createdAt:10,chapterManifest:old});
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('voiceofml-reader');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          await new Promise((resolve,reject)=>{const tx=db.transaction('entries','readwrite');
            tx.objectStore('entries').put({url:'future-record',schemaVersion:999,lastReadAt:12,payload:'keep'});
            tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
        }''', {'old': old, 'shared': shared})
        self.assertEqual(self.open_url(url=current, ext='epub-chapters'), 'ready')
        before = self.page.evaluate('''async ({old,shared})=>({old:await VoiceOfMLReaderStore.get(old),
          shared:await VoiceOfMLReaderStore.get(shared),marks:await VoiceOfMLReaderStore.listBookmarks(old)})''',
                                    {'old': old, 'shared': shared})
        self.open_panel('history')
        dialogs = []
        def reject(dialog):
            dialogs.append(dialog.message)
            dialog.dismiss()
        self.page.once('dialog', reject)
        self.page.locator('#history-clear').evaluate('node=>node.click()')
        self.page.wait_for_timeout(300)
        self.assertEqual(dialogs, ['清空全部阅读历史？'])
        self.assertEqual(self.page.evaluate('''async ({old,shared})=>({old:await VoiceOfMLReaderStore.get(old),
          shared:await VoiceOfMLReaderStore.get(shared),marks:await VoiceOfMLReaderStore.listBookmarks(old)})''',
                                            {'old': old, 'shared': shared}), before)
        def accept(dialog):
            dialogs.append(dialog.message)
            dialog.accept()
        self.page.once('dialog', accept)
        self.page.locator('#history-clear').evaluate('node=>node.click()')
        self.page.wait_for_function("()=>document.querySelector('#history-list').textContent.includes('暂无阅读记录')", timeout=30000)
        self.page.wait_for_timeout(800)
        after = self.page.evaluate('''async ({old,shared,current})=>{
          const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('voiceofml-reader');
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
          const raw=await new Promise((resolve,reject)=>{const tx=db.transaction('entries');
            const req=tx.objectStore('entries').getAll();tx.oncomplete=()=>resolve(req.result);tx.onabort=()=>reject(tx.error);});
          db.close();return {old:await VoiceOfMLReaderStore.get(old),shared:await VoiceOfMLReaderStore.get(shared),
            current:await VoiceOfMLReaderStore.get(current),marks:await VoiceOfMLReaderStore.listBookmarks(old),raw};
        }''', {'old': old, 'shared': shared, 'current': current})
        self.assertEqual(dialogs, ['清空全部阅读历史？', '清空全部阅读历史？'])
        self.assertIsNone(after['old'])
        self.assertIsNone(after['shared'])
        self.assertIsNone(after['current'])
        self.assertEqual(after['marks'], before['marks'])
        self.assertEqual(after['raw'], [{'url': 'future-record', 'schemaVersion': 999, 'lastReadAt': 12, 'payload': 'keep'}])
        self.assertEqual(self.external, [])

    def test_shared_book_id_rejects_other_original_even_on_explicit_url(self):
        _, shared = self.paths()
        first, second = '29b1i0i45mj7g', '0bkdmor8l52rg'
        self.seed_store()
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': first, 'url': shared})
        self.page.evaluate('''({key,shared})=>VoiceOfMLReaderStore.put({url:key,title:'first book history',
          lastReadAt:10,chapterManifest:shared,chapterIndex:3,chapterOffset:100})''', {'key': key, 'shared': shared})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        phase = self.open_url(id=first, url=shared, download=history.source_url(second), ext='epub-chapters')
        self.assertEqual(phase, 'failed')
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.assertEqual(self.external, [])

    def test_shared_book_id_rejects_other_original_in_fresh_session_cache(self):
        _, shared = self.paths()
        first, second = '29b1i0i45mj7g', '0bkdmor8l52rg'
        self.seed_store()
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': first, 'url': shared})
        self.page.evaluate('''async ({key,shared,id,download})=>{
          await VoiceOfMLReaderStore.put({url:key,title:'first book history',lastReadAt:10,
            chapterManifest:shared,chapterIndex:3,chapterOffset:100});
          sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({url:shared,chapter_manifest:shared,download,
            extension:'epub-chapters',original_extension:'chm'}));
        }''', {'key': key, 'shared': shared, 'id': first, 'download': history.source_url(second)})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_url(id=first, ext='epub-chapters'), 'failed')
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.assertEqual(self.external, [])

    def test_unknown_book_id_cannot_overwrite_shared_manifest_history(self):
        _, shared = self.paths()
        self.seed_store()
        self.page.evaluate('''async ({shared})=>{
          await VoiceOfMLReaderStore.put({url:shared,title:'unknown shared history',lastReadAt:10,
            chapterManifest:shared,chapterIndex:3,chapterOffset:200});
          sessionStorage.setItem('reader-resolve:unknown-book-id',JSON.stringify({url:shared,chapter_manifest:shared,
            download:'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/other.chm',
            extension:'epub-chapters',original_extension:'chm'}));
        }''', {'shared': shared})
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', shared)
        self.assertEqual(self.open_url(id='unknown-book-id', ext='epub-chapters'), 'failed')
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', shared), before)
        self.assertEqual(self.external, [])

    def test_shared_book_rejects_mismatched_manifest_bookmark_at_its_own_key(self):
        old, shared = self.paths()
        first = '29b1i0i45mj7g'
        self.seed_store()
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': first, 'url': shared})
        self.page.evaluate('''async ({key,old,shared,id,download})=>{
          await VoiceOfMLReaderStore.putBookmark({id:'old-in-new-key',url:key,label:'old-in-new-key',createdAt:10,
            chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({url:shared,chapter_manifest:shared,download,
            extension:'epub-chapters',original_extension:'chm'}));
        }''', {'key': key, 'old': old, 'shared': shared, 'id': first, 'download': history.source_url(first)})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key)
        self.assertEqual(self.open_url(id=first, ext='epub-chapters', bookmark='old-in-new-key', bookmark_source=key), 'ready')
        self.assertIn('旧书签', self.page.locator('#download-feedback').inner_text())
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key), before)
        self.open_panel('bookmarks')
        row = self.page.locator('#bookmarks-list .panel-item').filter(has_text='old-in-new-key')
        row.wait_for()
        self.assertEqual(row.locator('.panel-item-edit').count(), 0)
        self.assertEqual(row.locator('.panel-item-remove').count(), 0)
        self.assertEqual(self.external, [])

    def test_shared_book_keeps_mismatched_history_at_its_own_key(self):
        old, shared = self.paths()
        first = '29b1i0i45mj7g'
        self.seed_store()
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': first, 'url': shared})
        self.page.evaluate('''async ({key,old,shared,id,download})=>{
          await VoiceOfMLReaderStore.put({url:key,title:'old-in-new-history',lastReadAt:10,
            chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({url:shared,chapter_manifest:shared,download,
            extension:'epub-chapters',original_extension:'chm'}));
        }''', {'key': key, 'old': old, 'shared': shared, 'id': first, 'download': history.source_url(first)})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_url(id=first, ext='epub-chapters'), 'ready')
        self.assertIn('旧阅读位置', self.page.locator('#download-feedback').inner_text())
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.open_panel('history')
        row = self.page.locator('#history-list .panel-item').filter(has_text='old-in-new-history')
        row.wait_for()
        self.assertIn('旧版位置', row.inner_text())
        self.assertEqual(row.locator('.panel-item-remove').count(), 0)
        self.assertEqual(self.external, [])

    def test_shared_bundle_uses_distinct_new_records_and_keeps_old_record(self):
        first, second = '29b1i0i45mj7g', '0bkdmor8l52rg'
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        resource = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        keys = self.page.evaluate('''({first,second,resource})=>({first:VoiceOfMLReaderStore.localBookRecordKey(first,resource),
          second:VoiceOfMLReaderStore.localBookRecordKey(second,resource),
          unknown:VoiceOfMLReaderStore.localBookRecordKey('unknown',resource)})''',
                                  {'first': first, 'second': second, 'resource': resource})
        self.assertNotEqual(keys['first'], keys['second'])
        self.assertNotEqual(keys['first'], resource)
        self.assertEqual(keys['unknown'], resource)
        self.page.evaluate('''async ({firstKey,resource})=>{
          await VoiceOfMLReaderStore.put({url:resource,title:'synthetic shared old key',lastReadAt:10,
            chapterManifest:resource,chapterIndex:3,chapterOffset:200});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic shared old mark',url:resource,
            label:'synthetic shared old mark',createdAt:10,chapterManifest:resource,chapterIndex:3,chapterOffset:200});
          await VoiceOfMLReaderStore.put({url:firstKey,title:'synthetic first book',lastReadAt:20,
            chapterManifest:resource,chapterIndex:2,chapterOffset:0});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic first mark',url:firstKey,
            label:'synthetic first mark',createdAt:20,chapterManifest:resource,chapterIndex:2,chapterOffset:0});
        }''', {'firstKey': keys['first'], 'resource': resource})
        before = self.page.evaluate('''async ({firstKey,resource})=>({old:await VoiceOfMLReaderStore.get(resource),
          oldBookmarks:await VoiceOfMLReaderStore.listBookmarks(resource),first:await VoiceOfMLReaderStore.get(firstKey),
          firstBookmarks:await VoiceOfMLReaderStore.listBookmarks(firstKey)})''',
                                    {'firstKey': keys['first'], 'resource': resource})

        def go(reader_id):
            self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
            self.page.evaluate('''({id,resource,download})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
              url:resource,chapter_manifest:resource,download,extension:'epub-chapters',original_extension:'chm'}))''',
                               {'id': reader_id, 'resource': resource, 'download': history.source_url(reader_id)})
            target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
                'id': reader_id, 'ext': 'epub-chapters'})
            self.page.goto(target, wait_until='domcontentloaded')
            self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
            self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')

        go(second)
        self.page.evaluate('''url=>{
          window.__newBookSaved=false;window.__newBookTimer=setInterval(async()=>{
            if(await VoiceOfMLReaderStore.get(url))window.__newBookSaved=true;
          },100);
        }''', keys['second'])
        try:
            self.page.wait_for_function('()=>window.__newBookSaved===true', timeout=30000)
        finally:
            self.page.evaluate('()=>clearInterval(window.__newBookTimer)')
        if self.page.locator('#history').get_attribute('aria-expanded') == 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmark-ribbon').evaluate('node=>node.click()')
        self.page.locator('#bookmark-add').evaluate('node=>node.click()')
        self.page.wait_for_function("()=>document.querySelector('#bookmark-popover').hidden", timeout=30000)
        marks = self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', keys['second'])
        self.assertEqual(len(marks), 1)
        self.assertEqual(marks[0]['chapterManifest'], resource)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', resource), before['old'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', resource), before['oldBookmarks'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', keys['first']), before['first'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', keys['first']), before['firstBookmarks'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.localBookRecordKey("0bkdmor8l52rg",url)', resource), keys['second'])
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        ambiguous = self.page.locator('#bookmarks-list .panel-item').filter(has_text='synthetic shared old mark')
        ambiguous.wait_for()
        self.assertIn('来源未确认', ambiguous.inner_text())
        self.assertEqual(ambiguous.locator('.panel-item-edit').count(), 0)
        self.assertEqual(ambiguous.locator('.panel-item-remove').count(), 0)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', resource), before['oldBookmarks'])
        # Reopen A and B in this same disposable profile. B must not rewrite A
        # or the pre-existing shared-key record simply by opening/scrolling.
        go(first)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', resource), before['old'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', keys['first']), before['firstBookmarks'])
        self.page.wait_for_timeout(700)
        after_first = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', keys['first'])
        go(second)
        self.page.wait_for_timeout(700)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', keys['first']), after_first)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', resource), before['old'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', keys['second']), marks)
        # A saved link selects B's new record, not the shared resource or A.
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({id,resource,download})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:resource,chapter_manifest:resource,download,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'id': second, 'resource': resource, 'download': history.source_url(second)})
        bookmark_url = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': second, 'ext': 'epub-chapters', 'bookmark': marks[0]['id'], 'bookmark_source': keys['second']})
        self.page.goto(bookmark_url, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        geometry = self.page.evaluate('''index=>{const v=document.querySelector('#viewport');
          const ch=document.querySelector(`.reader-epub-chapter[data-chapter="${index}"]`);
          return {scrollTop:v.scrollTop,scrollHeight:v.scrollHeight,clientHeight:v.clientHeight,
            chapter:ch && {height:ch.getBoundingClientRect().height,
              top:ch.getBoundingClientRect().top-v.getBoundingClientRect().top}}}''', marks[0]['chapterIndex'])
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"),
                          msg=f"mark={marks[0]} feedback={self.page.locator('#download-feedback').inner_text()} "
                              f"geometry={geometry}")
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', keys['first']), after_first)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', resource), before['old'])
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({id,resource,download})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:resource,chapter_manifest:resource,download,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'id': second, 'resource': resource, 'download': history.source_url(second)})
        legacy_url = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': second, 'ext': 'epub-chapters', 'bookmark': 'synthetic shared old mark', 'bookmark_source': resource})
        self.page.goto(legacy_url, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"))
        self.assertIn('旧书签来源或位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', resource), before['oldBookmarks'])
        self.assertEqual(self.external, [])


if __name__ == '__main__':
    unittest.main()
