"""Exercise the actual browser Worker with local PDF text-index fixtures."""

from functools import partial
import gzip
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
SOURCE_SHA = 'a' * 64
GENERATION = 'c' * 64
TEXT_GENERATION = 'd' * 64
BASE = f'objects/aa/{SOURCE_SHA}/bbbbbbbbbbbbbbbb/text'


def packed(value):
    return gzip.compress(json.dumps(value).encode(), mtime=0)


def digest(value):
    return hashlib.sha256(value).hexdigest()


BOOK = packed({
    'version': 2, 'kind': 'pdf-book-text', 'complete': True,
    'offset_unit': 'unicode-codepoint', 'source_sha256': SOURCE_SHA,
    'page_count': 1, 'pages': [{
        'page': 1, 'text': 'needle ' * 120,
        'layout': {'offset_unit': 'unicode-codepoint'}, 'text_spans': [],
    }],
})
PARTITION = packed({
    'version': 1, 'kind': 'pdf-search-text-partition', 'source_sha256': SOURCE_SHA,
    'generation': GENERATION, 'offset_unit': 'unicode-codepoint', 'start': 1, 'end': 1,
    'pages': [{'page': 1, 'text': 'needle ' * 120, 'text_generation': TEXT_GENERATION}],
})
PARTITION2 = packed({
    'version': 1, 'kind': 'pdf-search-text-partition', 'source_sha256': SOURCE_SHA,
    'generation': GENERATION, 'offset_unit': 'unicode-codepoint', 'start': 2, 'end': 2,
    'pages': [{'page': 2, 'text': 'needle ' * 60, 'text_generation': TEXT_GENERATION}],
})
RESOURCES = {f'{BASE}/book-text.json.gz': BOOK, f'{BASE}/search-000001-000001.json.gz': PARTITION,
             f'{BASE}/search-000002-000002.json.gz': PARTITION2}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/pdf-worker-test':
            body, content_type = b'<!doctype html><title>PDF Worker test</title>', 'text/html'
        elif parsed.path == '/api/reader-bucket-resource':
            path = parse_qs(parsed.query).get('path', [''])[0]
            parts = path.split('/')
            if len(parts) > 3:
                parts[3] = 'bbbbbbbbbbbbbbbb'
            body = self.server.resources.get('/'.join(parts))
            if body is None:
                self.send_error(404)
                return
            content_type = 'application/octet-stream'
        else:
            return super().do_GET()
        state = None
        if parsed.path == '/api/reader-bucket-resource':
            with self.server.state_lock:
                state = self.server.state
                if state is None or len(parts) <= 3 or path.split('/')[3] != state['token']:
                    self.send_error(410, 'stale test case')
                    return
                state['active'] += 1
                state['peak'] = max(state['peak'], state['active'])
                state['paths'].append('/'.join(parts))
                state['done'].clear()
        try:
            if state and state['after_block_path'] and '/'.join(parts) == state['after_block_path']:
                if not state['arrived'].wait(state['timeout']):
                    self.server.block_timed_out.set()
                    self.send_error(503, 'first request did not arrive')
                    return
            if state and '/'.join(parts) == state['block_path']:
                state['arrived'].set()
                if not state['release'].wait(state['timeout']):
                    self.server.block_timed_out.set()
                    self.send_error(503, 'test release missing')
                    return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A cancelled Worker request may close its connection.
        finally:
            if state:
                with self.server.state_lock:
                    state['active'] -= 1
                    state['completed_paths'].append('/'.join(parts))
                    if not state['active']:
                        state['done'].set()

    def log_message(self, *_args):
        pass


class PdfBookWorkerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        cls.server.state_lock = threading.Lock()
        cls.server.resources = dict(RESOURCES)
        cls.server.state = None
        cls.server.block_timed_out = threading.Event()
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server_thread.join, timeout=5)
        cls.addClassCleanup(cls.server.shutdown)
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        browser = getattr(cls.playwright, os.environ.get('PDF_WORKER_TEST_BROWSER', 'chromium'))
        cls.browser = browser.launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.state = {
            'token': uuid.uuid4().hex[:16], 'block_path': None, 'after_block_path': None, 'timeout': 10,
            'arrived': threading.Event(), 'release': threading.Event(),
            'done': threading.Event(), 'active': 0, 'peak': 0, 'paths': [], 'completed_paths': [],
        }
        self.state['done'].set()
        with self.server.state_lock:
            self.assertIsNone(self.server.state)
            self.server.block_timed_out.clear()
            self.server.resources = dict(RESOURCES)
            self.server.state = self.state
        self.addCleanup(self.cleanup_requests)

    def cleanup_requests(self):
        self.state['release'].set()
        with self.server.state_lock:
            self.server.state = None  # Reject late requests before waiting for handlers.
        self.assertTrue(self.state['done'].wait(10), 'HTTP handlers did not finish')
        self.assertFalse(self.server.block_timed_out.is_set(), 'HTTP handler release timed out')

    def resource(self, path):
        path = path.replace("/bbbbbbbbbbbbbbbb/", f"/{self.state['token']}/")
        return f"{self.origin}/api/reader-bucket-resource?path={path}"

    def make_page(self):
        page = self.browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def cleanup():
            self.state['release'].set()
            try:
                unexpected = page.evaluate('''() => {
                  if (window.client) window.client.dispose();
                  return window.unexpected || [];
                }''')
                errors.extend(unexpected)
            finally:
                try:
                    page.close()
                finally:
                    self.assertEqual(errors, [], 'unexpected browser errors')

        self.addCleanup(cleanup)
        page.goto(f'{self.origin}/pdf-worker-test', timeout=10000)
        page.evaluate('''() => {
          window.unexpected = [];
          const RealWorker = window.Worker;
          window.Worker = class extends RealWorker {
            constructor(...args) {
              super(...args);
              this.addEventListener('error', event => {
                window.unexpected.push('Worker error: ' + event.message);
              });
            }
          };
          window.addEventListener('unhandledrejection', event => window.unexpected.push(String(event.reason)));
          window.deadline = (promise, label) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              clearTimeout(timer);
              reject(new Error(label + ' deadline exceeded'));
            }, 5000);
            Promise.resolve(promise).then(
              value => { clearTimeout(timer); resolve(value); },
              error => { clearTimeout(timer); reject(error); });
          });
          window.capture = (promise, label) => window.deadline(promise, label).then(
            value => ({value}), error => ({error: error.name, message: error.message}));
        }''')
        return page

    def configuration(self):
        def part(number, body):
            path = f'{BASE}/search-{number:06d}-{number:06d}.json.gz'
            return {'start': number, 'end': number,
                    'url': self.resource(path),
                    'bytes': len(body), 'sha256': digest(body)}
        return {'url': self.resource(f'{BASE}/book-text.json.gz'),
                'bytes': len(BOOK), 'sha256': digest(BOOK), 'pageCount': 2,
                'sourceSha': SOURCE_SHA, 'generation': GENERATION,
                'partitions': [part(1, PARTITION), part(2, PARTITION2)]}

    def test_missing_release_is_detected(self):
        from urllib.error import HTTPError
        from urllib.request import urlopen

        self.state['block_path'] = f'{BASE}/book-text.json.gz'
        self.state['timeout'] = 0.05
        with self.assertRaises(HTTPError) as raised:
            urlopen(self.resource(self.state['block_path']), timeout=2)
        self.assertEqual(raised.exception.code, 503)
        self.assertTrue(self.state['done'].wait(2))
        # Exercise the same cleanup assertion, then restore the expected fixture state.
        with self.assertRaisesRegex(AssertionError, 'release timed out'):
            self.cleanup_requests()
        self.server.block_timed_out.clear()

    def test_progress_prefetch_does_not_preempt_search(self):
        self.state['block_path'] = f'{BASE}/search-000002-000002.json.gz'
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          const client = createPdfBookSearch(config);
          window.client = client;
          window.progressSeen = false;
          window.outcome = window.capture(client.search('needle', progress => {
            if (window.progressSeen) return;
            window.progressSeen = true;
            window.progressSession = progress.session;
            window.prefetchOutcome = window.capture(client.prefetch(), 'progress prefetch');
          }), 'search');
        }''', self.configuration())
        self.assertTrue(self.state['arrived'].wait(10), 'second partition was not requested')
        page.wait_for_function('window.progressSeen === true', timeout=4000)
        self.state['release'].set()
        prefetch = page.evaluate('window.prefetchOutcome')
        self.assertEqual(prefetch.get('error'), 'AbortError', f'progress prefetch unexpectedly completed: {prefetch}')
        result = page.evaluate('''async () => {
          const search = await window.outcome;
          if (!search.value) return {search};
          const after = await window.deadline(window.client.prefetch(), 'after search prefetch');
          const page = await window.deadline(window.client.page(150), 'page');
          return {search, after, page, progressSession: window.progressSession};
        }''')
        first = result['search']['value']
        self.assertEqual(first['total'], 180)
        self.assertEqual(first['session'], result['progressSession'])
        self.assertEqual(result['after']['session'], first['session'])
        self.assertIsInstance(result['after']['session'], int)
        self.assertIsInstance(result['after']['id'], int)
        self.assertEqual(result['page']['session'], first['session'])
        self.assertEqual(result['page']['offset'], 150)
        self.assertEqual(len(result['page']['results']), 30)
        self.assertEqual(result['page']['results'][0]['page'], 2)
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def test_partition_lookahead_preserves_order_progress_and_paging(self):
        self.state['block_path'] = f'{BASE}/search-000001-000001.json.gz'
        # Either request can reach the server first. Hold the second until
        # the first is blocked so peak concurrency is deterministic.
        self.state['after_block_path'] = f'{BASE}/search-000002-000002.json.gz'
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);window.updates=[];
          window.outcome=window.capture(window.client.search('needle',p=>window.updates.push({
            scanned:p.scanned,total:p.total,pages:p.pages,first:p.results[0]?.page})), 'parallel search');
        }''', self.configuration())
        self.assertTrue(self.state['arrived'].wait(10), 'first partition not requested')
        # The second request must finish while the first remains blocked;
        # wall-clock speed is not used as the contract.
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            with self.server.state_lock:
                completed = list(self.state['completed_paths'])
            if f'{BASE}/search-000002-000002.json.gz' in completed:
                break
            page.wait_for_timeout(20)
        else:
            self.fail('second partition did not complete while first was blocked')
        self.assertEqual(page.evaluate('window.updates'), [], 'out-of-order work cannot publish past an unfinished predecessor')
        self.state['release'].set()
        result=page.evaluate('''async()=>{
          const done=await window.outcome;if(!done.value)return {done};
          const page=await window.deadline(window.client.page(100),'page');return {done,page,updates:window.updates};
        }''')
        self.assertEqual(result['done']['value']['total'], 180)
        self.assertEqual(result['updates'], [dict(scanned=1,total=120,pages=2,first=1),
                                               dict(scanned=2,total=180,pages=2,first=1)])
        self.assertEqual(result['page']['offset'], 100)
        self.assertEqual([hit['page'] for hit in result['page']['results']], [1]*20+[2]*30)
        self.assertTrue(all(hit['textGeneration'] == TEXT_GENERATION for hit in result['page']['results']))
        self.assertEqual(self.state['peak'],2,'exactly one lookahead may overlap the first partition')

    def test_result_page_cache_reuses_verified_index_and_resets_with_query(self):
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          window.first=await window.deadline(client.search('needle'), 'initial search');
        }''', self.configuration())
        initial = list(self.state['paths'])
        a = page.evaluate('''async() => {
          const a=await window.deadline(client.page(50),'first page');
          const b=await window.deadline(client.page(100),'cross-partition page');
          const c=await window.deadline(client.page(150),'next partition reuse');
          return {a,b,c};
        }''')
        self.assertEqual([a[k]['offset'] for k in ('a','b','c')], [50,100,150])
        self.assertEqual([hit['page'] for hit in a['b']['results']], [1]*20+[2]*30)
        self.assertTrue(all(hit['textGeneration'] == TEXT_GENERATION for k in a for hit in a[k]['results']))
        first_path = f'{BASE}/search-000001-000001.json.gz'
        second_path = f'{BASE}/search-000002-000002.json.gz'
        self.assertEqual(self.state['paths'][len(initial):], [first_path,second_path])
        page.evaluate('''async() => {window.same=await window.deadline(client.search('needle'),'new query');}''')
        self.assertNotEqual(page.evaluate('window.first.session'),page.evaluate('window.same.session'))
        self.assertCountEqual(self.state['paths'][len(initial):], [first_path,second_path,first_path,second_path])
        page.evaluate('''async() => {window.second=await window.deadline(client.page(150),'new session page');}''')
        self.assertEqual(self.state['paths'][-1], second_path)
        self.assertEqual(len(self.state['paths']),len(initial)+5)
        self.assertEqual(len(page.evaluate('window.second.results')),30)

    def test_result_page_cache_never_masks_a_changed_uncached_partition(self):
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          await window.deadline(client.search('needle'),'search');
          await window.deadline(client.page(50),'retain first partition');
        }''', self.configuration())
        target = f'{BASE}/search-000002-000002.json.gz'
        with self.server.state_lock:
            self.server.resources[target] = PARTITION2[:-1] + bytes([PARTITION2[-1] ^ 1])
        result = page.evaluate('''async()=>{
          const failed=await window.capture(client.page(100),'changed partition');
          const retry=await window.capture(client.page(50),'previous partition retry');
          return {failed,retry};
        }''')
        self.assertIn('PDF_OCR_HASH_MISMATCH',result['failed'].get('message',''))
        self.assertEqual(result['retry']['value']['offset'],50)
        self.assertEqual(len(result['retry']['value']['results']),50)
        self.assertEqual(self.state['paths'].count(f'{BASE}/search-000001-000001.json.gz'),3)

    def test_result_cache_is_discarded_after_cancellation(self):
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          await window.deadline(client.search('needle'),'search');
          await window.deadline(client.page(50),'retain');
          client.cancel();
        }''', self.configuration())
        target = f'{BASE}/search-000001-000001.json.gz'
        self.assertEqual(self.state['paths'].count(target),2)
        with self.server.state_lock:
            self.server.resources[target] = PARTITION[:-1] + bytes([PARTITION[-1] ^ 1])
        invalid = page.evaluate('''async()=>window.capture(client.page(50),'old session')''')
        self.assertIn('取消或加载超时',invalid.get('message',''))
        self.assertEqual(self.state['paths'].count(target),2)
        result = page.evaluate('''async()=>window.capture(client.search('needle'),'search after cancel')''')
        self.assertIn('PDF_OCR_HASH_MISMATCH',result.get('message',''))
        self.assertEqual(self.state['paths'].count(target),3)

    def test_result_page_cache_bounds_json_expansion(self):
        large = packed({
            'version':1, 'kind':'pdf-search-text-partition', 'source_sha256':SOURCE_SHA,
            'generation':GENERATION, 'offset_unit':'unicode-codepoint', 'start':1, 'end':1,
            # UTF-16 text fits, but serializing these control characters needs
            # six UTF-8 bytes apiece; it must not become a retained index.
            'pages':[{'page':1, 'text':'needle '*120 + '\u0001'*180000,
                      'text_generation':TEXT_GENERATION}],
        })
        target = f'{BASE}/search-000001-000001.json.gz'
        with self.server.state_lock:
            self.server.resources[target] = large
        config = self.configuration()
        config['partitions'][0]['bytes'] = len(large)
        config['partitions'][0]['sha256'] = digest(large)
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          await window.deadline(client.search('needle'),'search');
          await window.deadline(client.page(50),'first page');
          await window.deadline(client.page(50),'repeated page');
        }''', config)
        self.assertEqual(self.state['paths'].count(target),3)

    def test_result_page_cache_rejects_oversized_text(self):
        large = packed({
            'version':1, 'kind':'pdf-search-text-partition', 'source_sha256':SOURCE_SHA,
            'generation':GENERATION, 'offset_unit':'unicode-codepoint', 'start':1, 'end':1,
            'pages':[{'page':1, 'text':'needle '*120 + '中'*(1024*1024//2),
                      'text_generation':TEXT_GENERATION}],
        })
        target = f'{BASE}/search-000001-000001.json.gz'
        with self.server.state_lock:
            self.server.resources[target] = large
        config = self.configuration()
        config['partitions'][0]['bytes'] = len(large)
        config['partitions'][0]['sha256'] = digest(large)
        page = self.make_page()
        result = page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          await window.deadline(client.search('needle'),'search');
          const a=await window.deadline(client.page(50),'first page');
          const b=await window.deadline(client.page(50),'repeated page');
          return {a,b};
        }''',config)
        self.assertEqual(result['a']['results'],result['b']['results'])
        self.assertEqual(self.state['paths'].count(target),3)

    def test_partition_configuration_rejects_wrong_source_before_fetch(self):
        config = self.configuration()
        config['partitions'][0]['url'] = config['partitions'][0]['url'].replace(SOURCE_SHA, 'f' * 64)
        page = self.make_page()
        result = page.evaluate('''async config => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          const client = window.client = createPdfBookSearch(config);
          const progress = [];
          const result = await window.capture(client.search('needle', value => progress.push(value)), 'search');
          return {result, progress};
        }''', config)
        self.assertIn('PDF_TEXT_INDEX_INVALID', result['result'].get('message', ''))
        self.assertEqual(result['progress'], [])
        self.assertEqual(self.state['paths'], [])
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def test_partition_shape_rejects_null_page_before_progress_or_paging(self):
        malformed = packed({
            'version': 1, 'kind': 'pdf-search-text-partition', 'source_sha256': SOURCE_SHA,
            'generation': GENERATION, 'offset_unit': 'unicode-codepoint', 'start': 1, 'end': 1,
            'pages': [None],
        })
        target = f'{BASE}/search-000001-000001.json.gz'
        with self.server.state_lock:
            self.server.resources[target] = malformed
        config = self.configuration()
        config['partitions'][0]['bytes'] = len(malformed)
        config['partitions'][0]['sha256'] = digest(malformed)
        page = self.make_page()
        result = page.evaluate('''async config => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          const client = window.client = createPdfBookSearch(config);
          const progress = [];
          const result = await window.capture(client.search('needle', value => progress.push(value)), 'search');
          return {result, progress};
        }''', config)
        self.assertIn('PDF_TEXT_INDEX_INVALID', result['result'].get('message', ''))
        self.assertEqual(result['progress'], [])
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def test_partition_failure_never_commits_unverified_results(self):
        page=self.make_page()
        configuration=self.configuration()
        configuration['partitions'][0]['sha256']='0'*64
        result=page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);window.updates=[];
          const outcome=await window.capture(client.search('needle',p=>window.updates.push(p.scanned)),'failed search');
          return {outcome,updates:window.updates};
        }''',configuration)
        self.assertIn('PDF_OCR_HASH_MISMATCH',result['outcome'].get('message',''))
        self.assertEqual(result['updates'],[])

    def test_failed_lookahead_waits_for_verified_predecessor(self):
        self.state['block_path'] = f'{BASE}/search-000001-000001.json.gz'
        configuration = self.configuration()
        configuration['partitions'][1]['sha256'] = '0' * 64
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);window.updates=[];
          window.outcome=window.capture(client.search('needle',p=>window.updates.push({
            scanned:p.scanned,total:p.total,complete:p.complete})), 'bad lookahead');
        }''', configuration)
        self.assertTrue(self.state['arrived'].wait(10))
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            with self.server.state_lock:
                finished = f'{BASE}/search-000002-000002.json.gz' in self.state['completed_paths']
            if finished:
                break
            page.wait_for_timeout(20)
        self.assertTrue(finished, 'lookahead request did not finish')
        self.assertEqual(page.evaluate('window.updates'), [])
        self.state['release'].set()
        result = page.evaluate('''async()=>({outcome:await window.outcome,updates:window.updates})''')
        self.assertIn('PDF_OCR_HASH_MISMATCH', result['outcome'].get('message', ''))
        self.assertEqual(result['updates'], [dict(scanned=1,total=120,complete=False)])

    def test_cancel_after_legacy_prefetch_drains_partition_requests(self):
        page = self.make_page()
        self.state['block_path'] = f'{BASE}/search-000002-000002.json.gz'
        configuration = self.configuration()
        legacy = {key: configuration[key] for key in ('url', 'bytes', 'sha256', 'sourceSha')}
        legacy['pageCount'] = 1
        # A legacy ready Worker can receive cancel without termination; use the
        # protocol directly to exercise cleanup before a replacement search.
        page.evaluate('''async config => {
          window.worker = new Worker('/static/reader/search/workers/reader-pdf-book-search-worker.mjs', {type:'module'});
          window.workerMessages = [];
          worker.onmessage = event => window.workerMessages.push(event.data);
          worker.postMessage({type:'init',configuration:config});worker.postMessage({type:'prefetch',id:1});
        }''', legacy)
        page.wait_for_function('window.workerMessages.some(m=>m.id===1 && m.ready)', timeout=4000)
        page.evaluate('''config => {
          worker.postMessage({type:'init',configuration:config});worker.postMessage({type:'search',id:2,query:'needle'});
        }''', configuration)
        self.assertTrue(self.state['arrived'].wait(10))
        page.wait_for_function('window.workerMessages.some(m=>m.id===2 && m.progress)', timeout=4000)
        page.evaluate('''() => {
          worker.postMessage({type:'cancel'});worker.postMessage({type:'search',id:3,query:'needle'});
        }''')
        self.state['release'].set()
        page.wait_for_function('window.workerMessages.some(m=>m.id===3 && !m.progress)', timeout=4000)
        result = page.evaluate('''() => {
          const result = window.workerMessages.find(m=>m.id===3 && !m.progress);
          worker.terminate();return result;
        }''')
        self.assertEqual(result.get('total'), 180)
        self.assertEqual(len(result.get('results', [])), 50)

    def test_large_lookahead_is_not_started_early(self):
        self.state['block_path'] = f'{BASE}/search-000001-000001.json.gz'
        configuration = self.configuration()
        configuration['partitions'][1]['bytes'] = 1024 * 1024 + 1
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          window.outcome=window.capture(client.search('needle'), 'large lookahead');
        }''', configuration)
        self.assertTrue(self.state['arrived'].wait(10))
        page.wait_for_timeout(250)
        with self.server.state_lock:
            self.assertNotIn(f'{BASE}/search-000002-000002.json.gz', self.state['paths'])
        self.state['release'].set()
        outcome = page.evaluate('window.outcome')
        self.assertIn('PDF_OCR_SIZE_MISMATCH', outcome.get('message', ''))
        self.assertIn(f'{BASE}/search-000002-000002.json.gz', self.state['paths'])

    def test_cancelled_partition_search_cannot_abort_replacement(self):
        self.state['block_path']=f'{BASE}/search-000001-000001.json.gz'
        page=self.make_page()
        page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);
          window.first=window.capture(client.search('needle'),'old search');
        }''',self.configuration())
        self.assertTrue(self.state['arrived'].wait(10),'old request did not arrive')
        page.evaluate('''()=>{window.second=window.capture(window.client.search('needle'),'replacement');}''')
        self.state['release'].set()
        result=page.evaluate('''async()=>({first:await window.first,second:await window.second})''')
        self.assertEqual(result['first'].get('error'),'AbortError')
        self.assertEqual(result['second']['value']['total'],180)
        self.assertEqual(len(result['second']['value']['results']),50)

    def test_cancellation_aborts_lookahead_and_retry_succeeds(self):
        self.state['block_path']=f'{BASE}/search-000002-000002.json.gz'
        page=self.make_page()
        page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          window.client=createPdfBookSearch(config);window.updates=[];
          window.first=window.capture(client.search('needle',p=>window.updates.push(p.scanned)),'cancelled search');
        }''',self.configuration())
        self.assertTrue(self.state['arrived'].wait(10),'lookahead request did not arrive')
        page.wait_for_function('window.updates.includes(1)',timeout=4000)
        page.evaluate('window.client.cancel()')
        self.state['release'].set()
        result=page.evaluate('''async()=>{
          const first=await window.first,retry=await window.capture(window.client.search('needle'),'retry');
          return {first,retry};
        }''')
        self.assertEqual(result['first'].get('error'),'AbortError')
        self.assertEqual(result['retry']['value']['total'],180)

    def test_large_legacy_worker_search_replacement_keeps_cancellation(self):
        target = f'{BASE}/book-text.json.gz'
        text = '普通文本😀' * 2000
        packed_book = packed({'version':2, 'kind':'pdf-book-text', 'complete':True,
            'offset_unit':'unicode-codepoint', 'source_sha256':SOURCE_SHA, 'page_count':100,
            'pages':[{'page':number, 'text':text, 'layout':{'offset_unit':'unicode-codepoint'}, 'text_spans':[]}
                     for number in range(1,101)]})
        with self.server.state_lock:
            self.server.resources[target] = packed_book
        config = {'url':self.resource(target),'bytes':len(packed_book),'sha256':digest(packed_book),
                  'pageCount':100,'sourceSha':SOURCE_SHA}
        page = self.make_page()
        result = page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          const client=window.client=createPdfBookSearch(config);
          await window.deadline(client.prefetch(),'legacy prefetch');
          const old=window.capture(client.search('missing'),'superseded');
          const replacement=window.capture(client.search('普通'),'replacement');
          const [first,second]=await Promise.all([old,replacement]);
          const tail=await window.deadline(client.page(199950),'deep page');
          return {first,second,tail};
        }''', config)
        self.assertEqual(result['first'].get('error'),'AbortError')
        self.assertEqual(result['second']['value']['total'],200000)
        self.assertEqual(result['tail']['offset'],199950)
        self.assertEqual(len(result['tail']['results']),50)
        self.assertEqual(result['tail']['results'][0]['page'],100)
        self.assertEqual(result['tail']['results'][0]['start'],1950*len('普通文本😀'.encode('utf-16-le'))//2)

    def test_legacy_dense_results_keep_mapped_coordinates_across_pages(self):
        target = f'{BASE}/book-text.json.gz'
        text = '😀needle ' * 3500
        spans = [{'start':number*8+1, 'end':number*8+7,
                  'box':[0,0,1,1], 'block':number, 'precision':'glyph'} for number in range(3500)]
        body = packed({'version':2, 'kind':'pdf-book-text', 'complete':True,
            'offset_unit':'unicode-codepoint', 'source_sha256':SOURCE_SHA, 'page_count':1,
            'pages':[{'page':1, 'text':text, 'layout':{'offset_unit':'unicode-codepoint'}, 'text_spans':spans}]})
        with self.server.state_lock:
            self.server.resources[target] = body
        config = {'url':self.resource(target),'bytes':len(body),'sha256':digest(body),
                  'pageCount':1,'sourceSha':SOURCE_SHA}
        page = self.make_page()
        result = page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          const client=window.client=createPdfBookSearch(config);
          const search=await window.deadline(client.search('needle'),'mapped search');
          const pages=[];for(const offset of [500,1000,2250,3450])pages.push(await window.deadline(client.page(offset),'mapped page'));
          return {total:search.total,pages};
        }''',config)
        self.assertEqual(result['total'],3500)
        for expected, group in zip([500,1000,2250,3450],result['pages']):
            self.assertEqual(group['offset'],expected)
            self.assertEqual(len(group['results']),50)
            self.assertEqual([hit['boxes'][0]['block'] for hit in group['results']],list(range(expected,expected+50)))
            self.assertTrue(all(hit['boxes'][0]['precision']=='glyph' for hit in group['results']))
            self.assertEqual(group['results'][0]['start'],expected*len('😀needle '.encode('utf-16-le'))//2+2)

    def test_legacy_sparse_page_boundaries_return_exact_result_page(self):
        target = f'{BASE}/book-text.json.gz'
        pages = [{'page':number, 'text':'中' * 150 + '😀' * 530,
                  'layout':{'offset_unit':'unicode-codepoint'},
                  'text_spans':[{'start':0,'end':680,'box':[0,0,1,1],'block':number}]}
                 for number in range(1,5)]
        body = packed({'version':2,'kind':'pdf-book-text','complete':True,'offset_unit':'unicode-codepoint',
                       'source_sha256':SOURCE_SHA,'page_count':4,'pages':pages})
        with self.server.state_lock:
            self.server.resources[target] = body
        config = {'url':self.resource(target),'bytes':len(body),'sha256':digest(body),
                  'pageCount':4,'sourceSha':SOURCE_SHA}
        page = self.make_page()
        result = page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          const client=window.client=createPdfBookSearch(config);
          const first=await window.deadline(client.search('中'),'search');
          const last=await window.deadline(client.page(500),'last page');return {first,last};
        }''',config)
        self.assertEqual(result['first']['total'],600)
        self.assertEqual(result['last']['offset'],500)
        self.assertEqual(len(result['last']['results']),50)
        self.assertEqual([hit['page'] for hit in result['last']['results']],[4]*50)
        self.assertEqual([hit['start'] for hit in result['last']['results']],list(range(50,100)))
        self.assertTrue(all(hit['boxes'][0]['block']==4 for hit in result['last']['results']))

    def test_replacement_during_legacy_scan_keeps_progress_and_results(self):
        target = f'{BASE}/book-text.json.gz'
        text = '普通文本😀' * 2000
        packed_book = packed({'version':2, 'kind':'pdf-book-text', 'complete':True,
            'offset_unit':'unicode-codepoint', 'source_sha256':SOURCE_SHA, 'page_count':100,
            'pages':[{'page':number, 'text':text, 'layout':{'offset_unit':'unicode-codepoint'}, 'text_spans':[]}
                     for number in range(1,101)]})
        with self.server.state_lock:
            self.server.resources[target] = packed_book
        config = {'url':self.resource(target),'bytes':len(packed_book),'sha256':digest(packed_book),
                  'pageCount':100,'sourceSha':SOURCE_SHA}
        page = self.make_page()
        result = page.evaluate('''async config=>{
          const {createPdfBookSearch}=await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'),'import');
          const client=window.client=createPdfBookSearch(config);
          await window.deadline(client.prefetch(),'legacy prefetch');
          let replacement, observed=0;
          const old=window.capture(client.search('missing',progress=>{
            observed++;
            if (!replacement) replacement=window.capture(client.search('普通'),'replacement after progress');
          }),'superseded after progress');
          const first=await old;
          if (!replacement) return {first,observed};
          const second=await replacement;
          return {first,second,observed};
        }''',config)
        self.assertGreaterEqual(result['observed'],1,'replacement must begin after actual Worker progress')
        self.assertEqual(result['first'].get('error'),'AbortError')
        self.assertEqual(result['second']['value']['total'],200000)
        self.assertEqual(len(result['second']['value']['results']),50)

    def test_search_preempts_inflight_prefetch(self):
        self.state['block_path'] = f'{BASE}/book-text.json.gz'
        config = {'url': self.resource(self.state['block_path']),
                  'bytes': len(BOOK), 'sha256': digest(BOOK), 'pageCount': 1, 'sourceSha': SOURCE_SHA}
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          window.client = createPdfBookSearch(config);
          window.prefetchOutcome = window.capture(window.client.prefetch(), 'prefetch');
        }''', config)
        self.assertTrue(self.state['arrived'].wait(10), 'book prefetch was not requested')
        page.evaluate('''() => {
          window.outcome = window.capture(window.client.search('needle'), 'search');
        }''')
        prefetch = page.evaluate('window.prefetchOutcome')
        self.assertEqual(prefetch.get('error'), 'AbortError', str(prefetch))
        self.state['release'].set()
        result = page.evaluate('window.outcome')
        self.assertEqual(result['value']['total'], 120)
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def check_prefetch_after_search(self, partitioned):
        resource = self.resource

        configuration = {
            'url': resource(f'{BASE}/book-text.json.gz'), 'bytes': len(BOOK),
            'sha256': digest(BOOK), 'pageCount': 1, 'sourceSha': SOURCE_SHA,
        }
        if partitioned:
            configuration.update(generation=GENERATION, partitions=[{
                'start': 1, 'end': 1, 'url': resource(f'{BASE}/search-000001-000001.json.gz'),
                'bytes': len(PARTITION), 'sha256': digest(PARTITION),
            }])
        page = self.make_page()
        result = page.evaluate('''async configuration => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          const client = window.client = createPdfBookSearch(configuration);
          const before = await window.deadline(client.prefetch(), 'before prefetch');
          const first = await window.deadline(client.search('needle'), 'search');
          const after = await window.deadline(client.prefetch(), 'after prefetch');
          const page = await window.deadline(client.page(100), 'page');
          client.cancel();
          const cancelled = await window.deadline(client.prefetch(), 'cancelled prefetch');
          const retry = await window.deadline(client.search('needle'), 'retry');
          return {before, first, after, page, cancelled, retry};
        }''', configuration)
        self.assertEqual(result['before']['session'], None)
        first = result['first']
        self.assertEqual(first['total'], 120)
        self.assertEqual(len(first['results']), 50)
        self.assertEqual(result['after']['session'], first['session'])
        self.assertTrue(result['after']['ready'])
        self.assertEqual(result['page']['session'], first['session'])
        self.assertEqual(result['page']['offset'], 100)
        self.assertEqual(len(result['page']['results']), 20)
        if partitioned:
            self.assertEqual(result['page']['results'][0]['textGeneration'], TEXT_GENERATION)
        self.assertEqual(result['cancelled']['session'], None)
        self.assertEqual(result['retry']['total'], 120)
        self.assertNotEqual(result['retry']['session'], first['session'])
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def test_pdf_text_layer_vertical_geometry_and_selection(self):
        page = self.make_page()
        result = page.evaluate('''async () => {
          const stylesheet=document.createElement('link');
          stylesheet.rel='stylesheet';stylesheet.href='/static/reader.css';document.head.append(stylesheet);
          await new Promise((resolve,reject)=>{stylesheet.onload=resolve;stylesheet.onerror=reject});
          const {populatePdfTextLayer,populateIndependentTextLayer}=await import('/static/reader/pdf/reader-pdf-text.js');
          const shell=document.createElement('div');
          shell.style.cssText='position:relative;width:600px;height:800px;container-type:inline-size';
          const layer=document.createElement('div');layer.className='reader-pdf-text';shell.append(layer);document.body.append(shell);
          const viewport={width:600,height:800,scale:1,transform:[1,0,0,1,0,0],convertToViewportPoint:(x,y)=>[x,y]};
          const trace=[];const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'offsetHeight');
          Object.defineProperty(HTMLElement.prototype,'offsetHeight',{...descriptor,get(){
            if(this.classList.contains('reader-pdf-text-run')) trace.push('read');return descriptor.get.call(this);
          }});
          const position=n=>Math.round(n*1000)/1000;
          function inspect() {
            const runs=[...layer.querySelectorAll('.reader-pdf-text-run')];
            const range=document.createRange();range.selectNodeContents(layer);
            const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
            const value={selected:selection.toString(),runs:runs.map(run=>{
              const box=run.getBoundingClientRect();
              return {text:run.textContent,writingMode:getComputedStyle(run).writingMode,
                width:position(box.width),height:position(box.height)};
            })};
            selection.removeAllRanges();return value;
          }
          try {
            const items=[{str:'竖排 Latin😀',dir:'ttb',width:35,height:100,transform:[12,0,0,12,30,40]},
              {str:'第二列 Latin',dir:'ttb',width:35,height:80,transform:[12,0,0,12,80,40]},
              {str:'水平文字',dir:'ltr',width:100,height:12,transform:[12,0,0,12,150,40]}];
            populatePdfTextLayer(layer,items,viewport);
            const native=inspect(), nativeReads=trace.length;
            const regions=[{id:'a',text:'甲乙😀',start:0,end:3,writing_mode:'vertical-rl',direction:'ltr',
                quad:[[.1,.1],[.13,.1],[.13,.3],[.1,.3]],mapping_precision:'glyph'},
              {id:'b',text:'mixed Latin',start:4,end:15,writing_mode:'vertical-lr',direction:'ltr',
                quad:[[.2,.1],[.23,.1],[.23,.4],[.2,.4]],mapping_precision:'glyph'}];
            trace.length=0;
            populateIndependentTextLayer(layer,{text:'甲乙😀 mixed Latin',regions,generation:'fixture'});
            const independent=inspect(), independentReads=trace.length;
            return {native,nativeReads,independent,independentReads,generation:layer.dataset.textGeneration,
              userSelect:layer.style.userSelect,regionIds:[...layer.querySelectorAll('.reader-pdf-text-run')].map(n=>n.dataset.regionId)};
          } finally {Object.defineProperty(HTMLElement.prototype,'offsetHeight',descriptor);shell.remove();stylesheet.remove()}
        }''')
        self.assertEqual(result['native']['selected'], '竖排 Latin😀第二列 Latin水平文字')
        self.assertEqual(result['nativeReads'], 2)
        self.assertEqual([r['writingMode'] for r in result['native']['runs']],
                         ['vertical-rl', 'vertical-rl', 'horizontal-tb'])
        self.assertAlmostEqual(result['native']['runs'][0]['height'], 100, delta=2)
        self.assertAlmostEqual(result['native']['runs'][1]['height'], 80, delta=2)
        self.assertEqual(result['independent']['selected'], '甲乙😀 mixed Latin')
        self.assertEqual(result['independentReads'], 2)
        self.assertEqual([r['writingMode'] for r in result['independent']['runs']], ['vertical-rl', 'vertical-lr'])
        self.assertTrue(all(r['height'] > 0 for r in result['independent']['runs']))
        self.assertEqual(result['regionIds'], ['a', 'b'])
        self.assertEqual(result['generation'], 'fixture')
        self.assertEqual(result['userSelect'], 'text')

    def test_independent_text_render_unicode_gaps_and_selection(self):
        page = self.make_page()
        result = page.evaluate('''async () => {
          const {populateIndependentTextLayer}=await import('/static/reader/pdf/reader-pdf-text.js');
          const {paintTextHit}=await import('/static/reader/search/reader-book-text.js');
          const shell=document.createElement('div'),layer=document.createElement('div');
          shell.className='reader-page';shell.style.cssText='position:relative;width:600px;height:800px;container-type:inline-size';
          layer.className='reader-pdf-text';shell.append(layer);document.body.append(shell);
          const quad=[[.1,.1],[.3,.1],[.3,.2],[.1,.2]], region=(id,start,end,text,writing_mode,direction)=>
            ({id,start,end,text,quad,writing_mode,direction,mapping_precision:'glyph'});
          const text='前😀A\ud800B\udc00结尾';
          const regions=[region('emoji',1,2,'😀','horizontal-ltr','ltr'),
            region('high',3,4,'\ud800','vertical-rl','rtl'),region('low',5,6,'\udc00','vertical-lr','ltr')];
          let fullArrays=0;const oldFrom=Array.from;
          Array.from=function(value,...args){if(value===text)fullArrays++;return oldFrom.call(this,value,...args);};
          try {
            populateIndependentTextLayer(layer,{text,regions,generation:'unicode'});
            const gaps=[...layer.childNodes].filter((_,i)=>i%2===0).map(n=>n.data);
            const runs=[...layer.querySelectorAll('.reader-pdf-text-run')].map(n=>
              ({text:n.textContent,id:n.dataset.regionId,dir:n.dir,mode:getComputedStyle(n).writingMode}));
            const range=document.createRange();range.selectNodeContents(layer);
            const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
            const selectedExact=selection.toString()===text;selection.removeAllRanges();
            const textExact=layer.textContent===text;
            const units=value=>Array.from({length:value.length},(_,i)=>value.charCodeAt(i));
            const runUnits=runs.map(r=>units(r.text));
            paintTextHit(shell,[],{start:1,length:2});
            const highlights=shell.querySelectorAll('.reader-text-hit-box').length;
            const first=layer.querySelector('.reader-pdf-text-run').firstChild;
            const cut=document.createRange();cut.setStart(first,0);cut.setEnd(first,2);
            selection.removeAllRanges();selection.addRange(cut);
            const partial=selection.toString()==='😀';selection.removeAllRanges();
            const empty='😀中'.repeat(5000);populateIndependentTextLayer(layer,{text:empty,regions:[],generation:'empty'});
            range.selectNodeContents(layer);selection.addRange(range);
            const emptySelected=selection.toString()===empty;selection.removeAllRanges();
            const odd={text:'ABCDE',regions:[region('one',1,4,'BCD','horizontal-ltr','ltr'),
              region('two',2,3,'C','horizontal-ltr','ltr')]};
            populateIndependentTextLayer(layer,odd);
            const oddNodes=[...layer.childNodes].filter((_,i)=>i%2===0).map(n=>n.data);
            return {gaps,runs,runUnits,selectedExact,textExact,partial,emptySelected,highlights,fullArrays,oddText:layer.textContent,oddNodes};
          } finally {Array.from=oldFrom;getSelection().removeAllRanges();shell.remove();}
        }''')
        self.assertEqual(result['gaps'], ['前','A','B','结尾'])
        self.assertEqual(result['runUnits'], [[0xd83d,0xde00],[0xd800],[0xdc00]])
        self.assertEqual([r['id'] for r in result['runs']], ['emoji','high','low'])
        self.assertEqual([r['mode'] for r in result['runs']], ['horizontal-tb','vertical-rl','vertical-lr'])
        self.assertEqual([r['dir'] for r in result['runs']], ['ltr','rtl','ltr'])
        self.assertTrue(result['selectedExact'] and result['textExact'] and result['partial'] and result['emptySelected'])
        self.assertGreater(result['highlights'],0)
        self.assertEqual(result['fullArrays'],0)
        self.assertEqual(result['oddText'],'ABCDCDE')
        self.assertEqual(result['oddNodes'],['A','','DE'])

    def test_chapter_search_mapping_respects_nodes_ranges_and_detachment(self):
        page = self.make_page()
        result = page.evaluate('''async () => {
          const {chapterTextMap}=await import('/static/reader/search/reader-chapter-search.mjs');
          const root=document.createElement('article');
          root.innerHTML='<h2>标题 😀</h2><p id="one">甲 &amp; 中文 <b>needle</b> 后续</p>'+
            '<script>hidden needle</script><p id="two">zero needle 😀 tail</p>';
          document.body.append(root);
          try {
            const outputs=[];
            for (const profile of ['dom-text-v1',undefined]) {
              const map=chapterTextMap([root],profile), text=map.text;
              const matches=[...text.matchAll(/needle/giu)].map(match=>[match.index,match.index+match[0].length]);
              const cases=[];
              for (const [start,end] of [[0,1],[0,text.length],[3,25],...matches]) {
                const parts=map.parts(start,end,root);
                cases.push({start,end,text:parts.map(part=>part.node.data.slice(part.start,part.end)).join('')});
              }
              const target=root.querySelector('#two');target.remove();
              const detached=map.parts(matches[1][0],matches[1][1],root).length;
              root.append(target);
              outputs.push({profile:profile||'legacy',text,cases,detached});
            }
            return outputs;
          } finally {root.remove()}
        }''')
        for item in result:
            self.assertNotIn('hidden needle', item['text'])
            self.assertEqual(item['detached'], 0)
            needle = [case for case in item['cases'] if case['text'] == 'needle']
            self.assertEqual(len(needle), 2)
            self.assertTrue(item['cases'][1]['text'].startswith('标题 😀'))

    def test_pdf_search_highlight_cross_node_unicode_and_bounded_projection(self):
        page = self.make_page()
        result = page.evaluate(r'''async () => {
          const {createReaderPdfTextRuntime}=await import('/static/reader/pdf/reader-pdf-text-runtime.mjs');
          const {pdfSearchText,pdfSourceOffset,normalizePdfSearchText}=await import('/static/reader/pdf/reader-pdf-text.js');
          const shell=document.createElement('div'), layer=document.createElement('div');
          layer.className='reader-pdf-text';shell.append(layer);document.body.append(shell);
          let highlights=[];
          const context={readerAbortController:{signal:{aborted:false}},searchState:{query:''},
            pdfSearchText,pdfSourceOffset,normalizePdfSearchText,fullSearchEscape:x=>x,
            highlightTextParts:parts=>highlights.push(parts.map(p=>p.node.data.slice(p.start,p.end)))};
          const search=createReaderPdfTextRuntime(context);
          try {
            for(const text of ['手',' ', '机','', '😀','nee','dle',' ','手','\n','机']) {
              const node=document.createElement('span');node.textContent=text;layer.append(node);
            }
            search.highlightPdfText(shell,'手机');const chinese=highlights;
            highlights=[];search.highlightPdfText(shell,'needle');const split=highlights;
            highlights=[];search.highlightPdfText(shell,'😀');const emoji=highlights;
            layer.replaceChildren();const fragment=document.createDocumentFragment();
            for(let i=0;i<20000;i++) {const node=document.createElement('span');
              node.textContent=i%100===0?'needle':'ordinary';fragment.append(node)}
            layer.append(fragment);highlights=[];
            const oldFilter=Array.prototype.filter;let largeFilters=0;
            Array.prototype.filter=function(...args){if(this.length>=20000)largeFilters++;return oldFilter.apply(this,args)};
            try {search.highlightPdfText(shell,'needle')} finally {Array.prototype.filter=oldFilter}
            return {chinese,split,emoji,dense:highlights.length,largeFilters};
          } finally {shell.remove()}
        }''')
        self.assertEqual(result['chinese'], [['手', '\n', '机'], ['手', ' ', '机']])
        self.assertEqual(result['split'], [['nee', 'dle']])
        self.assertEqual(result['emoji'], [['😀']])
        self.assertEqual(result['dense'], 100)
        self.assertEqual(result['largeFilters'], 0)

    def test_book_text_prefetch_after_search(self):
        self.check_prefetch_after_search(False)

    def test_partitioned_prefetch_after_search(self):
        self.check_prefetch_after_search(True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
