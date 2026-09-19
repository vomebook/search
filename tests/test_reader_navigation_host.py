"""Search-host navigation: source checks, session handoff and focus ownership."""
import unittest
import subprocess
from pathlib import Path
from tests import test_paging_recovery as paging


class ReaderNavigationHostTests(unittest.TestCase):
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
        self.page.route('**/static/reader.html?**', lambda route: route.fulfill(
            content_type='text/html', body='<body>reader</body>'))

    def tearDown(self):
        self.assertEqual(self.fixture.errors, [])
        self.fixture.tearDown()

    def test_bundled_shell_starts_without_separate_dependency_scripts(self):
        root = Path(__file__).resolve().parents[1]
        shell = subprocess.check_output(['node', '--input-type=module', '-e', '''
import {readFileSync} from 'node:fs';
import {stripBundledScripts} from './scripts/compose_app.mjs';
process.stdout.write(stripBundledScripts(readFileSync('index.html','utf8')));
'''], cwd=root)
        bundle = subprocess.check_output(['node', 'scripts/compose_app.mjs'], cwd=root)
        with self.fixture.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            page.on('pageerror', lambda error: self.fixture.errors.append(str(error)))
            page.add_init_script(paging.FETCH_SCRIPT)
            page.route('**/api/**', lambda route: route.fulfill(content_type='application/json', body='[]'))
            page.route('https://vomebook-hitokoto.hf.space/**', lambda route: route.fulfill(body='{}'))
            page.route('**/static/app.js', lambda route: route.fulfill(content_type='text/javascript', body=bundle))
            page.route(self.fixture.origin + '/search/', lambda route: route.fulfill(content_type='text/html', body=shell))
            page.goto(self.fixture.origin + '/search/#/?q=paging&local=0', wait_until='domcontentloaded')
            page.wait_for_function('STATE.results.length === 100 && !STATE.isLoading')
            self.assertEqual(page.locator('script[src]').count(), 1)
            self.assertTrue(page.evaluate('typeof VoiceOfMLSearchSession.createSearchSession === "function"'))
            self.assertTrue(page.evaluate('typeof VoiceOfMLDownloadController.createDownloadController === "function"'))
            self.assertTrue(page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")'))
            self.assertTrue(page.evaluate('closeReaderOverlay()'))

    def test_replace_preserves_return_focus_session_and_background_attributes(self):
        result = self.page.evaluate('''() => {
          const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
          const existing=document.createElement('div');existing.setAttribute('inert','');
          existing.setAttribute('aria-hidden','false');document.body.append(existing);
          const readerPath=new URL(document.querySelector('script[src*="reader-navigation.js"]').src).pathname.replace('reader-navigation.js','reader.html');
          const target=readerPath+'?ext=txt&url=https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/a.txt';
          const returnUrl=location.href;
          navigateToReader(target);const first=readerOverlay;
          const token=new URL(first.src).searchParams.get('nav');
          const hidden=trigger.hasAttribute('inert') && trigger.getAttribute('aria-hidden')==='true';
          handleReaderMessage({origin:location.origin,source:first.contentWindow,data:{type:'voice-reader-open',url:target+'&title=next'}});
          const next=readerOverlay, saved=JSON.parse(sessionStorage.getItem('reader-navigation-current'));
          const state=history.state;
          const nextUrl=new URL(next.src);
          const inherited=nextUrl.searchParams.get('nav')===token && nextUrl.searchParams.get('return')===returnUrl;
          const session=saved.readerUrl===next.src && state.readerUrl===next.src && saved.returnScroll.viewKey;
          const share=!new URL(location.href).searchParams.has('nav') && !new URL(location.href).searchParams.has('return');
          const removed=!first.isConnected;
          history.replaceState(null,'',returnUrl);closeReaderOverlay();
          const restored=document.activeElement===trigger && !trigger.hasAttribute('inert') && !trigger.hasAttribute('aria-hidden') &&
            existing.hasAttribute('inert') && existing.getAttribute('aria-hidden')==='false';
          const closed=!next.isConnected && closeReaderOverlay()===false;
          trigger.remove();existing.remove();return {hidden,inherited,session:!!session,share,removed,restored,closed};
        }''')
        self.assertTrue(all(result.values()), result)

    def test_click_replenishes_evicted_reader_metadata(self):
        result = self.page.evaluate('''() => {
          const button=DOM.resultsList.querySelector('[data-action="read"]');
          const id=new URL(button.dataset.readerUrl,location.origin).searchParams.get('id');
          const expected=JSON.parse(sessionStorage.getItem('reader-source:'+id));
          for(let i=0;i<200;i++) cacheReaderMetadata('other-'+i,{url:'other'},true);
          const evicted=!sessionStorage.getItem('reader-source:'+id);
          let captured;
          navigateToReader=()=>{captured=JSON.parse(sessionStorage.getItem('reader-source:'+id));};
          button.click();
          return {evicted,expected,captured};
        }''')
        self.assertTrue(result['evicted'])
        self.assertIsNotNone(result['expected'])
        self.assertEqual(result['captured'], result['expected'])

    def test_reader_folder_url_uses_current_filters(self):
        result = self.page.evaluate('''() => {
          STATE.filterMinSize=2048; STATE.filterMaxSize=8192;
          STATE.filterExtensions=['pdf','txt']; STATE.searchFolders=false; STATE.exact=false;
          STATE.sort='size'; STATE.recordHistory=false; STATE.useLocalMode=false;
          DOM.searchInput.value='current query'; STATE.query='previous query';
          const url=new URL(getReaderFolderUrl({Repo:'VoiceOfML/Test',Folder:['a.b','书']}));
          return {path:url.pathname,route:url.hash.split('?')[0],params:Object.fromEntries(new URLSearchParams(url.hash.split('?')[1]))};
        }''')
        self.assertEqual(result['path'], '/search/')
        self.assertEqual(result['route'], '#/Test')
        params = result['params']
        self.assertEqual(params['sort'], 'size')
        self.assertEqual(params['ext'], 'pdf,txt')
        self.assertEqual(params['folder_self'], 'a.b/书')
        self.assertEqual(params['min_size'], '2KB')
        self.assertEqual(params['max_size'], '8KB')
        self.assertEqual(params['search_folders'], 'false')
        self.assertEqual(params['exact'], '0')
        self.assertEqual(params['history'], '0')
        self.assertEqual(params['local'], '0')
        self.assertEqual(params['q'], 'current query')

    def test_untrusted_and_stale_messages_cannot_change_active_reader(self):
        result = self.page.evaluate('''() => {
          const readerPath=new URL(document.querySelector('script[src*="reader-navigation.js"]').src).pathname.replace('reader-navigation.js','reader.html');
          const target=readerPath+'?ext=txt';navigateToReader(target);
          const first=readerOverlay, oldSource=first.contentWindow, theme=STATE.isDark;
          const message={type:'voice-reader-open',url:target+'&title=bad'};
          handleReaderMessage({origin:'https://invalid.example',source:oldSource,data:message});
          handleReaderMessage({origin:location.origin,source:window,data:message});
          handleReaderMessage({origin:location.origin,source:oldSource,data:{...message,url:'/wrong-path'}});
          const untouched=readerOverlay===first;
          handleReaderMessage({origin:location.origin,source:oldSource,data:{...message,url:target+'&title=valid'}});
          const second=readerOverlay;
          handleReaderMessage({origin:location.origin,source:oldSource,data:{type:'voice-reader-theme',theme:theme?'light':'dark'}});
          return {untouched,replaced:second!==first,staleIgnored:STATE.isDark===theme};
        }''')
        self.assertTrue(all(result.values()), result)

    def test_unavailable_session_storage_does_not_block_replacement(self):
        result = self.page.evaluate('''() => {
          const readerPath=new URL(document.querySelector('script[src*="reader-navigation.js"]').src).pathname.replace('reader-navigation.js','reader.html');
          const target=readerPath+'?ext=txt';navigateToReader(target);const first=readerOverlay;
          const original=Storage.prototype.setItem;
          try {
            Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};
            handleReaderMessage({origin:location.origin,source:first.contentWindow,data:{type:'voice-reader-open',url:target+'&title=next'}});
            return readerOverlay!==first && !first.isConnected && history.state.readerUrl===readerOverlay.src;
          } finally {Storage.prototype.setItem=original;}
        }''')
        self.assertTrue(result)
