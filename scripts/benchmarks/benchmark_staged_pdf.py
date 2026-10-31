"""Read-only local Reader A/B against immutable, public proxy sources.

This exercises real candidate Reader controls and only requests source ranges.
Input JSON rows: {id, source, bytes, etag, pages, toc?}. No OCR is produced.
"""
import argparse
import contextlib
import functools
import hashlib
import http.server
import json
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]

@contextlib.contextmanager
def server(root):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self,path):
            if path.startswith('/search/'):
                path=path[len('/search'):]
            return super().translate_path(path)
        def log_message(self,*args):pass
    app=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
    thread=threading.Thread(target=app.serve_forever,daemon=True);thread.start()
    try:yield f'http://127.0.0.1:{app.server_port}'
    finally:app.shutdown();app.server_close();thread.join(timeout=5)

def measure(browser,origin,row):
    context=browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1,service_workers='block')
    page=context.new_page();started=time.monotonic();requests=[];errors=[];warnings=[];mapping={}
    page.add_init_script('''(()=>{window.__firstPaint=null;function tick(){
      const canvas=document.querySelector('.reader-page[data-page="1"] canvas.ready');
      if(canvas && !window.__firstPaint){window.__firstPaint={ms:performance.now(),preview:!!canvas.closest('.reader-pdf-opening'),
        phase:document.documentElement.dataset.readerPhase,status:document.querySelector('#status')?.textContent};return;}
      requestAnimationFrame(tick);}requestAnimationFrame(tick)})()''')
    def request(req):
        if urlsplit(req.url).path!='/api/reader-content':return
        record={'range':req.headers.get('range'),'atMs':round((time.monotonic()-started)*1000,1)}
        requests.append(record);mapping[req]=record
    def response(res):
        rec=mapping.get(res.request)
        if rec is not None:
            h=res.headers;rec.update(status=res.status,etag=h.get('etag'),contentRange=h.get('content-range'))
    page.on('request',request);page.on('response',response)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:warnings.append(m.text[:400]) if m.type in ('warning','error') else None)
    url=origin+'/search/static/reader.html?'+urlencode({'url':row['source'],'ext':'pdf'})
    result={'requests':requests,'warnings':warnings,'errors':errors}
    try:
        page.goto(url,wait_until='domcontentloaded',timeout=60000)
        page.wait_for_function('''()=>!!document.querySelector('.reader-page[data-page="1"] canvas.ready') ||
          document.documentElement.dataset.readerPhase==='failed' ''',timeout=120000)
        if page.locator('html').get_attribute('data-reader-phase') == 'failed':
            raise RuntimeError('reader failed: '+str(page.locator('.reader-error').text_content()))
        result['first']=page.evaluate('()=>window.__firstPaint')
        # The preview may be painted one animation frame before the recording
        # callback runs; capture paint without string eval under real CSP.
        if result['first'] is None:
            page.wait_for_function('()=>window.__firstPaint!==null',timeout=2000)
            result['first']=page.evaluate('()=>window.__firstPaint')
        page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)",timeout=180000)
        if page.locator('html').get_attribute('data-reader-phase') != 'ready':
            raise RuntimeError('reader failed: '+str(page.locator('.reader-error').text_content()))
        result['readyMs']=round((time.monotonic()-started)*1000,1)
        if int(page.locator('#page-number').get_attribute('max'))!=row['pages']:raise ValueError('incorrect validated page count')
        pages={}
        for number in [1,(row['pages']+1)//2,row['pages']]:
            if number>1:
                page.locator('#page-number').fill(str(number));page.locator('#page-number').dispatch_event('change')
            shell=page.locator(f'.reader-page[data-page="{number}"]')
            canvas=shell.locator('canvas.ready');canvas.wait_for(timeout=90000)
            page.wait_for_function('n=>document.querySelector(`.reader-page[data-page="${n}"]`)?.dataset.textReady==="1"',arg=number,timeout=90000)
            text=shell.locator('.reader-pdf-text').text_content() or ''
            pixel=canvas.evaluate('''async c=>({dimensions:[c.width,c.height],hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',
              c.getContext('2d').getImageData(0,0,c.width,c.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('')})''')
            pages[str(number)]={'textSha256':hashlib.sha256(text.encode()).hexdigest(),'textLength':len(text),'pixels':pixel}
        result['pages']=pages
        if row.get('toc'):
            page.wait_for_function('n=>document.querySelectorAll("#toc-list .toc-item").length===n',arg=row['toc'],timeout=90000)
            values=page.locator('#toc-list .toc-item').all_text_contents()
            result['toc']={'count':len(values),'hash':hashlib.sha256(json.dumps(values,ensure_ascii=False).encode()).hexdigest()}
        else:result['toc']=None
        if errors:raise RuntimeError('browser error: '+errors[0])
        invalid=[r for r in requests if r.get('status') is not None and
          (r['status']!=206 or r.get('etag')!=row['etag'] or not (r.get('contentRange') or '').endswith('/'+str(row['bytes'])))]
        if invalid:raise RuntimeError('source validator or range mismatch: '+str(invalid[0]))
        result['requestsBeforeFirst']=sum(r['atMs'] <= result['first']['ms'] for r in requests)
        return result
    except Exception as error:
        result['failure']=str(error)[:600]
        try:result['debug']=page.evaluate('''()=>({phase:document.documentElement.dataset.readerPhase,
          status:document.querySelector('#status')?.textContent,error:document.querySelector('.reader-error')?.textContent,
          diagnostic:window.VoiceOfMLReaderPdfDiagnostics?.snapshot?.()})''')
        except Exception:pass
        raise RuntimeError(json.dumps(result,ensure_ascii=False)) from error
    finally:context.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--sources',type=Path,required=True)
    parser.add_argument('--baseline-root',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--pairs',type=int,default=2);args=parser.parse_args()
    if args.output.exists():raise FileExistsError(args.output)
    rows=json.loads(args.sources.read_text());tracked=['static/reader-resources.js','static/reader.js',
      'static/reader/pdf/reader-pdf-network.mjs','static/reader/pdf/reader-pdf-engine.mjs',
      'static/reader/pdf/reader-pdf-page-window.mjs','static/reader/pdf/pdf-first-page-worker-adapter.mjs',
      'static/reader/pdf/pdf-worker-wrapper.mjs','static/reader/pdf/reader-pdf-search.mjs',
      'static/reader/ui/reader-bookmarks.mjs','static/reader/formats/reader-foliate-format.mjs']
    report={'complete':False,'runs':[],'failures':[],
      'scope':'local original Reader versus local candidate; public ETag-checked source; sampled pages only',
      'candidateSha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in tracked}}
    with server(args.baseline_root) as baseline,server(ROOT) as candidate,sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox']);report['browser']=browser.version
        try:
            for row in rows:
                for i in range(args.pairs):
                    pair={'id':row['id'],'number':i+1,'order':['baseline','candidate'] if i%2==0 else ['candidate','baseline']}
                    for variant in pair['order']:
                        print('START',row['id'],i+1,variant,flush=True)
                        try:pair[variant]=measure(browser,baseline if variant=='baseline' else candidate,row)
                        except Exception as error:
                            report['failures'].append({'id':row['id'],'number':i+1,'variant':variant,'error':str(error)})
                            args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');raise
                        result=pair[variant]
                        print('DONE',row['id'],variant,'first',round(result['first']['ms'],1),'preview',result['first']['preview'],
                              'ready',result['readyMs'],'requests',result['requestsBeforeFirst'],flush=True)
                    pair['pagesEqual']=pair['baseline']['pages']==pair['candidate']['pages']
                    pair['tocEqual']=pair['baseline']['toc']==pair['candidate']['toc']
                    report['runs'].append(pair);args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
                    if not pair['pagesEqual'] or not pair['tocEqual']:raise RuntimeError('page/text/TOC mismatch')
        finally:browser.close()
    report['complete']=True;args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
