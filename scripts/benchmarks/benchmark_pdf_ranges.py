"""Compare real PDF.js range traffic without modifying or publishing source PDFs.

Examples:
    python -B scripts/benchmarks/benchmark_pdf_ranges.py \
      --file /path/to/book.pdf --id book --pairs 2 --output /tmp/results.json
    python -B scripts/benchmarks/benchmark_pdf_ranges.py \
      --live-id 2vy7ux94t7pd9 --pairs 1 --output /tmp/live-results.json

The local-server mode uses a supplied immutable PDF and exact 206 responses.
The opt-in live mode opens the real HF Reader/source and modifies only the
Reader's in-memory network module through Playwright routing, never the source.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import http.server
import json
from pathlib import Path
import re
import sys
import threading
import time
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tests.browser_support import local_server
PREFIX = '/search' if '/search/static/' in (ROOT / 'static/reader.html').read_text() else ''
@contextlib.contextmanager
def pdf_server(pdf, *, delay_ms=0):
    stats = {'active': 0, 'peak': 0, 'requests': []}
    lock = threading.Lock()
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def log_message(self, *_args):
            pass

        def do_GET(self):
            if urlsplit(self.path).path != '/api/reader-content':
                return super().do_GET()
            match = re.fullmatch(r'bytes=(\d+)-(\d+)', self.headers.get('Range', ''))
            if not match:
                self.send_error(400, 'range required')
                return
            begin, end = int(match[1]), min(int(match[2]), pdf.stat().st_size - 1)
            if begin > end:
                self.send_error(416)
                return
            with lock:
                stats['active'] += 1
                stats['peak'] = max(stats['peak'], stats['active'])
                stats['requests'].append({'begin': begin, 'end': end, 'bytes': end - begin + 1})
            try:
                if delay_ms:
                    time.sleep(delay_ms / 1000)
                self.send_response(206)
                for key, value in {'Content-Type': 'application/pdf', 'Content-Length': str(end - begin + 1),
                                   'Content-Range': f'bytes {begin}-{end}/{pdf.stat().st_size}',
                                   'ETag': f'"{digest}"', 'Accept-Ranges': 'bytes',
                                   'Access-Control-Allow-Origin': '*',
                                   'Access-Control-Expose-Headers': 'Content-Range,ETag,Content-Length'}.items():
                    self.send_header(key, value)
                self.end_headers()
                with pdf.open('rb') as source:
                    source.seek(begin)
                    self.wfile.write(source.read(end - begin + 1))
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with lock:
                    stats['active'] -= 1

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', stats, lock
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def measure(browser, target, mode, *, local=False, variant='baseline', target_page=50, pdf_origin=None,
            expected_size=None, expected_etag=None, candidate_network=None):
    context = browser.new_context(viewport={'width': 1100, 'height': 800}, service_workers='block',
                                  bypass_csp=local)
    page = context.new_page()
    requests, warnings = [], []
    start = time.monotonic()
    def elapsed():
        return round((time.monotonic() - start) * 1000, 1)
    by_request = {}
    def requested(request):
        if '/api/reader-content?' in request.url:
            row = {'request': request, 'at_ms': elapsed(), 'range': request.headers.get('range'),
                   'response_ms': None}
            requests.append(row)
            by_request[request] = row
    def responded(response):
        row = by_request.get(response.request)
        if row is not None:
            row['response_ms'] = elapsed()
    page.on('request', requested)
    page.on('response', responded)
    page.on('pageerror', lambda error: warnings.append(str(error)))
    # Local source-tree smoke runs may lack optional vendored WASM; page errors
    # remain fatal, while generic HTTP console errors include harmless 404s.
    if local:
        # Warm the pinned local engine exactly as the offline browser suite
        # does, avoiding unrelated CDN/WASM variability in this comparison.
        from tests.test_reader_performance import route_local_vendor_fallback
        route_local_vendor_fallback(page)
    if candidate_network:
        code = candidate_network.read_text(encoding='utf-8')
        if variant == 'baseline':
            code = re.sub(r'^(const PDF_MIN_SPARSE_PAGES = )\d+;', r'\g<1>1000000;', code, count=1, flags=re.M)
            if 'const PDF_MIN_SPARSE_PAGES = 1000000;' not in code:
                raise ValueError('adaptive range threshold cannot be isolated')
        context.route(re.compile(r'.*/static/reader/pdf/reader-pdf-network(?:\.[0-9a-f]{12})?\.mjs(?:\?.*)?$'),
                      lambda route: route.fulfill(body=code, content_type='text/javascript'))
    before = time.monotonic()
    if local:
        # Route inside the page's fetch call so the browser performs the actual
        # requests against the local HTTP server; Playwright cannot rewrite an
        # HTTPS request to HTTP via route.continue_.
        page.add_init_script('''(() => {
          const native = fetch, origin = ORIGIN;
          globalThis.fetch = (input, init) => {
            const url = String(input);
            return native(url.includes('/api/reader-content?')
              ? origin + '/api/reader-content?' + url.split('/api/reader-content?')[1] : input, init);
          };
        })();'''.replace('ORIGIN', json.dumps(pdf_origin)))
        page.goto(target + PREFIX + '/static/reader.html?' + urlencode({
            'url': 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/benchmark.pdf',
            'ext': 'pdf'}), wait_until='domcontentloaded', timeout=120000)
    else:
        page.goto(target, wait_until='domcontentloaded', timeout=120000)
    try:
        page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=180000)
        canvas_ms = elapsed()
        by_canvas = [row for row in requests if row['at_ms'] <= canvas_ms]
        page.locator('#page-number').fill(str(target_page))
        page.locator('#page-number').dispatch_event('change')
        shell = page.locator(f'.reader-page[data-page="{target_page}"]')
        shell.locator('canvas.ready').wait_for(timeout=180000)
        page.wait_for_function('number => document.querySelector(`.reader-page[data-page="${number}"]`)?.dataset.textReady === "1"', arg=target_page, timeout=180000)
        target_canvas_ms = elapsed()
        text = shell.locator('.reader-pdf-text').text_content()
        page.wait_for_timeout(1500)
        responses = []
        for row in requests:
            response = row['request'].response()
            if response:
                headers = response.headers
                responses.append({'at_ms': row['at_ms'], 'response_ms': row['response_ms'],
                                  'range': row['range'], 'status': response.status,
                                  'declared_bytes': int(headers.get('content-length') or 0),
                                  'content_range': headers.get('content-range'), 'etag': headers.get('etag')})
            else:
                responses.append({'at_ms': row['at_ms'], 'range': row['range'], 'status': None})
        if expected_size is not None:
            totals = {int(match.group(1)) for item in responses
                      if (match := re.search(r'/(\d+)$', item.get('content_range') or ''))}
            if totals != {expected_size}:
                raise ValueError('served source size changed while benchmarking')
        if expected_etag is not None:
            etags = {item.get('etag') for item in responses if item.get('status') == 206}
            if etags != {expected_etag}:
                raise ValueError('served source validator changed while benchmarking')
        row = {'variant': variant, 'requested_policy': 'adaptive' if variant == 'candidate' else 'fixed-262144',
               'canvas_ms': canvas_ms,
               'requests_by_canvas': len(by_canvas), 'requests_total': len(requests),
               'responses_206_by_canvas': sum(x.get('response_ms') is not None and x['response_ms'] <= canvas_ms
                                              and x['status'] == 206 for x in responses),
               'declared_bytes_by_canvas': sum(x.get('declared_bytes', 0) for x in responses
                                                if x.get('response_ms') is not None and x['response_ms'] <= canvas_ms
                                                and x['status'] == 206),
               'target_page': target_page, 'target_text_sha256': hashlib.sha256(text.encode()).hexdigest(),
               'target_text_chars': len(text), 'target_canvas_ms': target_canvas_ms,
               'toc_items': page.locator('#toc-list .toc-item').count(), 'warnings': warnings,
               'elapsed_seconds': round(time.monotonic() - before, 2), 'ranges': responses}
        return row
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--file', type=Path)
    group.add_argument('--live-id')
    parser.add_argument('--id', default='local-book')
    parser.add_argument('--pairs', type=int, default=1)
    parser.add_argument('--delay-ms', type=int, default=0)
    parser.add_argument('--expected-size', type=int, help='require this source size on all range responses')
    parser.add_argument('--expected-etag', help='require this exact strong source validator')
    parser.add_argument('--target-page', type=int, default=50)
    parser.add_argument('--candidate-network', type=Path, required=True,
                        help='inject this local network module into the live site, without deployment')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.pairs < 1 or args.pairs > 5 or args.delay_ms < 0:
        parser.error('pairs must be 1-5 and delay-ms must be non-negative')
    if args.file and not args.file.is_file():
        parser.error('input PDF does not exist')
    report = {'kind': 'pdf-range-benchmark', 'started_at': datetime.now(timezone.utc).isoformat(),
              'id': args.live_id or args.id, 'remote_mutations': 0, 'pairs': [], 'complete': False}
    if args.file:
        report['source_sha256'] = hashlib.sha256(args.file.read_bytes()).hexdigest()
        report['source_bytes'] = args.file.stat().st_size
    if args.candidate_network:
        report['candidate_sha256'] = hashlib.sha256(args.candidate_network.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright, contextlib.ExitStack() as stack:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        local_origin = stack.enter_context(local_server())[0] if args.file else None
        try:
            for number in range(args.pairs):
                pair = {'number': number + 1}
                order = ('baseline', 'candidate') if number % 2 == 0 else ('candidate', 'baseline')
                for variant in order:
                    if args.file:
                        with pdf_server(args.file, delay_ms=args.delay_ms) as (origin, stats, lock):
                            # Fixed chunk sizes are injected only for the
                            # comparison. An adaptive candidate replaces only
                            # the isolated browser's network module.
                            def run_local():
                                return measure(browser, local_origin, 'local', local=True, pdf_origin=origin,
                                               variant=variant, target_page=args.target_page,
                                               expected_size=args.expected_size, expected_etag=args.expected_etag,
                                               candidate_network=args.candidate_network)
                            row = run_local()
                            with lock:
                                row['server_peak_active'] = stats['peak']
                    else:
                        url = 'https://voiceofml-search.hf.space/static/reader.html?' + urlencode({
                            'id': args.live_id, 'ext': 'pdf'})
                        row = measure(browser, url, 'live', variant=variant, target_page=args.target_page,
                                      expected_size=args.expected_size,
                                      expected_etag=args.expected_etag, candidate_network=args.candidate_network)
                    if row['warnings']:
                        raise ValueError('browser error during benchmark: ' + row['warnings'][0])
                    if not row['responses_206_by_canvas'] or any(
                            item.get('status') not in (None, 206) for item in row['ranges']):
                        raise ValueError('benchmark did not retain exact range-only reads')
                    if variant == 'baseline' and args.candidate_network:
                        if any(item.get('range') and re.fullmatch(r'bytes=(\d+)-(\d+)', item['range'])
                               and int(re.fullmatch(r'bytes=(\d+)-(\d+)', item['range'])[2]) -
                                   int(re.fullmatch(r'bytes=(\d+)-(\d+)', item['range'])[1]) + 1 == 16384
                               for item in row['ranges']):
                            raise ValueError('baseline unexpectedly used sparse ranges')
                    pair[variant] = row
                    print(json.dumps({k:v for k,v in row.items() if k != 'ranges'}, ensure_ascii=False), flush=True)
                if pair['baseline']['target_text_sha256'] != pair['candidate']['target_text_sha256']:
                    raise ValueError('candidate page text differs from baseline')
                report['pairs'].append(pair)
                args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        finally:
            browser.close()
    report['complete'] = True
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
