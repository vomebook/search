"""Trace exact local boundary samples after a WebKit page-closed error.

The fixture only intercepts reviewed local candidate bytes, and the individual
boundary number is printed so an interrupted run is not mistaken for a pass.
"""
import gzip
import html
import json
import os
import re
import subprocess
import time
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlencode, unquote, urlsplit

from lxml import etree
from PIL import Image

from tests import test_chm_local_search_compat_20261105 as compat


class WebkitBoundaryDiagnostic(unittest.TestCase):
    setUpClass = classmethod(compat.LocalChmSearchIntegration.setUpClass.__func__)
    tearDownClass = classmethod(compat.LocalChmSearchIntegration.tearDownClass.__func__)
    setUp = compat.LocalChmSearchIntegration.setUp
    tearDown = compat.LocalChmSearchIntegration.tearDown
    local_only = compat.LocalChmSearchIntegration.local_only
    bucket = compat.LocalChmSearchIntegration.bucket
    open_book = compat.LocalChmSearchIntegration.open_book

    def test_toc_navigation_without_search_bridge_acquisition(self):
        """Control: exercise candidate chapters without loading any search index."""
        self.page.on('crash', lambda _: print(json.dumps({'event': 'page-crash'}), flush=True))
        self.page.on('close', lambda _: print(json.dumps({'event': 'page-close'}), flush=True))
        row = compat.fixture.PROOF['bundles'][2]
        manifest = json.loads((Path(row['local_root']) / 'chapter-manifest.json').read_bytes())
        choices, seen = [], set()
        for index, toc in enumerate(manifest['toc']):
            chapter = toc['chapter']
            if chapter >= 2 and chapter not in seen:
                choices.append((index, chapter))
                seen.add(chapter)
        self.assertGreaterEqual(len(choices), 12)
        requests = []
        self.page.on('request', lambda req: requests.append(req.url))
        source = row['source_root'].split('/')[3]
        path = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/chapter-manifest.json"
        url = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': path})
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({'url': url, 'ext': 'epub-chapters'})
        self.blocked_image_paths = []
        self.shared_tiny_count = 0
        self.kept_image_count = 0
        image_mode = os.environ.get('CHM_IMAGE_CONTROL', '')
        if (os.environ.get('CHM_ABORT_IMAGES') == '1' or image_mode) and os.environ.get('CHM_ANNOTATE_DIMENSIONS') != '1':
            # Test-only control: prevent candidate images from loading. This
            # is not acceptable Reader behavior or an asset deletion.
            self.context.route('**/api/reader-bucket-resource**', self.control_images)
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        if os.environ.get('CHM_FOLIATE_OBSERVER_CONTROL') == '1':
            before = self.page.evaluate('''()=>{
              const n=document.querySelectorAll('.foliate-continuous > article[data-section]').length;
              window.__localObserverQueries=0;
              const original=Document.prototype.querySelectorAll;
              Document.prototype.querySelectorAll=function(selector){
                if(selector==='.foliate-continuous > article[data-section]'){
                  window.__localObserverQueries++; return original.call(this,'__local_absent_tag__');
                }
                return original.call(this,selector);
              };
              return n;
            }''')
            self.assertEqual(before, 0, 'control is not restricted to chapter document')
        for toc_index, chapter in choices[:12]:
            self.assertFalse(any('epub-search-index.json.gz' in request for request in requests))
            if os.environ.get('CHM_TRACE_PROCESSES') == '1':
                proc = subprocess.run(['ps', '-eo', 'pid,ppid,rss,comm'], capture_output=True, text=True, check=True)
                rows = [line.split(None, 3) for line in proc.stdout.splitlines()[1:]]
                rows = [row for row in rows if len(row) == 4 and any(
                    term in row[3].lower() for term in ('webkit', 'webprocess', 'networkprocess', 'minibrowser', 'playwright'))]
                print(json.dumps({'event': 'toc-process', 'chapter': chapter, 'processes': rows}), flush=True)
            print(json.dumps({'event': 'toc-start', 'chapter': chapter, 'toc_index': toc_index}), flush=True)
            if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
                self.page.locator('#history').evaluate('node=>node.click()')
            self.page.locator('#toc-tab').evaluate('node=>node.click()')
            self.page.locator('#toc-list .panel-item-main').nth(toc_index).evaluate('node=>node.click()')
            chapter_article = self.page.locator(f'.reader-epub-chapter[data-chapter="{chapter}"]')
            chapter_article.wait_for(state='attached', timeout=90000)
            if os.environ.get('CHM_ENSURE_IMAGES') == '1':
                # Firefox correctly defers offscreen lazy images. This local
                # control forces the already-preserved URLs to load so that a
                # passing navigation sample is not merely image-free.
                chapter_article.locator('img').evaluate_all("imgs=>imgs.forEach(img=>{img.loading='eager';})")
                self.page.wait_for_function('''chapter=>{
                  const article=document.querySelector(`.reader-epub-chapter[data-chapter="${chapter}"]`);
                  return !!article && [...article.querySelectorAll('img')].every(
                    img=>img.hasAttribute('src')&&img.complete&&img.naturalWidth>0&&img.naturalHeight>0);
                }''', arg=chapter, timeout=30000)
                self.page.wait_for_function('''()=>[...document.querySelectorAll('.reader-epub-chapter img')]
                  .every(img=>img.hasAttribute('src'))''', timeout=30000)
                sample = self.page.locator('.reader-epub-chapter img[src]').first
                sample.wait_for(state='attached', timeout=30000)
                sample.evaluate('''async img=>{
                  img.loading='eager';
                  if(!img.complete || !img.naturalWidth) await new Promise((resolve,reject)=>{
                    img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true});
                  });
                  if(!img.naturalWidth || !img.naturalHeight) throw Error('sample image did not decode');
                }''')
            self.assertEqual(self.errors, [])
            self.assertEqual(self.external, [])
            metrics = self.page.evaluate('''()=>({
              connectedChapters:document.querySelectorAll('.reader-epub-chapter').length,
              connectedImages:document.querySelectorAll('.reader-epub-chapter img').length,
              imagesWithSrc:document.querySelectorAll('.reader-epub-chapter img[src]').length,
              completeImages:[...document.querySelectorAll('.reader-epub-chapter img')].filter(x=>x.complete&&x.naturalWidth>0).length
            })''')
            print(json.dumps({'event': 'toc-pass', 'chapter': chapter, **metrics}), flush=True)
        self.assertFalse(any('epub-search-index.json.gz' in request for request in requests))
        if os.environ.get('CHM_ABORT_IMAGES') == '1':
            self.assertGreater(len(self.blocked_image_paths), 0, 'image-blocking control did not intercept resources')
            print(json.dumps({'event': 'blocked-image-count', 'count': len(self.blocked_image_paths)}), flush=True)
        if image_mode == 'shared-tiny':
            self.assertGreater(self.shared_tiny_count, 0, 'shared-image control did not intercept known tiny GIFs')
            print(json.dumps({'event': 'shared-tiny-count', 'count': self.shared_tiny_count}), flush=True)
        if image_mode == 'correct-mime':
            self.assertGreater(self.shared_tiny_count, 0, 'MIME-correct control did not intercept images')
            print(json.dumps({'event': 'correct-mime-image-count', 'count': self.shared_tiny_count}), flush=True)
        if image_mode == 'delayed-gif':
            self.assertGreater(self.shared_tiny_count, 0, 'delay control did not intercept GIFs')
            print(json.dumps({'event': 'delayed-gif-image-count', 'count': self.shared_tiny_count}), flush=True)
        if image_mode == 'no-image-src':
            self.assertGreater(self.shared_tiny_count, 0, 'test-only image stripping did not intercept XHTML')
            print(json.dumps({'event': 'stripped-image-src-count', 'count': self.shared_tiny_count}), flush=True)
        if image_mode == 'first-image-only':
            self.assertGreater(self.shared_tiny_count, 0, 'first-image-only control did not process images')
            print(json.dumps({'event': 'first-image-kept-count', 'count': self.kept_image_count}), flush=True)
        if os.environ.get('CHM_FOLIATE_OBSERVER_CONTROL') == '1':
            queries = self.page.evaluate('()=>window.__localObserverQueries')
            self.assertGreater(queries, 0, 'control did not affect observer query')
            print(json.dumps({'event': 'foliate-observer-control-count', 'count': queries}), flush=True)

    def control_images(self, route):
        path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
        if os.environ.get('CHM_IMAGE_CONTROL') == 'first-image-only' and path.endswith('.xhtml'):
            row = compat.fixture.PROOF['bundles'][2]
            prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
            if path.startswith(prefix):
                root = Path(row['local_root']).resolve()
                candidate = (root / path[len(prefix):]).resolve()
                if candidate.is_relative_to(root) and candidate.is_file():
                    tree = etree.parse(str(candidate))
                    images = tree.xpath('//*[local-name()="img" and @src]')
                    self.kept_image_count += min(1, len(images))
                    for image in images[1:]:
                        image.attrib.pop('src')
                        self.shared_tiny_count += 1
                    print(json.dumps({'event': 'one-image-per-chapter', 'chapter': candidate.name,
                                      'kept': min(1, len(images)), 'stripped': max(0, len(images)-1)}), flush=True)
                    return route.fulfill(status=200, content_type='application/xhtml+xml',
                                         body=etree.tostring(tree, encoding='utf-8', xml_declaration=True),
                                         headers={'Access-Control-Allow-Origin': '*'})
        if os.environ.get('CHM_IMAGE_CONTROL') == 'no-image-src' and path.endswith('.xhtml'):
            row = compat.fixture.PROOF['bundles'][2]
            prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
            if path.startswith(prefix):
                root = Path(row['local_root']).resolve()
                candidate = (root / path[len(prefix):]).resolve()
                if candidate.is_relative_to(root) and candidate.is_file():
                    tree = etree.parse(str(candidate))
                    for image in tree.xpath('//*[local-name()="img" and @src]'):
                        image.attrib.pop('src')
                        self.shared_tiny_count += 1
                    if self.shared_tiny_count == 1 or self.shared_tiny_count % 25 == 0:
                        print(json.dumps({'event': 'stripped-image-src', 'count': self.shared_tiny_count}), flush=True)
                    return route.fulfill(status=200, content_type='application/xhtml+xml',
                                         body=etree.tostring(tree, encoding='utf-8', xml_declaration=True),
                                         headers={'Access-Control-Allow-Origin': '*'})
        if '/resources/' not in path:
            return self.bucket(route)
        if os.environ.get('CHM_IMAGE_CONTROL') in {'correct-mime', 'first-image-only'}:
            row = compat.fixture.PROOF['bundles'][2]
            prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
            if path.startswith(prefix):
                root = Path(row['local_root']).resolve()
                candidate = (root / path[len(prefix):]).resolve()
                if candidate.is_relative_to(root) and candidate.is_file():
                    mime = {'.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                            '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp'}.get(candidate.suffix.lower())
                    if mime:
                        self.shared_tiny_count += 1
                        if self.shared_tiny_count == 1 or self.shared_tiny_count % 25 == 0:
                            print(json.dumps({'event': 'correct-mime-image', 'count': self.shared_tiny_count}), flush=True)
                        return route.fulfill(status=200, body=candidate.read_bytes(), content_type=mime,
                                             headers={'Access-Control-Allow-Origin': '*'})
        if os.environ.get('CHM_IMAGE_CONTROL') == 'delayed-gif':
            row = compat.fixture.PROOF['bundles'][2]
            prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
            if path.startswith(prefix):
                root = Path(row['local_root']).resolve()
                candidate = (root / path[len(prefix):]).resolve()
                if candidate.is_relative_to(root) and candidate.is_file() and candidate.suffix.lower() == '.gif':
                    self.shared_tiny_count += 1
                    if self.shared_tiny_count == 1 or self.shared_tiny_count % 25 == 0:
                        print(json.dumps({'event': 'delayed-gif-image', 'count': self.shared_tiny_count}), flush=True)
                    time.sleep(0.05)
                    return route.fulfill(status=200, body=candidate.read_bytes(), content_type='image/gif',
                                         headers={'Access-Control-Allow-Origin': '*'})
        if os.environ.get('CHM_ABORT_IMAGES') == '1':
            self.blocked_image_paths.append(route.request.url)
            return route.abort()
        if os.environ.get('CHM_IMAGE_CONTROL') == 'shared-tiny':
            row = compat.fixture.PROOF['bundles'][2]
            prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
            if path.startswith(prefix):
                root = Path(row['local_root']).resolve()
                candidate = (root / unquote(path[len(prefix):])).resolve()
                if candidate.is_relative_to(root) and candidate.is_file():
                    with Image.open(candidate) as image:
                        tiny = image.format == 'GIF' and image.size == (14, 13)
                    if tiny:
                        self.shared_tiny_count += 1
                        if self.shared_tiny_count == 1 or self.shared_tiny_count % 25 == 0:
                            print(json.dumps({'event': 'shared-tiny-image', 'count': self.shared_tiny_count}), flush=True)
                        raw = (root / 'resources/chapter-0002/data-url-image17.gif').read_bytes()
                        return route.fulfill(status=200, body=raw, content_type='image/gif',
                                             headers={'Access-Control-Allow-Origin': '*'})
        return self.bucket(route)

    def test_trace_third_candidate(self):
        self.page.on('crash', lambda _: print(json.dumps({'event': 'page-crash'}), flush=True))
        self.page.on('close', lambda _: print(json.dumps({'event': 'page-close'}), flush=True))
        self.browser.on('disconnected', lambda _: print(json.dumps({'event': 'browser-disconnected'}), flush=True))
        item = compat.fixture.PROOF['bundles'][2]
        candidate = Path(item['local_root'])
        old = compat.fixture.LOCAL / candidate.name
        old_manifest = json.loads((old / 'chapter-manifest.json').read_bytes())
        new_manifest = json.loads((candidate / 'chapter-manifest.json').read_bytes())
        original = json.loads(gzip.decompress((old / old_manifest['search_index']['path']).read_bytes()))['chapters'][1]['text']
        parts = [html.unescape(row['text']) for row in json.loads(
            gzip.decompress((candidate / new_manifest['search_index']['path']).read_bytes()))['chapters'][1:]]
        spans, position, reconstructed = [], 0, ''
        for i, text in enumerate(parts):
            self.assertTrue(text.startswith('Unknown '))
            if i:
                reconstructed += ' '
                position += 1
            part = text if not i else text[len('Unknown '):]
            spans.append((position, position + len(part)))
            reconstructed += part
            position += len(part)
        self.assertEqual(reconstructed, original)
        audit = compat.fixture.AUDIT[2]['boundary_evidence']
        start, end = int(os.environ.get('CHM_BOUNDARY_START', '0')), int(os.environ.get('CHM_BOUNDARY_END', str(len(audit))))
        self.assertTrue(0 <= start < end <= len(audit))
        self.open_book(2)
        trace_processes = os.environ.get('CHM_TRACE_PROCESSES') == '1'
        for i in range(start, end):
            if trace_processes:
                proc = subprocess.run(['ps', '-eo', 'pid,ppid,rss,comm'], capture_output=True, text=True, check=True)
                rows = [line.split(None, 3) for line in proc.stdout.splitlines()[1:]]
                rows = [row for row in rows if len(row) == 4 and any(
                    term in row[3].lower() for term in ('webkit', 'webprocess', 'networkprocess', 'minibrowser', 'playwright'))]
                rows.sort(key=lambda row: int(row[2]), reverse=True)
                print(json.dumps({'event': 'webkit-process-observation', 'index': i,
                                  'processes': rows[:12], 'monotonic': time.monotonic()}), flush=True)
            print(json.dumps({'event': 'boundary-start', 'index': i, 'engine': os.environ.get('CHM_INTEGRATION_BROWSER')}), flush=True)
            case = audit[i]
            if i != start:
                if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
                    self.page.locator('#history').evaluate('node=>node.click()')
                if self.page.locator('#full-search-toggle').get_attribute('aria-expanded') != 'true':
                    self.page.locator('#full-search-toggle').evaluate('node=>node.click()')
            query = ' '.join(case['query'].split())
            matches = list(re.finditer(re.escape(query), original, re.IGNORECASE))
            self.assertEqual(len(matches), case['old_occurrences'])
            edge = spans[case['previous_chapter'] - 2][1]
            chosen = [n for n, match in enumerate(matches) if match.start() < edge and match.end() > edge + 1]
            self.assertEqual(len(chosen), 1)
            self.page.locator('#full-search-input').fill(query)
            self.page.wait_for_function("n=>document.querySelector('#full-search-status').textContent===`${n} 个结果`",
                                        arg=len(matches), timeout=90000)
            self.page.locator('#full-search-results .full-search-result').nth(chosen[0]).evaluate('node=>node.click()')
            self.page.wait_for_function('''pair=>{
              const chapters=[...document.querySelectorAll('.reader-epub-chapter:has(mark.full-search-highlight)')]
                .map(node=>Number(node.dataset.chapter));
              return chapters.length===2 && chapters[0]===pair[0] && chapters[1]===pair[1];
            }''', arg=[case['previous_chapter'], case['next_chapter']], timeout=90000)
            self.assertEqual(self.external, [])
            self.assertEqual(self.errors, [])
            print(json.dumps({'event': 'boundary-pass', 'index': i}), flush=True)
