"""DjVu original/canvas benchmark; normal, synthetic stall and trace are separate runs."""
import argparse
import contextlib
import functools
import hashlib
import http.server
import json
import re
import statistics
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


@contextlib.contextmanager
def local_server(root, prefix):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            if prefix and path.startswith(prefix+'/'):
                path=path[len(prefix):]
            return super().translate_path(path)
        def log_message(self, *_args):
            pass
        def copyfile(self, source, outputfile):
            try:
                super().copyfile(source, outputfile)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Browser cancellation after Reader disposal.
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)

MARKS = r"""(() => {
  const result = window.__djvuBenchmark = {firstCanvas:null,firstText:null,operations:[]};
  const NativeWorker=window.Worker;
  window.Worker=function(url,options) {
    const worker=new NativeWorker(url,options);
    if (!String(url).includes('reader-djvu-engine-worker')) return worker;
    const active=new Map(), original=worker.postMessage.bind(worker);
    worker.postMessage=(value,...args)=>{
      if (value?.operation && value.operation!=='range-result')
        active.set(value.id,{operation:value.operation,page:value.page||null,start:performance.now()});
      return original(value,...args);
    };
    worker.addEventListener('message',event=>{
      if (event.data?.operation==='range') return;
      const row=active.get(event.data?.id);
      if (!row) return;
      active.delete(event.data.id);
      result.operations.push({...row,end:performance.now(),ok:event.data.ok===true});
    });
    return worker;
  };
  window.Worker.prototype=NativeWorker.prototype;
  function sample() {
    const shell=document.querySelector('.reader-page[data-page="1"]');
    if (result.firstCanvas===null && shell?.querySelector('canvas.ready')) result.firstCanvas=performance.now();
    if (result.firstText===null && shell?.dataset.textReady==='1' && shell.querySelector('.reader-pdf-text')?.textContent.trim())
      result.firstText=performance.now();
    if (result.firstCanvas===null || result.firstText===null) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})()"""


def category(url):
    path = urlsplit(url).path
    if path.endswith('/api/reader-content'):
        return 'source'
    if path.endswith('/api/reader-source-revision'):
        return 'revision'
    if path.endswith('/api/reader-bucket-resource'):
        return 'ocr_resource'
    if '/djvu-rs-reader/' in path and path.endswith('.wasm'):
        return 'decoder_wasm'
    if '/djvu-rs-reader/' in path and path.endswith('.js'):
        return 'decoder_js'
    if '/pages/page-' in path or '/preview/' in path:
        return 'reading_image'
    return 'other'


def measure(browser, reader_url, *, fixture, prefix, mode, stall_ms, target, timeout, trace_path,
            live_proxy=False, ocr_mismatch=False, pinned_revision=None, expected_etag=None, textless=False):
    context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
    page = context.new_page()
    page.set_default_timeout(timeout)
    page.add_init_script(MARKS)
    requests = []
    live_validators = []
    request_rows = {}
    started = None
    event_failures = []

    def on_request(request):
        kind = category(request.url)
        if kind == 'other':
            return
        headers = request.headers
        row = {'kind': kind, 'method': request.method, 'start_ms': round((time.monotonic()-started)*1000, 2),
               'range': headers.get('range'), 'if_range': headers.get('if-range')}
        request_rows[request] = row
        requests.append(row)

    def on_response(response):
        row = request_rows.get(response.request)
        if row is not None:
            row.update(status=response.status, headers_ms=round((time.monotonic()-started)*1000, 2),
                       declared_bytes=response.headers.get('content-length'))

    def on_end(request):
        row = request_rows.get(request)
        if row is not None:
            row['finished_ms'] = round((time.monotonic()-started)*1000, 2)
            try:
                row['encoded_body_bytes'] = request.sizes()['responseBodySize']
            except PlaywrightError:
                row['encoded_body_bytes'] = None

    page.on('request', on_request)
    page.on('response', on_response)
    page.on('requestfinished', on_end)
    def on_failure(request):
        row=request_rows.get(request)
        if row is not None:
            row.update(error=request.failure, finished_ms=round((time.monotonic()-started)*1000, 2))
    page.on('requestfailed', on_failure)
    def snapshot_requests(rows):
        return [{**row, 'if_range':bool(row['if_range'])} for row in rows]
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    state = None
    if fixture:
        from tests.reader_native_fixture import install, separated_pages
        body = separated_pages() if fixture == 'separated' else (
            (ROOT/'tests/fixtures/synthetic-djvu-benchmark.djvu').read_bytes() if fixture == 'long' else None)
        options = {'prefix': prefix, 'ocr': fixture == 'ocr', 'mismatch': ocr_mismatch}
        if body is not None:
            options['body'] = body
        delayed = [False]
        if mode == 'stall':
            def stall(route):
                if not delayed[0] and route.request.method == 'GET':
                    delayed[0] = True
                    time.sleep(stall_ms / 1000)
                state['respond_source'](route)
            options['source_handler'] = stall
        state = install(page, reader_url, **options)
        reader_url = state['url']
    elif mode == 'stall':
        raise ValueError('stall mode is only supported for the offline fixture')
    elif live_proxy:
        from urllib.parse import parse_qs
        selected = parse_qs(urlsplit(reader_url).query).get('id', [])
        if len(selected) != 1:
            raise ValueError('local-vs-live comparison requires an id-only DjVu URL')
        def relay(route):
            remote='https://voiceofml-search.hf.space'+urlsplit(route.request.url).path+'?'+urlsplit(route.request.url).query
            response=route.fetch(url=remote,timeout=timeout)
            if urlsplit(route.request.url).path.endswith('/api/reader-content') and route.request.method=='GET':
                live_validators.append(response.headers.get('etag'))
            route.fulfill(response=response)
        def resolve(route):
            try:
                remote='https://voiceofml-search.hf.space/api/reader-resolve?'+urlsplit(route.request.url).query
                response=route.fetch(url=remote,timeout=timeout)
                metadata=response.json()
                source=metadata.get('url','')
                parsed=urlsplit(source)
                if not response.ok or parsed.scheme!='https' or parsed.hostname not in ('huggingface.co','hf-mirror.com') or metadata.get('extension')!='djvu':
                    raise ValueError('live ID did not resolve to a DjVu dataset source')
                if pinned_revision:
                    if '/resolve/main/' not in source:
                        raise ValueError('live source is not a mutable main link')
                    metadata['url']=source.replace('/resolve/main/',f'/resolve/{pinned_revision}/',1)
                route.fulfill(response=response,json=metadata)
            except Exception as error:
                event_failures.append(str(error))
                route.abort()
        page.route('**/api/reader-resolve?**',resolve)
        page.route('**/api/reader-source-revision?**',relay)
        page.route('**/api/reader-content?**',relay)
    if pinned_revision and fixture:
        from urllib.parse import parse_qsl, urlencode
        parts=urlsplit(reader_url)
        values=parse_qsl(parts.query,keep_blank_values=True)
        values=[(key,value.replace('/resolve/main/',f'/resolve/{pinned_revision}/',1) if key=='url' else value)
                for key,value in values]
        reader_url=parts._replace(query=urlencode(values)).geturl()
    if mode == 'trace':
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
    try:
        started = time.monotonic()
        page.goto(reader_url, wait_until='domcontentloaded', timeout=timeout)
        page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=timeout)
        page.wait_for_function("() => window.__djvuBenchmark?.firstCanvas !== null", timeout=timeout)
        first = page.evaluate("""() => ({at:performance.now(),count:Number(document.querySelector('#page-number').max),
          phase:document.documentElement.dataset.readerPhase,marks:window.__djvuBenchmark,
          canvas:(()=>{const c=document.querySelector('.reader-page[data-page="1"] canvas.ready');return {width:c.width,height:c.height}})(),
          diagnostics:window.VoiceOfMLReaderPdfDiagnostics?.snapshot()})""")
        # Align the DOM's performance clock with the host request clock. This
        # is approximate (the evaluate round trip is not instantaneous).
        cutoff_ms = (time.monotonic()-started)*1000 - first['at'] + first['marks']['firstCanvas']
        source_at_first = snapshot_requests([row for row in requests if row['kind'] == 'source' and row['start_ms'] <= cutoff_ms])
        if first['count'] < target:
            raise RuntimeError(f"target page {target} exceeds {first['count']}")
        jump = page.evaluate("""async ({target,timeout})=>{
          const input=document.querySelector('#page-number'),start=performance.now();
          const before=!!document.querySelector(`.reader-page[data-page="${target}"] canvas.ready`);
          input.value=String(target);input.dispatchEvent(new Event('change',{bubbles:true}));
          return new Promise((resolve,reject)=>{function check(){
            const c=document.querySelector(`.reader-page[data-page="${target}"] canvas.ready`);
            if(c && input.value===String(target)) return resolve({ms:performance.now()-start,readyBefore:before,width:c.width,height:c.height});
            if(performance.now()-start>timeout)return reject(Error('target canvas timeout'));
            requestAnimationFrame(check);
          }check()});
        }""", {'target':target, 'timeout':timeout})
        if not textless:
            page.wait_for_function("n => document.querySelector(`.reader-page[data-page=\"${n}\"]`)?.dataset.textReady === '1'", arg=target, timeout=timeout)
        details = page.evaluate("""n => ({marks:window.__djvuBenchmark,
          text:document.querySelector(`.reader-page[data-page="${n}"] .reader-pdf-text`)?.textContent || '',
          selection:(()=>{const x=document.querySelector(`.reader-page[data-page="${n}"] .reader-pdf-text`);
            if(!x)return '';
            const r=document.createRange();r.selectNodeContents(x);getSelection().removeAllRanges();getSelection().addRange(r);return getSelection().toString()})(),
          diagnostics:window.VoiceOfMLReaderPdfDiagnostics?.snapshot(),
          heap:performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize} : null})""", target)
        if not textless and (not details['text'].strip() or details['selection'].strip() != details['text'].strip()):
            raise RuntimeError(f"target page text is missing or cannot be selected: {details['text']!r} / {details['selection']!r}")
        if fixture == 'ocr':
            expected = f'Page{target}text' if ocr_mismatch else state['texts'][target-1]
            if expected not in details['text']:
                raise RuntimeError('OCR/source text did not match the fixture verification case')
            if ocr_mismatch and state['page_attempts']:
                raise RuntimeError('OCR pages were fetched after a source hash mismatch')
            if not state['source'] or any(row['range'] is not None for row in state['source']):
                raise RuntimeError('OCR fixture must authenticate the complete source')
        canvas_pixels = page.locator(f'.reader-page[data-page="{target}"] canvas.ready').evaluate("""async canvas=>{
          const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
          const digest=await crypto.subtle.digest('SHA-256',pixels);
          return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
        }""")
        if errors or event_failures:
            raise RuntimeError(f'page errors: {errors}; routing errors: {event_failures}')
        if any(row['kind'] == 'reading_image' for row in requests) or page.locator('.reader-page img').count():
            raise RuntimeError('DjVu unexpectedly requested a reading-page image')
        if fixture == 'separated' and not any(row['kind']=='source' and row.get('if_range') for row in requests):
            raise RuntimeError('synthetic jump did not exercise an If-Range request')
        if expected_etag and (not live_validators or any(value != expected_etag for value in live_validators)):
            raise RuntimeError('source ETag differs from the expected benchmark identity')
        result = {'first':first,'source_at_first':source_at_first,'jump':jump,
                'operations':details['marks']['operations'],'target_text_sha256':hashlib.sha256(details['text'].encode()).hexdigest(),
                'target_canvas_sha256':canvas_pixels,
                'target_text_characters':len(details['text']),'diagnostics':details['diagnostics'],
                'js_heap_snapshot':details['heap'],'requests':snapshot_requests(requests),
                'fixture_source_bytes':len(state['raw']) if state else None,
                'live_source_validator_sha256':hashlib.sha256(live_validators[0].encode()).hexdigest()
                  if live_validators and live_validators[0] else None}
        return result
    except Exception as error:
        try:
            phase=page.locator('html').get_attribute('data-reader-phase',timeout=2000)
            text=page.locator('.reader-error').all_text_contents(timeout=2000)
        except Exception:
            phase,text=None,[]
        raise RuntimeError(f'DjVu benchmark failed: {error}; phase={phase}; reader_errors={text}; page_errors={errors}; requests={requests}') from error
    finally:
        if mode == 'trace':
            context.tracing.stop(path=str(trace_path))
        context.close()


def summarize(rows):
    return {key:{'median_ms':round(statistics.median(values),2),'min_ms':round(min(values),2),
                 'max_ms':round(max(values),2),'samples':len(values)}
            for key, values in {'first_canvas':[row['first']['marks']['firstCanvas'] for row in rows],
                                'jump_canvas':[row['jump']['ms'] for row in rows]}.items() if values}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=['normal','stall','trace'],default='normal')
    parser.add_argument('--root',type=Path,default=ROOT,help='Reader checkout under test')
    parser.add_argument('--fixture',choices=['long','separated','small','ocr'],default='long')
    parser.add_argument('--reader-url',help='live URL; omit for isolated offline fixture')
    parser.add_argument('--live-id',help='run local Reader against this live source ID with proxied original requests')
    parser.add_argument('--browser',choices=['chromium','firefox','webkit'],default='chromium')
    parser.add_argument('--iterations',type=int,default=3)
    parser.add_argument('--target',type=int,default=20)
    parser.add_argument('--stall-ms',type=int,default=1500,help='stall only the first synthetic source response')
    parser.add_argument('--timeout-ms',type=int,default=90000)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--trace',type=Path,help='required only in trace mode; never compare its times with normal runs')
    parser.add_argument('--ocr-mismatch',action='store_true',help='use the mismatched OCR source hash fixture')
    parser.add_argument('--source-revision',help='already-pinned 40-hex dataset commit for a local fixture or live-ID run')
    parser.add_argument('--expected-etag',help='strong source ETag required for every local live-proxy range')
    parser.add_argument('--textless',action='store_true',help='allow no embedded text in a non-fixture source')
    args=parser.parse_args()
    if args.iterations<1 or args.target<2 or args.timeout_ms<1000 or args.stall_ms<0:
        parser.error('invalid iteration, target, timeout or stall')
    if (args.mode == 'trace') != bool(args.trace) or (args.mode == 'trace' and args.iterations != 1):
        parser.error('trace mode requires --trace and --iterations 1; other modes cannot use --trace')
    if args.reader_url and args.live_id:
        parser.error('--reader-url and --live-id are mutually exclusive')
    if (args.reader_url or args.live_id) and args.mode == 'stall':
        parser.error('stall mode is for the offline fixture only')
    if args.live_id and not re.fullmatch(r'[a-z0-9]{13}',args.live_id):
        parser.error('live ID must have 13 lowercase alphanumeric characters')
    if args.ocr_mismatch and (args.reader_url or args.live_id or args.fixture != 'ocr'):
        parser.error('--ocr-mismatch requires the offline OCR fixture')
    if args.source_revision and (args.reader_url or not re.fullmatch(r'[0-9a-f]{40}',args.source_revision)):
        parser.error('--source-revision requires a local source and a 40-hex revision')
    if args.expected_etag and (not args.live_id or not re.fullmatch(r'"[^"\r\n]{1,250}"',args.expected_etag)):
        parser.error('--expected-etag requires --live-id and a quoted strong ETag')
    if args.textless and not (args.reader_url or args.live_id):
        parser.error('--textless is for live sources only')
    target_root=args.root.resolve()
    prefix='/search' if '/search/static/' in (target_root/'static/reader.html').read_text() else ''
    import subprocess
    revision=subprocess.run(['git','rev-parse','HEAD'],cwd=target_root,text=True,capture_output=True,check=False)
    dirty=subprocess.run(['git','status','--porcelain=v1','--untracked-files=all'],cwd=target_root,text=True,capture_output=True,check=False)
    report={'started_at':datetime.now(timezone.utc).isoformat(),'mode':args.mode,'browser':args.browser,
            'reader_root':str(target_root),
            'reader_head':revision.stdout.strip() if revision.returncode==0 else None,
            'reader_dirty':bool(dirty.stdout) if dirty.returncode==0 else None,
            'viewport':{'width':390,'height':844},'fixture':None if args.reader_url or args.live_id else args.fixture,
            'cache_policy':'fresh context each run; service workers blocked; live runs use no routed requests' if args.reader_url else
                           'fresh context each run; service workers blocked; local Reader with routed live original requests' if args.live_id else
                           'fresh context each run; service workers blocked; fixture uses routed requests',
            'stall_ms':args.stall_ms if args.mode=='stall' else None,'target':args.target,'runs':[]}
    report['ocr_mismatch']=args.ocr_mismatch
    report['pinned_revision']=bool(args.source_revision)
    report['textless_allowed']=args.textless
    if args.reader_url:
        report['reader_url_sha256']=hashlib.sha256(args.reader_url.encode()).hexdigest()
    if args.live_id:
        report['live_id_sha256']=hashlib.sha256(args.live_id.encode()).hexdigest()
    if not args.reader_url and not args.live_id:
        from tests.reader_native_fixture import RAW, separated_pages
        fixture_bytes = separated_pages() if args.fixture == 'separated' else (
            (ROOT/'tests/fixtures/synthetic-djvu-benchmark.djvu').read_bytes() if args.fixture=='long' else RAW)
        report['fixture_source_sha256']=hashlib.sha256(fixture_bytes).hexdigest()
    def run(origin):
        with sync_playwright() as p:
            browser=getattr(p,args.browser).launch(headless=True)
            report['browser_version']=browser.version
            try:
                for iteration in range(args.iterations):
                    target_url=args.reader_url or (origin+prefix+'/static/reader.html?id='+args.live_id+'&ext=djvu' if args.live_id else origin)
                    report['runs'].append(measure(browser,target_url,
                        fixture=None if args.reader_url or args.live_id else args.fixture,prefix=prefix,mode=args.mode,
                        stall_ms=args.stall_ms,target=args.target,timeout=args.timeout_ms,trace_path=args.trace,
                        live_proxy=bool(args.live_id),ocr_mismatch=args.ocr_mismatch,pinned_revision=args.source_revision,
                        expected_etag=args.expected_etag,textless=args.textless))
                    print(f'{args.mode} {args.browser} {iteration+1}/{args.iterations}: first={report["runs"][-1]["first"]["marks"]["firstCanvas"]:.1f}ms jump={report["runs"][-1]["jump"]["ms"]:.1f}ms',file=sys.stderr)
            finally:
                browser.close()
    if args.reader_url:
        run(None)
    else:
        with local_server(target_root,prefix) as origin: run(origin)
    report['summary']=summarize(report['runs'])
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report['summary'],ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
