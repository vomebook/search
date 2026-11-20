import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from scripts.ci.pages_artifact_proof import fingerprint, uploaded_fingerprint


class PagesGenerationTests(unittest.TestCase):
    def test_generation_and_complete_artifact_are_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'data').mkdir()
            (root / 'data/generation-manifest.json').write_text(json.dumps({'generation': 'a' * 64}))
            file = root / 'data/member'
            file.write_bytes(b'candidate')
            original = fingerprint(root, 'a' * 64)
            self.assertEqual(original, fingerprint(root, 'a' * 64))
            with self.assertRaises(ValueError):
                fingerprint(root, 'b' * 64)
            file.write_bytes(b'changed')
            self.assertNotEqual(original, fingerprint(root, 'a' * 64))
            file.unlink()
            file.symlink_to(root / 'data/generation-manifest.json')
            with self.assertRaises(ValueError):
                fingerprint(root, 'a' * 64)

    def test_official_pages_tar_readback_matches_only_complete_tested_bytes(self):
        generation = 'a' * 64
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'site'
            (root / 'data').mkdir(parents=True)
            (root / 'data/generation-manifest.json').write_text(json.dumps({'generation': generation}))
            (root / 'index.html').write_text('tested')
            (root / 'data/pages_release_receipt.json').write_text('{"version":1}')
            archive = Path(temp) / 'artifact.tar'

            def package(*, duplicate=False):
                with tarfile.open(archive, 'w') as tar:
                    tar.add(root, arcname='.')
                    if duplicate:
                        tar.add(root / 'index.html', arcname='index.html')

            expected = fingerprint(root, generation)
            package()
            self.assertEqual(uploaded_fingerprint(archive, generation), expected)
            package(duplicate=True)
            with self.assertRaisesRegex(ValueError, 'Unexpected uploaded'):
                uploaded_fingerprint(archive, generation)
            (root / 'index.html').write_text('altered')
            package()
            self.assertNotEqual(uploaded_fingerprint(archive, generation), expected)
            (root / 'link').symlink_to(root / 'index.html')
            package()
            with self.assertRaisesRegex(ValueError, 'Unexpected uploaded'):
                uploaded_fingerprint(archive, generation)
