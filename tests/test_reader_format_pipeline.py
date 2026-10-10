"""Shared offline format preparation and progressive text acceptance."""
import unittest
from urllib.parse import urlencode

from tests import test_reader_pdf_followup as support
from tests.test_reader_performance import minimal_docx, epub_with_navigation


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
            'purify':'window.DOMPurify={sanitize:t=>t};',
            'jszip':'window.JSZip=function(){};',
            'docx-preview':'window.docx={parseAsync:async()=>({blobToURL:()=>null}),renderDocument:async()=>{const n=document.createElement("p");n.textContent="Document body";return [n];}};'
        }
        documents=[('md',b'Markdown body','text/plain'),('html',b'<h1>Heading</h1><p>HTML body</p>','text/html'),
                   ('docx',minimal_docx(),'application/octet-stream'),('epub',epub_with_navigation(),'application/epub+zip')]
        for ext,body,mime in documents:
            with self.subTest(format=ext):
                held=[]
                def engine(route):held.append(route)
                pattern='**/static/foliate-reader/view.js*' if ext=='epub' else '**/static/vendor/*.js'
                self.page.route(pattern,engine)
                self.page.route('**/api/reader-content**',lambda route,_request,body=body,mime=mime:route.fulfill(
                    content_type=mime,body=body,headers={'Access-Control-Allow-Origin':'*'}))
                url=('https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/'+'a'*64+'/document.docx'
                     if ext=='docx' else f'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/pipeline.{ext}')
                self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=url,ext=ext)),wait_until='domcontentloaded')
                self.page.wait_for_function('()=>window.__bodyReads>1',timeout=1500)
                self.assertTrue(held)
                self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'),'ready')
                self.page.unroute(pattern,engine)
                for route in held:
                    if ext=='epub':route.continue_()
                    else:
                        name=next(key for key in engines if '/'+key+'.' in route.request.url)
                        route.fulfill(content_type='text/javascript',body=engines[name])
                self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
                text=(self.page.frame_locator('.html-frame').locator('body').inner_text() if ext=='html' else
                      self.page.locator('.reader-section-body').first.inner_text() if ext=='epub' else self.page.locator('#content').inner_text())
                self.assertTrue(text.strip())

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
