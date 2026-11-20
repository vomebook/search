"""Shared offline format preparation and progressive text acceptance."""
import unittest
from urllib.parse import urlencode

from tests.reader.browser import test_reader_pdf_followup as support


class ReaderFormatPipelineTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def test_body_consumption_overlaps_delayed_format_engines(self):
        self.page.add_init_script('''(()=>{
          const native=fetch;window.__bodyReads=0;
          window.fetch=(input,init)=>native(input,init).then(response=>{
            if(!String(input).includes('/api/reader-content?'))return response;
            const source=response.body.getReader();
            return new Response(new ReadableStream({async pull(controller){
              __bodyReads++;const part=await source.read();
              if(part.done){source.releaseLock();controller.close();}else controller.enqueue(part.value);
            },cancel(reason){return source.cancel(reason);}} ,{highWaterMark:0}),{status:response.status,headers:response.headers});
          });
        })();''')
        engines={
            'marked':'window.marked={parse:t=>"<h1>Heading</h1><p>"+t+"</p>"};',
            'purify':'window.DOMPurify={addHook(){},removeHook(){},sanitize:(t,o)=>{if(!o?.RETURN_DOM_FRAGMENT)return t;const n=document.createElement("template");n.innerHTML=t;return n.content;}};',
        }
        documents=[('md',b'Markdown body','text/plain'),('html',b'<h1>Heading</h1><p>HTML body</p>','text/html')]
        for ext,body,mime in documents:
            with self.subTest(format=ext):
                held=[]
                def engine(route):held.append(route)
                pattern='**/static/vendor/*.js'
                self.page.route(pattern,engine)
                self.page.route('**/api/reader-content**',lambda route,_request,body=body,mime=mime:route.fulfill(
                    content_type=mime,body=body,headers={'Access-Control-Allow-Origin':'*'}))
                url=f'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/pipeline.{ext}'
                self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=url,ext=ext)),wait_until='domcontentloaded')
                self.page.wait_for_function('()=>window.__bodyReads>1',timeout=1500)
                self.assertTrue(held)
                self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'),'ready')
                self.page.unroute(pattern,engine)
                for route in held:
                    name=next(key for key in engines if '/'+key+'.' in route.request.url)
                    route.fulfill(content_type='text/javascript',body=engines[name])
                self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
                text=(self.page.frame_locator('.html-frame').locator('body').inner_text() if ext=='html' else
                      self.page.locator('#content').inner_text())
                self.assertTrue(text.strip())

    def test_swf_body_finishes_while_ruffle_is_held(self):
        held = []
        self.page.route('**/vendor/ruffle/**/ruffle.js', lambda route: held.append(route))
        self.page.add_init_script('''(()=>{
          const native=fetch;
          window.fetch=(url,init)=>String(url).includes('/api/reader-content?')
            ? Promise.resolve(new Response(new ReadableStream({pull(controller){
                controller.enqueue(Uint8Array.of(70,87,83));
                controller.close();
                window.__swfBodyRead=true;
              }},{highWaterMark:0}))) : native(url,init);
        })();''')
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/pipeline.swf',ext='swf')),wait_until='domcontentloaded')
        self.page.wait_for_function('()=>!!window.__swfBodyRead',timeout=5000)
        self.assertEqual(len(held),1)
        self.assertEqual(self.page.locator('.reader-swf').count(),0)
        held.pop().fulfill(content_type='text/javascript',body='''
          window.RufflePlayer={newest:()=>({createPlayer(){
            const player=document.createElement('div');
            player.ruffle=()=>({load:async({data})=>{window.__swfLoaded=[...data];}});
            return player;
          }})};
        ''')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertEqual(self.page.evaluate('window.__swfLoaded'),[70,87,83])

    def test_swf_engine_failure_cancels_the_body(self):
        held = []
        self.page.route('**/vendor/ruffle/**/ruffle.js', lambda route: held.append(route))
        self.page.add_init_script('''(()=>{
          const native=fetch;
          window.fetch=(url,init)=>String(url).includes('/api/reader-content?')
            ? Promise.resolve(new Response(new ReadableStream({
                start(controller){controller.enqueue(Uint8Array.of(70,87,83));},
                pull(){window.__swfBodyWaiting=true;},
                cancel(){window.__swfBodyCancelled=true;}
              },{highWaterMark:0}))) : native(url,init);
        })();''')
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/stalled.swf',ext='swf')),wait_until='domcontentloaded')
        self.page.wait_for_function('()=>!!window.__swfBodyWaiting',timeout=5000)
        self.assertEqual(len(held),1)
        held.pop().fulfill(status=503,body='unavailable')
        self.page.locator('#reader-engine-retry').wait_for(timeout=3000)
        self.page.wait_for_function('()=>!!window.__swfBodyCancelled')
        self.assertEqual(self.page.locator('.reader-swf').count(),0)

    def test_streaming_text_replaces_loading_feedback_before_response_finishes(self):
        self.page.add_init_script(r'''(()=>{
          const native=fetch;window.fetch=(input,init)=>String(input).includes('/api/reader-content?')
            ?Promise.resolve(new Response(new ReadableStream({start(c){
              c.enqueue(new TextEncoder().encode('Readable text\n'));
              window.__finishText=()=>{c.enqueue(new TextEncoder().encode('Tail text'));c.close();};
            }}),{headers:{'Content-Type':'text/plain'}})):native(input,init);
        })();''')
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/stream.txt',ext='txt')),wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.querySelector('.reader-text')?.textContent==='Readable text\\n'")
        self.assertEqual(self.page.locator('.reader-loading-indicator').count(),0)
        self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'),'ready')
        self.page.evaluate('window.__finishText()')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertEqual(self.page.locator('.reader-text').text_content(),'Readable text\nTail text')

    def test_bomless_chinese_text_is_visible_before_charset_sample_finishes(self):
        self.page.add_init_script(r'''(()=>{
          const native=fetch;window.fetch=(input,init)=>String(input).includes('/api/reader-content?')
            ?Promise.resolve(new Response(new ReadableStream({start(c){
              const encode = text => new TextEncoder().encode(text);
              const bytes = encode('中文首屏😀');
              c.enqueue(bytes.slice(0, -1));
              window.__finishChinese=()=>{c.enqueue(bytes.slice(-1));c.enqueue(encode('后续正文'));c.close();};
            }}),{headers:{'Content-Type':'text/plain'}})):native(input,init);
        })();''')
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/chinese-stream.txt',ext='txt')),wait_until='domcontentloaded')
        self.page.wait_for_function('''()=>{
          const text = document.querySelector('.reader-text');
          return text?.dataset.textPreview === '中文首屏' && getComputedStyle(text,'::before').content.includes('中文首屏');
        }''')
        self.assertEqual(self.page.locator('.reader-text').text_content(),'')
        self.assertEqual(self.page.locator('.reader-loading-indicator').count(),0)
        self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'),'ready')
        self.page.evaluate('window.__finishChinese()')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertEqual(self.page.locator('.reader-text').text_content(),'中文首屏😀后续正文')
        self.assertIsNone(self.page.locator('.reader-text').get_attribute('data-text-preview'))

    def test_engine_failure_cancels_a_stalled_body_without_waiting_for_download(self):
        self.page.add_init_script(r'''(()=>{
          const native=fetch;window.fetch=(input,init)=>String(input).includes('/api/reader-content?')
            ?Promise.resolve(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<h1>Body</h1>'));},
              cancel(){window.__bodyCancelled=true;}}),{headers:{'Content-Type':'text/html'}})):native(input,init);
        })();''')
        self.page.route('**/static/vendor/purify.min.*.js',lambda route:route.fulfill(status=503,body='unavailable'))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/stalled.html',ext='html')),wait_until='domcontentloaded')
        self.page.locator('#reader-engine-retry').wait_for(timeout=1500)
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'),'READER_ENGINE_NETWORK')
        self.page.wait_for_function('()=>!!window.__bodyCancelled')
