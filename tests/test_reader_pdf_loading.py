"""Actual module imports and PDF.js with cold cache and transport faults."""
import contextlib
import json
from pathlib import Path
import re
import threading
import time
import unittest
import urllib.parse
from unittest.mock import patch

from tests.browser_support import local_server
from tests.browser_support import SearchHandler
from tests.test_reader_performance import sync_playwright, PlaywrightError, minimal_pdf

MODULE = '**/static/vendor/pdf.min.*.mjs*'
SOURCE = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/cold-retry.pdf'


@unittest.skipIf(sync_playwright is None, 'Playwright is unavailable')
class PdfLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        resources = contextlib.ExitStack()
        cls.addClassCleanup(resources.close)
        cls.origin, _ = resources.enter_context(local_server())
        playwright = resources.enter_context(sync_playwright())
        try:
            cls.browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        except PlaywrightError as error:
            raise unittest.SkipTest(str(error))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.modules, self.documents = [], [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('request', lambda request: self.modules.append(request.url)
                     if '/vendor/pdf.min.' in request.url else None)
        self.page.route('**/api/reader-content**', self.document)

    def document(self, route):
        self.documents.append(route.request.url)
        route.fulfill(content_type='application/pdf', body=minimal_pdf())

    def open(self):
        self.page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(
            dict(url=SOURCE, ext='pdf', title='Cold retry')), wait_until='domcontentloaded')

    def ready(self):
        self.page.locator('.reader-page canvas.ready').wait_for(state='attached')
        self.assertEqual(self.page.locator('#status').text_content(), '1 页')
        self.assertEqual(self.errors, [])

    def test_cold_success_uses_one_module_request(self):
        self.open()
        self.ready()
        self.assertEqual(len(self.modules), 1)
        self.assertNotIn('reader-module-retry', self.modules[0])

    def test_resolved_original_download_name_keeps_exact_repeated_extension(self):
        original='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/poster.jpg.jpg'
        image=b'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;'
        self.page.route('**/api/reader-resolve?id=filename-test',lambda route:route.fulfill(json={
            'url':original,'download':original,'extension':'jpg','original_extension':'jpg',
            'title':'poster.jpg','filename':'poster.jpg.jpg'}))
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='image/gif',body=image))
        self.page.goto(self.origin+'/search/static/reader.html?id=filename-test&ext=jpg',wait_until='domcontentloaded')
        self.page.locator('.reader-image').wait_for()
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(self.page.locator('#download').get_attribute('href')).query)
        self.assertEqual(query['file'],['poster.jpg.jpg'])
        self.assertEqual(query['link'],[original])

    def test_malformed_original_filename_metadata_is_not_used_for_download(self):
        source='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/safe.txt'
        self.page.route('**/api/reader-resolve?id=filename-invalid',lambda route:route.fulfill(json={
            'url':source,'download':source,'extension':'txt','original_extension':'txt',
            'title':'safe','filename':'../unsafe.txt'}))
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/plain',body='safe'))
        self.page.goto(self.origin+'/search/static/reader.html?id=filename-invalid&ext=txt',wait_until='domcontentloaded')
        self.page.locator('.reader-text').wait_for()
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(self.page.locator('#download').get_attribute('href')).query)
        self.assertEqual(query['file'],['safe.txt'])

    def test_original_download_name_survives_title_change_and_button_handoff(self):
        source='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/Sample%20.PDF'
        checks=[]
        self.page.route('**/api/reader-resolve?id=filename-click',lambda route:route.fulfill(json={
            'url':source,'download':source,'extension':'txt','original_extension':'pdf',
            'title':'Sample ','filename':'Sample .PDF'}))
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/plain',body='safe'))
        self.page.route('**/api/download/check?**',lambda route:route.fulfill(json={'ok':True}))
        self.page.route('**/api/download?**',lambda route:(checks.append(route.request.url),route.fulfill(body='file')))
        self.page.goto(self.origin+'/search/static/reader.html?id=filename-click&ext=txt',wait_until='domcontentloaded')
        self.page.locator('.reader-text').wait_for()
        self.page.locator('#download').click()
        self.page.wait_for_function("()=>document.querySelector('#download-feedback')?.textContent.includes('已发起下载')")
        self.assertEqual(len(checks),1)
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(checks[0]).query)
        self.assertEqual(query['file'],['Sample .PDF'])
        self.assertEqual(query['link'],[source])

    def test_real_pdf_malformed_page_tree_preserves_all_page_numbers_and_text(self):
        fixture = Path(__file__).parent / 'fixtures/issue8088.pdf'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='application/pdf', body=fixture.read_bytes()))
        self.open()
        self.page.locator('.reader-page[data-page="1"][data-text-ready="1"] canvas.ready').wait_for()
        self.assertEqual(self.page.locator('#status').text_content(), '3 页')
        for number in (1, 2, 3):
            if number > 1:
                self.page.locator('#page-number').fill(str(number))
                self.page.locator('#page-number').dispatch_event('change')
            page = self.page.locator(f'.reader-page[data-page="{number}"]')
            page.locator('canvas.ready').wait_for()
            self.page.wait_for_function('number => document.querySelector(`.reader-page[data-page="${number}"]`)?.dataset.textReady === "1"', arg=number)
            self.assertIn(f'Issue 8088 - Page {number}', page.locator('.reader-pdf-text').text_content())
        self.assertEqual(self.errors, [])

    def test_real_pdf_native_text_double_click_and_drag_selection(self):
        fixture = Path(__file__).parent / 'fixtures/issue8088.pdf'
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='application/pdf', body=fixture.read_bytes()))
        self.open()
        shell = self.page.locator('.reader-page[data-page="1"][data-text-ready="1"]')
        shell.locator('canvas.ready').wait_for()
        run = shell.locator('.reader-pdf-text-run').filter(has_text='Issue 8088').first
        run.dblclick()
        self.page.wait_for_timeout(100)
        self.assertTrue(self.page.evaluate('getSelection().toString()').strip())
        self.page.evaluate('getSelection().removeAllRanges()')
        box = run.bounding_box()
        y = box['y'] + box['height'] / 2
        self.page.mouse.move(box['x'] + 2, y)
        self.page.mouse.down()
        self.page.mouse.move(box['x'] + box['width'] - 2, y, steps=10)
        self.page.mouse.up()
        self.page.wait_for_timeout(100)
        self.assertIn('Issue 8088', self.page.evaluate('getSelection().toString()'))
        self.assertEqual(self.errors, [])

    def test_sparse_mode_malformed_page_tree_still_uses_real_pdfjs_validation(self):
        # Based on PDF.js issue8088: the first of two child page-tree nodes is
        # empty, so assuming every child is one page silently shifts page IDs.
        # Padding pushes the nested catalog past the sparse detector's first
        # 16 KiB without changing the visible page text or source object order.
        kids = [4 + 6 * i for i in range(129)] + [800]
        objects = {
            1: b'<< /Type /Catalog /Pages 2 0 R >>',
            2: (f'<< /Type /Pages /Count 130 /Kids [{" ".join(f"{n} 0 R" for n in kids)}] >>').encode(),
            3: b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            800: b'<< /Type /Pages /Parent 2 0 R /Count 1 /Kids [801 0 R 802 0 R] >>',
            801: b'<< /Type /Pages /Parent 800 0 R /Count 0 /Kids [] >>',
            802: b'<< /Type /Pages /Parent 800 0 R /Count 1 /Kids [803 0 R] >>',
        }
        for number in range(129):
            objects[kids[number]] = (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 50] '
                f'/Resources << /Font << /F1 3 0 R >> >> /Contents {2000 + number} 0 R >>').encode()
            stream = f'BT /F1 14 Tf 10 20 Td (Page {number + 1}) Tj ET'.encode()
            objects[2000 + number] = (f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream +
                                      b'\nendstream')
        objects[803] = (b'<< /Type /Page /Parent 802 0 R /MediaBox [0 0 200 50] '
                        b'/Resources << /Font << /F1 3 0 R >> >> /Contents 2129 0 R >>')
        stream = b'BT /F1 14 Tf 10 20 Td (Page 130 final) Tj ET'
        objects[2129] = f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'\nendstream'
        # Place page dictionaries far apart to exercise range admission.
        payload, offsets = bytearray(b'%PDF-1.7\n'), {}
        for number in sorted(objects):
            if number == 800:
                pad = 9 * 1024 * 1024
                payload.extend(b'1999 0 obj\n<< /Length ' + str(pad).encode() + b' >>\nstream\n' +
                               b'x' * pad + b'\nendstream\nendobj\n')
            offsets[number] = len(payload)
            payload.extend(f'{number} 0 obj\n'.encode() + objects[number] + b'\nendobj\n')
        xref = len(payload)
        payload.extend(f'xref\n0 {max(objects) + 1}\n0000000000 65535 f \n'.encode())
        for number in range(1, max(objects) + 1):
            payload.extend((f'{offsets[number]:010d} 00000 n \n' if number in offsets else
                            '0000000000 00000 f \n').encode())
        payload.extend(f'trailer\n<< /Size {max(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
        ranges = []
        def record_engine(route):
            response = route.fetch()
            code = response.text()
            needle = 'task = pdfjs.getDocument({...options, rangeChunkSize:chunkSize, range:transport});'
            self.assertEqual(code.count(needle), 1)
            route.fulfill(response=response, body=code.replace(needle,
                'window.__actualPdfChunk = chunkSize; ' + needle))
        self.page.route('**/static/reader/pdf/reader-pdf-network.mjs*', record_engine)
        def serve(route):
            match = re.fullmatch(r'bytes=(\d+)-(\d+)', route.request.headers.get('range', ''))
            self.assertIsNotNone(match)
            start, end = int(match[1]), min(int(match[2]), len(payload) - 1)
            ranges.append((start, end))
            route.fulfill(status=206, content_type='application/pdf', body=bytes(payload[start:end + 1]),
                          headers={'Content-Range': f'bytes {start}-{end}/{len(payload)}', 'ETag': '"sparse-malformed"',
                                   'Access-Control-Allow-Origin': '*',
                                   'Access-Control-Expose-Headers': 'Content-Range,ETag,Content-Length'})
        self.page.route('**/api/reader-content**', serve)
        self.open()
        self.page.locator('.reader-page[data-page="1"][data-text-ready="1"] canvas.ready').wait_for(timeout=30000)
        self.assertEqual(self.page.locator('#status').text_content(), '130 页')
        self.assertEqual(self.page.evaluate('window.__actualPdfChunk'), 16384, ranges)
        self.page.locator('#page-number').fill('130')
        self.page.locator('#page-number').dispatch_event('change')
        self.page.locator('.reader-page[data-page="130"][data-text-ready="1"] canvas.ready').wait_for(timeout=30000)
        self.assertIn('Page 130 final', self.page.locator('.reader-page[data-page="130"] .reader-pdf-text').text_content())
        self.assertEqual(self.errors, [])

    def test_first_range_overlaps_held_engine_and_is_consumed_once(self):
        held = []
        self.page.route(MODULE, lambda route: held.append(route))
        with self.page.expect_response('**/api/reader-content**') as opened:
            self.open()
        self.assertEqual(opened.value.request.headers.get('range'), 'bytes=0-262143')
        self.assertEqual(len(self.documents), 1)
        self.assertEqual(self.page.locator('.reader-page canvas.ready').count(), 0)
        self.assertEqual(self.page.workers, [])
        self.assertTrue(held)
        self.page.unroute(MODULE)
        for route in held:
            route.continue_()
        self.ready()
        self.assertEqual(len(self.documents), 1)
        self.assertEqual(len(self.modules), 1)

    def test_reopen_skips_identical_zoom_but_restores_a_different_saved_zoom(self):
        self.page.add_init_script("localStorage.setItem('reader-zoom','100')")
        for zoom, draws in ((100, 1), (125, 2)):
            with self.subTest(zoom=zoom):
                self.page.goto(self.origin + '/search/static/manifest.json')
                self.page.add_script_tag(url=self.origin + '/search/static/reader/core/reader-store.js')
                self.page.evaluate('''async ({source,zoom})=>{
                  await VoiceOfMLReaderStore.clearHistory();
                  await VoiceOfMLReaderStore.put({url:source,page:1,zoom});
                }''', dict(source=SOURCE, zoom=zoom))
                self.open()
                self.ready()
                self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
                self.page.wait_for_function("n=>VoiceOfMLReaderPdfDiagnostics.snapshot().pages.filter(r=>r.page===1&&r.stage==='draw'&&r.outcome==='ready').length>=n", arg=draws)
                self.page.wait_for_timeout(100)
                self.assertEqual(self.page.evaluate("VoiceOfMLReaderPdfDiagnostics.snapshot().pages.filter(r=>r.page===1&&r.stage==='draw'&&r.outcome==='ready').length"), draws)
                self.assertEqual(self.page.locator('#zoom').input_value(), str(zoom))
                self.assertEqual(self.page.locator('#page-number').input_value(), '1')
                self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")

    def test_transient_worker_download_failure_recovers_without_reader_reload(self):
        self.page.add_init_script('''const native = window.setTimeout.bind(window);
          window.setTimeout = (fn, ms, ...args) => native(fn, ms === 20000 ? 300 : ms, ...args);''')
        self.page.route(MODULE, lambda route: route.fulfill(content_type='text/javascript', body='''
          export const GlobalWorkerOptions = {};
          export class PDFWorker {
            constructor() {
              window.__workerAttempts = (window.__workerAttempts || 0) + 1;
              (window.__workerUrls ||= []).push(GlobalWorkerOptions.workerSrc);
              this.promise = window.__workerAttempts === 1 ? new Promise(() => {}) : Promise.resolve();
            }
            destroy() { window.__workerDestroys = (window.__workerDestroys || 0) + 1; }
          }
          export function getDocument() {
            const page = {getViewport:({scale})=>({width:600*scale,height:800*scale}),
              getTextContent:async()=>({items:[]}),render:()=>({promise:Promise.resolve()})};
            return {promise:Promise.resolve({numPages:1,getPage:async()=>page,getOutline:async()=>null}),destroy(){}};
          }
        '''))
        self.open()
        self.ready()
        self.assertEqual(self.page.evaluate('__workerAttempts'), 2)
        self.assertEqual(self.page.evaluate('__workerDestroys'), 1)
        self.assertIn('reader-worker-retry=1', self.page.evaluate('__workerUrls[1]'))
        self.assertEqual(len(self.documents), 1)

    def test_pdf_range_policy_keeps_default_browser_cache_from_serializing_reads(self):
        payload = b''.join(bytes([index]) * 128 for index in range(16))
        metrics = {mode: {'active': 0, 'peak': 0} for mode in ('upstream', 'reader')}
        lock = threading.Lock()
        original = SearchHandler.do_GET

        def serve(handler):
            if not handler.path.startswith('/cache-lock-probe.pdf?'):
                return original(handler)
            mode = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)['mode'][0]
            match = re.fullmatch(r'bytes=(\d+)-(\d+)', handler.headers.get('Range', ''))
            start, end = int(match[1]), int(match[2])
            headers = {'Content-Type': 'application/pdf', 'Cache-Control': 'public, max-age=31536000',
                       'ETag': '"range-cache-probe"', 'Accept-Ranges': 'bytes',
                       'Content-Range': f'bytes {start}-{end}/{len(payload)}', 'Content-Length': str(end-start+1)}
            with lock:
                metrics[mode]['active'] += 1
                metrics[mode]['peak'] = max(metrics[mode]['peak'], metrics[mode]['active'])
            try:
                time.sleep(.08)
                handler.send_response(206)
                for name, value in headers.items():
                    handler.send_header(name, value)
                handler.end_headers()
                handler.wfile.write(payload[start:end+1])
                handler.wfile.flush()
            finally:
                with lock:
                    metrics[mode]['active'] -= 1

        # Playwright routing also disables HTTP caching. Use an un-routed context.
        with patch.object(SearchHandler, 'do_GET', serve), \
                self.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            page.goto(self.origin + '/search/static/manifest.json')
            page.evaluate("async () => { window.__pdfNetwork = await import('/search/static/reader/pdf/reader-pdf-network.mjs'); }")
            for mode in ('upstream', 'reader'):
                results = page.evaluate('''async mode => {
                  const url = '/cache-lock-probe.pdf?mode=' + mode;
                  const policy = mode === 'reader' ? __pdfNetwork.createPdfFetchPolicy() : null;
                  policy?.add([url]);
                  try { return await Promise.all(Array.from({length:16}, async (_, index) => {
                    const headers = {Range:'bytes=' + index*128 + '-' + (index*128+127)};
                    const response = await fetch(url, {headers});
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    return {status:response.status, range:response.headers.get('Content-Range'),
                            exact:bytes.length === 128 && bytes.every(value => value === index)};
                  })); } finally { policy?.dispose(); }
                }''', mode)
                self.assertEqual(results, [{'status':206, 'range':f'bytes {index*128}-{index*128+127}/2048',
                                            'exact':True} for index in range(16)])
        self.assertGreater(metrics['reader']['peak'], 1, metrics)
        self.assertEqual(self.errors, [])

    def test_pdf_fetch_policy_scopes_requests_preserves_options_and_restores_owner(self):
        with self.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            page.goto(self.origin + '/search/static/manifest.json')
            result = page.evaluate('''async () => {
              const {createPdfFetchPolicy} = await import('/search/static/reader/pdf/reader-pdf-network.mjs');
              const native = fetch, calls = [], signal = new AbortController().signal;
              const init = {cache:'force-cache', signal, headers:{Range:'bytes=0-1'}};
              const spy = (input, options) => {calls.push({input, options}); return Promise.resolve(new Response('ok'));};
              globalThis.fetch = spy;
              const policy = createPdfFetchPolicy();
              try {
                policy.add(['/document.pdf']);
                await fetch('/document.pdf', init);
                await fetch('/document.pdf?other=1', init);
                policy.add(['/fallback.pdf']);
                const request = new Request(new URL('/fallback.pdf', location.href));
                await fetch(request, init);
                policy.dispose();
                const restored = fetch === spy;
                await fetch('/document.pdf', init);
                return {caches:calls.map(call => call.options.cache),
                         signals:calls[0].options.signal.aborted && calls[2].options.signal.aborted &&
                           !signal.aborted && calls[1].options.signal === signal && calls[3].options.signal === signal,
                        headers:calls.every(call => call.options.headers === init.headers),
                        request:calls[2].input === request, outside:calls[1].options === init,
                        restored, originalCache:init.cache};
              } finally { policy.dispose(); globalThis.fetch = native; }
            }''')
        self.assertEqual(result, {'caches':['no-store','force-cache','no-store','force-cache'],
                                 'signals':True, 'headers':True, 'request':True, 'outside':True,
                                 'restored':True, 'originalCache':'force-cache'})

    def test_v2_bucket_pdf_uses_external_proxy_without_nested_content_request(self):
        path = 'derived/test/' + 'a' * 32 + '/document.pdf'
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + path
        for width, height, opening in ((1280, 800, 'direct'), (390, 844, 'resolved')):
            with self.subTest(opening=opening, width=width):
                self.page.set_viewport_size({'width': width, 'height': height})
                held = []
                self.page.route('**/api/reader-bucket-resource?**', lambda route: held.append(route))
                self.page.route('**/api/reader-resolve?**', lambda route: route.fulfill(
                    content_type='application/json', body=json.dumps({
                        'url': source, 'download': SOURCE, 'extension': 'pdf',
                    })))
                options = dict(ext='pdf', title='Bucket PDF')
                if opening == 'direct':
                    options['url'] = '/api/reader-bucket-resource?path=' + path
                else:
                    options['id'] = '398vk0yyy8m29'
                with self.page.expect_request('**/api/reader-bucket-resource?**'):
                    self.page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(options),
                                   wait_until='domcontentloaded')
                deadline = time.monotonic() + 5
                while not held and time.monotonic() < deadline:
                    self.page.wait_for_timeout(20)
                self.assertEqual(len(held), 1)
                self.assertEqual(held[0].request.url, source)
                self.assertEqual(self.documents, [])
                self.assertEqual(self.page.locator('.reader-preparing-surface').count(), 0)
                self.assertEqual(self.page.locator('.reader-loading-indicator').count(), 1)
                held[0].fulfill(content_type='application/pdf', body=minimal_pdf())
                self.ready()
                self.assertEqual(self.page.locator('.reader-loading-indicator').count(), 0)
                self.assertGreaterEqual(self.page.evaluate("document.querySelector('.reader-page').getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), -1)
                self.page.unroute('**/api/reader-bucket-resource?**')

    def test_legacy_v2_bucket_pdf_links_stay_on_proxy_for_both_buckets(self):
        direct = []
        self.page.route('https://huggingface.co/**', lambda route: (direct.append(route.request.url), route.abort()))
        for bucket, path in (
            ('reader-assets-v2', 'documents/pdf/ppt/' + 'a' * 64 + '/document.pdf'),
            ('pdf-pages-v2', 'derived/test/' + 'b' * 32 + '/document.pdf'),
        ):
            with self.subTest(bucket=bucket):
                requested = []
                def proxy(route):
                    requested.append(route.request.url)
                    route.fulfill(content_type='application/pdf', body=minimal_pdf())
                self.page.route('**/api/reader-bucket-resource?**', proxy)
                source = f'https://huggingface.co/buckets/vomebook/{bucket}/resolve/{path}'
                self.page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(
                    dict(url=source, ext='pdf', title='Legacy bucket link')), wait_until='domcontentloaded')
                self.ready()
                self.assertEqual(len(requested), 1)
                self.assertTrue(requested[0].startswith('https://voiceofml-search.hf.space/api/reader-bucket-resource?'))
                self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(requested[0]).query)['path'], [path])
                self.assertEqual(self.documents, [])
                self.assertEqual(direct, [])
                self.page.unroute('**/api/reader-bucket-resource?**', proxy)

    def test_pdf_engine_loads_while_id_resolution_is_pending(self):
        pending = []
        self.page.route('**/api/reader-resolve?**', lambda route: pending.append(route))
        with self.page.expect_worker() as opened:
            self.page.goto(self.origin + '/search/static/reader.html?id=398vk0yyy8m29&ext=pdf', wait_until='domcontentloaded')
        opened.value.evaluate('''() => new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error('Worker did not initialize')), 5000);
          const check = () => globalThis.pdfjsWorker ? (clearTimeout(deadline), resolve(true)) : setTimeout(check, 10);
          check();
        })''')
        self.assertEqual(len(pending), 1)
        self.assertEqual(self.documents, [])
        pending[0].fulfill(content_type='application/json', body=json.dumps({
            'url': SOURCE, 'download': SOURCE, 'extension': 'pdf',
        }))
        self.ready()
        self.assertEqual(len(self.modules), 1)
        self.assertEqual(len(self.page.workers), 1)
        self.assertEqual(len(pending), 1)

    def test_early_resolve_runs_before_main_module_and_retries_transient_http_once(self):
        held, lookups = [], []
        self.page.route('**/static/reader.js*', lambda route: held.append(route))
        def lookup(route):
            lookups.append(route)
            if len(lookups) == 1:
                route.fulfill(status=503, body='try again')
            else:
                route.fulfill(content_type='application/json', body=json.dumps({
                    'url': SOURCE, 'download': SOURCE, 'extension': 'pdf',
                }))
        self.page.route('**/api/reader-resolve?**', lookup)
        self.page.goto(self.origin + '/search/static/reader.html?id=398vk0yyy8m29&ext=pdf', wait_until='commit')
        self.page.wait_for_function('() => !!window.__VOICE_READER_RESOLVE__')
        self.assertEqual(self.page.evaluate('() => window.__VOICE_READER_RESOLVE__.promise.then(x => x.status)'), 503)
        self.assertEqual(self.documents, [])
        self.page.unroute('**/static/reader.js*')
        for route in held: route.continue_()
        self.ready()
        self.assertEqual(len(lookups), 2)

    def test_demand_id_partial_body_stall_recovers_before_total_deadline(self):
        self.page.set_default_timeout(2500)
        self.page.add_init_script('''(() => {
          const nativeFetch=fetch,nativeTimer=setTimeout;
          window.__idLookups=0;window.__partialCancelled=false;
          window.setTimeout=(callback,delay,...args)=>nativeTimer(callback,delay===10000?100:delay,...args);
          window.fetch=(url,init)=>{
            if(!String(url).includes('/api/reader-resolve?'))return nativeFetch(url,init);
            __idLookups++;
            if(__idLookups===1)return Promise.resolve(new Response('temporary',{status:503}));
            if(__idLookups!==2)return nativeFetch(url,init);
            return Promise.resolve(new Response(new ReadableStream({start(controller){
              controller.enqueue(new TextEncoder().encode('{"url":"abandoned'));
              init.signal.addEventListener('abort',()=>{
                __partialCancelled=true;controller.error(init.signal.reason);
              },{once:true});
            }}),{headers:{'Content-Type':'application/json'}}));
          };
        })();''')
        self.page.route('**/api/reader-resolve?**',lambda route:route.fulfill(
            content_type='application/json',body=json.dumps({'url':SOURCE,'download':SOURCE,'extension':'pdf'})))
        self.page.goto(self.origin+'/search/static/reader.html?id=398vk0yyy8m29&ext=pdf',wait_until='domcontentloaded')
        self.ready()
        self.assertEqual(self.page.evaluate('__idLookups'),3)
        self.assertTrue(self.page.evaluate('__partialCancelled'))
        self.assertEqual(len(self.documents),1)

    def test_disposal_terminates_prepared_worker_and_pending_resolve(self):
        self.page.add_init_script('''window.__lookupAborted = false;
          const nativeFetch = window.fetch;
          window.fetch = (url, options) => String(url).includes('/api/reader-resolve?')
            ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
                window.__lookupAborted = true; reject(new DOMException('closed', 'AbortError'));
              }, {once:true})) : nativeFetch(url, options);''')
        with self.page.expect_worker() as opened:
            self.page.goto(self.origin + '/search/static/reader.html?id=398vk0yyy8m29&ext=pdf', wait_until='domcontentloaded')
        with opened.value.expect_event('close'):
            self.page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
        self.assertTrue(self.page.evaluate('() => window.__lookupAborted'))
        self.assertEqual(self.documents, [])
        self.assertEqual(self.errors, [])

    def test_first_connection_failure_recovers_with_real_pdf_engine(self):
        def serve(route):
            if 'reader-module-retry' not in route.request.url:
                route.abort('connectionreset')
            else:
                route.continue_()
        self.page.route(MODULE, serve)
        self.open()
        self.ready()
        self.assertEqual(len(self.modules), 2)
        self.assertIn('reader-module-retry=1', self.modules[1])
        self.assertEqual(len(self.documents), 1)

    def test_http_failure_recovers_on_last_attempt(self):
        self.page.route(MODULE, lambda route: route.continue_()
                        if 'reader-module-retry=2' in route.request.url
                        else route.fulfill(status=503, body='temporarily unavailable'))
        self.open()
        self.ready()
        self.assertEqual(len(self.modules), 3)

    def test_exhaustion_has_bounded_requests_and_manual_reload_recovers(self):
        self.page.route(MODULE, lambda route: route.abort('connectionreset'))
        self.open()
        self.page.locator('#reader-engine-retry').wait_for()
        self.assertEqual(len(self.modules), 3)
        self.assertEqual(len(self.documents), 1)
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_ENGINE_NETWORK')
        self.assertNotIn('Failed to fetch', self.page.locator('.reader-error').inner_text())
        self.page.unroute(MODULE)
        self.page.locator('#reader-engine-retry').click()
        self.ready()
        self.assertEqual(len(self.documents), 2)

    def test_disposal_cancels_retry_backoff(self):
        self.page.route(MODULE, lambda route: route.abort('connectionreset'))
        self.open()
        self.page.wait_for_timeout(100)
        self.page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
        self.page.wait_for_timeout(1800)
        self.assertEqual(len(self.modules), 1)
        self.assertLessEqual(len(self.documents), 1)
        self.assertEqual(self.errors, [])

    def test_timed_out_import_cannot_start_document_after_disposal(self):
        held = []
        self.page.add_init_script('''const native = window.setTimeout.bind(window);
          window.setTimeout = (fn, ms, ...args) => native(fn, ms === 20000 ? 50 : ms, ...args);''')
        self.page.route(MODULE, lambda route: held.append(route))
        self.open()
        self.page.locator('#reader-engine-retry').wait_for()
        self.assertEqual(len(self.modules), 3)
        for route in held:
            route.fulfill(content_type='text/javascript', body='''
              export const GlobalWorkerOptions = {};
              export function getDocument() { window.__latePdfStarted=true; throw Error('late'); }
            ''')
        self.page.wait_for_timeout(200)
        self.assertFalse(self.page.evaluate('() => !!window.__latePdfStarted'))
        self.assertEqual(len(self.documents), 1)
        self.assertEqual(self.errors, [])

    def test_syntax_error_is_not_retried_as_network_failure(self):
        self.page.route(MODULE, lambda route: route.fulfill(content_type='text/javascript', body='export const = ;'))
        self.open()
        self.page.locator('.reader-error').wait_for()
        self.assertEqual(len(self.modules), 1)
        self.assertEqual(self.page.locator('#reader-engine-retry').count(), 0)

    def test_first_http_failure_recovers_under_real_service_worker(self):
        original = SearchHandler.do_GET
        requests = []
        def serve(handler):
            if '/vendor/pdf.min.' in handler.path:
                requests.append(handler.path)
                if len(requests) == 1:
                    handler.send_error(503)
                    return
            original(handler)
        with patch.object(SearchHandler, 'do_GET', serve), \
                self.browser.new_context(service_workers='allow') as context:
            page = context.new_page()
            context.route('**/api/reader-content**', lambda route: route.fulfill(
                content_type='application/pdf', body=minimal_pdf()))
            page.goto(self.origin + '/search/manifest.json')
            page.evaluate('''async () => {
              await navigator.serviceWorker.register('/search/sw.js',{scope:'/search/'});
              await navigator.serviceWorker.ready;
            }''')
            page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(
                dict(url=SOURCE, ext='pdf', title='Cold SW retry')))
            page.locator('.reader-page canvas.ready').wait_for(state='attached', timeout=15000)
            self.assertTrue(page.evaluate('() => !!navigator.serviceWorker.controller'))
            self.assertEqual(len(requests), 2)
            self.assertIn('reader-module-retry=1', requests[1])

    def test_engine_preload_starts_while_reader_dependency_is_still_pending(self):
        held=[]
        self.page.route('**/static/reader/core/reader-runtime.js',lambda route:held.append(route))
        self.page.goto(self.origin+'/static/reader.html?'+urllib.parse.urlencode(dict(url=SOURCE,ext='pdf')),wait_until='commit')
        self.page.locator('link[rel="modulepreload"][href*="pdf.min"]').wait_for(state='attached')
        for _ in range(100):
            if held: break
            self.page.wait_for_timeout(10)
        self.assertGreaterEqual(len(self.modules),1)
        self.assertEqual(len(self.documents),0)
        self.assertEqual(len(held),1)
        self.page.unroute('**/static/reader/core/reader-runtime.js')
        held[0].continue_()
        self.ready()
        self.assertEqual(len(self.modules),1)
