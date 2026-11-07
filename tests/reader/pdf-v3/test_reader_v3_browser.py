#!/usr/bin/env python3
"""Browser component contract for v3 manifests and text resources (not full Reader rendering)."""
import argparse
import gzip
import hashlib
import json
import os
import signal
import sys
import threading
import time
from types import MappingProxyType
from urllib.parse import unquote
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path


def hard_deadline(_signum, _frame):
    # Playwright's synchronous cleanup can hang after an interrupted protocol
    # request. Terminate the process instead of waiting for cleanup indefinitely.
    os.write(2, b'Reader v3 browser hard deadline exceeded\n')
    os._exit(124)


FIXTURE_ROOT = Path(__file__).resolve().parent
CHECKOUT = Path(__file__).resolve().parents[3]
FIXTURE_NAME = 'reader_v3_fixture.html'
S, G = 'a'*64, 'b'*64
BASE = f'objects/aa/{S}/' + 'd'*16

def build(case):
    files = {}
    def resource(name, value, compressed=False):
        raw = json.dumps(value, separators=(',', ':')).encode()
        data = gzip.compress(raw, mtime=0) if compressed else raw
        path = BASE + '/' + name
        files[path] = data
        return dict(bucket='vomebook/pdf-pages-v2', path=path, role='runtime', sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
    layer = dict(version=1, kind='pdf-text-layer', source_sha256=S, page=1, generation=G, raw_sha256=S, page_identity=S, offset_unit='unicode-codepoint', text='', revision='raw', quality='unreviewed', processing='processed', geometry=dict(width=1,height=1,coordinate_space='normalized-page'), regions=[])
    layerref = resource('text/page-000001.json.gz', None if case == 'layer-null' else layer, True)
    if case in ('bad-json', 'bad-gzip'):
        data = gzip.compress(b'{invalid', mtime=0) if case == 'bad-json' else b'not a gzip stream'
        files[layerref['path']] = data
        layerref.update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
    if case == 'wrong-page':
        layer['page'] = 2
        layerref = resource('text/page-000001.json.gz', layer, True)
    entry = dict(page=2 if case == 'wrong-page' else 1,generation=G,page_identity=S,quality='unreviewed',processing='processed',resource=layerref)
    if case == 'invalid-identity': entry['page_identity'] = 'wrong'
    partition = dict(version=1,kind='pdf-text-partition',source_sha256=S,generation=('f'*64 if case == 'invalid-generation' else G),start=1,end=1,pages=[None if case == 'entry-null' else entry])
    partref = resource('text/partition-000001-000001-manifest.json', None if case == 'partition-root-null' else partition)
    part = dict(start=1,end=1,resource=partref)
    bookref = resource('text/book-text.json.gz', {}, True)
    index = dict(version=1,kind='pdf-text-layer-index',complete=True,source_sha256=S,page_count=1,generation=G,revision='raw',offset_unit='unicode-codepoint',partitions=[None if case == 'part-null' else part],book_text=bookref)
    indexref = resource('text-layer-manifest.json', None if case == 'index-null' else index)
    pagemap = dict(version=1,kind='pdf-page-map',source_sha256=S,pages=[None if case == 'map-null' else dict(page=1,identity=S,width=1,height=1,rotation=0,crop_box=[0,0,1,1],media_box=[0,0,1,1])])
    mapref = resource('page-map.json.gz', None if case == 'map-root-null' else pagemap, True)
    # Corrupt the partition reference, so transport failure must prevent layer access.
    if case == 'size': partref['bytes'] += 1
    if case == 'hash': partref['sha256'] = '0'*64
    if case in ('size','hash'):
        indexref = resource('text-layer-manifest.json', index)
    primary = dict(kind='dataset-source',repo='VoiceOfML/test',path='book.pdf',revision='c'*40,sha256=S,bytes=10,role='runtime')
    manifest = dict(version=3,kind='pdf-reading',source_sha256=S,generation=G,page_count=1,source_key='VoiceOfML/test\0book.pdf',primary=dict(kind='pdf',status='ready',resource=primary),page_map=mapref,text_layer=indexref,preview=dict(complete=False,page_count=1,ready_pages=0,partitions=[None] if case == 'manifest-null' else []),components=dict(document='ready',preview='pending',text='ready'))
    if case == 'complete':
        manifest['preview'].update(complete=True, ready_pages=1, partitions=[dict(start=1,end=1,complete=True,resource=partref)])
        manifest['components']['preview'] = 'ready'
    files['reading-manifest.json'] = json.dumps(None if case == 'manifest-root-null' else manifest).encode()
    return files

CASES = ('ok', 'manifest-null', 'map-null', 'index-null', 'part-null',
         'entry-null', 'layer-null', 'size', 'hash', 'bad-json', 'bad-gzip',
         'manifest-root-null', 'map-root-null', 'partition-root-null', 'invalid-generation', 'invalid-identity', 'wrong-page', 'complete')
if len(CASES) != 18 or len(set(CASES)) != 18:
    raise RuntimeError('invalid v3 browser case inventory')
GRAPHS = MappingProxyType({case: MappingProxyType(build(case)) for case in CASES})
STATIC = None
INDEX = BASE + '/text-layer-manifest.json'
MAP = BASE + '/page-map.json.gz'
PART = BASE + '/text/partition-000001-000001-manifest.json'
LAYER = BASE + '/text/page-000001.json.gz'
EXPECTED = {case: ['reading-manifest.json', MAP] for case in CASES}
EXPECTED['manifest-null'] = EXPECTED['manifest-root-null'] = ['reading-manifest.json']
for case in ('ok', 'index-null', 'part-null', 'entry-null', 'layer-null', 'size', 'hash', 'bad-json', 'bad-gzip', 'partition-root-null', 'invalid-generation', 'invalid-identity', 'wrong-page', 'complete'):
    EXPECTED[case] += [INDEX]
for case in ('ok', 'entry-null', 'layer-null', 'size', 'hash', 'bad-json', 'bad-gzip', 'partition-root-null', 'invalid-generation', 'invalid-identity', 'wrong-page', 'complete'):
    EXPECTED[case] += [PART]
for case in ('ok', 'layer-null', 'bad-json', 'bad-gzip', 'invalid-identity', 'complete'):
    EXPECTED[case] += [LAYER]

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURE_ROOT), **kwargs)
    def log_message(self, *args): pass
    def send_response(self, code, message=None):
        with self.server.lock:
            self.server.requests.append((self.headers.get('X-Test-Run', ''), self.path, code))
        super().send_response(code, message)
    def translate_path(self, path):
        urlpath = unquote(urlparse(path).path)
        if urlpath == '/static' or urlpath.startswith('/static/'):
            relative = urlpath[len('/static'):].lstrip('/')
            target = (STATIC / relative).resolve()
            if not target.is_relative_to(STATIC):
                return str(STATIC / '__forbidden__')
            return str(target)
        return super().translate_path(path)
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/asset':
            q = parse_qs(u.query)
            case, path = q.get('case', [''])[0], q.get('path', [''])[0]
            data = GRAPHS.get(case, {}).get(path)
            if data is None: self.send_error(404); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

# Independent oracle: request trace, error, phase, and instrumented text-stage counters.
ERRORS = {case: 'PDF_V3_INVALID' for case in CASES}
ERRORS.update(ok='OK', complete='OK', size='PDF_OCR_SIZE_MISMATCH', hash='PDF_OCR_HASH_MISMATCH', **{'bad-json':'INVALID_JSON', 'bad-gzip':'INSTRUMENTED_NATIVE_GZIP_ERROR', 'manifest-root-null':'PDF_MANIFEST_INVALID'})
MANIFEST_PHASE = {'manifest-null', 'manifest-root-null', 'map-null', 'map-root-null'}

def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def main():
    from playwright.sync_api import sync_playwright

    global STATIC
    parser = argparse.ArgumentParser(description='Reader v3 browser component test')
    parser.add_argument('--browser', choices=('chromium', 'firefox'), required=True)
    args = parser.parse_args()
    STATIC = (CHECKOUT / 'static').resolve(strict=True)
    if not (STATIC / 'reader/pdf/reader-v3.mjs').is_file():
        parser.error('checkout lacks static/reader/pdf/reader-v3.mjs')
    print('Production static:', STATIC, flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.requests, server.lock = [], threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    failures, completed = [], []
    deadline = time.monotonic() + 120
    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0: raise TimeoutError('120s program deadline exceeded')
        return max(1, int(seconds * 1000))
    try:
        with sync_playwright() as p:
            for name in (args.browser,):
                browser = None
                try:
                    browser = getattr(p, name).launch(headless=True, timeout=remaining())
                    for case, wrong in [(c, False) for c in CASES] + [('bad-gzip', True)]:
                        context = None
                        label = case + ('-wrong-source' if wrong else '')
                        requests, errors, start = [], [], 0
                        try:
                            run_id = name + ':' + label
                            with server.lock: start = len(server.requests)
                            context = browser.new_context(extra_http_headers={'X-Test-Run': run_id})
                            page = context.new_page()
                            page.set_default_timeout(remaining())
                            errors, network = [], []
                            page.on('pageerror', lambda e: errors.append('pageerror: '+str(e)))
                            page.on('console', lambda m: errors.append('console: '+m.text) if m.type == 'error' else None)
                            page.on('requestfailed', lambda r: errors.append('requestfailed: '+r.url+' '+str(r.failure)))
                            page.on('response', lambda r: network.append((r.url, r.status)))
                            page.goto(f'http://127.0.0.1:{server.server_port}/{FIXTURE_NAME}', timeout=remaining())
                            result = page.evaluate("arg => Promise.race([runOne(arg), new Promise((_, reject) => setTimeout(() => reject(Error('deadline')), %d))])" % remaining(), {'test':case, 'wrongSource':wrong})
                            page.wait_for_timeout(30)
                            with server.lock: requests = list(server.requests[start:])
                            asset_requests = []
                            for request_run, url, status in requests:
                                require(request_run == run_id and status == 200, requests)
                                parsed = urlparse(url)
                                if parsed.path == '/asset':
                                    query = parse_qs(parsed.query)
                                    require(set(query) == {'case', 'path'} and query['case'] == [case] and len(query['path']) == 1, requests)
                                    asset_requests.append(query['path'][0])
                                else:
                                    require(parsed.path == '/' + FIXTURE_NAME or parsed.path.startswith('/static/'), requests)
                            expected_trace = EXPECTED[case]
                            expected_error = 'injected unrelated source error' if wrong else ERRORS[case]
                            require(result['case'] == case and result['actual'] == expected_error, result)
                            require(result['stage'] == ('manifest' if case in MANIFEST_PHASE else 'text'), result)
                            require(result['nativeGzipError'] == (case == 'bad-gzip' and not wrong), result)
                            if case in ('ok', 'complete'):
                                require(result['layer'] == dict(version=1, kind='pdf-text-layer', source_sha256=S, page=1, generation=G, raw_sha256=S, page_identity=S, offset_unit='unicode-codepoint', text='', revision='raw', quality='unreviewed', processing='processed', geometry=dict(width=1,height=1,coordinate_space='normalized-page'), regions=[]), result)
                            if case == 'bad-gzip' and not wrong:
                                require(result['counts']['gzipAttempted'] == 1 and result['counts']['gzipErrorStage'] == 'text', result)
                            require(asset_requests == expected_trace, (requests, expected_trace))
                            served = [(urlparse(url).path, status) for _, url, status in requests]
                            observed = [(urlparse(url).path, status) for url, status in network]
                            require(sorted(served) == sorted(observed), (served, observed))
                            require(not errors, errors)
                            require(all(status == 200 for _, status in network), network)
                            require(all(url.startswith(f'http://127.0.0.1:{server.server_port}/') for url, _ in network), network)
                            completed.append(label)
                            print(name, label, result, flush=True)
                        except Exception as exc:
                            failures.append((name, label, repr(exc)))
                            print('FAIL', name, label, repr(exc), flush=True)
                        finally:
                            if context:
                                try:
                                    context.close()
                                    with server.lock: final_requests = list(server.requests[start:])
                                    if final_requests != requests: failures.append((name, label, 'late requests '+repr(final_requests)))
                                    if errors: failures.append((name, label, 'browser events '+repr(errors)))
                                except Exception as exc: failures.append((name, label, 'cleanup '+repr(exc)))
                except Exception as exc:
                    failures.append((name, 'browser', repr(exc)))
                finally:
                    if browser: browser.close()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
        if thread.is_alive(): failures.append(('server', 'cleanup', 'thread still alive'))
    expected_cases = [*CASES, 'bad-gzip-wrong-source']
    if completed != expected_cases:
        failures.append((args.browser, 'inventory', f'expected {expected_cases!r}, got {completed!r}'))
    print('Failures:', failures, flush=True)
    return bool(failures)

if __name__ == '__main__':
    signal.signal(signal.SIGALRM, hard_deadline)
    signal.alarm(150)
    try:
        sys.exit(main())
    finally:
        signal.alarm(0)
