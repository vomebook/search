"""Local-only third-candidate search with independently verified image aliases.

The actual chapter/manifest bytes are not modified, and all original resource
objects remain untouched. Per-test browser aliases exist only on loopback.
This is a bounded experiment, never an upload or publication authorization.
"""
import hashlib
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from lxml import etree

from tests import test_chm_local_search_compat_20261105 as compat


EXPECTED = '26d32a822a28d0316fef4d3a04b20d9c9e9e8415bd8cce1cd261394792eaebe2'


class AliasSearchDiagnostic(unittest.TestCase):
    setUpClass = classmethod(compat.LocalChmSearchIntegration.setUpClass.__func__)
    tearDownClass = classmethod(compat.LocalChmSearchIntegration.tearDownClass.__func__)
    setUp = compat.LocalChmSearchIntegration.setUp
    tearDown = compat.LocalChmSearchIntegration.tearDown
    local_only = compat.LocalChmSearchIntegration.local_only
    bucket = compat.LocalChmSearchIntegration.bucket
    open_book = compat.LocalChmSearchIntegration.open_book
    exercise_all_boundaries = compat.LocalChmSearchIntegration.exercise_all_boundaries

    def test_third_candidate_boundaries_with_verified_local_images(self):
        row = compat.fixture.PROOF['bundles'][2]
        root = Path(row['local_root']).resolve()
        image_paths = set()
        # Reuse the exact five chapters already inspected in the preceding
        # local TOC experiment; do not expand to unrelated books/chapters.
        for chapter in (2, 5, 9, 14, 19):
            xhtml = root / 'chapters' / f'chapter-{chapter:04}.xhtml'
            for node in etree.parse(str(xhtml)).xpath('//*[local-name()="img" and @src]'):
                resource = (xhtml.parent / node.get('src')).resolve()
                self.assertTrue(resource.is_relative_to(root / 'resources') and resource.is_file())
                self.assertEqual(hashlib.sha256(resource.read_bytes()).hexdigest(), EXPECTED)
                image_paths.add(resource.relative_to(root).as_posix())
        self.assertEqual(len(image_paths), 181)
        self.verified_aliases = sorted(image_paths)
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        canonical = url('resources/chapter-0002/data-url-image17.gif')
        aliases = {url(path): canonical for path in sorted(image_paths)}
        self.page.add_init_script('window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(' + json.dumps(list(aliases.items())) + ')')
        self.image_requests = []
        failures = []
        crashed = []
        self.page.on('requestfailed', lambda request: failures.append({
            'url': request.url, 'failure': request.failure}))
        self.page.on('crash', lambda _: crashed.append(True))
        def images(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path.startswith(prefix + 'resources/'):
                relative = path[len(prefix):]
                candidate = (root / relative).resolve()
                self.assertTrue(candidate.is_relative_to(root / 'resources') and candidate.is_file())
                self.image_requests.append(relative)
                suffix = candidate.suffix.lower()
                mime = {'.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                        '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp'}.get(suffix)
                if mime:
                    return route.fulfill(status=200, body=candidate.read_bytes(), content_type=mime,
                                         headers={'Access-Control-Allow-Origin': '*'})
            return self.bucket(route)
        self.context.route('**/api/reader-bucket-resource**', images)
        try:
            self.exercise_all_boundaries(2)
            self.assertGreater(len(self.image_requests), 0)
            representative = 'resources/chapter-0002/data-url-image17.gif'
            self.assertIn(representative, self.image_requests)
            self.assertEqual(set(self.image_requests) & (set(image_paths) - {representative}), set())
            sample = self.page.locator('.reader-epub-chapter img[src]').first
            sample.wait_for(state='attached', timeout=30000)
            sample.evaluate('''async img=>{
              img.loading='eager';
              if(!img.complete || !img.naturalWidth) await new Promise((resolve,reject)=>{
                img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true});
              });
              if(!img.naturalWidth || !img.naturalHeight) throw Error('sample image did not decode');
            }''')
            images = self.page.evaluate('''()=>{
              const imgs=[...document.querySelectorAll('.reader-epub-chapter img')];
              return {total:imgs.length,withSrc:imgs.filter(img=>img.hasAttribute('src')).length,
                      decoded:imgs.filter(img=>img.complete&&img.naturalWidth>0).length};
            }''')
            self.assertGreater(images['total'], 0)
            self.assertEqual(images['total'], images['withSrc'])
            self.assertGreater(images['decoded'], 0)
            print(json.dumps({'event': 'local-search-image-sample', **images}), flush=True)
        except Exception:
            try:
                status = self.page.evaluate('''()=>({phase:document.documentElement.dataset.readerPhase,
                  searchStatus:document.querySelector('#full-search-status')?.textContent,
                  visibleChapters:document.querySelectorAll('.reader-epub-chapter').length,
                  marks:document.querySelectorAll('mark.full-search-highlight').length})''')
            except Exception:
                status = {'unavailable': True}
            print(json.dumps({'event': 'local-alias-search-failure', 'status': status, 'crashed': bool(crashed),
                              'request_failures': failures, 'page_errors': self.errors}), flush=True)
            raise
        finally:
            print(json.dumps({'event': 'local-alias-search-diagnostic', 'verified_aliases': len(aliases),
                              'image_requests': len(self.image_requests), 'unique_image_paths': len(set(self.image_requests)),
                              'remote_mutations': 0, 'deployed': False}), flush=True)

    def test_changed_chapter_bytes_are_rejected_before_aliasing(self):
        """A path alone is not proof that the rendered bytes were reviewed."""
        row = compat.fixture.PROOF['bundles'][2]
        root = Path(row['local_root']).resolve()
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        original = url('resources/chapter-0002/data-url-image18.gif')
        canonical = url('resources/chapter-0002/data-url-image17.gif')
        self.assertEqual(hashlib.sha256((root / 'resources/chapter-0002/data-url-image17.gif').read_bytes()).hexdigest(), EXPECTED)
        self.page.add_init_script('window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(' +
                                  json.dumps([[original, canonical]]) + ')')
        malicious = (root / 'chapters/chapter-0001.xhtml').read_text()
        closing = '</html:body>' if '</html:body>' in malicious else '</body>'
        self.assertIn(closing, malicious)
        self.assertNotIn('data-url-image18.gif', malicious)
        malicious = malicious.replace(closing,
            '<html:img src="../resources/chapter-0002/data-url-image18.gif"/>' + closing, 1)
        changed = []
        def altered(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path == prefix + 'chapters/chapter-0001.xhtml':
                changed.append(True)
                return route.fulfill(status=200, content_type='application/xhtml+xml', body=malicious,
                                     headers={'Access-Control-Allow-Origin': '*'})
            return self.bucket(route)
        self.context.route('**/api/reader-bucket-resource**', altered)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': url('chapter-manifest.json'), 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertEqual(self.page.locator('.reader-epub-chapter[data-chapter="1"] img').count(), 0)
        self.assertTrue(changed)
        self.assertEqual(self.external, [])
        print(json.dumps({'event': 'changed-chapter-alias-rejected', 'changed_chapter_served': len(changed),
                          'remote_mutations': 0, 'deployed': False}), flush=True)

    def test_different_representative_bytes_are_rejected(self):
        """The loopback experiment must verify the exact bytes it renders."""
        row = compat.fixture.PROOF['bundles'][2]
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        canonical_path = 'resources/chapter-0002/data-url-image17.gif'
        original = url('resources/chapter-0002/data-url-image18.gif')
        canonical = url(canonical_path)
        self.page.add_init_script('window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(' +
                                  json.dumps([[original, canonical]]) + ')')
        changed = []
        # An in-memory PNG is different from the original reviewed GIF. The
        # MIME is truthful and no file or real resource is changed.
        import io
        from PIL import Image
        data = io.BytesIO()
        Image.new('RGB', (14, 13), 'white').save(data, format='PNG')
        def altered(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path == prefix + canonical_path:
                changed.append(True)
                return route.fulfill(status=200, content_type='image/png', body=data.getvalue(),
                                     headers={'Access-Control-Allow-Origin': '*'})
            return self.bucket(route)
        self.context.route('**/api/reader-bucket-resource**', altered)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': url('chapter-manifest.json'), 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertGreater(len(changed), 0)
        self.assertEqual(self.external, [])
        print(json.dumps({'event': 'changed-representative-rejected', 'changed_responses': len(changed),
                          'remote_mutations': 0, 'deployed': False}), flush=True)

    def test_equal_length_wrong_representative_bytes_are_rejected(self):
        row = compat.fixture.PROOF['bundles'][2]
        root = Path(row['local_root']).resolve()
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        canonical_path = 'resources/chapter-0002/data-url-image17.gif'
        original = bytearray((root / canonical_path).read_bytes())
        self.assertEqual((len(original), hashlib.sha256(original).hexdigest()), (342, EXPECTED))
        original[-1] ^= 1
        self.assertNotEqual(hashlib.sha256(original).hexdigest(), EXPECTED)
        self.page.add_init_script('window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(' +
                                  json.dumps([[url('resources/chapter-0002/data-url-image18.gif'), url(canonical_path)]]) + ')')
        served = []
        def altered(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path == prefix + canonical_path:
                served.append(True)
                return route.fulfill(status=200, content_type='image/gif', body=bytes(original),
                                     headers={'Access-Control-Allow-Origin': '*'})
            return self.bucket(route)
        self.context.route('**/api/reader-bucket-resource**', altered)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': url('chapter-manifest.json'), 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'failed')
        self.assertGreater(len(served), 0)
        self.assertEqual(self.external, [])

    def test_changed_original_resource_is_not_detected_by_local_alias(self):
        """Counterexample: prior local equality is not a live-source proof."""
        row = compat.fixture.PROOF['bundles'][2]
        root = Path(row['local_root']).resolve()
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        unrelated = root / 'resources/chapter-0002/stylesheet.css'
        self.assertTrue(unrelated.is_file())
        self.assertNotEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), EXPECTED)
        # Keep the original XHTML exactly as served. Substitute only one image
        # response: this models an object changing after the map was prepared.
        changed_path = 'resources/chapter-0002/data-url-image18.gif'
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        representative = url('resources/chapter-0002/data-url-image17.gif')
        self.page.add_init_script('window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(' +
                                  json.dumps([[url(changed_path), representative]]) + ')')
        served_original = []
        def changed_original(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path == prefix + changed_path:
                served_original.append(True)
                return route.fulfill(status=200, content_type='text/css', body=unrelated.read_bytes(),
                                     headers={'Access-Control-Allow-Origin': '*'})
            return self.bucket(route)
        self.context.route('**/api/reader-bucket-resource**', changed_original)
        self.open_book(2)
        article = self.page.locator('.reader-epub-chapter[data-chapter="5"]')
        article.wait_for(state='attached', timeout=30000)
        self.assertGreater(article.locator('img[src^="blob:"]').count(), 0)
        self.assertEqual(served_original, [])
        self.assertEqual(self.external, [])
        print(json.dumps({'event': 'changed-original-alias-not-detected', 'chapter': 5,
                          'remote_mutations': 0, 'deployed': False}), flush=True)

    def test_verified_blob_is_revoked_after_reader_dispose(self):
        row = compat.fixture.PROOF['bundles'][2]
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        original = url('resources/chapter-0002/data-url-image18.gif')
        canonical = url('resources/chapter-0002/data-url-image17.gif')
        self.page.add_init_script('''(() => {
          window.__chmBlobs=[];window.__chmRevoked=[];
          const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
          URL.createObjectURL=value=>{const result=create(value);window.__chmBlobs.push(result);return result;};
          URL.revokeObjectURL=value=>{window.__chmRevoked.push(value);return revoke(value);};
        })();window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(''' + json.dumps([[original, canonical]]) + ')')
        self.open_book(2)
        before = self.page.evaluate('''()=>({created:[...window.__chmBlobs],revoked:[...window.__chmRevoked]})''')
        self.assertEqual(len(before['created']), 1)
        self.assertEqual(before['revoked'], [])
        self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
        self.page.wait_for_function('()=>window.__chmRevoked.length>0', timeout=30000)
        after = self.page.evaluate('''()=>({created:[...window.__chmBlobs],revoked:[...window.__chmRevoked]})''')
        self.assertEqual(after['revoked'], after['created'])
        self.assertEqual(self.external, [])

    def test_dispose_during_delayed_representative_fetch_leaves_no_late_blob(self):
        row = compat.fixture.PROOF['bundles'][2]
        root = Path(row['local_root']).resolve()
        source = row['source_root'].split('/')[3]
        prefix = f"chapters/ebook/chm/{source}/{row['new_bundle_version']}/"
        def url(path):
            return 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({'path': prefix + path})
        canonical_path = 'resources/chapter-0002/data-url-image17.gif'
        self.page.add_init_script('''(() => {
          window.__chmBlobs=[];window.__chmRevoked=[];
          const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
          URL.createObjectURL=value=>{const result=create(value);window.__chmBlobs.push(result);return result;};
          URL.revokeObjectURL=value=>{window.__chmRevoked.push(value);return revoke(value);};
        })();window.__CHM_LOCAL_VERIFIED_ALIASES__=new Map(''' +
                                  json.dumps([[url('resources/chapter-0002/data-url-image18.gif'), url(canonical_path)]]) + ')')
        held = []
        def delay(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path == prefix + canonical_path:
                held.append(route)
                self.page.evaluate('window.__chmRepresentativeHeld=true')
                return
            return self.bucket(route)
        self.context.route('**/api/reader-bucket-resource**', delay)
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode({
            'url': url('chapter-manifest.json'), 'ext': 'epub-chapters'})
        self.page.goto(target, wait_until='domcontentloaded')
        # The intercepted representative GET remains unresolved until after
        # disposal; use a synchronous page flag rather than inspecting files.
        self.page.wait_for_function('()=>window.__chmRepresentativeHeld === true', timeout=30000)
        self.assertEqual(len(held), 1)
        self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
        from playwright.sync_api import Error as PlaywrightError
        try:
            held[0].fulfill(status=200, content_type='image/gif', body=(root / canonical_path).read_bytes(),
                            headers={'Access-Control-Allow-Origin': '*'})
        except PlaywrightError:
            pass  # The Reader's abort may have already closed the route.
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.evaluate('window.__chmBlobs'), [])
        self.assertEqual(self.external, [])
