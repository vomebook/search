"""Test the local-only saved-bookmark warning and storage guard prototype.

All Reader assets are fulfilled by the existing loopback-only test fixture.
The database, records and source IDs are synthetic; no actual user record or
online object is read or modified. Older tabs and deployed clients are not
fenced by this prototype, so passing these tests is not publication approval.
"""
import hashlib
import json
import subprocess
import unittest
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from tests import test_chm_local_search_compat_20261105 as compat


SOURCE_RECORDS = {
    '29b1i0i45mj7g': ('VOMEBOOK', '马列之声ebook小组第二批成果集成赞助部分/jiang/各种版本的《毛泽东思想万岁》/武汉版《毛泽东思想万岁》/《毛泽东思想万岁》全五卷.CHM'),
    '0bkdmor8l52rg': ('VOMEBOOK', '马列之声ebook小组第三批成果集成赞助部分/jiang2-贡献/武汉版《Mao思想万岁》/武汉版《毛泽东思想万岁》/《毛泽东思想万岁》全五卷.CHM'),
    '1nd5z6md7qzl6': ('MLMRL-Hub', '000266/1870520043_3044_《毛泽东思想万岁》.chm'),
    '13i6hffuvzujn': ('MLMRL-Library', '安全培训/维基备份/软件/综合性资料/编程随想的博客/军事/军事/现代军事史/二战/(综合)/阿诺德·汤因比 (主编)：第二次世界大战战史大全.chm'),
}


def source_url(reader_id):
    repo, path = SOURCE_RECORDS[reader_id]
    return f'https://huggingface.co/datasets/VoiceOfML/{repo}/resolve/main/' + quote(path, safe='/')


class HistoryRetargetDiagnostic(unittest.TestCase):
    setUpClass = classmethod(compat.LocalChmSearchIntegration.setUpClass.__func__)
    tearDownClass = classmethod(compat.LocalChmSearchIntegration.tearDownClass.__func__)
    setUp = compat.LocalChmSearchIntegration.setUp
    tearDown = compat.LocalChmSearchIntegration.tearDown
    local_only = compat.LocalChmSearchIntegration.local_only
    bucket = compat.LocalChmSearchIntegration.bucket

    def wait_for_record(self, url, *, bookmark_count=None):
        """Wait with a synchronous predicate, then check the observed IDB state."""
        self.page.evaluate('''({url,count})=>{
          window.__syntheticRecordReady=false;
          window.__syntheticRecordCheck=setInterval(async()=>{
            const ready=count===null ? !!(await VoiceOfMLReaderStore.get(url)) :
              (await VoiceOfMLReaderStore.listBookmarks(url)).length===count;
            if(ready) window.__syntheticRecordReady=true;
          },100);
        }''', {'url': url, 'count': bookmark_count})
        try:
            self.page.wait_for_function('()=>window.__syntheticRecordReady === true', timeout=30000)
        finally:
            self.page.evaluate('()=>clearInterval(window.__syntheticRecordCheck)')
        return self.page.evaluate('''async ({url,count})=>count===null ? VoiceOfMLReaderStore.get(url) :
          VoiceOfMLReaderStore.listBookmarks(url)''', {'url': url, 'count': bookmark_count})

    def test_short_id_contract_vectors_for_four_observed_originals(self):
        """Check the local contract against four independently observed source URLs."""
        originals = [source_url(key) for key in SOURCE_RECORDS]
        self.page.goto(self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': self.bucket_url_for_test(), 'ext': 'epub-chapters'}), wait_until='domcontentloaded')
        ids = self.page.evaluate('urls=>urls.map(url=>VoiceOfMLReader.shortSourceId(url))', originals)
        self.assertEqual(ids, list(SOURCE_RECORDS))
        self.assertEqual(self.external, [])

    @staticmethod
    def bucket_url_for_test():
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})

    def test_id_resolved_new_manifest_does_not_restore_old_manifest_bookmark(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        path = row['source_root'] + '/chapter-manifest.json'
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': path})
        old_slash = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + path
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        reader_id = '29b1i0i45mj7g'
        saved_reader_url = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': reader_id, 'ext': 'epub-chapters'})

        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,oldSlash,readerUrl})=>{
          await VoiceOfMLReaderStore.put({url:old,readerUrl,title:'synthetic old progress',
            extension:'epub-chapters',lastReadAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
          await VoiceOfMLReaderStore.put({url:oldSlash,readerUrl,title:'synthetic slash progress',
            extension:'epub-chapters',lastReadAt:101,chapterIndex:2,chapterManifest:oldSlash,chapterOffset:54321});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-old-mark',url:old,readerUrl,
            label:'synthetic old bookmark',createdAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-slash-mark',url:oldSlash,readerUrl,
            label:'synthetic slash bookmark',createdAt:101,chapterIndex:2,chapterManifest:oldSlash,chapterOffset:54321});
        }''', {'old': old, 'oldSlash': old_slash, 'readerUrl': saved_reader_url})
        before = self.page.evaluate('''async ({old,oldSlash})=>({history:await VoiceOfMLReaderStore.get(old),
          slashHistory:await VoiceOfMLReaderStore.get(oldSlash),bookmarks:await VoiceOfMLReaderStore.listBookmarks(old),
          slashBookmarks:await VoiceOfMLReaderStore.listBookmarks(oldSlash)})''', {'old': old, 'oldSlash': old_slash})
        self.assertEqual(before['bookmarks'][0]['chapterOffset'], 123456)

        metadata = {'url': new, 'chapter_manifest': new, 'download': source_url(reader_id), 'extension': 'epub-chapters',
                    'original_extension': 'chm', 'title': 'synthetic split book'}
        self.page.evaluate('''({key,value})=>sessionStorage.setItem(key,JSON.stringify(value))''',
                           {'key': 'reader-resolve:' + reader_id, 'value': metadata})
        target = saved_reader_url + '&' + urlencode({'bookmark': 'synthetic-old-mark', 'bookmark_source': old})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': reader_id, 'url': new})
        self.assertIsNotNone(self.wait_for_record(key))
        after = self.page.evaluate('''async ({old,oldSlash,key})=>({oldHistory:await VoiceOfMLReaderStore.get(old),
          slashHistory:await VoiceOfMLReaderStore.get(oldSlash),slashBookmarks:await VoiceOfMLReaderStore.listBookmarks(oldSlash),
          oldBookmarks:await VoiceOfMLReaderStore.listBookmarks(old), newHistory:await VoiceOfMLReaderStore.get(key),
          newBookmarks:await VoiceOfMLReaderStore.listBookmarks(key),params:new URL(location.href).searchParams.toString()})''',
                                   {'old': old, 'oldSlash': old_slash, 'key': key})
        self.assertEqual(after['oldHistory'], before['history'])
        self.assertEqual(after['slashHistory'], before['slashHistory'])
        self.assertEqual(after['oldBookmarks'], before['bookmarks'])
        self.assertEqual(after['slashBookmarks'], before['slashBookmarks'])
        self.assertEqual(after['newBookmarks'], [])
        self.assertNotEqual(after['newHistory'].get('chapterOffset'), 123456)
        self.assertNotIn('bookmark=synthetic-old-mark', after['params'])
        self.assertIn('旧书签来源或位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-list .panel-item-main', has_text='synthetic old bookmark').wait_for()
        self.page.locator('#bookmarks-list .panel-item-main', has_text='synthetic slash bookmark').wait_for()
        old_row = self.page.locator('#bookmarks-list .panel-item').filter(has_text='synthetic old bookmark')
        self.assertIn('旧版位置', old_row.inner_text())
        self.assertEqual(old_row.locator('.panel-item-remove').count(), 0)
        self.assertEqual(old_row.locator('.panel-item-edit').count(), 0)
        old_row.locator('.panel-item-main').evaluate('node=>node.click()')
        self.assertIn('旧书签位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        if self.page.locator('#history').get_attribute('aria-expanded') == 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmark-ribbon').evaluate('node=>node.click()')
        self.page.locator('#bookmark-add').evaluate('node=>node.click()')
        self.assertEqual(len(self.wait_for_record(key, bookmark_count=1)), 1)
        new_mark = self.page.evaluate('''async url=>(await VoiceOfMLReaderStore.listBookmarks(url))[0]''', key)
        self.assertEqual(new_mark['chapterManifest'], new)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', old), before['bookmarks'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', old_slash), before['slashBookmarks'])
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_reusing_old_storage_url_with_new_manifest_preserves_old_position(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async old=>{
          await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',extension:'epub-chapters',
            lastReadAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-existing-mark',url:old,label:'keep existing',
            createdAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
        }''', old)
        saved = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
        saved_marks = self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', old)
        self.assertEqual(saved['chapterManifest'], old)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': old, 'chapter_manifest': new, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.page.wait_for_timeout(900)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), saved)
        self.assertIn('旧阅读位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        self.page.locator('#bookmark-ribbon').evaluate('node=>node.click()')
        self.page.locator('#bookmark-add').evaluate('node=>node.click()')
        self.page.wait_for_function("()=>document.querySelector('#bookmark-popover').hidden")
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', old), saved_marks)
        direct_key = self.page.evaluate('url=>VoiceOfMLReaderStore.localBookRecordKey("",url)', old)
        self.assertEqual(len(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', direct_key)), 1)
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_old_history_panel_and_clear_warn_without_removing_old_record(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async old=>VoiceOfMLReaderStore.put({url:old,title:'synthetic old history',
          extension:'epub-chapters',lastReadAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456})''', old)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': new, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#history-tab').evaluate('node=>node.click()')
        old_row = self.page.locator('#history-list .panel-item').filter(has_text='synthetic old history')
        old_row.wait_for()
        self.assertIn('旧版位置', old_row.inner_text())
        self.assertEqual(old_row.locator('.panel-item-remove').count(), 0)
        old_row.locator('.panel-item-main').evaluate('node=>node.click()')
        self.assertIn('旧阅读位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        dialogs = []
        def dismiss(dialog):
            dialogs.append(dialog.message)
            dialog.dismiss()
        self.page.once('dialog', dismiss)
        self.page.locator('#history-clear').evaluate('node=>node.click()')
        self.page.wait_for_timeout(200)
        self.assertEqual(dialogs, ['清空全部阅读历史？'])
        self.assertIsNotNone(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old))
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_stale_old_source_and_old_manifest_cache_remains_unreadable(self):
        # Establish the pre-experiment counterexample with the original HEAD
        # controller, rather than depending on the loopback prototype.
        module = 'static/reader/formats/reader-format-controller.mjs'
        pristine = subprocess.check_output(['git', 'show', 'HEAD:' + module], cwd=compat.HERE)
        served_pristine = []
        def pristine_controller(route):
            served_pristine.append(True)
            route.fulfill(status=200, content_type='text/javascript', body=pristine)
        self.page.route('**/' + module, pristine_controller)
        row = compat.fixture.PROOF['bundles'][0]
        manifest_path = row['source_root'] + '/chapter-manifest.json'
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': manifest_path})
        manifest_bytes = (compat.fixture.LOCAL / row['source_root'].split('/')[3] / 'chapter-manifest.json').read_bytes()
        self.assertEqual(hashlib.sha256(manifest_bytes).hexdigest(), row['source_manifest_sha256'])
        self.assertGreater(json.loads(manifest_bytes)['chapters'][1]['bytes'], 8 * 1024 * 1024)
        manifest_responses = []
        self.page.on('response', lambda response: manifest_responses.append(response.status)
                     if parse_qs(urlsplit(response.url).query).get('path') == [manifest_path] else None)
        reader_id = 'synthetic-stale-cache'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,id})=>{
          await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',extension:'epub-chapters',
            lastReadAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
          sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({url:old,chapter_manifest:old,
            extension:'epub-chapters',original_extension:'chm',title:'synthetic stale source'}));
        }''', {'old': old, 'id': reader_id})
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertEqual(served_pristine, [True])
        self.assertIn(200, manifest_responses, 'old manifest must have been served, not merely missing')
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_PARSE')
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
        self.assertEqual(self.external, [])

    def test_local_refresh_rejects_matching_manifest_for_unknown_book_id(self):
        """The loopback-only registry rejects a manifest match for an unknown ID."""
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        reader_id = 'synthetic-foreign-id'
        calls = []
        def wrong_resolve(route):
            calls.append(route.request.url)
            route.fulfill(status=200, json={'url': new, 'chapter_manifest': new, 'extension': 'epub-chapters',
                                           'original_extension': 'chm', 'title': 'synthetic wrong book'},
                          headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', wrong_resolve)
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({old,id})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:old,chapter_manifest:old,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'old': old, 'id': reader_id})
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.external, [])

    def test_local_stale_cache_uses_matching_fresh_resolution_without_writing_old_record(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        reader_id = '29b1i0i45mj7g'
        requests, manifests = [], []
        metadata = {'url': new, 'chapter_manifest': new, 'extension': 'epub-chapters',
                    'original_extension': 'chm', 'download': source_url(reader_id), 'title': 'synthetic refreshed book'}
        def resolve(route):
            requests.append({'url': route.request.url, 'method': route.request.method,
                             'headers': route.request.headers})
            route.fulfill(status=200, json=metadata, headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', resolve)
        self.page.add_init_script('''(() => {
          const nativeFetch=window.fetch;
          window.__localResolveCalls=[];
          window.fetch=function(url,init){
            if (String(url).includes('/api/reader-resolve?'))
              window.__localResolveCalls.push({cache:init?.cache||'', credentials:init?.credentials||''});
            return nativeFetch.call(this,url,init);
          };
        })()''')
        self.page.on('response', lambda response: manifests.append(response.status)
                     if parse_qs(urlsplit(response.url).query).get('path') == [
                         f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"] else None)
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,id})=>{
          await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',extension:'epub-chapters',
            lastReadAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
          const stale={url:old,chapter_manifest:old,extension:'epub-chapters',original_extension:'chm'};
          sessionStorage.setItem('reader-resolve:'+id,JSON.stringify(stale));
          sessionStorage.setItem('reader-source:'+id,JSON.stringify(stale));
        }''', {'old': old, 'id': reader_id})
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]['method'], 'GET')
        self.assertEqual(self.page.evaluate('window.__localResolveCalls'), [{'cache': 'no-store', 'credentials': 'omit'}])
        self.assertIn(200, manifests)
        download = parse_qs(urlsplit(self.page.locator('#download').get_attribute('href')).query)['link']
        self.assertEqual(download, [source_url(reader_id)])
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': reader_id, 'url': new})
        self.assertIsNotNone(self.wait_for_record(key))
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
        self.assertIn('旧阅读位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_shared_bundle_refresh_rejects_another_books_original_download(self):
        """The local consistency check rejects swapping the two shared-bundle sources."""
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        reader_id = '29b1i0i45mj7g'
        original_a = source_url(reader_id)
        original_b = source_url('0bkdmor8l52rg')
        fresh = {'url': new, 'chapter_manifest': new, 'download': original_b,
                 'extension': 'epub-chapters', 'original_extension': 'chm', 'title': 'synthetic book B'}
        requests = []
        def resolver(route):
            requests.append(route.request.method)
            route.fulfill(status=200, json=fresh, headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', resolver)
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({id,old,source})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:old,chapter_manifest:old,download:source,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'id': reader_id, 'old': old, 'source': original_a})
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertNotIn(original_b, self.page.locator('#download').get_attribute('href') or '')
        self.assertEqual(requests, ['GET'])
        self.assertEqual(self.external, [])

    def test_source_url_sha_guard_rejects_short_id_spoof(self):
        """Even an artificially matching short ID cannot substitute another URL."""
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        reader_id = '29b1i0i45mj7g'
        foreign = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-other.chm'
        self.assertIn(source, new)
        calls = []
        def resolver(route):
            calls.append(route.request.method)
            route.fulfill(status=200, json={'url': new, 'chapter_manifest': new, 'download': foreign,
                                           'extension': 'epub-chapters', 'original_extension': 'chm',
                                           'title': 'synthetic mismatched source'},
                          headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', resolver)
        # Serve a modified local contract only in this synthetic context. This
        # does not compute a real FNV collision or modify the checkout.
        path = 'static/reader/core/reader-contract.js'
        contract = (compat.HERE / path).read_bytes()
        marker = b'  root.VoiceOfMLReader = Object.freeze({'
        self.assertEqual(contract.count(marker), 1)
        modified = contract.replace(marker,
            b'  shortSourceId = () => "29b1i0i45mj7g";\n' + marker)
        self.page.route('**/' + path, lambda route: route.fulfill(status=200,
                        content_type='text/javascript', body=modified))
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({id,old})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:old,chapter_manifest:old,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'id': reader_id, 'old': old})
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertEqual(self.page.evaluate('(url)=>VoiceOfMLReader.shortSourceId(url)', foreign), reader_id)
        self.assertEqual(calls, ['GET'])
        self.assertEqual(self.external, [])

    def test_one_old_session_entry_overrides_otherwise_fresh_cache(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        metadata = {'url': new, 'chapter_manifest': new, 'extension': 'epub-chapters',
                    'original_extension': 'chm', 'title': 'synthetic candidate'}
        calls = []
        def unavailable(route):
            calls.append(route.request.method)
            route.fulfill(status=503, json={}, headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', unavailable)
        cases = [('old-source', {'reader-source': old, 'reader-resolve': new}),
                 ('old-resolve', {'reader-source': new, 'reader-resolve': old}),
                 ('old-manifest', {'reader-source': new, 'reader-resolve': new})]
        for index, (label, urls) in enumerate(cases):
            with self.subTest(case=label):
                reader_id = '29b1i0i45mj7g'
                self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
                self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
                self.page.evaluate('''async ({old,id,urls,metadata,label})=>{
                  await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',lastReadAt:100,
                    extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
                  for (const [kind,url] of Object.entries(urls)) {
                    const data={...metadata,url,chapter_manifest:label==='old-manifest' && kind==='reader-source' ? old : url};
                    sessionStorage.setItem(kind+':'+id,JSON.stringify(data));
                  }
                }''', {'old': old, 'id': reader_id, 'urls': urls, 'metadata': metadata, 'label': label})
                before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
                calls_before = len(calls)
                target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
                    'id': reader_id, 'ext': 'epub-chapters'})
                self.page.goto(target, wait_until='domcontentloaded')
                self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
                self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
                self.assertEqual(calls[calls_before:], ['GET'])
                self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
                self.assertEqual(self.external, [])

    def test_conflicting_old_session_paths_fail_without_choosing_a_book(self):
        first, second = compat.fixture.PROOF['bundles'][:2]
        url = lambda row: 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        old, other = url(first), url(second)
        reader_id = 'synthetic-conflicting-cache'
        calls = []
        def unexpected(route):
            calls.append(route.request.url)
            route.fulfill(status=500, json={}, headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', unexpected)
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,other,id})=>{
          await VoiceOfMLReaderStore.put({url:old,title:'synthetic progress A',lastReadAt:100,chapterOffset:123456});
          await VoiceOfMLReaderStore.put({url:other,title:'synthetic progress B',lastReadAt:101,chapterOffset:54321});
          for(const [kind,url] of [['reader-source',old],['reader-resolve',other]])
            sessionStorage.setItem(kind+':'+id,JSON.stringify({url,chapter_manifest:url,extension:'epub-chapters'}));
        }''', {'old': old, 'other': other, 'id': reader_id})
        before = self.page.evaluate('async()=>VoiceOfMLReaderStore.list()')
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertEqual(calls, [])
        self.assertEqual(self.page.evaluate('async()=>VoiceOfMLReaderStore.list()'), before)
        self.assertEqual(self.external, [])

    def test_old_source_cache_disposes_early_resolution_and_refreshes(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        reader_id = '29b1i0i45mj7g'
        metadata = {'url': new, 'chapter_manifest': new, 'extension': 'epub-chapters',
                    'original_extension': 'chm', 'download': source_url(reader_id), 'title': 'synthetic refreshed book'}
        calls = []
        def resolve(route):
            calls.append(route.request.method)
            route.fulfill(status=200, json=metadata, headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', resolve)
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,id})=>{
          await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          sessionStorage.setItem('reader-source:'+id,JSON.stringify({url:old,chapter_manifest:old,
            extension:'epub-chapters',original_extension:'chm'}));
        }''', {'old': old, 'id': reader_id})
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
        # The inline Reader resolver starts first. Capture its actual disposer
        # just before the locally patched controller checks session metadata.
        path = 'static/reader/formats/reader-format-controller.mjs'
        body = (compat.HERE / path).read_bytes()
        marker = b'export function createReaderFormatController(readerContext) {'
        self.assertEqual(body.count(marker), 1)
        instrumented = body.replace(marker, marker + b'''
          const originalEarly = window.__VOICE_READER_RESOLVE__;
          window.__localEarlyDisposeCalls = 0;
          if (originalEarly) {
            const dispose = originalEarly.dispose;
            originalEarly.dispose = () => { window.__localEarlyDisposeCalls++; return dispose(); };
          }
        ''')
        self.page.route('**/' + path, lambda route: route.fulfill(status=200,
                        content_type='text/javascript', body=instrumented))
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertEqual(self.page.evaluate('window.__localEarlyDisposeCalls'), 1)
        self.assertGreaterEqual(len(calls), 1)
        self.assertTrue(all(method == 'GET' for method in calls))
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_refresh_identifies_each_candidate_without_cross_book_remapping(self):
        current = {}
        calls = []
        def resolve(route):
            calls.append(route.request.url)
            route.fulfill(status=200, json=current['metadata'], headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', resolve)
        def bucket(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': path})
        pairs = [(0, '29b1i0i45mj7g'), (0, '0bkdmor8l52rg'),
                 (1, '1nd5z6md7qzl6'), (2, '13i6hffuvzujn')]
        for index, reader_id in pairs:
            row = compat.fixture.PROOF['bundles'][index]
            with self.subTest(candidate=index, reader_id=reader_id):
                source = row['source_root'].split('/')[3]
                old = bucket(row['source_root'] + '/chapter-manifest.json')
                new = bucket(f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json")
                current['metadata'] = {'url': new, 'chapter_manifest': new, 'extension': 'epub-chapters',
                                       'original_extension': 'chm', 'download': source_url(reader_id),
                                       'title': 'synthetic candidate'}
                self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
                self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
                self.page.evaluate('''async ({old,id})=>{
                  await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',lastReadAt:100,
                    extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
                  sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({url:old,chapter_manifest:old,
                    extension:'epub-chapters',original_extension:'chm'}));
                }''', {'old': old, 'id': reader_id})
                before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
                old_calls = len(calls)
                target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
                    'id': reader_id, 'ext': 'epub-chapters'})
                self.page.goto(target, wait_until='domcontentloaded')
                self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
                phase = self.page.locator('html').get_attribute('data-reader-phase')
                if phase != 'ready':
                    detail = self.page.evaluate('''async url=>({error:document.querySelector('#content')?.dataset.errorCode,
                      content:document.querySelector('#content')?.textContent?.slice(0,250),
                      stored:await VoiceOfMLReaderStore.get(url)})''', new)
                    self.fail(f'candidate={index} id={reader_id} phase={phase} detail={detail}')
                self.assertEqual(len(calls), old_calls + 1)
                key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                         {'id': reader_id, 'url': new})
                self.assertIsNotNone(self.wait_for_record(key))
                self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
                self.assertEqual(self.external, [])
                self.assertEqual(self.errors, [])

    def test_reviewed_fresh_cache_does_not_trigger_extra_lookup(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        reader_id = '29b1i0i45mj7g'
        calls = []
        def unexpected(route):
            calls.append(route.request.url)
            route.fulfill(status=503, json={}, headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', unexpected)
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({id,newUrl,download})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:newUrl,chapter_manifest:newUrl,download,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'id': reader_id, 'newUrl': new, 'download': source_url(reader_id)})
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertEqual(calls, [])
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_unrecognized_manifest_url_alias_still_uses_stale_metadata(self):
        """Counterexample: data URL and manifest URL need not be the same."""
        row = compat.fixture.PROOF['bundles'][0]
        path = row['source_root'] + '/chapter-manifest.json'
        # The reader accepts the last `path` value, while the local exact-pair
        # recognizer deliberately rejects extra or duplicated parameters.
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': path}) + '&extra=1'
        reader_id = 'synthetic-unrecognized-old'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.evaluate('''({id,old})=>sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({
          url:old,chapter_manifest:old,extension:'epub-chapters',original_extension:'chm'}))''',
                           {'id': reader_id, 'old': old})
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({'id': reader_id, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertEqual(self.external, [])

    def test_original_source_with_split_manifest_shows_old_manifest_bookmarks(self):
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async old=>{
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-old-mark',url:old,label:'synthetic old bookmark',
            createdAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
        }''', old)
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', old)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        mark = self.page.locator('#bookmarks-list .panel-item').filter(has_text='synthetic old bookmark')
        mark.wait_for()
        self.assertIn('旧版位置', mark.inner_text())
        self.assertEqual(mark.locator('.panel-item-edit').count(), 0)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', old), before)
        self.assertEqual(self.external, [])

    def test_shared_manifest_bookmarks_distinguish_address_or_unknown(self):
        """Do not attribute another or ambiguous source to the current book."""
        row = compat.fixture.PROOF['bundles'][0]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        sources = [source_url('29b1i0i45mj7g'), source_url('0bkdmor8l52rg')]
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,sources})=>{
          for(let i=0;i<sources.length;i++)
            await VoiceOfMLReaderStore.putBookmark({id:'synthetic-shared-'+i,url:sources[i],
              label:'synthetic source '+i,createdAt:100+i,chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-shared-ambiguous',url:old,
            label:'synthetic shared manifest',createdAt:102,chapterManifest:old,chapterIndex:2,chapterOffset:123456});
        }''', {'old': old, 'sources': sources})
        sources_and_old = sources + [old]
        before = self.page.evaluate('''async sources=>Promise.all(sources.map(url=>VoiceOfMLReaderStore.listBookmarks(url)))''', sources_and_old)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': sources[0], 'chapter_manifest': new, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        panel = self.page.locator('#bookmarks-list')
        panel.get_by_text('synthetic source 0', exact=False).wait_for()
        panel.get_by_text('synthetic source 1', exact=False).wait_for()
        panel.get_by_text('synthetic shared manifest', exact=False).wait_for()
        self.assertIn('同原件地址', panel.locator('.panel-item').filter(has_text='synthetic source 0').inner_text())
        self.assertIn('其他原件地址', panel.locator('.panel-item').filter(has_text='synthetic source 1').inner_text())
        self.assertIn('来源未确认', panel.locator('.panel-item').filter(has_text='synthetic shared manifest').inner_text())
        self.assertEqual(panel.locator('.panel-item').count(), 3)
        self.assertEqual(panel.locator('.panel-item-edit').count(), 0)
        after = self.page.evaluate('''async sources=>Promise.all(sources.map(url=>VoiceOfMLReaderStore.listBookmarks(url)))''', sources_and_old)
        self.assertEqual(after, before)
        self.assertEqual(self.external, [])

    def test_shared_manifest_id_route_without_original_is_rejected(self):
        """An unknown ID cannot claim a shared derived URL."""
        row = compat.fixture.PROOF['bundles'][0]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        sources = [source_url('29b1i0i45mj7g'), source_url('0bkdmor8l52rg')]
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,sources,newUrl})=>{
          for(let i=0;i<sources.length;i++)
            await VoiceOfMLReaderStore.putBookmark({id:'synthetic-id-'+i,url:sources[i],label:'id source '+i,
              createdAt:100+i,chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          sessionStorage.setItem('reader-resolve:synthetic-shared-id',JSON.stringify({url:newUrl,
            chapter_manifest:newUrl,extension:'epub-chapters',original_extension:'chm'}));
        }''', {'old': old, 'sources': sources, 'newUrl': new})
        before = self.page.evaluate('''async sources=>Promise.all(sources.map(url=>VoiceOfMLReaderStore.listBookmarks(url)))''', sources)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': 'synthetic-shared-id', 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        after = self.page.evaluate('''async sources=>Promise.all(sources.map(url=>VoiceOfMLReaderStore.listBookmarks(url)))''', sources)
        self.assertEqual(after, before)
        self.assertEqual(self.external, [])

    def test_shared_new_manifest_does_not_reuse_another_books_progress(self):
        """Keep the former counterexample as a non-overwrite regression."""
        new = self.bucket_url_for_test()
        first_id, second_id = '29b1i0i45mj7g', '0bkdmor8l52rg'
        first_reader = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': first_id, 'ext': 'epub-chapters'})
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({neo,id,download,readerUrl})=>{
          await VoiceOfMLReaderStore.put({url:neo,readerUrl,title:'synthetic first book',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:neo,chapterIndex:3,chapterOffset:200});
          sessionStorage.setItem('reader-resolve:'+id,JSON.stringify({url:neo,chapter_manifest:neo,
            download,extension:'epub-chapters',original_extension:'chm',title:'synthetic second book'}));
        }''', {'neo': new, 'id': second_id, 'download': source_url(second_id), 'readerUrl': first_reader})
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', new)
        key = self.page.evaluate('''({id,url})=>VoiceOfMLReaderStore.localBookRecordKey(id,url)''',
                                 {'id': second_id, 'url': new})
        second_reader = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'id': second_id, 'ext': 'epub-chapters'})
        self.page.goto(second_reader, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.page.evaluate('''url=>{
          window.__syntheticSecondSaved=false;
          window.__syntheticSecondTimer=setInterval(async()=>{
            const row=await VoiceOfMLReaderStore.get(url);
            if(row?.readerUrl && new URL(row.readerUrl).searchParams.get('id')==='0bkdmor8l52rg')
              window.__syntheticSecondSaved=true;
          },100);
        }''', key)
        try:
            self.page.wait_for_function('()=>window.__syntheticSecondSaved === true', timeout=30000)
        finally:
            self.page.evaluate('()=>clearInterval(window.__syntheticSecondTimer)')
        after = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', new)
        second = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', key)
        self.assertEqual(parse_qs(urlsplit(before['readerUrl']).query)['id'], [first_id])
        self.assertEqual(parse_qs(urlsplit(second['readerUrl']).query)['id'], [second_id])
        self.assertEqual(after, before)
        self.assertEqual(self.external, [])

    def test_old_history_and_bookmark_handoff_are_both_preserved(self):
        """The selected incompatible bookmark must not be masked by history."""
        row = compat.fixture.PROOF['bundles'][0]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,original})=>{
          await VoiceOfMLReaderStore.put({url:original,title:'synthetic old history',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-handoff',url:original,label:'synthetic handoff',
            createdAt:100,chapterManifest:old,chapterIndex:2,chapterOffset:123456});
        }''', {'old': old, 'original': original})
        before = self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters',
            'bookmark': 'synthetic-handoff', 'bookmark_source': original})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertIn('旧书签位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"))
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark_source')"))
        after = self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        self.assertEqual(after, before)
        self.assertEqual(self.external, [])

    def test_old_history_preserved_while_valid_new_bookmark_is_restored(self):
        """New chapter identity is restored separately without rewriting old history."""
        row = compat.fixture.PROOF['bundles'][0]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,original,neo})=>{
          await VoiceOfMLReaderStore.put({url:original,title:'synthetic old history',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-new-mark',url:original,label:'synthetic new mark',
            createdAt:100,chapterManifest:neo,chapterIndex:3,chapterOffset:200});
        }''', {'old': old, 'original': original, 'neo': new})
        before = self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters',
            'bookmark': 'synthetic-new-mark', 'bookmark_source': original})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"))
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark_source')"))
        target_chapter = self.page.locator('.reader-epub-chapter[data-chapter="3"]')
        target_chapter.wait_for(state='attached', timeout=30000)
        for delay in (0, 200, 1000):
            if delay:
                self.page.wait_for_timeout(delay)
            geometry = target_chapter.evaluate('''node=>{
              const viewport=document.querySelector('#viewport'), imgs=[...document.querySelectorAll('.reader-epub-chapter img')];
              return {offset:node.getBoundingClientRect().top-viewport.getBoundingClientRect().top,
                scrollTop:viewport.scrollTop, scrollHeight:viewport.scrollHeight, clientHeight:viewport.clientHeight,
                chapters:[...document.querySelectorAll('.reader-epub-chapter')].map(ch=>Number(ch.dataset.chapter)),
                images:imgs.length, completeImages:imgs.filter(img=>img.complete&&img.naturalWidth>0).length};
            }''')
            self.assertAlmostEqual(geometry['offset'], 8 - 200, delta=4, msg=f'delay={delay} geometry={geometry}')
        self.assertEqual(self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original), before)
        self.assertEqual(self.external, [])

    def test_new_bookmark_user_input_does_not_write_old_history(self):
        """Explicit scrolling must not mutate an incompatible old record."""
        row = compat.fixture.PROOF['bundles'][0]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,original,neo})=>{
          await VoiceOfMLReaderStore.put({url:original,title:'synthetic old history',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-new-mark',url:original,label:'synthetic new mark',
            createdAt:100,chapterManifest:neo,chapterIndex:3,chapterOffset:200});
        }''', {'old': old, 'original': original, 'neo': new})
        before = self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters',
            'bookmark': 'synthetic-new-mark', 'bookmark_source': original})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"))
        viewport = self.page.locator('#viewport')
        before_scroll = viewport.evaluate('node=>node.scrollTop')
        viewport.evaluate('''node=>{
          node.dispatchEvent(new WheelEvent('wheel',{deltaY:600,bubbles:true}));node.scrollTop+=600;
        }''')
        self.page.wait_for_timeout(300)
        moved = viewport.evaluate('node=>node.scrollTop')
        self.assertGreater(moved - before_scroll, 400)
        self.page.wait_for_timeout(1000)
        settled = viewport.evaluate('node=>node.scrollTop')
        self.assertGreater(settled - before_scroll, 400)
        self.assertEqual(self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original), before)
        self.assertEqual(self.external, [])

    def test_out_of_range_new_bookmark_is_currently_consumed_without_error(self):
        """Pristine HEAD counterexample: exact manifest does not validate pixels."""
        module = 'static/reader/formats/reader-chapter-format.mjs'
        pristine = subprocess.check_output(['git', 'show', 'HEAD:' + module], cwd=compat.HERE)
        served = []
        def pristine_chapter(route):
            served.append(True)
            route.fulfill(status=200, content_type='text/javascript', body=pristine)
        self.page.route('**/' + module, pristine_chapter)
        row = compat.fixture.PROOF['bundles'][0]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = self.bucket_url_for_test()
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,original,neo})=>{
          await VoiceOfMLReaderStore.put({url:original,title:'synthetic old history',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-invalid-offset',url:original,label:'invalid position',
            createdAt:100,chapterManifest:neo,chapterIndex:3,chapterOffset:1000000000});
        }''', {'old': old, 'original': original, 'neo': new})
        before = self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters',
            'bookmark': 'synthetic-invalid-offset', 'bookmark_source': original})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertIsNone(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"))
        self.page.wait_for_timeout(1200)
        self.assertEqual(self.page.evaluate('''async url=>({history:await VoiceOfMLReaderStore.get(url),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(url)})''', original), before)
        self.assertTrue(served)
        self.assertEqual(self.external, [])

    def test_direct_original_source_old_manifest_records_remain_unchanged(self):
        """Guard both old source and old manifest identities in local UI."""
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        old = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': row['source_root'] + '/chapter-manifest.json'})
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async ({old,original})=>{
          await VoiceOfMLReaderStore.put({url:original,title:'synthetic old source',lastReadAt:100,
            extension:'epub-chapters',chapterManifest:old,chapterIndex:2,chapterOffset:123456});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-hidden-mark',url:original,label:'synthetic hidden mark',
            createdAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
        }''', {'old': old, 'original': original})
        saved = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', original)
        marks = self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', original)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.page.wait_for_timeout(1200)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', original), saved)
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.listBookmarks(url)', original), marks)
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        row = self.page.locator('#bookmarks-list .panel-item').filter(has_text='synthetic hidden mark')
        row.wait_for()
        self.assertEqual(row.locator('.panel-item-edit').count(), 0)
        self.assertIn('旧版位置', row.inner_text())
        self.assertEqual(self.external, [])

    def test_foliate_legacy_record_is_preserved_without_guessing_position(self):
        """Different or missing chapter identities fail closed in local UI."""
        row = compat.fixture.PROOF['bundles'][0]
        source = row['source_root'].split('/')[3]
        new = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"})
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-book.chm'
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        self.page.evaluate('''async url=>{
          await VoiceOfMLReaderStore.put({url,title:'synthetic Foliate progress',extension:'epub',lastReadAt:100,
            cfi:'epubcfi(/6/4!/4/2:5)',foliateSection:2,foliateOffset:1234});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-foliate-mark',url,label:'synthetic Foliate mark',
            extension:'epub',createdAt:100,cfi:'epubcfi(/6/4!/4/2:5)',foliateSection:2,foliateOffset:1234});
        }''', original)
        before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', original)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': original, 'chapter_manifest': new, 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.page.wait_for_timeout(1200)
        after = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', original)
        self.assertEqual(after, before)
        self.assertIn('旧阅读位置无法准确转换', self.page.locator('#download-feedback').inner_text())
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        mark = self.page.locator('#bookmarks-list .panel-item').filter(has_text='synthetic Foliate mark')
        mark.wait_for()
        self.assertEqual(mark.locator('.panel-item-edit').count(), 0)
        self.assertIn('旧版位置', mark.inner_text())
        self.page.locator('#history-tab').evaluate('node=>node.click()')
        dialogs = []
        def dismiss(dialog):
            dialogs.append(dialog.message)
            dialog.dismiss()
        self.page.once('dialog', dismiss)
        self.page.locator('#history-clear').evaluate('node=>node.click()')
        self.page.wait_for_timeout(200)
        self.assertEqual(dialogs, ['清空全部阅读历史？'])
        self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', original), before)
        self.assertEqual(self.external, [])

    def test_local_stale_cache_rejects_missing_old_and_mismatched_resolutions(self):
        row, other = compat.fixture.PROOF['bundles'][:2]
        source = row['source_root'].split('/')[3]
        other_source = other['source_root'].split('/')[3]
        bucket = lambda path: 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': path})
        old = bucket(row['source_root'] + '/chapter-manifest.json')
        new = bucket(f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json")
        wrong = bucket(f"chapters/ebook/chm/{other_source}/{other['new_bundle_version']}/chapter-manifest.json")
        cases = [
            ('unavailable', 503, {}),
            ('old', 200, {'url': old, 'chapter_manifest': old, 'extension': 'epub-chapters'}),
            ('different-source', 200, {'url': wrong, 'chapter_manifest': wrong, 'extension': 'epub-chapters'}),
            ('different-manifest', 200, {'url': new, 'chapter_manifest': wrong, 'extension': 'epub-chapters'}),
            ('wrong-extension', 200, {'url': new, 'chapter_manifest': new, 'extension': 'pdf'}),
            ('extra-param', 200, {'url': new + '&extra=1', 'chapter_manifest': new, 'extension': 'epub-chapters'}),
            *[(label, 200, {'url': new, 'chapter_manifest': new, 'extension': 'epub-chapters',
                            'original_extension': original_ext, 'download': download})
              for label, original_ext, download in (
                  ('missing-original', 'chm', ''),
                  ('other-original', 'chm', source_url('0bkdmor8l52rg')),
                  ('wrong-origin', 'chm', source_url('29b1i0i45mj7g').replace('huggingface.co', 'huggingface.co.evil.test')),
                  ('query-on-original', 'chm', source_url('29b1i0i45mj7g') + '?synthetic=1'),
                  ('fragment-on-original', 'chm', source_url('29b1i0i45mj7g') + '#synthetic'),
                  ('wrong-original-extension', 'pdf', source_url('29b1i0i45mj7g')),
              )],
        ]
        current = {}
        requests = []
        def resolve(route):
            requests.append(route.request.url)
            route.fulfill(status=current['status'], json=current['payload'], headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-resolve**', resolve)
        for index, (label, status, payload) in enumerate(cases):
            with self.subTest(case=label):
                current.update(status=status, payload=payload)
                before_requests = len(requests)
                reader_id = '29b1i0i45mj7g'
                self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
                self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
                self.page.evaluate('''async ({old,id})=>{
                  await VoiceOfMLReaderStore.put({url:old,title:'synthetic old progress',extension:'epub-chapters',
                    lastReadAt:100,chapterIndex:2,chapterManifest:old,chapterOffset:123456});
                  const stale={url:old,chapter_manifest:old,extension:'epub-chapters',original_extension:'chm'};
                  sessionStorage.setItem('reader-resolve:'+id,JSON.stringify(stale));
                  sessionStorage.setItem('reader-source:'+id,JSON.stringify(stale));
                }''', {'old': old, 'id': reader_id})
                before = self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old)
                target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
                    'id': reader_id, 'ext': 'epub-chapters'})
                self.page.goto(target, wait_until='domcontentloaded')
                self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
                self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
                self.assertEqual(len(requests), before_requests + 1)
                self.assertEqual(self.page.evaluate('url=>VoiceOfMLReaderStore.get(url)', old), before)
                self.assertEqual(self.external, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
