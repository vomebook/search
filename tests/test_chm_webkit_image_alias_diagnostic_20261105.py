"""Loopback-only image-alias diagnosis, not a CHM production repair.

The fixture intercepts known third-candidate XHTML in memory and changes an
image URL only after verifying the old and target GIF bytes are identical. No
manifest, candidate file, remote service or real browser profile is modified.
The altered XHTML does not match its manifest SHA and cannot be published.
"""
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from lxml import etree

from tests import test_chm_webkit_boundary_diagnostic_20261105 as diagnostic


EXPECTED = '26d32a822a28d0316fef4d3a04b20d9c9e9e8415bd8cce1cd261394792eaebe2'


class ImageAliasDiagnostic(diagnostic.WebkitBoundaryDiagnostic):
    def setUp(self):
        super().setUp()
        self.aliased = 0
        self.verified_chapters = 0
        self.pristine_modules = []
        self.image_requests = []
        os.environ['CHM_ANNOTATE_DIMENSIONS'] = '1'
        os.environ['CHM_ENSURE_IMAGES'] = '1'
        self.addCleanup(os.environ.pop, 'CHM_ANNOTATE_DIMENSIONS', None)
        self.addCleanup(os.environ.pop, 'CHM_ENSURE_IMAGES', None)
        self.page.on('request', lambda request: self.image_requests.append(
            parse_qs(urlsplit(request.url).query).get('path', [''])[0])
            if request.resource_type == 'image' else None)
        self.context.route('**/api/reader-bucket-resource**', self.serve_alias)
        # Use the original Reader chapter/search modules as a control, with no
        # local bridge or experimental chapter rendering changes involved.
        import subprocess
        for path in ('static/reader/formats/reader-chapter-format.mjs',
                     'static/reader/search/reader-search-backends.mjs'):
            raw = subprocess.check_output(['git', 'show', 'HEAD:' + path], cwd=diagnostic.compat.HERE)
            def serve_module(route, request, *, name=path, body=raw):
                self.pristine_modules.append(name)
                route.fulfill(status=200, content_type='text/javascript', body=body)
            self.page.route('**/' + path, serve_module)

    def serve_alias(self, route):
        row = diagnostic.compat.fixture.PROOF['bundles'][2]
        prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
        path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
        if not path.startswith(prefix):
            return self.bucket(route)
        root = Path(row['local_root']).resolve()
        candidate = (root / path[len(prefix):]).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            return route.fulfill(status=404, body='missing reviewed local resource')
        if path.endswith('.xhtml'):
            tree = etree.parse(str(candidate))
            representative = (root / 'resources/chapter-0002/data-url-image17.gif').resolve()
            self.assertTrue(representative.is_relative_to(root / 'resources'))
            self.assertEqual(hashlib.sha256(representative.read_bytes()).hexdigest(), EXPECTED)
            for image in tree.xpath('//*[local-name()="img" and @src]'):
                original = (candidate.parent / unquote(image.get('src'))).resolve()
                self.assertTrue(original.is_relative_to(root / 'resources') and original.is_file())
                if hashlib.sha256(original.read_bytes()).hexdigest() == EXPECTED:
                    image.set('src', '../resources/chapter-0002/data-url-image17.gif')
                    self.aliased += 1
            self.verified_chapters += 1
            return route.fulfill(status=200, content_type='application/xhtml+xml',
                                 body=etree.tostring(tree, encoding='utf-8', xml_declaration=True),
                                 headers={'Access-Control-Allow-Origin': '*'})
        if '/resources/' in path:
            mime = {'.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp'}.get(candidate.suffix.lower())
            if mime:
                return route.fulfill(status=200, content_type=mime, body=candidate.read_bytes(),
                                     headers={'Access-Control-Allow-Origin': '*'})
        return self.bucket(route)

    def test_trace_third_candidate(self):
        self.skipTest('modified chapter bytes intentionally fail the search bridge SHA check')

    def test_toc_navigation_without_search_bridge_acquisition(self):
        try:
            super().test_toc_navigation_without_search_bridge_acquisition()
            self.assertGreaterEqual(self.aliased, 124)
            self.assertIn('static/reader/formats/reader-chapter-format.mjs', self.pristine_modules)
            self.assertIn('static/reader/search/reader-search-backends.mjs', self.pristine_modules)
            self.assertGreater(len(self.image_requests), 0)
            self.assertEqual({path.rsplit('/resources/', 1)[-1] for path in self.image_requests},
                             {'chapter-0002/data-url-image17.gif'})
        finally:
            print(json.dumps({'event': 'local-alias-summary', 'aliased': self.aliased,
                              'chapters': self.verified_chapters, 'pristine_modules': sorted(self.pristine_modules),
                              'remote_mutations': 0, 'publication_authorized': False}), flush=True)
