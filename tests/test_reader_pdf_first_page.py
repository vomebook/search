"""Native PDF first-paint safety gates using actual pinned PDF.js."""
import contextlib
import functools
import hashlib
import http.server
import io
import os
import shutil
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright
from tests.browser_support import ROOT, SearchHandler, ServerState, local_server

SOURCE = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/first-page-staged.pdf"


def sparse_pdf(count=130, declared=None, stride=71680, nested=False, linked_padding=False, xfa=False, root_at_end=False):
    declared = count if declared is None else declared
    ids = [10 + 3 * index for index in range(count)]
    root, catalog = (5000, 5001) if root_at_end else (2, 1)
    if root_at_end and (nested or xfa):
        raise ValueError('tail fixture is intentionally a simple page tree')
    objects = {
        catalog: b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /XFA [ (template) 5 0 R (datasets) 6 0 R ] >> >>" if xfa
           else f"<< /Type /Catalog /Pages {root} 0 R >>".encode(),
        root: (f'<< /Type /Pages /Count {declared} /Kids [{"10 0 R 4 0 R" if nested else " ".join(f"{n} 0 R" for n in ids)}] >>').encode(),
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    if nested:
        objects[4] = (f'<< /Type /Pages /Parent 2 0 R /Count {declared - 1} /Kids [{" ".join(f"{n} 0 R" for n in ids[1:])}] >>').encode()
    if xfa:
        objects[5]=b"<< /Length 35 >>\nstream\n<template xmlns='http://www.xfa.org'/>\nendstream"
        objects[6]=b"<< /Length 11 >>\nstream\n<datasets/>\nendstream"
    if root_at_end:
        objects[7]=b"<< /Font << /F1 3 0 R >> >>"
    for index, number in enumerate(ids):
        text = f"BT /F1 14 Tf 10 20 Td (Page {index + 1}) Tj ET".encode()
        if linked_padding:
            text += b'\n%' + hashlib.shake_256(str(index).encode()).hexdigest(stride//2).encode() + b'\n'
        parent = 4 if nested and index else root
        resources = "7 0 R" if root_at_end else "<< /Font << /F1 3 0 R >> >>"
        objects[number] = (f"<< /Type /Page /Parent {parent} 0 R /MediaBox [0 0 200 50] "
                           f"/Resources {resources} /Contents {number + 1} 0 R >>").encode()
        objects[number + 1] = f"<< /Length {len(text)} >>\nstream\n".encode() + text + b"\nendstream"
        objects[number + 2] = f"<< /Length {stride} >>\nstream\n".encode() + b"x" * stride + b"\nendstream"
    payload, offsets = bytearray(b"%PDF-1.7\n"), {}
    order = sorted(objects)
    if root_at_end:
        order.remove(ids[0])
        order.insert(0, ids[0])
    for number in order:
        body = objects[number]
        offsets[number] = len(payload)
        payload.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(payload)
    payload.extend(f"xref\n0 {max(objects) + 1}\n0000000000 65535 f \n".encode())
    for number in range(1, max(objects) + 1):
        payload.extend((f"{offsets[number]:010d} 00000 n \n" if number in offsets else "0000000000 00000 f \n").encode())
    payload.extend(f"trailer\n<< /Size {max(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(payload)


def reordered_linearized_pdf():
    # Start from a genuinely linearized PDF, then append a newer page tree whose
    # first two pages are reversed. The old /L no longer equals the file length;
    # the current catalog, not the old first-page hint, must define identity.
    with tempfile.TemporaryDirectory(prefix='reader-linearized-fixture-') as tmp:
        source=Path(tmp)/'source.pdf';linear=Path(tmp)/'linear.pdf'
        source.write_bytes(sparse_pdf(nested=True,linked_padding=True))
        subprocess.run(['qpdf','--linearize','--stream-data=preserve','--preserve-unreferenced',str(source),str(linear)],check=True,capture_output=True)
        pdf=linear.read_bytes()
        objects={}
        from pypdf import PdfReader
        reader=PdfReader(io.BytesIO(pdf))
        refs=[(page.indirect_reference.idnum,page.indirect_reference.generation) for page in reader.pages]
        for number,_generation in refs:
            objects[number]=subprocess.run(['qpdf',f'--show-object={number}',str(linear)],capture_output=True,check=True).stdout.strip()
    root=reader.trailer['/Root'].indirect_reference
    pages=reader.trailer['/Root']['/Pages'].indirect_reference
    catalog=reader.trailer['/Root']
    if set(str(key) for key in catalog.keys())!={'/Type','/Pages'}:
        raise RuntimeError('unexpected linearized fixture catalog')
    order=[refs[1],refs[0],*refs[2:]]
    old=int(re.findall(rb'startxref\s+(\d+)',pdf)[-1]);entries={}
    def append(obj,content):
        nonlocal pdf
        entries[obj]=len(pdf);pdf+=f'\n{obj} 0 obj\n'.encode()+content+b'\nendobj\n'
    append(pages.idnum,(f'<< /Type /Pages /Count {len(order)} /Kids ['+
        ' '.join(f'{number} {generation} R' for number,generation in order)+'] >>').encode())
    for number,generation in refs:
        if generation != 0:raise RuntimeError('unexpected generation in linearized fixture')
        raw=objects[number]
        updated,count=re.subn(rb'/Parent\s+\d+\s+\d+\s+R',f'/Parent {pages.idnum} 0 R'.encode(),raw,count=1)
        if count != 1:raise RuntimeError('missing page parent')
        append(number,updated)
    size=max(int(reader.trailer['/Size']),max(entries)+1)
    # Add a large valid incremental-update comment so the final object graph
    # stays small while exercising the large-file opening path.
    padding=b'\n%'+b'P'*(9*1024*1024)+b'\n'
    pdf+=padding
    pdf+=b'\n';xref=len(pdf);pdf+=b'xref\n'
    for number,offset in sorted(entries.items()):pdf+=f'{number} 1\n{offset:010d} 00000 n \n'.encode()
    pdf+=(f'trailer\n<< /Size {size} /Root {root.idnum} {root.generation} R /Prev {old} >>\n'
          f'startxref\n{xref}\n%%EOF\n').encode()
    return pdf


@contextlib.contextmanager
def range_source(payload):
    identity = '"' + hashlib.sha256(payload).hexdigest() + '"'
    state = {"block": threading.Event(), "requests": [], "changed": False, "active": 0, "peak": 0, "fail_from": None,
             "block_from": 262144}
    lock = threading.Lock()

    built = Path(os.environ['READER_BUILT_SITE']) if os.environ.get('READER_BUILT_SITE') else None
    project = os.environ.get('READER_BUILT_PROJECT', 'github')

    class Handler(SearchHandler):
        def translate_path(self, path):
            if built:
                if path.startswith('/search/'):
                    path=path[len('/search'):]
                if project == 'hf' and path.startswith('/static/'):
                    path=path[len('/static'):]
                return http.server.SimpleHTTPRequestHandler.translate_path(self,path)
            return super().translate_path(path)

        def do_GET(self):
            if not self.path.startswith("/api/reader-content?"):
                return super().do_GET()
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range", ""))
            if not match:
                self.send_error(400)
                return
            begin, end = int(match[1]), min(int(match[2]), len(payload) - 1)
            if begin > end:
                self.send_error(416)
                return
            with lock:
                state["requests"].append((begin, end))
                state["active"] += 1
                state["peak"] = max(state["peak"],state["active"])
            if begin >= state['block_from'] and end < len(payload) - 524288:
                state["block"].wait(timeout=15)
            with lock:
                etag = '"changed"' if state["changed"] and begin >= 262144 and end < len(payload) - 524288 else identity
                fail = state['fail_from'] is not None and begin >= state['fail_from'] and end < len(payload) - 524288
            body = payload[begin:end + 1]
            try:
                if fail:
                    self.send_error(503)
                    return
                self.send_response(206)
                for key, value in {
                    "Content-Type": "application/pdf", "Content-Length": str(len(body)),
                    "Content-Range": f"bytes {begin}-{end}/{len(payload)}", "ETag": etag,
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Expose-Headers": "Content-Range,ETag,Content-Length",
                }.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with lock: state["active"] -= 1

    Handler.state = ServerState()
    handler = functools.partial(Handler, directory=str(built or ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", state, lock
    finally:
        state["block"].set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class PdfFirstPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = contextlib.ExitStack()
        cls.addClassCleanup(stack.close)
        cls.origin, _ = stack.enter_context(local_server())
        playwright = stack.enter_context(sync_playwright())
        browser = getattr(playwright, os.environ.get("READER_TEST_BROWSER", "chromium"))
        cls.browser = browser.launch(headless=True, args=["--no-sandbox"] if browser == playwright.chromium else [])
        cls.addClassCleanup(cls.browser.close)

    def open(self, page, source):
        page.add_init_script('''(() => {
          const native=fetch, origin=ORIGIN;
          window.fetch=(input,init)=>{const url=String(input);return native(url.includes('/api/reader-content?')
            ? origin+'/api/reader-content?'+url.split('/api/reader-content?')[1] : input,init)};
        })()'''.replace("ORIGIN", repr(source)))
        prefix = "/static" if os.environ.get('READER_BUILT_PROJECT') == 'hf' else "/search/static"
        page.goto(source + prefix + "/reader.html?" + urlencode({"url": SOURCE, "ext": "pdf"}), wait_until="domcontentloaded")

    def test_first_page_reused_and_wrong_count_corrected(self):
        with range_source(sparse_pdf(declared=135)) as (source, state, lock):
            context = self.browser.new_context(viewport={"width":390,"height":844}, service_workers="block")
            self.addCleanup(context.close)
            page = context.new_page(); errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            self.open(page, source)
            opening = page.locator('.reader-page[data-preview-ready="1"]')
            opening.locator("canvas.ready").wait_for(timeout=15000)
            self.assertIn("正在检查文档", page.locator("#status").text_content())
            self.assertEqual(page.locator("#page-total").text_content(), "")
            if page.locator('.page-controls').is_visible():
                self.assertTrue(page.locator('#page-number').is_hidden())
            self.assertTrue(page.locator("#bookmark-ribbon").is_disabled())
            page.wait_for_function("()=>document.querySelector('.reader-pdf-opening .reader-pdf-text')?.textContent.includes('Page 1')")
            page.evaluate('''() => {
              const shell=document.querySelector('.reader-pdf-opening');window.__opening=shell;
              const layer=shell.querySelector('.reader-pdf-text');const range=document.createRange();range.selectNodeContents(layer);
              getSelection().removeAllRanges();getSelection().addRange(range);
            }''')
            self.assertIn("Page 1", page.evaluate("() => getSelection().toString()"))
            with lock:
                self.assertLess(len(state["requests"]), 130)
            state["block"].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
            self.assertEqual(page.locator("#page-number").get_attribute("max"), "130")
            self.assertEqual(page.locator("#status").text_content(), "130 页")
            self.assertFalse(page.locator("#bookmark-ribbon").is_disabled())
            self.assertTrue(page.evaluate("() => window.__opening===document.querySelector('.reader-page[data-page=\"1\"]')"))
            self.assertIn("Page 1", page.evaluate("() => getSelection().toString()"))
            page.locator("#page-number").fill("130");page.locator("#page-number").dispatch_event("change")
            page.locator('.reader-page[data-page="130"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="130"]')?.dataset.textReady==='1' ''')
            self.assertIn("Page 130", page.locator('.reader-page[data-page="130"] .reader-pdf-text').text_content())
            self.assertEqual(errors, [])

    def test_nested_tree_first_page_does_not_wait_for_other_pages(self):
        with range_source(sparse_pdf(nested=True)) as (source, state, lock):
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_timeout(300)
            with lock:
                self.assertLess(len(state["requests"]), 15)
                self.assertGreater(state["active"],1)
                self.assertLessEqual(state["peak"],26)  # 24 demand reads plus initial/tail
            if page.locator('.page-controls').is_visible():
                self.assertTrue(page.locator('#page-number').is_hidden())
            state["block"].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            page.locator('#page-number').fill('130');page.locator('#page-number').dispatch_event('change')
            page.locator('.reader-page[data-page="130"] canvas.ready').wait_for(timeout=15000)

    def test_tail_page_tree_is_staged_but_count_still_recovers(self):
        with range_source(sparse_pdf(declared=135, root_at_end=True)) as (source,state,_lock):
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            if page.locator('.page-controls').is_visible():
                self.assertTrue(page.locator('#page-number').is_hidden())
            self.assertEqual(page.locator('#page-total').text_content(),'')
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            page.locator('#page-number').fill('130');page.locator('#page-number').dispatch_event('change')
            page.locator('.reader-page[data-page="130"] canvas.ready').wait_for(timeout=15000)

    def test_understated_page_count_is_rebuilt_before_navigation(self):
        with range_source(sparse_pdf(declared=2, root_at_end=True)) as (source,state,_lock):
            state['block'].set()
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            page.locator('#page-number').fill('130');page.locator('#page-number').dispatch_event('change')
            page.locator('.reader-page[data-page="130"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="130"]')?.dataset.textReady==='1' ''')
            self.assertIn('Page 130',page.locator('.reader-page[data-page="130"] .reader-pdf-text').text_content())

    def test_sequential_second_page_before_full_validation(self):
        with range_source(sparse_pdf()) as (source,state,_lock):
            state['block_from'] = 1024*1024
            context=self.browser.new_context(viewport={'width':390,'height':844},service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_function("()=>document.querySelector('#page-number')?.hidden",timeout=15000)
            self.assertIn('正在检查文档',page.locator('#status').text_content())
            self.assertTrue(page.locator('#page-number').is_hidden())
            page.locator('#page-next').click()
            shell=page.locator('.reader-page[data-page="2"]')
            shell.locator('canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="2"]')?.dataset.textReady==='1' ''')
            self.assertIn('Page 2',shell.locator('.reader-pdf-text').text_content())
            self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'),'ready')
            self.assertTrue(page.locator('#bookmark-ribbon').is_disabled())
            before=shell.evaluate('node=>node.getBoundingClientRect().top')
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            self.assertAlmostEqual(before,shell.evaluate('node=>node.getBoundingClientRect().top'),delta=4)
            self.assertEqual(page.locator('#page-number').input_value(),'2')

    def test_scroll_to_second_page_before_full_validation(self):
        with range_source(sparse_pdf()) as (source,state,_lock):
            state['block_from']=1024*1024
            context=self.browser.new_context(viewport={'width':390,'height':250},service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=15000)
            shell=page.locator('.reader-page[data-page="2"]')
            shell.wait_for(timeout=15000)
            shell.scroll_into_view_if_needed()
            shell.locator('canvas.ready').wait_for(timeout=15000)
            self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'),'ready')
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            self.assertEqual(page.locator('#page-number').input_value(),'2')

    def test_pending_second_page_survives_validation_handoff(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source module is bundled in a built artifact')
        with range_source(sparse_pdf()) as (source,state,_lock):
            state['block_from']=1024*1024
            context=self.browser.new_context(viewport={'width':390,'height':844},service_workers='block');self.addCleanup(context.close)
            page=context.new_page()
            def delay(route):
                script=route.fetch().text()
                needle='function renderPdfShell(shell, force = false, priority = false) {'
                self.assertIn(needle,script)
                script=script.replace(needle,needle+'''\n    if (shell.dataset.page === "2" && !shell.dataset.testDelayed) {
                  shell.dataset.testDelayed="1"; return new Promise(resolve=>setTimeout(resolve,2500)).then(()=>renderPdfShell(shell,force,priority));
                }''')
                route.fulfill(content_type='text/javascript',body=script)
            page.route('**/static/reader/pdf/reader-pdf-renderer.mjs*',delay)
            self.open(page,source)
            page.wait_for_function("()=>document.querySelector('#page-number')?.hidden",timeout=15000)
            page.locator('#page-next').click();state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            page.locator('.reader-page[data-page="2"] canvas.ready').wait_for(timeout=15000)
            self.assertEqual(page.locator('#page-number').input_value(),'2')

    def test_closing_during_prefix_does_not_write_unverified_progress(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source store URL is content-addressed in a built artifact')
        with range_source(sparse_pdf()) as (source,state,_lock):
            state['block_from']=1024*1024
            context=self.browser.new_context(viewport={'width':390,'height':844},service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.wait_for_function("()=>document.querySelector('#page-number')?.hidden",timeout=15000)
            page.locator('#page-next').click()
            page.locator('.reader-page[data-page="2"] canvas.ready').wait_for(timeout=15000)
            page.evaluate('''()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))''')
            entry=page.evaluate('async source=>await VoiceOfMLReaderStore.get(source)',SOURCE)
            self.assertIsNone(entry)

    def test_full_text_search_waits_for_verified_count(self):
        with range_source(sparse_pdf()) as (source,state,_lock):
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            page.locator('#history').click();page.locator('#full-search-toggle').click()
            page.locator('#full-search-input').fill('Page 130')
            page.wait_for_function("()=>document.querySelector('#full-search-status')?.textContent.includes('正在检查文档')",timeout=5000)
            self.assertNotIn('0 个结果',page.locator('#full-search-status').text_content())
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            page.wait_for_function("()=>document.querySelector('#full-search-status')?.textContent.includes('个结果')",timeout=30000)
            self.assertIn('1 个结果',page.locator('#full-search-status').text_content())

    def test_progress_panel_cannot_add_bookmark_during_validation(self):
        with range_source(sparse_pdf()) as (source,state,_lock):
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            page.locator('#history').click()
            page.locator('.reader-progress-bookmark').click()
            self.assertTrue(page.locator('#bookmark-popover').is_hidden())
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            page.locator('.reader-progress-bookmark').click()
            self.assertTrue(page.locator('#bookmark-popover').is_visible())

    @unittest.skipUnless(shutil.which('qpdf'), 'qpdf is required to build an incremental linearized fixture')
    def test_incremental_linearized_preview_uses_current_first_page(self):
        payload=reordered_linearized_pdf()
        with range_source(payload) as (source,state,_lock):
            state['block'].set()
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page()
            page.add_init_script('''(()=>{window.__previewText=null;const run=()=>{
              const s=document.querySelector('.reader-pdf-opening .reader-pdf-text');
              if(s&&s.textContent.includes('Page')){window.__previewText=s.textContent;return;} requestAnimationFrame(run)};
              requestAnimationFrame(run)})()''')
            self.open(page,source)
            try:
                page.wait_for_function('()=>window.__previewText!==null',timeout=15000)
            except Exception as error:
                self.fail(str({'error':str(error),'status':page.locator('#status').text_content(),
                    'phase':page.locator('html').get_attribute('data-reader-phase'),
                    'readerError':page.locator('.reader-error').all_text_contents(), 'requests':state['requests'][:20]}))
            self.assertIn('Page 2',page.evaluate('()=>window.__previewText'))
            self.assertNotIn('Page 1',page.evaluate('()=>window.__previewText'))
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=90000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            self.assertIn('Page 2',page.locator('.reader-page[data-page="1"] .reader-pdf-text').text_content())
            page.locator('#page-number').fill('2');page.locator('#page-number').dispatch_event('change')
            page.locator('.reader-page[data-page="2"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="2"]')?.dataset.textReady==='1' ''')
            self.assertIn('Page 1',page.locator('.reader-page[data-page="2"] .reader-pdf-text').text_content())

    def test_changed_source_after_preview_fails_closed(self):
        with range_source(sparse_pdf()) as (source, state, lock):
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            with lock: state["changed"] = True
            state["block"].set()
            page.locator("#reader-engine-retry").wait_for(timeout=20000)
            self.assertEqual(page.locator("#status").text_content(), "无法打开")
            self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
            self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_PDF_TRANSPORT")

    def test_failure_in_parallel_validation_never_publishes_page_count(self):
        with range_source(sparse_pdf(nested=True)) as (source,state,lock):
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            with lock: state['fail_from']=7*1024*1024
            state['block'].set()
            page.locator('#reader-engine-retry').wait_for(timeout=20000)
            self.assertEqual(page.locator('#status').text_content(),'无法打开')
            self.assertEqual(page.locator('#content').get_attribute('data-error-code'),'READER_PDF_TRANSPORT')
            self.assertEqual(page.locator('.reader-page').count(),0)

    def test_close_aborts_queued_validation_reads(self):
        with range_source(sparse_pdf()) as (source, state, lock):
            context=self.browser.new_context(service_workers="block");page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_timeout(150);context.close()
            with lock: at_close=len(state["requests"])
            time.sleep(.3)
            with lock: self.assertEqual(len(state["requests"]),at_close)

    def test_history_page_restores_after_full_validation(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source store URL is content-addressed in a built artifact')
        with range_source(sparse_pdf()) as (source, state, _lock):
            state["block"].set()
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();page.goto(source+"/search/static/manifest.json")
            page.add_script_tag(url=source+"/search/static/reader/core/reader-store.js")
            page.evaluate('''async source => {await VoiceOfMLReaderStore.clearHistory();
              await VoiceOfMLReaderStore.put({url:source,page:50,zoom:100});}''',SOURCE)
            self.open(page,source)
            page.locator('.reader-page[data-page="50"] canvas.ready').wait_for(timeout=30000)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
            self.assertEqual(page.locator('#page-number').input_value(),'50')
            self.assertEqual(page.locator('.reader-pdf-opening').count(),0)

    def test_changed_source_keeps_existing_deep_history(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source store URL is content-addressed in a built artifact')
        with range_source(sparse_pdf(root_at_end=True)) as (source,state,lock):
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();page.goto(source+'/search/static/manifest.json')
            page.add_script_tag(url=source+'/search/static/reader/core/reader-store.js')
            page.evaluate('''async source=>{await VoiceOfMLReaderStore.clearHistory();
              await VoiceOfMLReaderStore.put({url:source,page:50,pageCount:130,zoom:100});}''',SOURCE)
            self.open(page,source)
            page.wait_for_function("()=>document.querySelector('#status')?.textContent.includes('检查')",timeout=15000)
            with lock: state['changed']=True
            state['block'].set()
            page.locator('#reader-engine-retry').wait_for(timeout=30000)
            entry=page.evaluate('async source=>await VoiceOfMLReaderStore.get(source)',SOURCE)
            self.assertEqual(entry['page'],50)
            self.assertEqual(entry['pageCount'],130)

    def test_reopening_saved_page_one_keeps_early_navigation(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source store URL is content-addressed in a built artifact')
        with range_source(sparse_pdf()) as (source,state,_lock):
            state['block_from']=1024*1024
            context=self.browser.new_context(viewport={'width':390,'height':844},service_workers='block');self.addCleanup(context.close)
            page=context.new_page();page.goto(source+'/search/static/manifest.json')
            page.add_script_tag(url=source+'/search/static/reader/core/reader-store.js')
            page.evaluate('''async source=>{await VoiceOfMLReaderStore.clearHistory();
              await VoiceOfMLReaderStore.put({url:source,page:1,pageOffset:0,pageCount:130,zoom:100});}''',SOURCE)
            self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=15000)
            page.locator('#page-next').wait_for(state='visible',timeout=15000)
            page.locator('#page-next').click()
            page.locator('.reader-page[data-page="2"] canvas.ready').wait_for(timeout=15000)
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').input_value(),'2')

    def test_preview_page_recreated_after_virtual_window_eviction(self):
        with range_source(sparse_pdf(count=300,stride=32768)) as (source,state,_lock):
            state['block_from']=1024*1024
            context=self.browser.new_context(viewport={'width':390,'height':844},service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.wait_for_function("()=>document.querySelector('#page-number')?.hidden",timeout=15000)
            page.locator('#page-next').click()
            shell=page.locator('.reader-page[data-page="2"]');shell.locator('canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="2"]')?.dataset.textReady==='1' ''')
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            page.locator('#page-number').fill('299');page.locator('#page-number').dispatch_event('change')
            page.locator('.reader-page[data-page="299"] canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>!document.querySelector('.reader-page[data-page="2"]')''',timeout=15000)
            page.locator('#page-number').fill('2');page.locator('#page-number').dispatch_event('change')
            shell=page.locator('.reader-page[data-page="2"]');shell.locator('canvas.ready').wait_for(timeout=15000)
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="2"]')?.dataset.textReady==='1' ''')
            self.assertIn('Page 2',shell.locator('.reader-pdf-text').text_content())

    def test_stalled_second_prefix_does_not_prevent_validation(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source module is bundled in a built artifact')
        with range_source(sparse_pdf()) as (source,state,_lock):
            state['block_from']=1024*1024
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page()
            def stall(route):
                script=route.fetch().text()
                needle='pdf._transport.messageHandler.sendWithPromise("ReaderGetPagePrefix", {limit:2})'
                self.assertIn(needle,script)
                route.fulfill(content_type='text/javascript',body=script.replace(needle,'new Promise(()=>{})'))
            page.route('**/static/reader/pdf/reader-pdf-page-window.mjs*',stall)
            self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=15000)
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')

    def test_cyclic_tree_never_commits_count(self):
        payload=sparse_pdf(root_at_end=True)
        needle=b'/Kids [10 0 R 13 0 R'
        self.assertIn(needle,payload)
        payload=payload.replace(needle,b'/Kids [10 0 R 10 0 R',1)
        with range_source(payload) as (source,state,_lock):
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.wait_for_function("()=>document.querySelector('#status')?.textContent.includes('检查') || document.documentElement.dataset.readerPhase==='failed'",timeout=15000)
            state['block'].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='failed'",timeout=30000)
            self.assertEqual(page.locator('html').get_attribute('data-reader-phase'),'failed')
            self.assertNotEqual(page.locator('#page-number').get_attribute('max'),'130')

    def test_unknown_or_missing_child_never_commits_count(self):
        payload=sparse_pdf(root_at_end=True)
        needle=b'/Kids [10 0 R 13 0 R'
        self.assertIn(needle,payload)
        payload=payload.replace(needle,b'/Kids [10 0 R 03 0 R',1)
        with range_source(payload) as (source,state,_lock):
            state['block'].set()
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='failed'",timeout=30000)
            self.assertNotEqual(page.locator('#page-number').get_attribute('max'),'130')

    def test_understated_nested_tree_deep_history_rebuilds_order(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source store URL is content-addressed in a built artifact')
        payload=sparse_pdf(nested=True,declared=2)
        with range_source(payload) as (source,state,_lock):
            state['block'].set()
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();page.goto(source+'/search/static/manifest.json')
            page.add_script_tag(url=source+'/search/static/reader/core/reader-store.js')
            page.evaluate('''async source=>{await VoiceOfMLReaderStore.clearHistory();
              await VoiceOfMLReaderStore.put({url:source,page:50,pageCount:130,zoom:100});}''',SOURCE)
            page.route('**/static/reader/pdf/reader-pdf-network.mjs*',lambda route:route.fulfill(
                content_type='text/javascript',body=(ROOT/'static/reader/pdf/reader-pdf-network.mjs').read_text().replace(
                  'if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(total) || total < 8 * 1024 * 1024) return false;',
                  'if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(total) || total < 8 * 1024 * 1024) return false; return true;')))
            self.open(page,source)
            page.locator('.reader-page[data-page="50"] canvas.ready').wait_for(timeout=30000)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            self.assertEqual(page.locator('#page-number').input_value(),'50')
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="50"]')?.dataset.textReady==='1' ''')
            self.assertIn('Page 50',page.locator('.reader-page[data-page="50"] .reader-pdf-text').text_content())

    def test_hung_history_does_not_start_untrusted_preview(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source store URL is content-addressed in a built artifact')
        with range_source(sparse_pdf()) as (source,state,_lock):
            state["block"].set()
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page()
            page.route('**/static/reader/core/reader-store.js',lambda route:route.fulfill(content_type='text/javascript',body='''
              window.VoiceOfMLReaderStore={get:()=>new Promise(()=>{}),put:async()=>{},list:async()=>[],
                listBookmarks:async()=>[],listAllBookmarks:async()=>[],removeBookmark:async()=>{}};
            '''))
            self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=15000)
            self.assertEqual(page.locator('.reader-pdf-opening').count(),0)
            self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'),'ready')

    def test_scroll_is_preserved_when_preview_becomes_full_reader(self):
        with range_source(sparse_pdf()) as (source,state,_lock):
            context=self.browser.new_context(viewport={"width":390,"height":250},service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            page.evaluate('''()=>{const v=document.querySelector('#viewport');v.style.maxHeight='80px';v.scrollTop=v.scrollHeight;}''')
            before=page.locator('#viewport').evaluate('node=>node.scrollTop')
            self.assertGreater(before,0)
            state["block"].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            self.assertAlmostEqual(before,page.locator('#viewport').evaluate('node=>node.scrollTop'),delta=3)

    def test_ordinary_pdf_does_not_start_staged_worker(self):
        with range_source(sparse_pdf(count=20,stride=32768)) as (source,state,_lock):
            state["block"].set()
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();worker_sources=[]
            page.on('request',lambda req:worker_sources.append(req.url) if '/pdf.worker.07ceb740d746.mjs' in req.url else None)
            self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'20')
            self.assertEqual(page.locator('.reader-pdf-opening').count(),0)
            self.assertEqual(worker_sources,[])

    def test_xfa_document_does_not_show_unvalidated_preview(self):
        with range_source(sparse_pdf(xfa=True)) as (source,state,_lock):
            state['block'].set()
            context=self.browser.new_context(service_workers='block');self.addCleanup(context.close)
            page=context.new_page();seen=[]
            page.add_init_script('''(()=>{new MutationObserver(()=>{if(document.querySelector('.reader-pdf-opening'))
              document.documentElement.dataset.sawPreview='1';}).observe(document,{childList:true,subtree:true})})()''')
            page.on('request',lambda req:seen.append(req.url) if 'pdf-worker-wrapper' in req.url else None)
            self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
            self.assertEqual(page.locator('.reader-pdf-opening').count(),0)
            self.assertNotEqual(page.locator('html').get_attribute('data-saw-preview'),'1')
            self.assertTrue(any('reader-first-page=1' in url for url in seen))
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')

    def test_zoom_during_validation(self):
        with range_source(sparse_pdf()) as (source,state,_lock):
            context=self.browser.new_context(viewport={"width":390,"height":844},service_workers="block");self.addCleanup(context.close)
            page=context.new_page();self.open(page,source)
            page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
            before=page.locator('.reader-page[data-page="1"] canvas.ready').evaluate('node=>node.width')
            page.locator('#zoom').fill('150');page.locator('#zoom').dispatch_event('change')
            page.wait_for_function('width=>document.querySelector(\'.reader-page[data-page="1"] canvas.ready\')?.width>width',arg=before,timeout=5000)
            state["block"].set()
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=30000)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=15000)
            self.assertEqual(page.locator('#zoom').input_value(),'150')
            page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="1"]')?.dataset.textReady==='1' ''')
            self.assertIn('Page 1',page.locator('.reader-page[data-page="1"] .reader-pdf-text').text_content())

    def test_initial_candidate_failure_reopens_with_stock_worker(self):
        if os.environ.get('READER_BUILT_SITE'): self.skipTest('source module is bundled in a built artifact')
        with range_source(sparse_pdf()) as (source,state,_lock):
            state["block"].set()
            context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
            page=context.new_page();attempts=[]
            def fail_once(route):
                response=route.fetch();script=response.text()
                needle='return readerContext.measurePdf(readerContext.loadPdfWithTimeout(pdfjs, options, target, proxyUrl, takeInitial), "document")'
                self.assertIn(needle,script)
                script=script.replace(needle,'''return readerContext.measurePdf(stagedWorker
                    ? Promise.reject(new Error("injected staged parser failure"))
                    : readerContext.loadPdfWithTimeout(pdfjs, options, target, proxyUrl, takeInitial), "document")''')
                route.fulfill(response=response,body=script)
            page.route('**/static/reader/pdf/reader-pdf-engine.mjs*',fail_once)
            page.on('request',lambda req:attempts.append(req.url) if 'pdf-worker-wrapper.mjs' in req.url else None)
            self.open(page,source)
            page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
            self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
            self.assertEqual(page.locator('.reader-pdf-opening').count(),0)
            self.assertTrue(any('reader-first-page=1' in url for url in attempts))

    def test_worker_source_unavailable_falls_back_to_stock(self):
        for mode in ("unavailable", "integrity"):
            with self.subTest(mode=mode), range_source(sparse_pdf()) as (source,state,_lock):
                state["block"].set()
                context=self.browser.new_context(service_workers="block");self.addCleanup(context.close)
                page=context.new_page();attempts=[]
                def fail(route):
                    attempts.append(route.request.url)
                    route.fulfill(status=503 if mode == "unavailable" else 200,body="not the pinned worker")
                page.route('**/static/vendor/pdf.worker.07ceb740d746.mjs',fail)
                self.open(page,source)
                page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
                page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
                self.assertEqual(page.locator('#page-number').get_attribute('max'),'130')
                self.assertEqual(page.locator('.reader-pdf-opening').count(),0)
                self.assertEqual(len(attempts),1)
