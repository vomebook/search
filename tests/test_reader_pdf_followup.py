"""Explicit offline browser acceptance for PDF demand recovery and disk text reuse."""
import contextlib
import functools
import http.server
import json
import os
import re
from pathlib import Path
import threading
import unittest
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

ROOT = Path(os.environ.get("READER_PDF_FOLLOWUP_ROOT", Path(__file__).resolve().parents[1]))
PREFIX = "/search" if '/search/static/' in (ROOT / 'static/reader.html').read_text() else ""
ENGINE = '''export const GlobalWorkerOptions={};export class PDFWorker{promise=Promise.resolve();destroy(){}}
export function getDocument(options){return {promise:(async()=>{
  const response=await fetch(options.url);const version=await response.text();window.__textCalls={};
  return {numPages:12,getOutline:async()=>null,getPage:async number=>{
    if(number===2&&window.__holdSecond&&!window.__releasedSecond){
      window.__blockedSecond=true;await new Promise(resolve=>{window.__releaseSecond=()=>{window.__releasedSecond=true;resolve();};});}
    return {getViewport:({scale})=>({width:600*scale,height:800*scale}),
      getTextContent:async()=>{__textCalls[number]=(__textCalls[number]||0)+1;
        return {items:[{str:'needle'+version+' page '+number+' 手机 手。机',transform:[12,0,0,12,20,40]}],styles:{}};},
      render:({canvasContext:ctx})=>{ctx.fillStyle='white';ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
        ctx.fillStyle='black';ctx.fillText('PDF '+number,20,40);return {promise:Promise.resolve(),cancel(){}};}};}};
})(),destroy(){}};}'''


class PdfFollowupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = contextlib.ExitStack()
        cls.addClassCleanup(stack.close)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith('/search/'):
                    self.path = self.path[len('/search'):]
                super().do_GET()
            def guess_type(self, path):
                return 'text/javascript' if path.endswith(('.mjs','.js')) else super().guess_type(path)
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        cls.addClassCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(3)))
        cls.origin = f'http://127.0.0.1:{server.server_port}'
        playwright = stack.enter_context(sync_playwright())
        cls.browser = playwright.chromium.launch(headless=True,args=['--no-sandbox'])
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(viewport=dict(width=390,height=844),service_workers='block')
        self.addCleanup(self.context.close)
        self.context.route('**/*',lambda route:route.continue_() if route.request.url.startswith(self.origin+'/') else route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        self.errors = []
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        self.addCleanup(lambda:self.assertEqual(self.errors,[]))
        self.version = 'A'
        self.weak_validator = False
        self.page.route('**/static/vendor/pdf.min.*.mjs',lambda route:route.fulfill(content_type='text/javascript',body=ENGINE))
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='application/pdf',body=self.version,
            headers={'ETag':('W/' if self.weak_validator else '')+'"book-'+self.version+'"','Content-Length':'1','Access-Control-Allow-Origin':'*',
                     'Access-Control-Expose-Headers':'ETag,Content-Length'}))

    def open(self):
        self.page.goto(self.origin+PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/persistent.pdf',ext='pdf')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")

    def search(self, query, total):
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill(query)
        self.page.wait_for_function("total=>document.querySelector('#full-search-status').textContent===total+' 个结果'",arg=total)

    def test_scroll_demand_preempts_a_stalled_offscreen_page(self):
        self.page.add_init_script('window.__holdSecond=true;')
        self.open()
        self.page.wait_for_function('()=>!!window.__blockedSecond')
        self.page.evaluate('''()=>{const s=document.querySelector('.reader-page[data-page="6"]'),v=document.querySelector('#viewport');
          v.scrollTop+=s.getBoundingClientRect().top-v.getBoundingClientRect().top;}''')
        self.page.locator('.reader-page[data-page="6"] canvas.ready').wait_for(state='attached',timeout=1500)
        self.assertFalse(self.page.evaluate('!!window.__releasedSecond'))
        self.page.evaluate('window.__releaseSecond()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator('.reader-page[data-page="2"] canvas.ready').count(),0)
        stages=self.page.evaluate('VoiceOfMLReaderPdfDiagnostics.snapshot().pages.map(r=>r.stage)')
        self.assertIn('queue',stages)
        self.assertIn('draw',stages)

    def test_first_page_loading_replaces_document_indicator_without_moving_paper(self):
        held=ENGINE.replace("return {promise:Promise.resolve(),cancel(){}};",
            "return {promise:new Promise(resolve=>{if(number===1)window.__releaseFirst=resolve;}),cancel(){}};")
        self.page.route('**/static/vendor/pdf.min.*.mjs',lambda route:route.fulfill(content_type='text/javascript',body=held))
        self.page.goto(self.origin+PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/persistent.pdf',ext='pdf')),wait_until='domcontentloaded')
        self.page.wait_for_function('()=>!!window.__releaseFirst')
        self.assertEqual(self.page.locator('.reader-loading-indicator').count(),0)
        shell=self.page.locator('.reader-page[data-page="1"]')
        self.assertTrue(shell.locator('.reader-page-state').is_visible())
        before=shell.bounding_box()
        self.page.evaluate('window.__releaseFirst()')
        shell.locator('canvas.ready').wait_for(state='attached')
        self.assertAlmostEqual(before['y'],shell.bounding_box()['y'],delta=1)

    def test_range_headers_and_first_chunk_are_available_before_end_of_body(self):
        self.page.goto(self.origin+PREFIX+'/static/reader.html?ext=txt')
        result=self.page.evaluate('''async()=>{
          const {createPdfFetchPolicy}=await import('./reader-pdf-network.mjs'),native=fetch;
          let source;globalThis.fetch=async()=>new Response(new ReadableStream({start(c){source=c;c.enqueue(new Uint8Array([1,2]));}}),
            {status:206,headers:{'Content-Range':'bytes 0-3/4',ETag:'"A"'}});
          const policy=createPdfFetchPolicy({idleMs:1000});policy.add(['/stream.pdf']);
          try{
            const response=await Promise.race([fetch('/stream.pdf',{headers:{Range:'bytes=0-3'}}),
              new Promise((_,reject)=>setTimeout(()=>reject(Error('headers withheld until body completes')),150))]);
            const reader=response.body.getReader();const first=await reader.read();
            source.enqueue(new Uint8Array([3,4]));source.close();const second=await reader.read(),end=await reader.read();
            return {first:[...first.value],second:[...second.value],end:end.done};
          }finally{policy.dispose();globalThis.fetch=native;}
        }''')
        self.assertEqual(result,dict(first=[1,2],second=[3,4],end=True))

    def test_initial_and_conditional_fetches_keep_their_existing_header_deadline(self):
        self.page.goto(self.origin+PREFIX+'/static/reader.html?ext=txt')
        result=self.page.evaluate('''async()=>{
          const {createPdfFetchPolicy}=await import('./reader-pdf-network.mjs'),native=fetch;
          let calls=0;globalThis.fetch=async(_url,init)=>{
            calls++;await new Promise(resolve=>setTimeout(resolve,70));init.signal.throwIfAborted();return new Response('complete');};
          const policy=createPdfFetchPolicy({idleMs:15,attemptMs:30});policy.add(['/slow.pdf']);
          try{return {bodies:await Promise.all([fetch('/slow.pdf'),fetch('/slow.pdf',{headers:{Range:'bytes=0-3','If-Range':'"A"'}})])
              .then(rs=>Promise.all(rs.map(r=>r.text()))),calls};}
          finally{policy.dispose();globalThis.fetch=native;}
        }''')
        self.assertEqual(result,dict(bodies=['complete','complete'],calls=2))

    def test_real_pdf_engine_accepts_partial_range_recovery_without_reopening_document(self):
        from tests.test_reader_performance import minimal_pdf
        small=minimal_pdf();xref=small.index(b'xref\n');attachment=b'x'*(4*1024*1024)
        extra=b'6 0 obj\n<< /Length '+str(len(attachment)).encode()+b' >>\nstream\n'+attachment+b'\nendstream\nendobj\n'
        suffix=small[xref:].replace(b'0 6\n',b'0 7\n').replace(b'trailer\n',f'{xref:010d} 00000 n \ntrailer\n'.encode()).replace(b'/Size 6',b'/Size 7')
        suffix=re.sub(rb'startxref\n\d+',b'startxref\n'+str(xref+len(extra)).encode(),suffix)
        packed=small[:xref]+extra+suffix
        self.page.unroute('**/static/vendor/pdf.min.*.mjs')
        self.page.route('**/reader-pdf-network.mjs',lambda route:route.fulfill(content_type='text/javascript',body=
            (ROOT/'static/reader-pdf-network.mjs').read_text().replace('idleMs = 15000','idleMs = 80')))
        prefix=small[:xref]+extra[:extra.index(b'stream\n')+7]
        tail=b'\nendstream\nendobj\n'+suffix
        setup=f'const source=new Uint8Array({len(packed)});source.set({json.dumps(list(prefix))});source.set({json.dumps(list(tail))},{len(packed)-len(tail)});'
        self.page.add_init_script('(()=>{'+setup+'''
          const native=fetch;window.__pdfRequests=[];let held=false;
          window.fetch=async(input,init)=>{
            const url=String(input);if(!url.includes('/api/reader-content?'))return native(input,init);
            const range=new Headers(init?.headers).get('Range');__pdfRequests.push(range);
            const match=/bytes=(\\d+)-(\\d+)/.exec(range||'');
            const start=match?Number(match[1]):0,end=match?Math.min(Number(match[2]),source.length-1):source.length-1;
            const headers={'Content-Type':'application/pdf','Content-Length':String(end-start+1),'Accept-Ranges':'bytes',ETag:'"fixture"'};
            if(match)headers['Content-Range']='bytes '+start+'-'+end+'/'+source.length;
            let body=source.slice(start,end+1);
            if(match&&end===source.length-1&&!held){held=true;
              body=new ReadableStream({start(c){c.enqueue(source.slice(start,start+17));},cancel(){window.__partialCancelled=true;}});}
            const response=new Response(body,{status:match?206:200,headers});
            Object.defineProperty(response,'url',{value:new URL(url,location.href).href});return response;
          };
        })();''')
        self.open()
        self.page.locator('.reader-page canvas.ready').wait_for(state='attached')
        self.assertTrue(self.page.evaluate('!!window.__partialCancelled'))
        self.assertEqual(self.page.evaluate('__pdfRequests.filter(r=>r===null).length'),1)
        self.assertFalse(self.page.locator('.reader-loading-indicator').count())

    def test_complete_search_reuses_disk_text_on_reopen_and_invalidates_version(self):
        self.open()
        self.search('needleA',12)
        self.assertEqual(self.page.evaluate('__textCalls[8]'),1)
        self.page.wait_for_timeout(100)
        self.page.reload()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.search('needleA',12)
        self.assertEqual(self.page.evaluate('__textCalls[8]||0'),0)
        self.page.locator('#full-search-input').fill('手机')
        self.page.wait_for_function("()=>document.querySelector('#full-search-status').textContent==='12 个结果'")
        self.version='B'
        self.page.reload()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.search('needleB',12)
        self.assertEqual(self.page.evaluate('__textCalls[8]'),1)

    def test_optional_cache_module_failure_does_not_block_opening_or_search(self):
        requested=[]
        self.page.route('**/reader-pdf-text-store.mjs',lambda route:(requested.append(route.request.url),route.abort()))
        self.open()
        self.assertEqual(requested,[])
        self.search('needleA',12)
        self.assertEqual(len(requested),1)
        self.assertEqual(self.page.evaluate('__textCalls[8]'),1)

    def test_weak_validator_does_not_reuse_persistent_text(self):
        self.weak_validator = True
        self.open()
        self.search('needleA',12)
        self.page.reload()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.search('needleA',12)
        self.assertEqual(self.page.evaluate('__textCalls[8]'),1)
        self.assertIsNone(self.page.evaluate('VoiceOfMLReaderPdfDiagnostics.snapshot().cache'))

    def test_range_recovery_is_bounded_and_never_mixes_versions(self):
        self.page.goto(self.origin+PREFIX+'/static/reader.html?ext=txt')
        result=self.page.evaluate('''async()=>{
          const {createPdfFetchPolicy}=await import('./reader-pdf-network.mjs');
          const native=fetch,rows=[];
          const headers={'Content-Range':'bytes 0-3/4','ETag':'"A"'};
          async function run(mode){let calls=0,cancels=0;
            globalThis.fetch=async(_url,init)=>{calls++;
              if(mode==='headers'&&calls===1)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason)));
              if(mode==='permanent')return new Response('missing',{status:404});
              if(mode==='temporary'&&calls===1)return new Response('retry',{status:503});
              if(mode==='body'||mode==='changed'||mode==='exhausted'||mode==='cancel'){
                if(calls===1||mode==='exhausted'||mode==='cancel')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},cancel(){cancels++;}}),{status:206,headers});}
              return new Response(new Uint8Array([1,2,3,4]),{status:206,headers:mode==='changed'?{...headers,ETag:'"B"'}:headers});};
            const policy=createPdfFetchPolicy({idleMs:40,attemptMs:200});policy.add(['/fixture.pdf']);
            const controller=new AbortController();
            const task=fetch('/fixture.pdf',{headers:{Range:'bytes=0-3'},signal:controller.signal});
            if(mode==='cancel')setTimeout(()=>controller.abort(),10);
            let bytes,error;
            try{const r=(await task).body.getReader();bytes=[];
              while(true){const part=await r.read();if(part.done)break;bytes.push(...new Uint8Array(part.value.buffer));}
            }catch(e){error=e.message;}
            rows.push({mode,calls,cancels,bytes,error,identity:policy.identity,timings:policy.timings});policy.dispose();}
          try{for(const mode of ['headers','body','temporary','changed','exhausted','cancel','permanent'])await run(mode);return rows;}
          finally{globalThis.fetch=native;}
        }''')
        by_mode={row['mode']:row for row in result}
        for mode in ('headers','body','temporary'):
            self.assertEqual(by_mode[mode]['bytes'],[1,2,3,4])
            self.assertEqual(by_mode[mode]['calls'],2)
        self.assertEqual(by_mode['changed']['error'],'PDF_SOURCE_CHANGED')
        self.assertIsNone(by_mode['changed']['identity'])
        self.assertEqual(by_mode['exhausted']['calls'],2)
        self.assertIn('stalled',by_mode['exhausted']['error'])
        self.assertEqual(by_mode['cancel']['calls'],1)
        self.assertEqual(by_mode['permanent']['calls'],1)
        self.assertGreater(by_mode['body']['cancels'],0)

    def test_disk_store_preserves_unicode_bounds_expiry_and_failure_fallback(self):
        self.page.goto(self.origin+PREFIX+'/static/reader.html?ext=txt')
        result=self.page.evaluate('''async()=>{
          const {createPdfTextStore,pdfTextStoreKey}=await import('./reader-pdf-text-store.mjs');
          const input={source:'https://example.test/book.pdf',version:'"A"',pageCount:12,engine:'engine1'};
          const key=await pdfTextStoreKey(input),other=await pdfTextStoreKey({...input,version:'"B"'});
          let clock=1000000;const options={now:()=>clock,limits:{bytes:600,entries:2,entryBytes:500,ttl:1000}};
          let store=createPdfTextStore(key,options);
          await store.put(1,'手机 🍀');await store.put(2,'');await store.put(3,'手。机');
          const evicted=await store.get(1),empty=await store.get(2),third=await store.get(3);
          const oversized=await store.put(4,'x'.repeat(500));store.dispose();
          store=createPdfTextStore(key,options);const reopened=await store.get(3);
          const different=createPdfTextStore(other,options);const isolated=await different.get(3);different.dispose();
          clock+=1001;const expired=await store.get(3);store.dispose();
          const native=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{throw Error('storage denied');};
          const broken=createPdfTextStore(key,options);let unavailable;
          try{unavailable=await broken.get(3);}finally{broken.dispose();indexedDB.open=native;}
          return {evicted,empty,third,oversized,reopened,isolated,expired,unavailable,keysDiffer:key!==other};
        }''')
        self.assertEqual(result,dict(evicted=None,empty='',third='手。机',oversized=False,reopened='手。机',
                                    isolated=None,expired=None,unavailable=None,keysDiffer=True))
