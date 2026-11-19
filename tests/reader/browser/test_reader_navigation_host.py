"""Search-host navigation: source checks, session handoff and focus ownership."""
import unittest
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import expect
from tests.search.browser import test_paging_recovery as paging


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
        root = Path(__file__).resolve().parents[3]
        shell = subprocess.check_output(['node', '--input-type=module', '-e', '''
import {readFileSync} from 'node:fs';
import {stripBundledScripts} from './scripts/build/compose_app.mjs';
process.stdout.write(stripBundledScripts(readFileSync('static/index.html','utf8')));
'''], cwd=root)
        bundle = subprocess.check_output(['node', 'scripts/build/compose_app.mjs'], cwd=root)
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
            self.assertEqual(page.evaluate('parseSizeStr(fmtSizeUrl(1048577))'), 1048577)
            self.assertEqual(page.evaluate('bytesToDisplay(0).unit'), 'B')
            for current in (self.page, page):
                self.assertEqual(current.evaluate('''() => {
                  const original = isValidSearchResponse;
                  const desc = Object.getOwnPropertyDescriptor(globalThis, 'isValidSearchResponse');
                  const replacement = () => 'replacement';
                  globalThis.isValidSearchResponse = replacement;
                  const changed = isValidSearchResponse === replacement;
                  globalThis.isValidSearchResponse = original;
                  const restored = isValidSearchResponse === original;
                  const deleted = delete globalThis.isValidSearchResponse;
                  const valid = isValidSearchResponse({total:1,page:1,page_size:2,results:[{}]},1,2);
                  const invalid = isValidSearchResponse({total:1,page:1,page_size:2,results:[]},1,2);
                  return [desc.writable,desc.enumerable,desc.configurable,changed,restored,deleted,valid,invalid];
                }'''), [True, True, False, True, True, False, True, False])
                self.assertEqual(current.evaluate('''() => {
                  const original = getResultStableId;
                  const originalPath = globalThis.buildRecordRelativePath;
                  const desc = Object.getOwnPropertyDescriptor(globalThis, 'getResultStableId');
                  const replacement = () => 'replacement';
                  let changed, restored, deleted, fallback, received;
                  try {
                    globalThis.getResultStableId = replacement;
                    changed = getResultStableId === replacement;
                    globalThis.getResultStableId = original;
                    restored = getResultStableId === original;
                    deleted = delete globalThis.getResultStableId;
                    const record = {Repo:'R'};
                    globalThis.buildRecordRelativePath = value => { received = value === record; return 'mock/path'; };
                    fallback = getResultStableId(record);
                  } finally {
                    globalThis.getResultStableId = original;
                    globalThis.buildRecordRelativePath = originalPath;
                  }
                  return [desc.writable,desc.enumerable,desc.configurable,changed,restored,deleted,fallback,received];
                }'''), [True, True, False, True, True, False, 'R\0mock/path', True])
                self.assertEqual(current.evaluate('''() => [ORDERED_EXTENSIONS.length,
                  ORDERED_EXTENSIONS.indexOf('pdf'), ORDERED_EXTENSIONS.indexOf('PDF'),
                  getFileIconType('AAC'), getFileIconType('unknown')]'''), [67, 0, -1, 'audio', 'file'])
                self.assertEqual(current.evaluate('''() => {
                  const reassign = value => { try { eval(value); return false; } catch (error) { return error.name === 'TypeError'; } };
                  const result = [Object.hasOwn(globalThis, 'ORDERED_EXTENSIONS'), Object.hasOwn(globalThis, 'FILE_ICON_MAP'),
                    reassign('ORDERED_EXTENSIONS = []'), reassign('FILE_ICON_MAP = {}')];
                  ORDERED_EXTENSIONS.push('probe-extension'); FILE_ICON_MAP['probe-extension'] = 'audio';
                  result.push(ORDERED_EXTENSIONS.indexOf('probe-extension') === 67 && getFileIconType('PROBE-EXTENSION') === 'audio');
                  ORDERED_EXTENSIONS.pop(); delete FILE_ICON_MAP['probe-extension']; return result;
                }'''), [False, False, True, True, True])
            for current in (self.page, page):
                cache = current.evaluate('''() => {
                  const c=new BoundedResponseCache(2,10000,1000);
                  c.set('a',{n:1});c.set('b',{n:2});c.get('a');c.set('c',{n:3});
                  return {keys:[...c.keys()], first:c.get('a').n, hasB:c.has('b'), bytes:c.bytes};
                }''')
                self.assertEqual(cache['keys'], ['a', 'c'])
                self.assertEqual(cache['first'], 1)
                self.assertFalse(cache['hasB'])
                self.assertGreater(cache['bytes'], 0)
            for current in (self.page, page):
                self.assertEqual(current.evaluate('''() => [formatSize(0), formatSize(1023), formatSize(1024),
                  formatSize(1048576), formatSize(1073741824)]'''), ['', '1023 B', '1.0 KB', '1.0 MB', '1.00 GB'])
                row = current.evaluate('''() => {
                  const html = buildResultHTML({Repo:'VoiceOfML/Test', File:'size', Extension:'txt', Folder:[], Size:1536}, 0);
                  const node = document.createElement('div'); node.innerHTML = html;
                  return node.textContent.includes('1.5 KB');
                }''')
                self.assertTrue(row)
            for current in (self.page, page):
                highlighted = current.evaluate('''() => {
                  const input = '<img src=x onerror="alert(1)"> Tom & abcab';
                  const host = document.createElement('div');
                  host.innerHTML = highlightText(input, 'img tom amp ab abc');
                  return {html: host.innerHTML, text: host.textContent, images: host.querySelectorAll('img').length,
                    marks: [...host.querySelectorAll('mark')].map(node => node.textContent)};
                }''')
                self.assertEqual(highlighted['text'], '<img src=x onerror="alert(1)"> Tom & abcab')
                self.assertEqual(highlighted['images'], 0)
                self.assertEqual(highlighted['marks'], ['img', 'Tom', 'abc', 'ab'])
                self.assertIn('&amp;', highlighted['html'])
            record = {'Repo': 'VoiceOfML/Test', 'File': 'a #?%.jpg', 'Extension': 'jpg', 'Folder': ['目录', 'sub dir']}
            encoded = '%E7%9B%AE%E5%BD%95/sub%20dir/a%20%23%3F%25.jpg.jpg'
            base = 'https://huggingface.co/datasets/VoiceOfML/Test/'
            for current in (self.page, page):
                links = current.evaluate('rec => [buildRecordRelativePath(rec), buildRecordLink(rec), buildRecordPath(rec)]', record)
                self.assertEqual(links, ['目录/sub dir/a #?%.jpg.jpg', base + 'resolve/main/' + encoded, base + 'blob/main/' + encoded])
            self.assertTrue(page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")'))
            self.assertTrue(page.evaluate('closeReaderOverlay()'))

    def test_replace_preserves_return_focus_session_and_background_attributes(self):
        result = self.page.evaluate('''() => {
          const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
          const existing=document.createElement('div');existing.setAttribute('inert','');
          existing.setAttribute('aria-hidden','false');document.body.append(existing);
          const readerPath=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
          const target=readerPath+'?ext=txt&url=https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/a.txt';
          const returnUrl=location.href;
          navigateToReader(target);const first=readerHost.overlay;
          const token=new URL(first.src).searchParams.get('nav');
          const hidden=trigger.hasAttribute('inert') && trigger.getAttribute('aria-hidden')==='true';
          handleReaderMessage({origin:location.origin,source:first.contentWindow,data:{type:'voice-reader-open',url:target+'&title=next'}});
          const next=readerHost.overlay, saved=JSON.parse(sessionStorage.getItem('reader-navigation-current'));
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

    def test_replace_can_return_null_during_reentrant_dom_callbacks(self):
        result = self.page.evaluate('''() => {
          const nav = VoiceOfMLReaderNavigation.createNavigation('/search/static/reader.html');
          const first = nav.mount(new URL('/search/static/reader.html?ext=txt&id=first', location.origin));
          const setAttribute = HTMLElement.prototype.setAttribute;
          const focus = HTMLIFrameElement.prototype.focus;
          let disposed = false, reentered = false;
          first.contentWindow.addEventListener('voice-reader-dispose', () => {
            disposed = true;
            HTMLIFrameElement.prototype.focus = function() {};
            HTMLElement.prototype.setAttribute = function(name, value) {
              const result = setAttribute.call(this, name, value);
              if (!reentered && name === 'inert' && document.querySelector('.reader-overlay-pending')) {
                reentered = true;
                nav.unmount(false);
              }
              return result;
            };
          });
          try {
            const replaced = nav.replace('/search/static/reader.html?ext=txt&id=second', {});
            return {disposed, reentered, isNull:replaced === null,
                    frames:document.querySelectorAll('iframe.reader-overlay').length};
          } finally {
            HTMLIFrameElement.prototype.focus = focus;
            HTMLElement.prototype.setAttribute = setAttribute;
            nav.unmount(false);
          }
        }''')
        self.assertEqual(result, dict(disposed=True, reentered=True, isNull=True, frames=0))

    def test_reader_title_tracks_foreground_and_restores_search(self):
        result = self.page.evaluate('''async () => {
          document.title='搜索原始标题';
          const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
          const send=(source,title,origin=location.origin)=>window.dispatchEvent(new MessageEvent('message',
            {origin,source,data:{type:'voice-reader-title',title}}));
          navigateToReader(path+'?ext=txt'); const first=readerHost.overlay;
          send(first.contentWindow,'第一本.txt - VoiceOfML Reader');
          const firstTitle=document.title, frameTitle=first.title;
          send(window,'错误来源');send(first.contentWindow,'错误域名','https://example.invalid');
          const rejected=document.title;
          handleReaderMessage({origin:location.origin,source:first.contentWindow,
            data:{type:'voice-reader-open',url:path+'?ext=txt&title=second'}});
          const second=readerHost.overlay, duringReplace=document.title;
          send(first.contentWindow,'迟到的旧标题');
          const stale=document.title;
          send(second.contentWindow,'第二本.pdf - VoiceOfML Reader');
          const next=document.title;
          readerNavigation.dismiss();
          send(second.contentWindow,'关闭后的迟到标题');
          const dismissed=document.title;
          closeReaderOverlay();
          return {firstTitle,frameTitle,rejected,duringReplace,stale,next,dismissed,closed:document.title};
        }''')
        self.assertEqual(result, dict(firstTitle='第一本.txt - VoiceOfML Reader',
          frameTitle='第一本.txt - VoiceOfML Reader', rejected='第一本.txt - VoiceOfML Reader',
          duringReplace='second', stale='second', next='第二本.pdf - VoiceOfML Reader',
          dismissed='搜索原始标题', closed='搜索原始标题'))

    def test_connected_host_precedes_history_and_filename_follows_it(self):
        result = self.page.evaluate('''() => {
          const before=document.title, original=history.pushState, seen=[];
          history.pushState=function(...args){seen.push({title:document.title,url:String(args[2]),
            connected:readerHost.overlay?.isConnected,
            shaded:document.body.classList.contains('reader-overlay-open')});return original.apply(this,args)};
          try {
            navigateToReader('/search/static/reader.html?id=sample&ext=html&title=bb_204.html');
            const title=document.title, share=location.href;
            closeReaderOverlay();
            return {before,title,share,seen,restored:document.title};
          } finally {history.pushState=original}
        }''')
        self.assertEqual(result['title'], 'bb_204.html')
        self.assertEqual(result['seen'][0]['title'], result['before'])
        self.assertTrue(result['seen'][0]['connected'])
        self.assertTrue(result['seen'][0]['shaded'])
        self.assertIn('title=bb_204.html', result['share'])
        self.assertEqual(result['restored'], result['before'])

    def test_search_history_entry_keeps_its_title_across_reader_back_and_forward(self):
        if self.fixture.browser.browser_type.name != 'chromium':
            self.skipTest('CDP history entry titles require Chromium')
        cdp = self.page.context.new_cdp_session(self.page)
        def current_entry():
            state = cdp.send('Page.getNavigationHistory')
            return state['entries'][state['currentIndex']]
        original = current_entry()
        title = self.page.title()
        self.page.evaluate('''() => {
          const path = location.pathname.startsWith('/search/') ? '/search/static/reader.html' : '/static/reader.html';
          navigateToReader(path + '?id=history-title&ext=txt&title=Book');
        }''')
        self.page.wait_for_function("readerHost.overlay?.contentDocument?.body?.textContent === 'reader'")
        self.assertEqual(self.page.title(), 'Book')
        search = next(entry for entry in cdp.send('Page.getNavigationHistory')['entries'] if entry['id'] == original['id'])
        self.assertEqual(search['title'], title)
        self.page.evaluate('''() => handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,
          data:{type:'voice-reader-close'}})''')
        self.page.wait_for_function('!readerHost.overlay')
        self.assertEqual(current_entry()['id'], original['id'])
        self.assertEqual(current_entry()['title'], title)
        self.assertEqual(self.page.title(), title)
        self.page.evaluate('history.forward()')
        self.page.wait_for_function("readerHost.overlay?.contentDocument?.body?.textContent === 'reader'")
        self.assertEqual(self.page.title(), 'Book')
        self.page.evaluate('history.back()')
        self.page.wait_for_function('!readerHost.overlay')
        self.assertEqual(current_entry()['id'], original['id'])
        self.assertEqual(current_entry()['title'], title)
        cdp.detach()

    def test_open_yields_to_newer_reader_mounted_during_disposal(self):
        result = self.page.evaluate('''() => {
          const path = location.pathname.startsWith('/search/') ? '/search/static/reader.html' : '/static/reader.html';
          const search = document.title;
          navigateToReader(path + '?id=first&title=First');
          readerHost.overlay.contentWindow.addEventListener('voice-reader-dispose', () => {
            navigateToReader(path + '?id=newest&title=Newest');
          });
          navigateToReader(path + '?id=stale&title=Stale');
          const result = {title:document.title,id:new URL(readerHost.overlay.src).searchParams.get('id'),
            historyId:new URL(history.state.readerUrl).searchParams.get('id'),connected:readerHost.overlay.isConnected,
            count:document.querySelectorAll('iframe.reader-overlay').length};
          closeReaderOverlay();
          return {...result,restored:document.title === search};
        }''')
        self.assertEqual(result, dict(title='Newest', id='newest', historyId='newest', connected=True, count=1, restored=True))

    def test_close_during_disposal_cancels_open_without_orphan_or_history_push(self):
        result = self.page.evaluate('''() => {
          const path = location.pathname.startsWith('/search/') ? '/search/static/reader.html' : '/static/reader.html';
          const title = document.title;
          const background = Array.from(document.body.children).map(element => ({element,
            inert:element.hasAttribute('inert'),hidden:element.getAttribute('aria-hidden')}));
          navigateToReader(path + '?id=first&title=First');
          const first = readerHost.overlay, url = location.href, state = JSON.stringify(history.state), length = history.length;
          let closed = false;
          first.contentWindow.addEventListener('voice-reader-dispose', () => { closed = closeReaderOverlay(); });
          navigateToReader(path + '?id=cancelled&title=Cancelled');
          return {closed,hostEmpty:readerHost.overlay===null,firstRemoved:!first.isConnected,
            frames:document.querySelectorAll('iframe.reader-overlay').length,
            openings:document.querySelectorAll('.reader-overlay-opening').length,
            historyUnchanged:location.href===url && JSON.stringify(history.state)===state && history.length===length,
            backgroundRestored:background.every(({element,inert,hidden}) => element.hasAttribute('inert')===inert &&
              element.getAttribute('aria-hidden')===hidden),
            unshaded:!document.body.classList.contains('reader-overlay-open'),titleRestored:document.title===title};
        }''')
        self.assertEqual(result, dict(closed=True, hostEmpty=True, firstRemoved=True, frames=0, openings=0,
            historyUnchanged=True, backgroundRestored=True, unshaded=True, titleRestored=True))

    def test_older_embedded_reader_still_refreshes_host_title_on_load(self):
        # This is a title compatibility test, not a service-worker cache test.
        # A fresh context prevents the Reader shell warmup from racing the route.
        with self.fixture.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(paging.FETCH_SCRIPT)
            page.route('**/api/**', lambda route: route.fulfill(content_type='application/json', body='[]'))
            page.route('https://vomebook-hitokoto.hf.space/**', lambda route: route.fulfill(body='{}'))
            page.route('**/static/reader.html?**', lambda route: route.fulfill(content_type='text/html',
                body='<title>旧阅读器文档.txt</title><body>reader</body>'))
            page.goto(self.fixture.origin + '/search/#/?q=paging&local=0', wait_until='domcontentloaded')
            page.wait_for_function('STATE._loadedPage === 1 && !STATE.isLoading && window.pagingRequests.includes(2)')
            before = page.title()
            page.evaluate('navigateToReader("/search/static/reader.html?id=older&ext=txt")')
            page.frame_locator('iframe.reader-overlay').locator('body').wait_for()
            page.wait_for_function("()=>document.title==='旧阅读器文档.txt'")
            page.evaluate('closeReaderOverlay()')
            self.assertEqual(page.title(), before)
            self.assertEqual(errors, [])

    def test_parked_reader_title_is_restored_only_when_reopened(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?id=speech-title&ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.wait_for_function('() => !document.querySelector(".reader-overlay-opening")')
        result = self.page.evaluate('''() => {
          const frame=readerHost.overlay, url=frame.src;
          frame.contentDocument.title='朗读中.txt - VoiceOfML Reader';
          frame.contentWindow.CCRDSpeech={state:()=>({active:true,playing:true}),reveal:()=>{}};
          window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:frame.contentWindow,
            data:{type:'voice-reader-title',title:frame.contentDocument.title}}));
          const playing=document.title;closeReaderOverlay();const parked=document.title;
          window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:frame.contentWindow,
            data:{type:'voice-reader-title',title:'后台迟到标题'}}));
          const late=document.title;navigateToReader(url);const reopened=document.title;
          const reused=readerHost.overlay===frame, freshNav=history.state.readerUrl!==frame.src;
          readerNavigation.disposeBackground();closeReaderOverlay();
          return {playing,parked,late,reopened,reused,freshNav};
        }''')
        self.assertEqual(result['playing'], '朗读中.txt - VoiceOfML Reader')
        self.assertEqual(result['parked'], 'VoiceOfML Search')
        self.assertEqual(result['late'], 'VoiceOfML Search')
        self.assertEqual(result['reopened'], result['playing'])
        self.assertTrue(result['reused'])
        self.assertTrue(result['freshNav'])

    def test_foreground_opened_from_parked_reader_keeps_search_title(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?id=first-speech&ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.wait_for_function('() => !document.querySelector(".reader-overlay-opening")')
        result = self.page.evaluate('''() => {
          const first=readerHost.overlay;
          first.contentDocument.title='第一本 - VoiceOfML Reader';
          first.contentWindow.CCRDSpeech={state:()=>({active:true,playing:true}),reveal:()=>{}};
          window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:first.contentWindow,
            data:{type:'voice-reader-title',title:first.contentDocument.title}}));
          closeReaderOverlay();const search=document.title;
          navigateToReader('/search/static/reader.html?id=second-book&ext=txt');
          const second=readerHost.overlay;
          window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:second.contentWindow,
            data:{type:'voice-reader-title',title:'第二本 - VoiceOfML Reader'}}));
          navigateToReader(first.src);
          const reopened=document.title;
          closeReaderOverlay();return {search,reopened,restored:document.title};
        }''')
        self.assertEqual(result['search'], 'VoiceOfML Search')
        self.assertEqual(result['reopened'], '第一本 - VoiceOfML Reader')
        self.assertEqual(result['restored'], result['search'])

    def test_click_replenishes_evicted_reader_metadata(self):
        result = self.page.evaluate('''() => {
           const button=DOM.resultsList.querySelector('[data-action="read"]');
           const id=new URL(button.dataset.readerUrl,location.origin).searchParams.get('id');
           getReaderLink(STATE.results[Number(button.closest('.result-item').dataset.index)]);
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

    def test_djvu_read_button_preserves_ocr_handoff(self):
        # Exercise the rendered action and its click-time enrichment. Stop at
        # navigation: OCR decoding/source integrity has separate Reader tests.
        result = self.page.evaluate(r'''() => {
          cancelReaderWarmup();
          const savedAssets=readerAssetController.state.assets, savedNavigate=navigateToReader;
          const record={Repo:'VoiceOfML/Test',Folder:['docs'],File:'scan.djvu',Extension:'DjVu'};
          const original=getRecordLink(record);
          const root='objects/aa/'+'a'.repeat(64)+'/'+'b'.repeat(16);
          const manifestPath=root+'/ocr-manifest.json';
          const rows=[];
          try {
            readerAssetController.state.assets={[record.Repo+'\0'+buildRecordRelativePath(record)]:
              {s:3,b:'vomebook/pdf-pages-v2',o:manifestPath,om:'accepted'}};
            const enriched=applyReaderAsset(record,record.Repo,buildRecordRelativePath(record),original);
            for(const warm of ['none','matching','different-source','different-version']) {
              VSCROLL.templateCache.delete(0);
              const row=createResultRow(record,0);
              DOM.resultsList.replaceChildren(row);
              const button=row.querySelector('[data-action="read"]');
              const url=new URL(button.dataset.readerUrl,location.href), id=url.searchParams.get('id');
              sessionStorage.removeItem('reader-source:'+id);
              sessionStorage.removeItem('reader-resolve:'+id);
              if(warm!=='none') cacheReaderMetadata(id,{
                url:warm==='different-source'?original.replace('scan.djvu.DjVu','other.djvu'):original,
                download:original,extension:'DjVu',
                ocr_manifest:warm==='different-version'
                  ?enriched.ReaderOcrManifest.replace('b'.repeat(16),'c'.repeat(16)):enriched.ReaderOcrManifest,
                ocr_mode:warm==='matching'?'accepted':'stale',version:'warm-only'
              });
              let captured=null;
              navigateToReader=target=>{
                captured={id:new URL(target,location.href).searchParams.get('id'),
                  source:JSON.parse(sessionStorage.getItem('reader-source:'+id)),
                  resolved:JSON.parse(sessionStorage.getItem('reader-resolve:'+id))};
              };
              button.click();
              rows.push({warm,id,inlineOcr:url.searchParams.has('ocr_manifest'),captured});
            }
            return {original,manifestPath,manifest:enriched.ReaderOcrManifest,rows};
          } finally {
            readerAssetController.state.assets=savedAssets;navigateToReader=savedNavigate;
          }
        }''')
        self.assertTrue(result['manifest'])
        self.assertEqual(parse_qs(urlsplit(result['manifest']).query)['path'], [result['manifestPath']])
        for row in result['rows']:
            with self.subTest(warm=row['warm']):
                self.assertRegex(row['id'], r'^[a-z0-9]{13}$')
                self.assertFalse(row['inlineOcr'])
                self.assertIsNotNone(row['captured'])
                self.assertEqual(row['captured']['id'], row['id'])
                for key in ('source', 'resolved'):
                    metadata = row['captured'][key]
                    self.assertEqual(metadata['url'], result['original'])
                    self.assertEqual(metadata['download'], result['original'])
                    self.assertEqual(metadata['extension'], 'DjVu')
                    self.assertEqual(metadata['original_extension'], 'DjVu')
                    self.assertEqual(metadata['filename'], 'scan.djvu.DjVu')
                    self.assertEqual(metadata['repo'], 'Test')
                    self.assertEqual(metadata['folder'], ['docs'])
                    self.assertEqual(metadata.get('ocr_manifest'), result['manifest'])
                    self.assertEqual(metadata.get('ocr_mode'), 'accepted')
                    self.assertNotIn('version', metadata)

    def test_directory_preserves_repeated_filename_extension_for_read_and_download(self):
        result = self.page.evaluate('''() => {
          const repo='VoiceOfML/Test', folder='目录', files=[
            {name:'poster.jpg',ext:'jpg',size:1}, {name:'normal',ext:'jpg',size:1},
            {name:'book.PDF',ext:'pdf',size:1}, {name:'README',ext:'',size:1}];
          const list=document.createElement('div');list.className='browser-list';DOM.sidebarContent.append(list);
          renderBrowserListItems(list,{folders:[],files},repo,folder);
          return [...list.querySelectorAll('.browser-item')].map(row=>({filename:row.dataset.filename,
            link:decodeURIComponent(new URL(row.dataset.link).pathname),
            reader:row.dataset.readerUrl ? new URL(row.dataset.readerUrl,location.href).searchParams.get('id') : null}));
        }''')
        self.assertEqual([row['filename'] for row in result],
                         ['poster.jpg.jpg','normal.jpg','book.PDF.pdf','README'])
        for row in result:
            self.assertTrue(row['link'].endswith('/目录/'+row['filename']))
        self.assertTrue(result[0]['reader'])

    def test_session_handoff_keeps_exact_original_filename(self):
        result=self.page.evaluate('''()=>{
          const record={Repo:'VoiceOfML/Test',Folder:['docs'],File:'poster.jpg',Extension:'JPG'};
          const url=getReaderLink(record),id=new URL(url,location.href).searchParams.get('id');
          return JSON.parse(sessionStorage.getItem('reader-source:'+id));
        }''')
        self.assertEqual(result['filename'],'poster.jpg.JPG')

    def test_explicit_close_ignores_late_panel_state_before_history_pop(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        state = self.page.evaluate('''() => {
          const frame=readerHost.overlay, back=history.back;
          history.back=()=>{};
          try {
            handleReaderMessage({origin:location.origin,source:frame.contentWindow,data:{type:'voice-reader-close'}});
            handleReaderMessage({origin:location.origin,source:frame.contentWindow,
              data:{type:'voice-reader-ui-state',state:'panel'}});
            return readerUiState;
          } finally { history.back=back; }
        }''')
        self.assertEqual(state, 'base')
        self.page.evaluate('history.back()')
        self.page.locator('.reader-overlay').wait_for(state='detached')
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")')
        state = self.page.evaluate('''()=>{
          handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,
            data:{type:'voice-reader-ui-state',state:'panel'}});
          return readerUiState;
        }''')
        self.assertEqual(state, 'panel', 'a new Reader must still publish its real panel state')

    def test_back_with_panel_open_exits_even_without_overlay_history_entry(self):
        # Formerly the close waited on history.back(); a non-overlay current entry
        # left the Reader open and readerClosing then ignored every later tap.
        before = self.page.evaluate('() => new URL(location.href).pathname')
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.evaluate("""() => {
          history.replaceState({foreign:{nested:{items:['keep', 7]}}}, "", location.href);
          handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,
            data:{type:'voice-reader-ui-state',state:'panel'}});
          handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,
            data:{type:'voice-reader-close'}});
        }""")
        self.page.locator('.reader-overlay').wait_for(state='detached', timeout=3000)
        self.assertFalse(self.page.evaluate('readerClosing'))
        self.assertEqual(self.page.evaluate('() => new URL(location.href).pathname'), before)
        self.assertEqual(self.page.evaluate('history.state'), {'foreign': {'nested': {'items': ['keep', 7]}}})

    def test_back_tap_recovers_when_history_traversal_never_arrives(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        target = self.page.evaluate('new URL(readerHost.overlay.src).searchParams.get("return")')
        self.page.evaluate("""() => {
          window.__backCalls = 0;
          history.back = () => { __backCalls++; };
          handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,data:{type:'voice-reader-close'}});
        }""")
        # Automatic replacement destroyed the Reader entry when Back was late.
        # The stalled contract now requires a visible, usable explicit recovery.
        recovery = self.page.get_by_role('link', name='直接打开搜索页')
        recovery.wait_for(state='visible', timeout=3000)
        self.assertEqual(recovery.get_attribute('href'), target)
        self.assertFalse(recovery.evaluate('link => !!link.closest("[inert]")'))
        self.assertEqual(self.page.evaluate('__backCalls'), 1)
        self.assertTrue(self.page.evaluate('readerClosing && history.state.voiceReaderOverlay'))
        with self.page.expect_navigation(wait_until='domcontentloaded'):
            recovery.click()
        self.assertEqual(self.page.url, target)
        self.page.wait_for_function('STATE.results.length > 0 && !STATE.isLoading')
        self.assertEqual(self.page.locator('.reader-overlay').count(), 0)
        self.assertFalse(self.page.evaluate('readerClosing'))
        self.assertFalse(self.page.evaluate('!!history.state?.voiceReaderOverlay'))
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.evaluate('history.back()')
        self.page.locator('.reader-overlay').wait_for(state='detached')

    def test_close_without_overlay_entry_never_traverses_history_for_a_foreign_return(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt", "/elsewhere/page")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        traversed = self.page.evaluate("""() => {
          let calls = 0; const back = history.back; history.back = () => { calls++; };
          history.replaceState({foreign:{nested:{items:['keep', 7]}}}, "", location.href);
          try {
            handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,data:{type:'voice-reader-close'}});
          } finally { history.back = back; }
          return calls;
        }""")
        self.page.locator('.reader-overlay').wait_for(state='detached', timeout=3000)
        self.assertEqual(traversed, 0)
        self.assertEqual(self.page.evaluate('history.state'), {'foreign': {'nested': {'items': ['keep', 7]}}})
        self.assertEqual(self.page.evaluate('() => new URL(location.href).pathname'), '/search/')
        self.assertFalse(self.page.evaluate('readerClosing'))

    def test_close_disposes_child_synchronously_before_detachment(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        result = self.page.evaluate('''() => {
          const child=readerHost.overlay.contentWindow, frame=readerHost.overlay;
          let disposed=false, attached=false;
          child.addEventListener('voice-reader-dispose', () => {
            disposed=true; attached=frame.isConnected;
          });
          closeReaderOverlay();
          return {disposed, attached, removed:!frame.isConnected, blank:frame.src==='about:blank'};
        }''')
        self.assertTrue(all(result.values()), result)

    def test_pending_shell_has_immediate_feedback_and_rejects_unowned_reveal(self):
        held = []
        self.context = self.fixture.context
        self.context.route('**/static/pending-reader.html?**', lambda route: held.append(route))
        self.page.evaluate('''() => {
          window.__pendingNavigation = VoiceOfMLReaderNavigation.createNavigation('/search/static/pending-reader.html');
          __pendingNavigation.mount(new URL('/search/static/pending-reader.html?ext=txt', location.origin));
        }''')
        self.page.locator('.reader-overlay-opening').wait_for()
        self.assertTrue(self.page.locator('.reader-overlay-pending').count())
        self.page.evaluate('window.postMessage({type:"voice-reader-shell"},location.origin)')
        self.page.wait_for_timeout(30)
        self.assertTrue(self.page.locator('.reader-overlay-opening').is_visible())
        self.page.evaluate('__pendingNavigation.unmount()')
        self.assertEqual(self.page.locator('.reader-overlay-opening').count(), 0)
        self.assertEqual(self.page.locator('.reader-overlay').count(), 0)
        for route in held:
            route.fulfill(content_type='text/html', body='<body>cancelled</body>')

    def _deliver_late_reader_shell(self, route, recovery):
        # Observe the real iframe load and child message while Back is still stalled.
        # The body must belong to the routed document, not the initial about:blank.
        recovery.evaluate('''link => {
          const frame = readerHost.overlay;
          const late = window.__lateReader = {frame, link, loaded:false, delivered:false};
          frame.addEventListener('load', function onLoad() {
            if (frame.contentDocument?.body?.id !== 'late-reader-shell') return;
            late.loaded = true;
            frame.removeEventListener('load', onLoad);
          });
          window.addEventListener('message', function onShell(event) {
            if (event.origin !== location.origin || event.source !== frame.contentWindow ||
                event.data?.type !== 'voice-reader-shell') return;
            late.delivered = true;
            window.removeEventListener('message', onShell);
          });
        }''')
        route.fulfill(content_type='text/html', body='<body id="late-reader-shell">late reader shell</body>')
        body = route.request.frame.locator('body#late-reader-shell')
        body.wait_for(state='attached')
        self.page.wait_for_function('__lateReader.loaded')
        body.evaluate('() => parent.postMessage({type:"voice-reader-shell"}, location.origin)')
        self.page.wait_for_function('__lateReader.delivered')
        self.assertEqual(recovery.evaluate('''link => {
          const {frame, link: originalLink} = __lateReader;
          const style = getComputedStyle(frame);
          return {owned:readerHost.overlay === frame && frame.isConnected,
                  pending:frame.classList.contains('reader-overlay-pending'),
                  visibility:style.visibility, pointerEvents:style.pointerEvents,
                  sameLink:link === originalLink, focused:document.activeElement === link,
                  inert:!!link.closest('[inert]')};
        }'''), dict(owned=True, pending=True, visibility='hidden', pointerEvents='none',
                    sameLink=True, focused=True, inert=False))
        self.assertTrue(recovery.is_visible(), 'late load and shell message must not dismiss recovery')

    def test_pending_shell_can_leave_even_when_history_traversal_stalls(self):
        held = []
        self.page.unroute('**/static/reader.html?**')
        self.page.route('**/static/reader.html?**', lambda route: held.append(route))
        with self.page.expect_request('**/static/reader.html?**'):
            present = self.page.evaluate('''() => {history.back=()=>{};
              navigateToReader('/search/static/reader.html?ext=txt');
              const button=document.querySelector('.reader-overlay-opening button');button?.click();return !!button;}''')
        self.assertTrue(present)
        recovery = self.page.get_by_role('link', name='直接打开搜索页')
        recovery.wait_for(state='visible', timeout=3000)
        self.assertEqual(len(held), 1)
        self._deliver_late_reader_shell(held.pop(), recovery)
        with self.page.expect_navigation(wait_until='domcontentloaded'):
            recovery.click()
        self.page.wait_for_function('STATE.results.length > 0 && !STATE.isLoading')
        self.assertEqual(self.page.locator('.reader-overlay-opening').count(), 0)
        self.assertEqual(self.page.locator('.reader-overlay').count(), 0)
        self.assertFalse(self.page.evaluate('readerClosing'))

    def test_closing_a_speech_reader_does_not_leave_the_reopened_frame_hidden(self):
        self.page.evaluate('navigateToReader("/search/static/reader.html?id=speech-resume&ext=txt")')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.wait_for_function('() => !document.querySelector(".reader-overlay-opening")')
        result = self.page.evaluate('''() => {
          const frame=readerHost.overlay;
          frame.contentWindow.CCRDSpeech={state:()=>({active:true,playing:true}),reveal:()=>{}};
          const target=frame.src;
          readerNavigation.dismiss();closeReaderOverlay();
          navigateToReader(target);
          return {same:readerHost.overlay===frame, opacity:getComputedStyle(frame).opacity,
            pointer:getComputedStyle(frame).pointerEvents};
        }''')
        self.assertEqual(result, dict(same=True, opacity='1', pointer='auto'))

    def test_reader_intent_preempts_a_stalled_hover_without_stale_cache(self):
        result = self.page.evaluate(r'''async () => {
          cancelReaderWarmup();
          const originalFetch=window.fetch, savedUrl=location.href;
          const calls=[], errors=[];
          const handler=event=>errors.push(String(event.reason));
          window.addEventListener('unhandledrejection',handler);
          window.fetch=(url,options)=>{
            if (!String(url).includes('/api/reader-resolve?id=warm-')) return originalFetch(url,options);
            return new Promise(resolve=>calls.push({url:String(url),options,resolve}));
          };
          const make=(id,attribute)=>{
            const button=document.createElement('button');button.type='button';
            button.dataset[attribute]='/static/reader.html?id=warm-'+id+'&ext=txt';
            document.body.appendChild(button);return button;
          };
          const hover=make('hover','readerUrl'), click=make('click','readUrl'), keyboard=make('keyboard','readerUrl');
          try {
            hover.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
            let releaseBody;
            calls[0].resolve({ok:true,json:()=>new Promise(resolve=>{releaseBody=resolve})});
            await Promise.resolve();await Promise.resolve();
            click.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
            const before=calls.length;
            click.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));
            const replaced=calls[0].options.signal.aborted && calls[1].url.endsWith('id=warm-click');
            releaseBody({url:'https://source.test/stale'});
            await new Promise(resolve=>setTimeout(resolve,0));
            const stale=sessionStorage.getItem('reader-resolve:warm-hover');
            const slot=readerWarmupInFlight;
            calls[1].resolve({ok:true,json:async()=>({url:'https://source.test/click'})});
            await new Promise(resolve=>setTimeout(resolve,0));
            const cached=JSON.parse(sessionStorage.getItem('reader-resolve:warm-click') || 'null');
            // A keyboard focus supersedes a different hover, too.
            hover.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
            keyboard.focus();
            const keyboardReplaced=calls[2].options.signal.aborted && calls[3].url.endsWith('id=warm-keyboard');
            calls[3].resolve({ok:true,json:async()=>({url:'https://source.test/keyboard'})});
            await new Promise(resolve=>setTimeout(resolve,0));
            return {before,replaced,stale,slot,cached:cached?.url,keyboardReplaced,
              keyboard:JSON.parse(sessionStorage.getItem('reader-resolve:warm-keyboard') || 'null')?.url,
              active:readerWarmupInFlight,errors};
          } finally {
            cancelReaderWarmup();window.fetch=originalFetch;window.removeEventListener('unhandledrejection',handler);
            hover.remove();click.remove();keyboard.remove();history.replaceState(null,'',savedUrl);
          }
        }''')
        self.assertEqual(result, dict(before=1,replaced=True,stale=None,slot=1,
                                      cached='https://source.test/click',keyboardReplaced=True,
                                      keyboard='https://source.test/keyboard',active=0,errors=[]))

    def test_priority_warmup_is_consumed_by_real_reader(self):
        # The target resolves before activation; the real Reader must use the
        # session handoff rather than issue a second metadata request.
        self.page.unroute('**/static/reader.html?**')
        lookups = []
        self.page.route('**/api/reader-resolve?**', lambda route: (
            lookups.append(route.request.url), route.fulfill(json={'error':'unexpected resolve'}, status=500,
                                                               headers={'Access-Control-Allow-Origin':'*'})))
        self.page.route('**/api/reader-content?**', lambda route: route.fulfill(
            content_type='text/plain', body='Priority handoff document', headers={'Access-Control-Allow-Origin':'*'}))
        self.page.evaluate(r'''() => {
          cancelReaderWarmup();
          window.__priorityFetch=window.fetch;
          window.__priorityCalls=[];
          window.fetch=(url,options={})=>{
            if (!String(url).includes('/api/reader-resolve?id=')) return __priorityFetch(url,options);
            return new Promise((resolve,reject)=>{
              const id=new URL(String(url),location.href).searchParams.get('id');
              __priorityCalls.push({id,signal:options.signal});
              options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});
              if(id==='bbbbbbbbbbbbb')setTimeout(()=>resolve({ok:true,json:async()=>({
                url:'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/warm.txt',
                download:'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/warm.txt',extension:'txt'})}),50);
            });
          };
          const holder=document.createElement('div');holder.id='priority-reader-test';
          DOM.sidebarContent.parentNode.insertBefore(holder,DOM.sidebarContent);
          const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
          for(const id of ['aaaaaaaaaaaaa','bbbbbbbbbbbbb']){
            const row=document.createElement('div');row.className='browser-item';row.dataset.type='file';
            row.dataset.readerUrl=path+'?id='+id+'&ext=txt';row.dataset.readUrl=row.dataset.readerUrl;
            const button=document.createElement('button');button.textContent=id;row.appendChild(button);holder.appendChild(row);
          }
          holder.addEventListener('click',event=>{
            const row=event.target.closest('.browser-item');if(row)navigateToReader(row.dataset.readerUrl);
          });
        }''')
        try:
            self.page.evaluate("document.querySelectorAll('#priority-reader-test button')[0].dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))")
            self.page.wait_for_function('__priorityCalls.length === 1')
            self.page.evaluate("document.querySelectorAll('#priority-reader-test button')[1].focus()")
            self.page.wait_for_function('__priorityCalls.length === 2')
            self.assertTrue(self.page.evaluate('__priorityCalls[0].signal.aborted'))
            self.page.wait_for_function('!!sessionStorage.getItem("reader-resolve:bbbbbbbbbbbbb")')
            self.page.evaluate("document.querySelectorAll('#priority-reader-test button')[1].click()")
            frame = self.page.frame_locator('.reader-overlay')
            content = frame.locator('.reader-text')
            expect(content).to_contain_text('Priority handoff document', timeout=12000)
            self.assertTrue(content.is_visible())
            self.assertEqual(lookups, [])
        finally:
            self.page.evaluate('''() => {
              if(readerHost.overlay) { readerNavigation.dismiss();closeReaderOverlay(); }
              document.querySelector('#priority-reader-test')?.remove();
              window.fetch=window.__priorityFetch;cancelReaderWarmup();
            }''')

    def test_late_priority_metadata_never_disrupts_an_open_reader(self):
        self.page.unroute('**/static/reader.html?**')
        source='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/late.txt'
        lookups=[]
        self.page.route('**/api/reader-resolve?**', lambda route: (
            lookups.append(route.request.url),route.fulfill(json={'url':source,'download':source,'extension':'txt'},
                                                              headers={'Access-Control-Allow-Origin':'*'})))
        self.page.route('**/api/reader-content?**', lambda route: route.fulfill(
            content_type='text/plain',body='Reader independent of delayed warmup',headers={'Access-Control-Allow-Origin':'*'}))
        self.page.evaluate(r'''() => {
          cancelReaderWarmup();window.__lateOriginalFetch=fetch;window.__lateCalls=[];
          window.fetch=(url,options={})=>{
            if(!String(url).includes('/api/reader-resolve?id='))return __lateOriginalFetch(url,options);
            return new Promise((resolve,reject)=>{
              __lateCalls.push({resolve,signal:options.signal});
              options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});
            });
          };
          const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
          const first=document.createElement('button'),second=document.createElement('button');
          first.dataset.readerUrl=path+'?id=aaaaaaaaaaaaa&ext=txt';
          second.dataset.readerUrl=path+'?id=ccccccccccccc&ext=txt';
          document.body.append(first,second);window.__lateButtons=[first,second];
          first.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
          second.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
          navigateToReader(second.dataset.readerUrl);
        }''')
        try:
            self.assertTrue(self.page.evaluate('__lateCalls.length === 2 && __lateCalls[0].signal.aborted'))
            frame=self.page.frame_locator('.reader-overlay')
            frame.locator('.reader-text').wait_for(state='visible',timeout=12000)
            self.assertIn('Reader independent of delayed warmup',frame.locator('.reader-text').inner_text())
            self.assertEqual(len(lookups),1)
            self.page.evaluate('''url=>__lateCalls[1].resolve({ok:true,json:async()=>({url,extension:'txt'})})''', source)
            self.page.wait_for_function('readerWarmupInFlight === 0')
            self.assertIn('Reader independent of delayed warmup',frame.locator('.reader-text').inner_text())
            self.assertEqual(len(lookups),1)
        finally:
            self.page.evaluate('''() => {
              if(readerHost.overlay){readerNavigation.dismiss();closeReaderOverlay();}
              __lateButtons.forEach(button=>button.remove());window.fetch=__lateOriginalFetch;cancelReaderWarmup();
            }''')

    def test_shell_is_warmed_without_pointer_intent_or_reader_execution(self):
        self.page.wait_for_function('warmedReaderAssets.has("/search/static/reader.html")')
        # Under SW control the link follows the cached shell fetch.
        self.page.locator('link[rel="modulepreload"][href="/search/static/reader.js"]').wait_for(state='attached')
        self.assertEqual(self.page.locator('.reader-overlay').count(), 0)
        self.assertFalse(self.page.evaluate('!!window.VoiceOfMLReaderPdfDiagnostics'))

    def test_random_reader_body_timeout_after_close_remains_retryable(self):
        result = self.page.evaluate('''async () => {
          const originalFetch=fetch, originalTimer=setTimeout, previousUrl=location.href;
          const localFallback=typeof ensureLocalDataLoaded==='function'?ensureLocalDataLoaded:null;
          let attempts=0, aborted=false;
          STATE.dataLoaded=false;
          if (localFallback) ensureLocalDataLoaded=async()=>false;
          window.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===10000?50:ms,...args);
          window.fetch=(input,options)=>{
            if (!String(input).includes('/api/random-reader')) return originalFetch(input,options);
            if (++attempts===1) return Promise.resolve(new Response(new ReadableStream({start(controller){
              options.signal.addEventListener('abort',()=>{aborted=true;controller.error(new DOMException('timed out','AbortError'));},{once:true});
            }})));
            return Promise.resolve(new Response(JSON.stringify({Repo:'VoiceOfML/Test',File:'next',Extension:'txt',
              Link:'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/next.txt',Folder:[]})));
          };
          try {
            const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
            navigateToReader(path+'?ext=txt');closeReaderOverlay();history.replaceState(null,'',previousUrl);
            await randomTxt();await new Promise(resolve=>originalTimer(resolve,100));
            const recovered=aborted&&!!readerHost.overlay;
            closeReaderOverlay();history.replaceState(null,'',previousUrl);
            await randomTxt();await new Promise(resolve=>originalTimer(resolve,100));
            return {recovered,attempts,opened:!!readerHost.overlay};
          } finally {
            window.fetch=originalFetch;window.setTimeout=originalTimer;
            if(localFallback)ensureLocalDataLoaded=localFallback;
          }
        }''')
        self.assertEqual(result, {'recovered':True,'attempts':3,'opened':True})

    def test_random_reader_retries_transient_http_but_not_permanent_or_stale_failure(self):
        result = self.page.evaluate('''async () => {
          const originalFetch=fetch, savedUrl=location.href;
          const success={Repo:'VoiceOfML/Test',File:'next',Extension:'txt',
            Link:'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/next.txt',Folder:[]};
          const rows=[];
          try {
            for(const code of [503,429,404]) {
              let requests=0;
              window.fetch=(input,options)=>String(input).includes('/api/random-reader')
                ? Promise.resolve(++requests===1
                  ? new Response('{}',{status:code}) : new Response(JSON.stringify(success)))
                : originalFetch(input,options);
              const id=++randomReaderRequestId;
              try { await fetchRandomReaderRecord('/api/random-reader',id,savedUrl); } catch (_) {}
              rows.push(requests);
            }
            let requests=0;
            window.fetch=(input,options)=>{
              if (!String(input).includes('/api/random-reader')) return originalFetch(input,options);
              requests++;randomReaderRequestId++;return Promise.reject(new TypeError('network'));
            };
            await fetchRandomReaderRecord('/api/random-reader',++randomReaderRequestId,savedUrl);
            rows.push(requests);
            return rows;
          } finally {window.fetch=originalFetch;}
        }''')
        self.assertEqual(result, [2,2,1,1])

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
        self.assertEqual(params['path'], 'a.b/书')
        self.assertEqual(params['min_size'], '2KB')
        self.assertEqual(params['max_size'], '8KB')
        self.assertEqual(params['search_folders'], 'false')
        self.assertEqual(params['exact'], '0')
        self.assertEqual(params['history'], '0')
        self.assertEqual(params['local'], '0')
        self.assertEqual(params['q'], 'current query')

    def test_reader_folder_url_root_and_special_characters_are_unambiguous(self):
        result = self.page.evaluate('''() => {
          const decode=record=>Object.fromEntries(new URLSearchParams(new URL(getReaderFolderUrl(record)).hash.split('?')[1] || ''));
          return {root:decode({Repo:'VoiceOfML/Test',Folder:[]}),
            special:decode({Repo:'VoiceOfML/Test',Folder:['a%2F &','#书?']})};
        }''')
        self.assertNotIn('path', result['root'])
        self.assertNotIn('folder_self', result['root'])
        self.assertEqual(result['special']['path'], 'a%2F &/#书?')
        self.assertEqual(result['special']['folder_self'], result['special']['path'])

    def test_reader_folder_message_positions_sidebar_without_changing_filter_scope(self):
        for width in (1280, 390):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 800})
                result = self.page.evaluate('''async width => {
                  STATE.isMobile=width<600;applyMobileMode();
                  STATE.leftSidebarOpen=width>=600;STATE.rightSidebarOpen=false;updateSidebarVisibility();
                  STATE.query='paging';DOM.searchInput.value='paging';STATE.filterExtensions=['txt'];STATE.sort='size';
                  STATE.filterMinSize=1024;STATE.filterMaxSize=8192;STATE.filterFolderSelfs=[];STATE.filterFolderSubtrees=[];
                  getFolderContents=async (_repo,path)=>({folders:[],files:[{name:path || 'root',ext:'txt',size:1}]});
                  fetchFolderTree=async()=>[];loadSidebarInitial=async()=>null;
                  const folder='a%2F &/#书?',target=getReaderFolderUrl({Repo:'VoiceOfML/Test',Folder:['a%2F &','#书?']});
                  navigateToReader('/search/static/reader.html?ext=txt');
                  const frame=readerHost.overlay;
                  handleReaderMessage({origin:location.origin,source:frame.contentWindow,data:{type:'voice-reader-navigate',url:target}});
                  return {folder,target,reader:!!readerHost.overlay};
                }''', width)
                self.page.wait_for_function('''folder=>STATE.repo==='Test' && STATE.browserPath===folder &&
                  document.querySelector('.sidebar-breadcrumb .current')?.dataset.path===folder''', arg=result['folder'])
                self.assertFalse(result['reader'])
                self.assertEqual(self.page.evaluate('STATE.filterFolderSelfs'), [result['folder']])
                self.assertEqual(self.page.evaluate('STATE.filterFolderSubtrees'), [])
                self.assertEqual(self.page.evaluate('[STATE.query,STATE.filterExtensions,STATE.sort,STATE.filterMinSize,STATE.filterMaxSize]'),
                                 ['paging', ['txt'], 'size', 1024, 8192])
                self.assertEqual(self.page.evaluate('STATE.leftSidebarOpen'), width >= 600)
                self.assertEqual(self.page.evaluate('STATE.rightSidebarOpen'), False)
                if width < 600:
                    self.page.locator('#hamburger-btn').click()
                    self.assertTrue(self.page.locator('#left-sidebar').evaluate("n=>n.classList.contains('open')"))
                    self.assertEqual(self.page.locator('.sidebar-breadcrumb .current').get_attribute('data-path'), result['folder'])

    def test_reader_return_captures_cleared_query_before_search_finishes(self):
        result = self.page.evaluate('''() => {
          STATE.query = '旧查询'; DOM.searchInput.value = STATE.query; syncStateToURL();
          const originalSearch = doSearch;
          doSearch = () => new Promise(() => {});
          try {
            submitSearchQuery('', {clearResults: true, updateInput: true});
            const current = location.href;
            navigateToReader('/search/static/reader.html?ext=txt');
            const saved = JSON.parse(sessionStorage.getItem('reader-navigation-current'));
            history.back();
            return {current, route: new URL(saved.readerUrl).searchParams.get('return'),
                    scroll: saved.returnScroll, reader: readerHost.overlay !== null};
          } finally { doSearch = originalSearch; }
        }''')
        self.assertNotIn('q=%E6%97%A7%E6%9F%A5%E8%AF%A2', result['current'])
        self.assertEqual(result['route'], result['current'])
        self.assertIsNone(result['scroll'], 'uncommitted results cannot own a return scroll snapshot')
        self.assertTrue(result['reader'])

    def test_reader_folder_return_merges_current_filters_into_pages_hash(self):
        result = self.page.evaluate('''() => {
          STATE.query=''; STATE.filterExtensions=['pdf','txt'];
          STATE.filterMinSize=2048; STATE.filterMaxSize=8192;
          STATE.searchFolders=false; STATE.exact=false; STATE.useLocalMode=false;
          STATE.recordHistory=false; STATE.useMirrorLinks=false; STATE.sort='size';
          DOM.searchInput.value='current query';
          let target=new URL('/search/#/Test?folder_self=docs&ext=stale&q=stale',location.origin);
          target=readerNavigation.mergeSearchParams(target,currentReaderSearchParams(),{
            hashRoute:true,keys:READER_RETURN_SEARCH_KEYS
          });
          return {route:target.hash.split('?')[0],params:Object.fromEntries(new URLSearchParams(target.hash.split('?')[1]))};
        }''')
        self.assertEqual(result['route'], '#/Test')
        params = result['params']
        self.assertEqual(params['folder_self'], 'docs')
        self.assertEqual(params['q'], 'current query')
        self.assertEqual(params['ext'], 'pdf,txt')
        self.assertEqual(params['min_size'], '2KB')
        self.assertEqual(params['max_size'], '8KB')
        self.assertEqual(params['sort'], 'size')
        self.assertEqual(params['search_folders'], 'false')
        self.assertEqual(params['exact'], '0')
        self.assertEqual(params['local'], '0')
        self.assertEqual(params['history'], '0')
        self.assertEqual(params['mirror'], '0')

    def test_untrusted_and_stale_messages_cannot_change_active_reader(self):
        result = self.page.evaluate('''() => {
          const readerPath=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
          const target=readerPath+'?ext=txt';navigateToReader(target);
          const first=readerHost.overlay, oldSource=first.contentWindow, theme=STATE.isDark;
          const message={type:'voice-reader-open',url:target+'&title=bad'};
          handleReaderMessage({origin:'https://invalid.example',source:oldSource,data:message});
          handleReaderMessage({origin:location.origin,source:window,data:message});
          handleReaderMessage({origin:location.origin,source:oldSource,data:{...message,url:'/wrong-path'}});
          const untouched=readerHost.overlay===first;
          handleReaderMessage({origin:location.origin,source:oldSource,data:{...message,url:target+'&title=valid'}});
          const second=readerHost.overlay;
          handleReaderMessage({origin:location.origin,source:oldSource,data:{type:'voice-reader-theme',theme:theme?'light':'dark'}});
          return {untouched,replaced:second!==first,staleIgnored:STATE.isDark===theme};
        }''')
        self.assertTrue(all(result.values()), result)

    def test_unavailable_session_storage_does_not_block_replacement(self):
        result = self.page.evaluate('''() => {
          const readerPath=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src).pathname.replace('search/reader-host/application/navigation.js','reader.html');
          const target=readerPath+'?ext=txt';navigateToReader(target);const first=readerHost.overlay;
          const original=Storage.prototype.setItem;
          try {
            Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};
            handleReaderMessage({origin:location.origin,source:first.contentWindow,data:{type:'voice-reader-open',url:target+'&title=next'}});
            return readerHost.overlay!==first && !first.isConnected && history.state.readerUrl===readerHost.overlay.src;
          } finally {Storage.prototype.setItem=original;}
        }''')
        self.assertTrue(result)

    def test_watchdog_late_back_preserves_reader_forward_and_foreign_state(self):
        self.page.locator('#search-input').focus()
        before = self.page.evaluate('''() => {
          history.replaceState({...history.state, foreignSearch:{keep:1}}, '', location.href);
          return {url:location.href, state:history.state, rows:STATE.results.map(getResultStableId)};
        }''')
        opened = self.page.evaluate('''() => {
          const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src)
            .pathname.replace('search/reader-host/application/navigation.js','reader.html');
          navigateToReader(path+'?ext=txt&title=Delayed');
          history.replaceState({...history.state, foreignReader:{keep:2}}, '', location.href);
          return {url:location.href, state:history.state, length:history.length};
        }''')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.evaluate('''() => {
          const back=history.back.bind(history);
          window.__releaseBack=()=>{history.back=back;back();};
          window.__backCalls=0; window.__historyWrites=0;
          history.back=()=>{__backCalls++;};
          for (const name of ['pushState','replaceState']) {
            const original=history[name].bind(history);
            history[name]=(...args)=>{__historyWrites++;return original(...args);};
          }
          window.__returnSnapshot=readerReturnSnapshot;
          handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,data:{type:'voice-reader-close'}});
        }''')
        recovery = self.page.get_by_role('link', name='直接打开搜索页')
        recovery.wait_for(state='visible', timeout=3000)
        self.assertEqual(self.page.evaluate('({url:location.href,state:history.state,length:history.length})'), opened)
        self.assertEqual(self.page.evaluate('[__backCalls,__historyWrites]'), [1, 0])
        self.assertTrue(self.page.evaluate('readerClosing && readerReturnSnapshot === __returnSnapshot'))
        # Release the sole requested traversal only after the watchdog has run.
        self.page.evaluate('__releaseBack()')
        self.page.locator('.reader-overlay').wait_for(state='detached')
        self.assertEqual(self.page.url, before['url'])
        self.assertEqual(self.page.evaluate('history.state'), before['state'])
        self.assertEqual(self.page.evaluate('STATE.results.map(getResultStableId)'), before['rows'])
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'search-input')
        self.assertEqual(self.page.locator('.reader-overlay-opening').count(), 0)
        self.page.evaluate('history.forward()')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.assertEqual(self.page.evaluate('({url:location.href,state:history.state,length:history.length})'), opened)
        self.assertEqual(self.page.evaluate('readerHost.overlay.src'), opened['state']['readerUrl'])
        self.assertFalse(self.page.evaluate('readerClosing'))
        self.assertEqual(self.page.locator('.reader-overlay-opening a').count(), 0)

    def test_pending_watchdog_late_frame_and_back_preserve_history(self):
        held = []
        self.page.unroute('**/static/reader.html?**')
        self.page.route('**/static/reader.html?**', lambda route: held.append(route))
        self.page.locator('#search-input').focus()
        before = self.page.evaluate('''() => {
          history.replaceState({...history.state, foreignSearch:{keep:1}}, '', location.href);
          return {url:location.href, state:history.state, rows:STATE.results.map(getResultStableId)};
        }''')
        with self.page.expect_request('**/static/reader.html?**'):
            self.page.evaluate('''() => {
              const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src)
                .pathname.replace('search/reader-host/application/navigation.js','reader.html');
              navigateToReader(path+'?ext=txt&title=Pending');
              history.replaceState({...history.state, foreignReader:{keep:2}}, '', location.href);
              const back=history.back.bind(history);
              window.__releaseBack=()=>{history.back=back;back();};
              window.__backCalls=0; window.__historyWrites=0;
              history.back=()=>{__backCalls++;};
              for (const name of ['pushState','replaceState']) {
                const original=history[name].bind(history);
                history[name]=(...args)=>{__historyWrites++;return original(...args);};
              }
              window.__returnSnapshot=readerReturnSnapshot;
            }''')
        opening = self.page.locator('.reader-overlay-opening')
        opening.wait_for(state='visible')
        self.assertEqual(len(held), 1)
        pending = self.page.evaluate('({url:location.href,state:history.state})')
        opening.locator('button').click()
        recovery = self.page.get_by_role('link', name='直接打开搜索页')
        recovery.wait_for(state='visible', timeout=3000)
        self.assertFalse(recovery.evaluate('link => !!link.closest("[inert]")'))
        self.assertEqual(self.page.evaluate('[__backCalls,__historyWrites]'), [1, 0])
        self.assertTrue(self.page.evaluate('readerClosing && readerReturnSnapshot === __returnSnapshot'))
        self.assertEqual(self.page.evaluate('({url:location.href,state:history.state})'), pending)
        self._deliver_late_reader_shell(held.pop(), recovery)
        self.assertEqual(self.page.evaluate('[__backCalls,__historyWrites]'), [1, 0])
        self.assertTrue(self.page.evaluate('readerClosing && readerReturnSnapshot === __returnSnapshot'))
        opened = self.page.evaluate('({url:location.href,state:history.state,length:history.length})')
        self.assertEqual({k: opened[k] for k in pending}, pending)
        self.page.evaluate('__releaseBack()')
        self.page.locator('.reader-overlay').wait_for(state='detached')
        self.assertEqual(self.page.url, before['url'])
        self.assertEqual(self.page.evaluate('history.state'), before['state'])
        self.assertEqual(self.page.evaluate('STATE.results.map(getResultStableId)'), before['rows'])
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'search-input')
        self.assertEqual(self.page.locator('.reader-overlay-opening').count(), 0)
        self.page.unroute('**/static/reader.html?**')
        self.page.route('**/static/reader.html?**', lambda route: route.fulfill(
            content_type='text/html', body='<body>reader</body>'))
        self.page.evaluate('history.forward()')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.assertEqual(self.page.evaluate('({url:location.href,state:history.state,length:history.length})'), opened)
        self.assertEqual(self.page.evaluate('readerHost.overlay.src'), opened['state']['readerUrl'])
        self.assertFalse(self.page.evaluate('readerClosing'))
        self.assertEqual(self.page.locator('.reader-overlay-opening a').count(), 0)

    def test_watchdog_recovery_rejects_foreign_and_non_search_targets(self):
        self.page.evaluate('''() => {
          const path=new URL(document.querySelector('script[src*="search/reader-host/application/navigation.js"]').src)
            .pathname.replace('search/reader-host/application/navigation.js','reader.html');
          navigateToReader(path+'?ext=txt');
        }''')
        self.page.frame_locator('.reader-overlay').locator('body').wait_for()
        self.page.evaluate('''() => {
          history.back=()=>{};
          handleReaderMessage({origin:location.origin,source:readerHost.overlay.contentWindow,data:{type:'voice-reader-close'}});
        }''')
        recovery = self.page.get_by_role('link', name='直接打开搜索页')
        recovery.wait_for(state='visible', timeout=3000)
        safe = self.page.evaluate('new URL(new URL(readerHost.overlay.src).pathname.startsWith("/search/")?"/search/":"/",location.origin).href')
        for target in ('https://invalid.example/', 'javascript:alert(1)', '/static/reader.html', '/elsewhere/page', 'http://['):
            self.page.evaluate('target => readerNavigation.showCloseRecovery(target)', target)
            self.assertEqual(recovery.get_attribute('href'), safe)
            self.assertFalse(recovery.evaluate('link => !!link.closest("[inert]")'))
