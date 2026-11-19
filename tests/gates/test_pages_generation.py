import json
from pathlib import Path
import tempfile
import unittest

from scripts.ci.pages_artifact_proof import fingerprint


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
