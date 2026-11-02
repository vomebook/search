"""Closing an overlay must not wait on the Reader's local storage."""
import unittest
from urllib.parse import urlencode

from tests import test_paging_recovery as paging


class ReaderCloseResponsivenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paging.PagingRecoveryTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        paging.PagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.fixture = paging.PagingRecoveryTests()
        self.fixture.setUp()
        self.page = self.fixture.page

    def tearDown(self):
        self.assertEqual(self.fixture.errors, [])
        self.fixture.tearDown()

    def test_embedded_title_follows_resolved_book_and_browser_history(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/title-test.txt'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body='readable title test'))
        original = self.page.title()
        url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt', title='真实书名'))
        self.page.evaluate('url => navigateToReader(url)', url)
        frame = self.page.frame_locator('iframe.reader-overlay')
        frame.locator('html[data-reader-phase="ready"]').wait_for()
        self.page.wait_for_function("()=>document.title==='真实书名.txt - VoiceOfML Reader'")
        self.assertEqual(frame.locator('#title').inner_text(), '真实书名.txt')
        self.assertEqual(frame.locator('body').evaluate('()=>document.title'), self.page.title())
        self.page.evaluate('history.back()')
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.assertEqual(self.page.title(), original)
        self.page.evaluate('history.forward()')
        frame.locator('html[data-reader-phase="ready"]').wait_for()
        self.page.wait_for_function("()=>document.title==='真实书名.txt - VoiceOfML Reader'")
        frame.locator('#back').click()
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.assertEqual(self.page.title(), original)

    def test_slow_old_write_cannot_delay_close_or_overwrite_last_position(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/responsive.txt'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body=('a reading line\n' * 1200)))
        url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt', title='Responsive'))
        self.page.evaluate('url => navigateToReader(url)', url)
        frame = self.page.frame_locator('iframe.reader-overlay')
        frame.locator('html[data-reader-phase="ready"]').wait_for()
        frame.locator('#viewport').evaluate('n => n.scrollTop = 1000')
        frame.locator('#zoom-in').click()
        frame.locator('body').evaluate('''() => {
          const old = window.VoiceOfMLReaderStore;
          window.VoiceOfMLReaderStore = {...old, put: value => new Promise((resolve, reject) =>
            setTimeout(() => old.put(value).then(resolve, reject), 800))};
        }''')
        frame.locator('#zoom-in').click()
        self.page.evaluate('window.__closeStart=performance.now()')
        frame.locator('#back').click()
        self.page.wait_for_function('() => !document.querySelector("iframe.reader-overlay:not(.reader-overlay-parked)")', timeout=2000)
        elapsed = self.page.evaluate('performance.now()-window.__closeStart')
        self.assertLess(elapsed, 300, f'closing waited for storage: {elapsed:.0f}ms')
        self.page.wait_for_function('() => !!window.VoiceOfMLReaderStore', timeout=5000)
        self.page.wait_for_function('async source => (await VoiceOfMLReaderStore.get(source))?.zoom===120', arg=source, timeout=5000)
        self.page.wait_for_timeout(1000)
        saved = self.page.evaluate('source => VoiceOfMLReaderStore.get(source)', source)
        self.assertEqual(saved['zoom'], 120)
        self.assertGreater(saved['scrollTop'], 0)

    def test_unconfirmed_restoration_is_not_saved_by_close(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/unknown.txt'
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__holdRestore = () => updateDocumentState({restorationReady:false});
            ''')
        self.fixture.context.route('**/static/reader.js*', instrument)
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body='hello'))
        url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt'))
        self.page.evaluate('url => navigateToReader(url)', url)
        frame = self.page.frame_locator('iframe.reader-overlay')
        frame.locator('html[data-reader-phase="ready"]').wait_for()
        frame.locator('body').evaluate('() => window.__holdRestore()')
        self.page.evaluate('''() => { window.__closeProgress='not-received';
          addEventListener('message', event => {if (event.data?.type === 'voice-reader-close')
            window.__closeProgress = event.data.progress ?? null;}); }''')
        frame.locator('#back').click()
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.assertIsNone(self.page.evaluate('window.__closeProgress'))

    def test_cleared_history_is_not_recreated_by_quick_close(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/cleared.txt'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body='history clear'))
        url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt'))
        self.page.evaluate('url => navigateToReader(url)', url)
        frame = self.page.frame_locator('iframe.reader-overlay')
        frame.locator('html[data-reader-phase="ready"]').wait_for()
        frame.locator('#history').click()
        frame.locator('#history-tab').click()
        self.page.on('dialog', lambda dialog: dialog.accept())
        frame.locator('#history-clear').click()
        frame.locator('#back').click()
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.page.wait_for_timeout(300)
        self.assertIsNone(self.page.evaluate('''source => new Promise((resolve,reject) => {
          const request=indexedDB.open('voiceofml-reader');request.onerror=()=>reject(request.error);
          request.onsuccess=()=>{const read=request.result.transaction('entries').objectStore('entries').get(source);
            read.onsuccess=()=>resolve(read.result||null);read.onerror=()=>reject(read.error);};
        })''', source))

    def test_stalled_history_hides_reader_immediately_then_recovers(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/history.txt'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body='history fallback'))
        url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt'))
        self.page.evaluate('url => navigateToReader(url)', url)
        frame = self.page.frame_locator('iframe.reader-overlay')
        frame.locator('html[data-reader-phase="ready"]').wait_for()
        self.page.evaluate('''() => {
          window.__nativeBack=history.back;history.back=()=>{};
          window.__hiddenOnMessage=false;
          addEventListener('message', event=>{if(event.data?.type==='voice-reader-close')
            window.__hiddenOnMessage=getComputedStyle(readerOverlay).opacity==='0';});
        }''')
        frame.locator('#back').click()
        self.page.wait_for_function('() => window.__hiddenOnMessage', timeout=1000)
        self.page.locator('iframe.reader-overlay').wait_for(state='detached', timeout=3000)
        self.page.evaluate('() => { history.back=window.__nativeBack; }')
        self.assertFalse(self.page.evaluate('readerClosing'))

    def test_host_updates_store_when_a_new_reader_version_closes(self):
        first = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/version-a.txt'
        second = first.replace('version-a', 'version-b')
        self.page.route('**/reader/core/reader-store.aaaaaaaaaaaa.js',
                        lambda route: route.fulfill(content_type='text/javascript', body='''
                          window.VoiceOfMLReaderStore = {STORE_VERSION:'aaaaaaaaaaaa',
                            put: async entry => { (window.__versionedSaves ||= []).push(['a',entry.url]); }};
                        '''))
        self.page.route('**/reader/core/reader-store.bbbbbbbbbbbb.js',
                        lambda route: route.fulfill(content_type='text/javascript', body='''
                          window.VoiceOfMLReaderStore = {STORE_VERSION:'bbbbbbbbbbbb',
                            put: async entry => { (window.__versionedSaves ||= []).push(['b',entry.url]); }};
                        '''))
        self.fixture.context.route('**/static/reader.html?**', lambda route: route.fulfill(
            content_type='text/html', body='<head><script type="application/x-test" src="/search/static/reader/core/reader-store.aaaaaaaaaaaa.js"></script></head><body>reader</body>'))
        for version, source in [('aaaaaaaaaaaa', first), ('bbbbbbbbbbbb', second)]:
            url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt'))
            self.page.evaluate('url => navigateToReader(url)', url)
            self.page.frame_locator('iframe.reader-overlay').locator('body').wait_for()
            self.page.evaluate('''([version, source]) => {
              const hostVersion=version[0];
              window.VoiceOfMLReaderStore={STORE_VERSION:version,
                put:async entry => {(window.__versionedSaves ||= []).push([hostVersion,entry.url]);}};
              const frame=readerOverlay;
              frame.contentDocument.querySelector('script').setAttribute('src',
                '/search/static/reader/core/reader-store.'+version+'.js');
              handleReaderMessage({origin:location.origin, source:frame.contentWindow,
                data:{type:'voice-reader-close',progress:{url:source,zoom:110}}});
            }''', [version, source])
            self.page.locator('iframe.reader-overlay').wait_for(state='detached')
            self.page.wait_for_function('version => (window.__versionedSaves||[]).some(row=>row[0]===version)',
                                        arg=version[0])
        self.assertEqual(self.page.evaluate('window.__versionedSaves'), [['a', first], ['b', second]])

    def test_delayed_host_load_cannot_overwrite_a_newer_reader_position(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/rapid-reopen.txt'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body=('reading line\n' * 400)))
        url = '/search/static/reader.html?' + urlencode(dict(url=source, ext='txt'))
        self.page.evaluate('''() => { window.__pendingStoreScript=null;
          window.__hadProgress=null;
          addEventListener('message', e => {if(e.data?.type==='voice-reader-close')
            window.__hadProgress=e.data.progress||false;});
          const append=Element.prototype.append;
          Element.prototype.append=function(...nodes) {
            const node=nodes[0];
            if (this===document.head && node?.tagName==='SCRIPT' && /reader-store/.test(node.src)) {
              window.__pendingStoreScript=node; return;
            }
            return append.apply(this,nodes);
          };
          window.__releaseStoreScript=()=>append.call(document.head,window.__pendingStoreScript);
        }''')
        self.page.evaluate('url => navigateToReader(url)', url)
        first = self.page.frame_locator('iframe.reader-overlay')
        first.locator('html[data-reader-phase="ready"]').wait_for()
        first.locator('#zoom-in').click()
        first.locator('#back').click()
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.assertTrue(self.page.evaluate('!!window.__pendingStoreScript'),
                        self.page.evaluate('''()=>({progress:window.__hadProgress,
                          store:window.VoiceOfMLReaderStore?.STORE_VERSION,
                          scripts:[...document.scripts].map(s=>s.src).filter(s=>s.includes('reader-store'))})'''))
        self.page.evaluate('url => navigateToReader(url)', url)
        second = self.page.frame_locator('iframe.reader-overlay')
        second.locator('html[data-reader-phase="ready"]').wait_for()
        second.locator('#zoom').fill('120')
        second.locator('#zoom').dispatch_event('change')
        second.locator('body').evaluate('''async (node, source) => {
          await VoiceOfMLReaderStore.put({url:source,zoom:120,lastReadAt:Date.now()+10});
        }''', source)
        second.locator('#back').click()
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.page.evaluate('window.__releaseStoreScript()')
        self.page.wait_for_function('() => !!window.VoiceOfMLReaderStore', timeout=5000)
        self.page.wait_for_function('async source => (await VoiceOfMLReaderStore.get(source))?.zoom===120',
                                    arg=source, timeout=5000)
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.evaluate('source => VoiceOfMLReaderStore.get(source)', source)['zoom'], 120)


if __name__ == '__main__':
    unittest.main()
