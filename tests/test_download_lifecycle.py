"""Download handoff/queue and decorative activity lifecycle in Chromium."""
import unittest
from tests import test_paging_recovery as paging


class DownloadLifecycleTests(unittest.TestCase):
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
        errors = self.fixture.errors[:]
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def test_intent_and_repeated_click_share_check_and_show_feedback(self):
        self.page.evaluate('''() => {
          window.checkCalls=0; window.launches=[];
          const native=window.fetch;
          window.fetch=(url, options)=>String(url).includes('/api/download/check')
            ? (checkCalls++, new Promise(resolve=>window.finishCheck=()=>resolve(new Response('{"ok":true}'))))
            : native(url, options);
          window.triggerDownload=url=>launches.push(url);
          const button=DOM.resultsList.querySelector('[data-action="download"]');
          button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
          button.click(); button.click();
        }''')
        self.assertEqual(self.page.evaluate('checkCalls'), 1)
        self.assertEqual(self.page.locator('[data-action="download"]').first.text_content(), '准备中…')
        self.assertEqual(self.page.evaluate('launches.length'), 0)
        self.page.evaluate('finishCheck()')
        self.page.wait_for_function('launches.length === 1 && pendingDownloads.size === 0')
        self.page.locator('[data-action="download"]').first.click()
        self.page.wait_for_function('launches.length === 2')
        self.assertEqual(self.page.evaluate('checkCalls'), 1)
        self.assertEqual(self.page.locator('[data-action="download"]').first.text_content(), '下载')

    def test_checks_are_bounded_expire_and_failures_retry(self):
        result = self.page.evaluate('''async () => {
          const native=window.fetch; const calls={}; window.triggerDownload=()=>{};
          window.fetch=(url,options)=>{
            if (!String(url).includes('/api/download/check')) return native(url,options);
            const link=new URL(url,location.origin).searchParams.get('link');
            calls[link]=(calls[link]||0)+1;
            return Promise.resolve(new Response(link==='bad' && calls[link]===1 ? '{"error":"missing"}' : '{"ok":true}',
              {status:link==='bad' && calls[link]===1 ? 503 : 200}));
          };
          for(let i=0;i<70;i++) await checkDownload('cache'+i);
          const size=downloadChecks.size;
          downloadChecks.get('cache69').expires=Date.now()-1;
          await checkDownload('cache69');
          const first=await downloadFile('bad.txt','bad');
          const second=await downloadFile('bad.txt','bad');
          return {size,expiredCalls:calls.cache69,failedCalls:calls.bad,first,second};
        }''')
        self.assertEqual(result, dict(size=64, expiredCalls=2, failedCalls=2, first=False, second=True))

    def test_batch_limits_checks_and_retries_only_failures(self):
        self.page.evaluate('''() => {
          window.launches=[];window.calls={};window.active=0;window.peak=0;
          const native=window.fetch;
          window.fetch=(url,options)=>{
            if (!String(url).includes('/api/download/check')) return native(url,options);
            const link=new URL(url,location.origin).searchParams.get('link');
            calls[link]=(calls[link]||0)+1;active++;peak=Math.max(peak,active);
            return new Promise(resolve=>setTimeout(()=>{
              active--;const fail=link==='batch3' && calls[link]===1;
              resolve(new Response(fail ? '{"error":"missing"}' : '{"ok":true}',{status:fail?503:200}));
            },30));
          };
          window.triggerDownload=url=>launches.push(url);
          const items=Array.from({length:7},(_,i)=>({filename:i+'.txt',link:'batch'+i}));
          startDownloadBatch(items); startDownloadBatch(items);
          STATE.results=[]; selectedIndices={};
        }''')
        self.page.wait_for_function('downloadBatch.done')
        self.assertEqual(self.page.evaluate('[peak,downloadBatch.started,downloadBatch.failed.length,launches.length]'), [2,6,1,6])
        self.page.locator('[data-queue="retry"]').click()
        self.page.wait_for_function('downloadBatch.done && downloadBatch.started === 1')
        self.assertEqual(self.page.evaluate('Object.values(calls).sort()'), [1,1,1,1,1,1,2])
        self.assertEqual(self.page.evaluate('launches.length'), 7)

    def test_cancel_prevents_late_handoff_and_remaining_checks(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.evaluate('''() => {
          window.releases=[];window.launches=[];
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).includes('/api/download/check')
            ? new Promise(resolve=>releases.push(()=>resolve(new Response('{"ok":true}')))) : native(url,options);
          window.triggerDownload=url=>launches.push(url);
          startDownloadBatch(Array.from({length:20},(_,i)=>({filename:i+'.txt',link:'cancel'+i})));
        }''')
        self.page.locator('[data-queue="cancel"]').click()
        self.page.evaluate('releases.forEach(release=>release())')
        self.page.wait_for_function('downloadBatch.done')
        self.assertEqual(self.page.evaluate('[releases.length,launches.length,pendingDownloads.size]'), [2,0,0])
        self.page.locator('[data-queue="close"]').click()
        self.assertEqual(self.page.locator('#download-queue').count(), 0)

    def test_stalled_check_body_times_out_and_releases_queue(self):
        self.page.clock.install()
        self.page.evaluate('''() => {
          const native=window.fetch;window.downloadResult=null;
          window.fetch=(url,options)=>String(url).includes('/api/download/check')
            ? Promise.resolve({ok:true,json:()=>new Promise((resolve,reject)=>{
                options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));
              })}) : native(url,options);
          downloadFile('stalled.txt','stalled').then(value=>window.downloadResult=value);
        }''')
        self.page.clock.fast_forward(8001)
        self.page.wait_for_function('window.downloadResult === false')
        self.assertEqual(self.page.evaluate('[activeDownloadChecks,downloadChecks.size,pendingDownloads.size]'), [0,0,0])
        self.assertIn('超时', self.page.locator('#toast').text_content())

    def test_attachment_handoff_keeps_search_page_and_filename(self):
        self.page.route('**/api/download?*', lambda route: route.fulfill(
            content_type='application/octet-stream', body='test attachment',
            headers={'Content-Disposition': "attachment; filename*=UTF-8''book.txt"}))
        before = self.page.url
        with self.page.expect_download() as event:
            self.page.evaluate("downloadFile('book.txt','https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/book.txt',{skipCheck:true})")
        self.assertEqual(event.value.suggested_filename, 'book.txt')
        self.assertEqual(self.page.url, before)

    def test_quote_animation_pauses_and_resumes_without_catchup(self):
        self.page.evaluate('''() => {
          window.quoteHidden=false;
          Object.defineProperty(document,'hidden',{configurable:true,get:()=>quoteHidden});
          hitokotoState.lastAt=Date.now();
          typewriter(DOM.hitokoto,'你好🌟世界再见',30);
        }''')
        self.page.wait_for_function('DOM.hitokoto.textContent.length > 0')
        paused = self.page.evaluate('''() => {
          quoteHidden=true;document.dispatchEvent(new Event('visibilitychange'));
          return DOM.hitokoto.textContent;
        }''')
        self.page.wait_for_timeout(200)
        self.assertEqual(self.page.evaluate('DOM.hitokoto.textContent'), paused)
        self.assertTrue(self.page.evaluate('hitokotoState.timer === null && hitokotoState.animation.timer === null'))
        self.page.evaluate("quoteHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        self.page.wait_for_function("DOM.hitokoto.textContent === '你好🌟世界再见'")
        self.page.emulate_media(reduced_motion='reduce')
        self.page.evaluate("typewriter(DOM.hitokoto,'完整显示')")
        self.assertEqual(self.page.evaluate('DOM.hitokoto.textContent'), '完整显示')

    def test_quote_aborts_hidden_request_and_ignores_stale_response(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.page.evaluate('''() => {
          window.quoteHidden=false;window.quoteRequests=[];
          Object.defineProperty(document,'hidden',{configurable:true,get:()=>quoteHidden});
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).includes('vomebook-hitokoto')
            ? new Promise(resolve=>quoteRequests.push({signal:options.signal,resolve})) : native(url,options);
          fetchHitokoto();fetchHitokoto();
          quoteHidden=true;document.dispatchEvent(new Event('visibilitychange'));
        }''')
        self.assertTrue(self.page.evaluate('quoteRequests.length === 1 && quoteRequests[0].signal.aborted'))
        self.page.evaluate("hitokotoState.lastAt=0;quoteHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        self.page.wait_for_function('quoteRequests.length === 2')
        self.page.evaluate("quoteRequests[1].resolve(new Response('{\"hitokoto\":\"新句子\"}'))")
        self.page.wait_for_function("DOM.hitokoto.textContent === '新句子'")
        self.page.evaluate("quoteRequests[0].resolve(new Response('{\"hitokoto\":\"迟到旧句子\"}'))")
        self.page.wait_for_timeout(50)
        self.assertEqual(self.page.evaluate('DOM.hitokoto.textContent'), '新句子')
