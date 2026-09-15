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

    def test_composed_app_starts_with_legacy_html_without_navigation_script(self):
        root = Path(__file__).resolve().parents[1]
        legacy = subprocess.check_output(['git', '-c', f'safe.directory={root}', 'show', '888265a:index.html'], cwd=root)
        app = subprocess.check_output(['node', 'scripts/compose_app.mjs'], cwd=root)
        with self.fixture.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            page.on('pageerror', lambda error: self.fixture.errors.append(str(error)))
            page.add_init_script(paging.FETCH_SCRIPT)
            page.route('**/api/**', lambda route: route.fulfill(content_type='application/json', body='[]'))
            page.route('**/static/app.js', lambda route: route.fulfill(content_type='text/javascript', body=app))
            page.route(self.fixture.origin + '/search/', lambda route: route.fulfill(content_type='text/html', body=legacy))
            page.goto(self.fixture.origin + '/search/#/?q=paging&local=0', wait_until='domcontentloaded')
            page.wait_for_function('typeof VoiceOfMLReaderNavigation === "object" && STATE.results.length > 0')
            self.assertEqual(page.locator('script[src*="reader-navigation"]').count(), 0)
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
