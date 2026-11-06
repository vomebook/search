"""Loopback-only candidate resource-dimension experiment; no asset is changed.

This narrowly annotates known 14x13 GIFs in intercepted candidate chapters to
test browser lazy loading. It does not modify the splitter, candidate files,
manifests, Reader limits or any production URL.
"""
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import unittest

from lxml import etree
from PIL import Image

from tests import test_chm_webkit_boundary_diagnostic_20261105 as diagnostic


class ImageDimensionDiagnostic(diagnostic.WebkitBoundaryDiagnostic):
    def setUp(self):
        super().setUp()
        self.chapters_annotated = 0
        self.images_annotated = 0
        os.environ['CHM_ANNOTATE_DIMENSIONS'] = '1'
        self.addCleanup(os.environ.pop, 'CHM_ANNOTATE_DIMENSIONS', None)
        self.context.route('**/api/reader-bucket-resource**', self.serve_reviewed)

    def serve_reviewed(self, route):
        path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
        row = diagnostic.compat.fixture.PROOF['bundles'][2]
        prefix = f"chapters/ebook/chm/{row['source_root'].split('/')[3]}/{row['new_bundle_version']}/"
        if path.startswith(prefix) and path.endswith('.xhtml'):
            root = Path(row['local_root']).resolve()
            candidate = (root / path[len(prefix):]).resolve()
            if not candidate.is_relative_to(root) or not candidate.is_file():
                return route.fulfill(status=404, body='not a reviewed local path')
            tree = etree.parse(str(candidate))
            count = 0
            for image in tree.xpath('//*[local-name()="img" and @src]'):
                ref = image.get('src')
                resource = (candidate.parent / ref).resolve()
                if not resource.is_relative_to(root / 'resources') or not resource.is_file():
                    raise ValueError('invalid candidate image reference')
                with Image.open(resource) as source:
                    is_target = source.format == 'GIF' and source.size == (14, 13)
                if is_target and image.get('width') is None and image.get('height') is None:
                    image.set('width', '14')
                    image.set('height', '13')
                    count += 1
            self.chapters_annotated += 1
            self.images_annotated += count
            print(json.dumps({'event': 'local-annotated-chapter', 'chapter': candidate.name,
                              'images': count, 'total_images': self.images_annotated}), flush=True)
            return route.fulfill(status=200, content_type='application/xhtml+xml',
                                 body=etree.tostring(tree, encoding='utf-8', xml_declaration=True),
                                 headers={'Access-Control-Allow-Origin': '*'})
        if '/resources/' in path:
            return self.control_images(route)
        return self.bucket(route)

    def test_trace_third_candidate(self):
        self.skipTest('search bridge rejects modified chapter bytes by design')

    def test_toc_navigation_without_search_bridge_acquisition(self):
        try:
            super().test_toc_navigation_without_search_bridge_acquisition()
            self.assertGreater(self.images_annotated, 0)
            self.assertEqual(self.external, [])
        finally:
            print(json.dumps({'event': 'local-annotation-summary', 'chapters': self.chapters_annotated,
                              'images': self.images_annotated, 'remote_mutations': 0,
                              'publication_authorized': False}), flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
