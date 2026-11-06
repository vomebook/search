"""Isolated image control for the reviewed third CHM candidate.

Loads all 124 original GIF references from candidate chapters 2, 5 and 9 into
a simple loopback page. No Reader, remote network, user profile or candidate
files are modified. Passing does not prove that the real Reader is safe.
"""
import hashlib
import io
import json
import os
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest
from urllib.parse import urlsplit

from lxml import etree
from PIL import Image

from tests import test_chm_local_search_compat_20261105 as compat


class MinimalImageControl(unittest.TestCase):
    setUpClass = classmethod(compat.LocalChmSearchIntegration.setUpClass.__func__)
    tearDownClass = classmethod(compat.LocalChmSearchIntegration.tearDownClass.__func__)
    setUp = compat.LocalChmSearchIntegration.setUp
    tearDown = compat.LocalChmSearchIntegration.tearDown
    local_only = compat.LocalChmSearchIntegration.local_only
    bucket = compat.LocalChmSearchIntegration.bucket

    def test_original_gifs_in_plain_tables(self):
        candidate = Path(compat.fixture.PROOF['bundles'][2]['local_root']).resolve()
        image_paths = []
        for chapter in (2, 5, 9):
            path = candidate / 'chapters' / f'chapter-{chapter:04}.xhtml'
            for image in etree.parse(str(path)).xpath('//*[local-name()="img" and @src]'):
                resource = (path.parent / image.get('src')).resolve()
                self.assertTrue(resource.is_relative_to(candidate / 'resources') and resource.is_file())
                image_paths.append(resource)
        self.assertEqual(len(image_paths), 124)
        payloads = [path.read_bytes() for path in image_paths]
        self.assertEqual({hashlib.sha256(payload).hexdigest() for payload in payloads}, {
            '26d32a822a28d0316fef4d3a04b20d9c9e9e8415bd8cce1cd261394792eaebe2'})
        count = int(os.environ.get('CHM_MINIMAL_IMAGE_COUNT', '124'))
        self.assertTrue(1 <= count <= len(payloads))
        mode = os.environ.get('CHM_MINIMAL_IMAGE_MODE', 'original')
        self.assertIn(mode, {'original', 'png-rgba', 'baseline-gif'})
        content_type = 'image/gif'
        if mode == 'png-rgba':
            # Synthetic comparison only: decode one original and re-encode in
            # memory. Never modify a candidate, and do not treat this as a fix.
            with Image.open(io.BytesIO(payloads[0])) as source:
                converted = io.BytesIO()
                source.convert('RGBA').save(converted, format='PNG')
            payloads = [converted.getvalue()] * len(payloads)
            content_type = 'image/png'
        elif mode == 'baseline-gif':
            converted = io.BytesIO()
            Image.new('RGB', (14, 13), 'white').save(converted, format='GIF')
            payloads = [converted.getvalue()] * len(payloads)
        shared = os.environ.get('CHM_MINIMAL_SHARED_URL') == '1'
        use_http = os.environ.get('CHM_MINIMAL_DIRECT_HTTP') == '1'
        served = []
        self.page.on('crash', lambda _: print(json.dumps({'event': 'minimal-page-crash',
                                                          'served': len(served), 'mode': mode,
                                                          'shared': shared, 'direct_http': use_http,
                                                          'requested_images': count}), flush=True))
        def image(route):
            name = urlsplit(route.request.url).path.rsplit('/', 1)[-1]
            if not name.isdigit() or not 0 <= int(name) < len(payloads):
                return route.fulfill(status=404, body='invalid local image')
            served.append(int(name))
            return route.fulfill(status=200, content_type=content_type, body=payloads[int(name)])
        if use_http:
            # No Playwright request interception in this independent server:
            # the server binds loopback and serves only a fixture page and
            # exact in-memory image bytes.
            class Handler(SimpleHTTPRequestHandler):
                def do_GET(self):
                    name = urlsplit(self.path).path.rsplit('/', 1)[-1]
                    if self.path == '/fixture':
                        content, mime = b'<!doctype html><meta charset="utf-8"><body></body>', 'text/html; charset=utf-8'
                    elif self.path.startswith('/__chm-minimal-image/') and name.isdigit() and 0 <= int(name) < len(payloads):
                        served.append(int(name))
                        content, mime = payloads[int(name)], content_type
                    else:
                        self.send_error(404)
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', mime)
                    self.send_header('Content-Length', str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)

                def log_message(self, *_):
                    pass

            server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(candidate)))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def stop_server():
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            self.addCleanup(stop_server)
            self.context.unroute('**/*', self.local_only)
            self.context.unroute('**/api/reader-bucket-resource**', self.bucket)
            self.page.goto(f'http://127.0.0.1:{server.server_port}/fixture', wait_until='domcontentloaded')
        else:
            self.page.route('**/__chm-minimal-image/*', image)
            self.page.goto(self.origin + '/synthetic-minimal-image-control', wait_until='domcontentloaded')
        self.page.evaluate('''({count,shared})=>{
          document.body.replaceChildren();
          for(let index=0;index<count;index++){
            const table=document.createElement('table'), row=table.insertRow(), cell=row.insertCell();
            const img=document.createElement('img');img.src=`/__chm-minimal-image/${shared ? 0 : index}`;
            img.loading='eager';img.decoding='async';cell.append(img,document.createTextNode(` local image ${index}`));
            document.body.append(table);
          }
        }''', {'count': count, 'shared': shared})
        self.page.wait_for_function('''count=>{
          const imgs=[...document.images];return imgs.length===count&&imgs.every(img=>img.complete&&img.naturalWidth===14&&img.naturalHeight===13);
        }''', arg=count, timeout=60000)
        for index in range(12):
            state = self.page.evaluate('''index=>{
              const images=[...document.images];images[(index*11)%images.length].scrollIntoView();
              return {connected:images.length,decoded:images.filter(img=>img.complete&&img.naturalWidth===14).length};
            }''', index)
            self.assertEqual(state, {'connected': count, 'decoded': count})
        self.assertEqual(set(served), {0} if shared else set(range(count)))
        self.assertEqual(self.errors, [])
        self.assertEqual(self.external, [])
        print(json.dumps({'event': 'minimal-images-pass', 'images': count, 'served': len(served),
                          'mode': mode, 'shared': shared, 'direct_http': use_http, 'navigation_samples': 12,
                          'remote_mutations': 0, 'deployed': False}), flush=True)
