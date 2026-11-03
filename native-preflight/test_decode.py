"""Standalone candidate parity, sanitization boundaries and microbenchmarks."""
from array import array
import random
import statistics
import unittest
import platform
from time import perf_counter

import _search_index_native as native
import search_indexes as index


def varint(number):
    result = bytearray()
    while number >= 128:
        result.append((number & 127) | 128)
        number >>= 7
    result.append(number)
    return bytes(result)


class NativePostingPreflight(unittest.TestCase):
    def test_candidate_is_loaded(self):
        self.assertIs(index._native_decode_postings, native.decode_postings)

    def test_randomized_values_and_truncations_match_python(self):
        rng = random.Random(20261103)
        values = [b'', b'\x80', b'\xff' * 12 + b'\x7f', b'\x80' * 10 + b'\0',
                  varint(1 << 63) + varint(1 << 63)]
        values.extend(bytes(rng.randrange(256) for _ in range(rng.randrange(40))) for _ in range(20000))
        for body in values:
            for data in (body, memoryview(body)):
                try:
                    expected = index._decode_postings_python(data)
                except ValueError as error:
                    with self.assertRaisesRegex(ValueError, '^' + str(error) + '$'):
                        index.decode_postings(data)
                else:
                    self.assertEqual(index.decode_postings(data), expected)

    def test_nonstandard_views_and_checked_decoding_keep_python_semantics(self):
        inputs = [memoryview(array('H', [1, 2])), memoryview(array('b', [-1, 0])),
                  memoryview(b'\x01\0\x02')[::2], memoryview(bytearray(b'\x01\x02')).toreadonly()]
        for data in inputs:
            self.assertEqual(index.decode_postings(data), index._decode_postings_python(data))
        with self.assertRaisesRegex(ValueError, '^posting record id out of range$'):
            index.decode_postings(b'\x01\x02', 3)
        with self.assertRaises(OverflowError):
            native.decode_postings(varint(1 << 63) + varint(1 << 63))
        self.assertEqual(index.decode_postings(varint(1 << 63) + varint(1 << 63)), {1 << 63, 1 << 64})

    def test_older_or_absent_extension_uses_python_fallback(self):
        previous = index._native_decode_postings
        try:
            index._native_decode_postings = None
            self.assertEqual(index.decode_postings(b'\x01\x02'), {1, 3})
        finally:
            index._native_decode_postings = previous

    def test_native_and_python_packed_entry_paths_agree(self):
        body = b'\x01a\x02\x03\0\0\x02' + b'\x01b\x01\x01\x01'
        for materialize in (False, True):
            expected = {key: decoded if materialize else location for key, location, decoded in
                        index._read_posting_entries(body, 0, 2, 3, materialize)}
            self.assertEqual(native.read_entries(body, 0, 2, 3, materialize), expected)
            with self.assertRaises(ValueError):
                native.read_entries(body[:-1] + b'\x80', 0, 2, 3, materialize)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NativePostingPreflight))
    if not result.wasSuccessful():
        raise SystemExit(1)
    body = b'\x01' * 80000
    expected = index._decode_postings_python(body)
    rows = {'python': [], 'native': []}
    for pair in range(16):
        order = [('python', index._decode_postings_python), ('native', index.decode_postings)]
        if pair % 2:
            order.reverse()
        for label, fn in order:
            start = perf_counter()
            decoded = fn(body)
            elapsed = (perf_counter() - start) * 1000
            if decoded != expected:
                raise AssertionError('benchmark decoder mismatch')
            if pair >= 2:
                rows[label].append(elapsed)
    print(platform.machine(), 'synthetic 80000-ID list median milliseconds:',
          {name: round(statistics.median(values), 3) for name, values in rows.items()})
