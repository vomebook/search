from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from urllib.error import HTTPError
from zipfile import ZipFile

from scripts.ci.pages_artifact_proof import fingerprint, uploaded_fingerprint
from scripts.ci.wait_pages_artifact import blob_url, seal, wait, write_tar


class PagesGenerationTests(unittest.TestCase):
    def test_exact_rest_upload_requires_correct_id_run_attempt_digest_and_size(self):
        accepted = dict(workflow_run={'id': 5}, name='github-pages-5-1', id=7, expired=False,
                        size_in_bytes=877, digest='sha256:' + 'a' * 64)
        self.assertEqual(seal(accepted, 5, 'github-pages-5-1', 7), (877, accepted['digest']))
        for changes in (dict(id=8), dict(workflow_run={'id': 6}), dict(name='github-pages-5-2'),
                        dict(expired=True), dict(digest='a' * 64), dict(size_in_bytes=0),
                        dict(size_in_bytes=1024 ** 3 + 1)):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                seal({**accepted, **changes}, 5, 'github-pages-5-1', 7)
        good_url = 'https://upload.example.test/opaque?signature=fixture'
        self.assertEqual(blob_url(good_url), good_url)
        for url in ('http://example.test/file', 'https://token@example.test/file', '//example.test/file'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                blob_url(url)

    def test_temporary_rest_metadata_absence_can_settle_without_a_new_upload(self):
        statuses = iter((404, 503, 200))
        sleeps = []

        def get():
            code = next(statuses)
            if code != 200:
                raise HTTPError('https://example.test', code, '', None, None)
            return {'id': 7}

        self.assertEqual(wait(get, sleep=sleeps.append), {'id': 7})
        self.assertEqual(sleeps, [3, 3])

    def test_zip_readback_verifies_exact_digest_and_extracts_only_single_expected_tar(self):
        def package(*names):
            raw = BytesIO()
            with ZipFile(raw, 'w') as archive:
                for name in names:
                    archive.writestr(name, b'official tar bytes')
            data = raw.getvalue()
            return data, (len(data), 'sha256:' + sha256(data).hexdigest())

        data, expected = package('artifact.tar')
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'proof.tar'
            bad = [package('../artifact.tar'), package('artifact.tar', 'extra'),
                   (data + b'!', expected), (data[:-1], expected),
                   (data, (len(data), 'sha256:' + 'a' * 64))]
            for raw, proof in bad:
                with self.assertRaises(ValueError):
                    write_tar(BytesIO(raw), proof, target)
                self.assertFalse(target.exists())
            write_tar(BytesIO(data), expected, target)
            self.assertEqual(target.read_bytes(), b'official tar bytes')
            with self.assertRaises(FileExistsError):
                write_tar(BytesIO(data), expected, target)

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
