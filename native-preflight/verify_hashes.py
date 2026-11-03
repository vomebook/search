"""Fail if preflight copies differ from the locally reviewed candidate."""
from hashlib import sha256
from pathlib import Path

root = Path(__file__).resolve().parent
expected = {
    'search_index_native.c': '11c04c74b3a489c2d9acd6a2eb7ac42ebfdfe0ff4cc36f1d28096f24458c1a80',
    'search_indexes.py': '95d1c3fd9e41c0bb1cc875f349c611033fea50eb848b5b4ae2fb39bdc2cdeba5',
    'test_native_search_indexes.py': '311952c2b226062291cf1a9ef6783e60816bea89c3d7db0a796c737d56a7633d',
}
for name, digest in expected.items():
    actual = sha256((root / name).read_bytes()).hexdigest()
    if actual != digest:
        raise SystemExit('candidate file hash mismatch: ' + name)
    print(name, actual)
