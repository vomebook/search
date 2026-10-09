"""Un-routed streaming transport acceptance for actual overlay removal."""
import contextlib
import json
import threading
import time
import unittest
import urllib.parse
from unittest.mock import patch

from tests.test_reader_performance import sync_playwright, PlaywrightError, minimal_pdf
from tests.browser_support import SearchHandler as StaticHandler, local_server


@contextlib.contextmanager
def static_server():
    with local_server() as (origin, _state):
        yield origin


@unittest.skipIf(sync_playwright is None, 'Playwright is unavailable')
class ReaderCloseTrafficTests(unittest.TestCase):
    def test_close_mid_transfer_stops_bytes_and_next_book_opens(self):
        original = StaticHandler.do_GET
        lock = threading.Lock()
        transfers = []
        payload = minimal_pdf() + b'\0' * (8 * 1024 * 1024)
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/closing.pdf'

        def serve(handler):
            path = urllib.parse.urlsplit(handler.path)
            if path.path != '/api/reader-content':
                return original(handler)
            target = urllib.parse.parse_qs(path.query)['url'][0]
            if target.endswith('.txt'):
                body = b'Next book is readable'
                handler.send_response(200)
                handler.send_header('Content-Type', 'text/plain')
                handler.send_header('Content-Length', str(len(body)))
                handler.end_headers()
                handler.wfile.write(body)
                return
            record = {'sent': 0, 'done': False}
            with lock:
                transfers.append(record)
            try:
                handler.send_response(200)
                handler.send_header('Content-Type', 'application/pdf')
                handler.send_header('Content-Length', str(len(payload)))
                handler.send_header('Accept-Ranges', 'bytes')
                handler.end_headers()
                for offset in range(0, len(payload), 4096):
                    handler.wfile.write(payload[offset:offset+4096])
                    handler.wfile.flush()
                    with lock:
                        record['sent'] += 4096
                    time.sleep(.01)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with lock:
                    record['done'] = True

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(StaticHandler, 'do_GET', serve))
            origin = stack.enter_context(static_server())
            playwright = stack.enter_context(sync_playwright())
            try:
                browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
            except PlaywrightError as error:
                raise unittest.SkipTest(str(error))
            stack.callback(browser.close)
            context = browser.new_context(service_workers='block')
            stack.callback(context.close)
            page = context.new_page()
            page.set_default_timeout(10000)
            page.add_init_script('''const nativeFetch=window.fetch;
              window.fetch=(input,init) => {
                const url=new URL(input instanceof Request?input.url:input,location.href);
                return nativeFetch(url.pathname==='/api/reader-content'?location.origin+url.pathname+url.search:input,init);
              };''')
            page.goto(origin+'/search/manifest.json')
            page.add_script_tag(url=origin+'/search/static/reader-navigation.js')
            page.evaluate('''url => {
              window.__navigation = VoiceOfMLReaderNavigation.createNavigation('/search/static/reader.html');
              window.__reader = __navigation.mount(new URL(url));
            }''', origin+'/search/static/reader.html?'+urllib.parse.urlencode(dict(url=source, ext='pdf')))
            deadline = time.monotonic()+10
            while time.monotonic() < deadline:
                with lock:
                    started = any(row['sent'] > 0 for row in transfers)
                if started:
                    break
                page.wait_for_timeout(20)
            self.assertTrue(started)
            result = page.evaluate('''() => {
              let phase;
              __reader.contentWindow.addEventListener('voice-reader-dispose', () => {
                phase=__reader.contentDocument.documentElement.dataset.readerPhase;
              });
              __navigation.unmount();
              return phase;
            }''')
            self.assertEqual(result, 'disposed')
            with lock:
                before = sum(row['sent'] for row in transfers)
                count = len(transfers)
            page.wait_for_timeout(750)
            with lock:
                self.assertTrue(all(row['done'] for row in transfers), transfers)
                self.assertEqual(len(transfers), count)
                self.assertLess(sum(row['sent'] for row in transfers)-before, 65536)
            next_source = source.replace('.pdf', '.txt')
            page.evaluate('url => __navigation.mount(new URL(url))', origin+'/search/static/reader.html?'+urllib.parse.urlencode(dict(url=next_source, ext='txt')))
            frame = page.frame_locator('.reader-overlay')
            frame.locator('html[data-reader-phase="ready"]').wait_for()
            self.assertEqual(frame.locator('.reader-text').inner_text(), 'Next book is readable')

    def test_touch_tap_clears_selection_in_text_pdf_and_isolated_html(self):
        with contextlib.ExitStack() as stack:
            origin = stack.enter_context(static_server())
            playwright = stack.enter_context(sync_playwright())
            browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
            stack.callback(browser.close)
            context = browser.new_context(has_touch=True, is_mobile=True, viewport={'width':390,'height':844})
            stack.callback(context.close)
            page = context.new_page()
            for extension in ('txt', 'html', 'pdf'):
                with self.subTest(extension=extension):
                    body = minimal_pdf() if extension == 'pdf' else b'<p>Selectable book text</p><p style="height:1600px">Other book text</p>'
                    page.route('**/api/reader-content?**', lambda route: route.fulfill(body=body, content_type='application/pdf' if extension == 'pdf' else 'text/html'))
                    source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/touch.'+extension
                    page.goto(origin+'/search/static/reader.html?'+urllib.parse.urlencode(dict(url=source, ext=extension)))
                    page.locator('html[data-reader-phase="ready"]').wait_for()
                    target = page.frame_locator('.html-frame').locator('p').first if extension == 'html' else page.locator('.reader-pdf-text-run' if extension == 'pdf' else '.reader-text').first
                    target.evaluate('''node => {
                      const doc=node.ownerDocument, range=doc.createRange();
                      range.selectNodeContents(node); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
                    }''')
                    self.assertTrue(target.evaluate('node => !!node.ownerDocument.getSelection().toString()'))
                    target.dispatch_event('pointerdown', {'pointerType':'touch','pointerId':41,'isPrimary':True,'clientX':100,'clientY':100})
                    page.wait_for_timeout(350)
                    target.dispatch_event('pointerup', {'pointerType':'touch','pointerId':41,'isPrimary':True,'clientX':100,'clientY':100})
                    self.assertTrue(target.evaluate('node => !!node.ownerDocument.getSelection().toString()'))
                    preserved = target.evaluate('''node => {
                      const doc=node.ownerDocument, selection=doc.getSelection(), output=[];
                      const send = (type, values={}) => node.dispatchEvent(new PointerEvent(type,
                        {bubbles:true, composed:true, pointerType:'touch', pointerId:41, isPrimary:true,
                         clientX:100,clientY:100,...values}));
                      for (const action of ['drag','cancel','changed','secondary']) {
                        const range=doc.createRange();range.selectNodeContents(node);
                        selection.removeAllRanges();selection.addRange(range);
                        send('pointerdown', action==='secondary'?{isPrimary:false}:{});
                        if (action==='drag') send('pointermove',{clientX:120});
                        if (action==='cancel') send('pointercancel');
                        if (action==='changed') selection.setBaseAndExtent(node.firstChild,0,node.firstChild,3);
                        send('pointerup');
                        output.push(!!selection.toString());
                      }
                      const range=doc.createRange();range.selectNodeContents(node);
                      selection.removeAllRanges();selection.addRange(range);
                      return output;
                    }''')
                    self.assertEqual(preserved, [True]*4)
                    box = target.bounding_box()
                    page.touchscreen.tap(min(370, box['x']+box['width']-2), box['y']+min(box['height']-2, 20))
                    self.assertFalse(target.evaluate('node => !!node.ownerDocument.getSelection().toString()'))
                    page.unroute('**/api/reader-content?**')
