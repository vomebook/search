"""Optional compiled parser equivalence; no build or corpus scan on import."""
import gzip
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch

from backend import search_indexes


def varint(value):
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


class PythonSearchIndexTests(unittest.TestCase):
    def test_posting_accelerator_dispatch_respects_buffer_and_validation_semantics(self):
        from array import array
        calls = []

        def accelerated(data):
            calls.append(data)
            return {9}

        with patch.object(search_indexes, '_native_decode_postings', accelerated):
            immutable = (b'\x01\x02', memoryview(b'\x01\x02'))
            for data in immutable:
                self.assertEqual(search_indexes.decode_postings(data), {9})
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(actual is expected for actual, expected in zip(calls, immutable)))
            for data in (bytearray(b'\x01\x02'), memoryview(bytearray(b'\x01\x02')),
                         memoryview(bytearray(b'\x01\x02')).toreadonly(),
                         memoryview(b'\x01\x00\x02')[::2], memoryview(array('H', [1, 2])),
                         memoryview(array('b', [-1, 0]))):
                self.assertEqual(search_indexes.decode_postings(data), search_indexes._decode_postings_python(data))
            self.assertEqual(search_indexes.decode_postings(b'\x01\x02', 4), {1, 3})
            self.assertEqual(len(calls), 2)
        with patch.object(search_indexes, '_native_decode_postings', side_effect=OverflowError):
            self.assertEqual(search_indexes.decode_postings(b'\x80' * 10 + b'\x00'), {0})
            self.assertEqual(search_indexes.decode_postings(b'\xff' * 12 + b'\x7f'),
                             search_indexes._decode_postings_python(b'\xff' * 12 + b'\x7f'))
        with patch.object(search_indexes, '_native_decode_postings', None):
            self.assertEqual(search_indexes.decode_postings(b'\x01\x02'), {1, 3})
            with self.assertRaisesRegex(ValueError, '^truncated varint$'):
                search_indexes.decode_postings(b'\x80')

    def test_native_posting_dispatch_rejects_non_byte_and_mutable_views(self):
        from array import array
        data = memoryview(array('H', [1, 2]))
        self.assertEqual(search_indexes.decode_postings(data), {1, 3})
        # A contiguous 16-bit view has a different byte representation on
        # little-endian machines; never pass its raw bytes to the accelerator.
        with patch.object(search_indexes, '_native_decode_postings', side_effect=AssertionError('unsafe native buffer')):
            self.assertEqual(search_indexes.decode_postings(data), {1, 3})
            self.assertEqual(search_indexes.decode_postings(memoryview(bytearray(b'\x01\x02'))), {1, 3})
            self.assertEqual(search_indexes.decode_postings(memoryview(bytearray(b'\x01\x02')).toreadonly()), {1, 3})
            self.assertEqual(search_indexes.decode_postings(memoryview(b'\x01\x00\x02')[::2]), {1, 3})

    def test_varints_accumulate_multibyte_values_and_report_truncation(self):
        for value in (0, 1, 127, 128, 16383, 16384, (1 << 42) + 713):
            encoded = varint(value)
            with self.subTest(value=value):
                self.assertEqual(search_indexes.decode_varint(b"prefix" + encoded + b"suffix", 6),
                                 (value, 6 + len(encoded)))
        for data, offset in ((b"", 0), (b"\x80", 0), (b"x", 1), (b"\x80\x80", 0)):
            with self.subTest(data=data, offset=offset), self.assertRaisesRegex(ValueError, "^truncated varint$"):
                search_indexes.decode_varint(data, offset)

    def test_posting_deltas_duplicates_limits_and_truncation(self):
        body = b"".join(varint(delta) for delta in (130, 300, 0, 20000))
        expected = {130, 430, 20430}
        self.assertEqual(search_indexes.decode_postings(body), expected)
        self.assertEqual(search_indexes.decode_postings(memoryview(body), 20431), expected)
        self.assertEqual(search_indexes._validate_postings(b"!" + body + b"?", 1, len(body) + 1, 20431), 3)
        for decoder in (lambda data: search_indexes.decode_postings(data, 20430),
                        lambda data: search_indexes._validate_postings(data, 0, len(data), 20430)):
            with self.assertRaisesRegex(ValueError, "^posting record id out of range$"):
                decoder(body)
        for decoder in (lambda data: search_indexes.decode_postings(data),
                        lambda data: search_indexes._validate_postings(data, 0, len(data), 20431)):
            with self.assertRaisesRegex(ValueError, "^truncated varint$"):
                decoder(body + b"\x80")
        self.assertEqual(search_indexes._validate_postings(b"", 0, 0, 0), 0)
        self.assertEqual(search_indexes.decode_postings(b""), set())

    def test_slice_and_posting_storage_preserve_exact_boundaries(self):
        self.assertEqual(search_indexes._bounded_slice(b"abc", 3, 0), (3, 3))
        self.assertEqual(search_indexes._bounded_slice(b"abc", 1, 2), (1, 3))
        for offset, length in ((1, -1), (2, 2), (4, 0)):
            with self.subTest(offset=offset, length=length), self.assertRaisesRegex(ValueError, "^truncated postings$"):
                search_indexes._bounded_slice(b"abc", offset, length)
        body = b"\x01a\x02\x02\x00\x02"
        original = {0, 2}
        self.assertEqual(search_indexes.resolve_postings((4, 6, 2), body), original)
        self.assertEqual(search_indexes.resolve_postings(b"\x81\x01", b""), {129})
        for source in (original, frozenset(original)):
            decoded = search_indexes.resolve_postings(source, b"")
            self.assertEqual(decoded, original)
            self.assertIsNot(decoded, source)
        self.assertEqual(search_indexes.resolve_postings({129, 430}, b""), {129, 430})
        with self.assertRaisesRegex(ValueError, "^posting count mismatch$"):
            list(search_indexes._read_posting_entries(b"\x01a\x02\x01\x00", 0, 1, 3))
        with self.assertRaisesRegex(ValueError, "^trailing postings$"):
            list(search_indexes._read_posting_entries(body + b"x", 0, 1, 3))
        self.assertEqual(list(search_indexes._read_posting_entries(body, 0, 1, 3)), [("a", (4, 6, 2), original)])
        self.assertEqual(list(search_indexes._read_posting_entries(body, 0, 1, 3, False)), [("a", (4, 6, 2), None)])
        with self.assertRaisesRegex(ValueError, "^posting record id out of range$"):
            list(search_indexes._read_posting_entries(body, 0, 1, 2, True))
        with patch.object(search_indexes, "_validate_postings", side_effect=AssertionError("extra validation")):
            self.assertEqual(list(search_indexes._read_posting_entries(body, 0, 1, 3, True)),
                             [("a", (4, 6, 2), original)])

    def test_native_adapter_preserves_arguments_and_overflow_falls_back(self):
        body = b"\x01a\x01\x01\x00"
        calls = []

        def native(data, offset, count, record_count, materialize):
            calls.append((data, offset, count, record_count, materialize))
            return {"native": {1}}

        with patch.object(search_indexes, "_native_read_entries", native):
            self.assertEqual(search_indexes._load_posting_entries(body, 0, 1, 2, False), {"native": {1}})
            self.assertEqual(calls, [(body, 0, 1, 2, False)])
        with patch.object(search_indexes, "_native_read_entries", side_effect=OverflowError):
            self.assertEqual(search_indexes._load_posting_entries(body, 0, 1, 1, True), {"a": {0}})
            self.assertEqual(search_indexes._load_posting_entries(body, 0, 1, 1, False), {"a": (4, 5, 1)})
            with self.assertRaisesRegex(ValueError, "^posting record id out of range$"):
                search_indexes._load_posting_entries(body, 0, 1, 0, True)

    def test_fallback_preserves_shapes_duplicates_and_does_not_publish_partial_data(self):
        # Two keys and a duplicate delta; the second posting is either valid or
        # truncated after the first entry has already been decoded.
        body = b"\x01a\x02\x03\x00\x00\x02" + b"\x01b\x01\x01\x01"
        with patch.object(search_indexes, "_native_read_entries", None):
            self.assertEqual(search_indexes._load_posting_entries(body, 0, 2, 3, True),
                             {"a": {0, 2}, "b": {1}})
            packed = search_indexes._load_posting_entries(body, 0, 2, 3, False)
            self.assertEqual({key: search_indexes.resolve_postings(value, body) for key, value in packed.items()},
                             {"a": {0, 2}, "b": {1}})
            for materialize in (False, True):
                with self.subTest(materialize=materialize), self.assertRaises(ValueError):
                    search_indexes._load_posting_entries(body[:-1] + b"\x80", 0, 2, 3, materialize)

    def test_fallback_keeps_packed_postings_lazy(self):
        body = b"\x01a\x01\x01\x00"
        with patch.object(search_indexes, "_native_read_entries", None), \
             patch.object(search_indexes, "decode_postings", side_effect=AssertionError("unexpected materialization")):
            self.assertEqual(search_indexes._load_posting_entries(body, 0, 1, 1, False), {"a": (4, 5, 1)})

    def test_loaders_reject_foreign_digests_tokenizers_counts_and_magic(self):
        digest = bytes(range(32))
        tokenizer = search_indexes.WORD_INDEX_TOKENIZER.encode("utf-8")
        word = search_indexes.WORD_INDEX_MAGIC + varint(len(tokenizer)) + tokenizer + digest + varint(3) + varint(0)
        ngram = search_indexes.NGRAM_MAGIC + b"\x02" + digest + varint(3) + varint(0)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.gz"
            path.write_bytes(gzip.compress(ngram))
            self.assertEqual(search_indexes.load_ngram_index(path, 2, 3, digest), ({}, ngram))
            self.assertEqual(search_indexes.load_ngram_index(path, 2, 3, b"x" * 32), ({}, b""))
            self.assertEqual(search_indexes.load_ngram_index(path, 2, 4, digest), ({}, b""))
            self.assertEqual(search_indexes.load_ngram_index(path, 3, 3, digest), ({}, b""))

            path.write_bytes(gzip.compress(word))
            self.assertEqual(search_indexes.load_word_index(path, 3, digest), {})
            self.assertEqual(search_indexes.load_word_index(path, 3, digest, False), ({}, word))
            for payload, count, expected in ((b"wrong-magic", 3, digest), (word, 3, b"x" * 32),
                                              (word, 4, digest),
                                              (word.replace(tokenizer, b"x" * len(tokenizer)), 3, digest)):
                with self.subTest(payload=payload[:8], count=count, expected=expected[:1]):
                    path.write_bytes(gzip.compress(payload))
                    self.assertEqual(search_indexes.load_word_index(path, count, expected), {})
                    self.assertEqual(search_indexes.load_word_index(path, count, expected, False), ({}, b""))

    def test_nonempty_indexes_preserve_posting_shapes_and_reject_invalid_files(self):
        digest = bytes(range(32))
        tokenizer = search_indexes.WORD_INDEX_TOKENIZER.encode("utf-8")
        entries = varint(3) + varint(1) + b"\x01a\x02\x02\x00\x02"
        ngram = search_indexes.NGRAM_MAGIC + b"\x02" + digest + entries
        word = search_indexes.WORD_INDEX_MAGIC + varint(len(tokenizer)) + tokenizer + digest + entries
        with tempfile.TemporaryDirectory() as directory, patch.object(search_indexes, "_native_read_entries", None):
            path = Path(directory) / "index.gz"
            for payload, loader in ((ngram, lambda: search_indexes.load_ngram_index(path, 2, 3, digest)),
                                    (word, lambda: search_indexes.load_word_index(path, 3, digest, False))):
                path.write_bytes(gzip.compress(payload))
                postings, buffer = loader()
                self.assertEqual(buffer, payload)
                self.assertIsInstance(postings["a"], tuple)
                self.assertEqual(search_indexes.resolve_postings(postings["a"], buffer), {0, 2})
                path.write_bytes(gzip.compress(payload[:-1] + b"\x03"))
                self.assertEqual(loader(), ({}, b""), "out-of-range record IDs must fail closed")
            path.write_bytes(gzip.compress(word))
            self.assertEqual(search_indexes.load_word_index(path, 3, digest, True), {"a": {0, 2}})
            path.write_bytes(b"not a gzip stream")
            self.assertEqual(search_indexes.load_ngram_index(path, 2, 3, digest), ({}, b""))
            self.assertEqual(search_indexes.load_word_index(path, 3, digest, False), ({}, b""))
            self.assertEqual(search_indexes.load_word_index(path, 3, digest, True), {})
            path.write_bytes(gzip.compress(b"BAD!" + ngram[4:]))
            self.assertEqual(search_indexes.load_ngram_index(path, 2, 3, digest), ({}, b""))

    def test_ngram_reader_passes_literal_boolean_to_native_extension(self):
        digest = bytes(range(32))
        payload = search_indexes.NGRAM_MAGIC + b"\x02" + digest + b"\x01\x01\x01a\x01\x01\x00"
        native_calls = []

        def native(data, offset, count, record_count, materialize):
            native_calls.append((data, offset, count, record_count, materialize))
            if type(materialize) is not bool:
                raise TypeError("native materialize must be boolean")
            return {"a": (offset + 4, offset + 5, 1)}

        with tempfile.TemporaryDirectory() as directory, patch.object(search_indexes, "_native_read_entries", native):
            path = Path(directory) / "index.gz"
            path.write_bytes(gzip.compress(payload))
            postings, buffer = search_indexes.load_ngram_index(path, 2, 1, digest)
        self.assertEqual(native_calls, [(payload, 39, 1, 1, False)])
        self.assertEqual(search_indexes.resolve_postings(postings["a"], buffer), {0})

    def test_materialized_loader_rejects_missing_decoded_posting(self):
        with patch.object(search_indexes, "_native_read_entries", None), \
             patch.object(search_indexes, "_read_posting_entries", return_value=iter([("a", (0, 1, 1), None)])):
            with self.assertRaisesRegex(RuntimeError, "^materialized posting missing$"):
                search_indexes._load_posting_entries(b"", 0, 1, 1, True)


@unittest.skipUnless(search_indexes._native_read_entries, "build optional native posting decoder explicitly")
class NativeSearchIndexTests(unittest.TestCase):
    def test_native_posting_decode_matches_python_random_and_boundary_buffers(self):
        native = search_indexes._native_decode_postings
        if native is None:
            self.skipTest('build updated optional native posting decoder')
        rng = random.Random(20261103)
        bodies = [b'', b'\0', b'\x80', b'\x80' * 10 + b'\0',
                  b'\xff' * 12 + b'\x7f', b'\0\0\x01']
        bodies += [bytes(rng.randrange(256) for _ in range(rng.randrange(30))) for _ in range(5000)]
        for body in bodies:
            for value in (body, memoryview(body)):
                try:
                    expected = search_indexes._decode_postings_python(value)
                except ValueError as error:
                    with self.assertRaisesRegex(ValueError, '^' + str(error) + '$'):
                        search_indexes.decode_postings(value)
                else:
                    self.assertEqual(search_indexes.decode_postings(value), expected)
                    self.assertIsNot(search_indexes.decode_postings(value), expected)

    def test_native_cumulative_overflow_and_wide_varints_fall_back_without_truncation(self):
        native = search_indexes._native_decode_postings
        if native is None:
            self.skipTest('build updated optional native posting decoder')
        # Each of these two varints is accepted by the native parser on its
        # own, while their cumulative total overflows an unsigned 64-bit ID.
        body = varint(1 << 63) + varint(1 << 63)
        with self.assertRaises(OverflowError):
            native(body)
        self.assertEqual(search_indexes.decode_postings(body), {1 << 63, 1 << 64})
        with self.assertRaises(OverflowError):
            native(b'\x80' * 10 + b'\0')
        self.assertEqual(search_indexes.decode_postings(b'\x80' * 10 + b'\0'), {0})
        with self.assertRaisesRegex(ValueError, '^truncated varint$'):
            search_indexes.decode_postings(b'\x80')

    def test_native_entries_match_python_for_multibyte_duplicates_and_corruption(self):
        rng = random.Random(731)
        bodies = []
        for _ in range(100):
            ids = sorted(rng.randrange(100000) for _ in range(rng.randrange(40)))
            if ids:
                ids.insert(0, ids[0])
            previous = 0
            body = b""
            for index in ids:
                body += varint(index - previous)
                previous = index
            key = "\u6587\u5316".encode()
            encoded = varint(len(key)) + key + varint(len(set(ids))) + varint(len(body)) + body
            bodies.extend([encoded, encoded[:-1], encoded + b"\0", encoded[:-1] + b"\x80"])
        bodies.extend([b"", b"\x01\xff\0\0", b"\x01a\x01\x01\x80",
                       b"\x01a\x01\x02" + varint(100000), b"\x01a\x02\x02\0\0"])
        native = search_indexes._native_read_entries
        for materialize in (False, True):
            for body in bodies:
                with self.subTest(materialize=materialize, body=body):
                    try:
                        expected = {key: decoded if materialize else location
                                    for key, location, decoded in search_indexes._read_posting_entries(body, 0, 1, 100000, materialize)}
                    except (ValueError, UnicodeError):
                        with self.assertRaises((ValueError, UnicodeError)):
                            native(body, 0, 1, 100000, materialize)
                    else:
                        self.assertEqual(native(body, 0, 1, 100000, materialize), expected)

    def test_empty_trailing_bounds_and_wide_varint_fallback(self):
        native = search_indexes._native_read_entries
        self.assertEqual(native(b"", 0, 0, 0, False), {})
        for args in ((b"x", 0, 0, 1, False), (b"", -1, 0, 1, False), (b"", 1, 0, 1, False)):
            with self.assertRaises(ValueError):
                native(*args)
        # An overlong encoding of zero remains valid under the Python contract.
        body = b"\x01a\x01\x0b" + b"\x80" * 10 + b"\x00"
        with patch.object(search_indexes, "_native_read_entries", native):
            self.assertEqual(search_indexes._load_posting_entries(body, 0, 1, 1, True), {"a":{0}})

    def test_partial_native_failure_cannot_publish_entries(self):
        body = b"\x01a\x01\x01\x00" + b"\x01b\x01\x01\x80"
        with self.assertRaises(ValueError):
            search_indexes._native_read_entries(body, 0, 2, 10, True)


if __name__ == "__main__":
    unittest.main()
