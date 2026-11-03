"""Readers for the generated word and n-gram posting files.

The generated formats are deliberately small and self-describing.  Keeping
their parsing independent from the FastAPI application makes malformed input
handling testable without importing application state.
"""

import gzip
from collections.abc import Iterator
from pathlib import Path
from typing import Literal, overload

try:
    import _search_index_native as _native_index
except ImportError:
    _native_index = None

_native_read_entries = getattr(_native_index, "read_entries", None)
_native_decode_postings = getattr(_native_index, "decode_postings", None)


NGRAM_MAGIC = b"VNG3"
WORD_INDEX_MAGIC = b"VWI2"
WORD_INDEX_TOKENIZER = "jieba-0.42.1-cjk-char-v1"

PostingLocation = tuple[int, int, int]
Posting = set[int] | PostingLocation
PostingIndex = dict[str, Posting]


def decode_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
    raise ValueError("truncated varint")


def decode_postings(data: bytes | memoryview, record_count: int | None = None) -> set[int]:
    # Non-byte, strided, or mutable-backed buffers retain Python iteration semantics.
    if (_native_decode_postings is not None and record_count is None and
            (type(data) is bytes or (type(data) is memoryview and data.readonly and
                                     type(data.obj) is bytes and data.format == "B" and
                                     data.ndim == 1 and data.c_contiguous))):
        try:
            return _native_decode_postings(data)
        except OverflowError:
            # Python integers support valid varints and cumulative IDs wider than 64 bits.
            pass
    return _decode_postings_python(data, record_count)


def _decode_postings_python(data: bytes | memoryview, record_count: int | None = None) -> set[int]:
    record_ids: set[int] = set()
    previous = 0
    value = shift = 0
    for byte in data:
        value |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            continue
        previous += value
        if record_count is not None and previous >= record_count:
            raise ValueError("posting record id out of range")
        record_ids.add(previous)
        value = shift = 0
    if shift:
        raise ValueError("truncated varint")
    return record_ids


def _bounded_slice(data: bytes, offset: int, length: int) -> tuple[int, int]:
    end = offset + length
    if length < 0 or end < offset or end > len(data):
        raise ValueError("truncated postings")
    return offset, end


def _validate_postings(data: bytes, start: int, end: int, record_count: int) -> int:
    """Count distinct monotonic IDs without allocating a temporary posting set."""
    previous = 0
    last = -1
    count = 0
    value = shift = 0
    for offset in range(start, end):
        byte = data[offset]
        value |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            continue
        previous += value
        if previous >= record_count:
            raise ValueError("posting record id out of range")
        if previous != last:
            count += 1
            last = previous
        value = shift = 0
    if shift:
        raise ValueError("truncated varint")
    return count


def _read_posting_entries(data: bytes, offset: int, count: int, record_count: int,
                          materialize: bool = True) -> Iterator[tuple[str, PostingLocation, set[int] | None]]:
    """Yield validated entries while leaving storage policy to each loader."""
    for _ in range(count):
        key_length, offset = decode_varint(data, offset)
        key_start, offset = _bounded_slice(data, offset, key_length)
        key = data[key_start:offset].decode("utf-8")
        posting_count, offset = decode_varint(data, offset)
        posting_length, offset = decode_varint(data, offset)
        posting_start, offset = _bounded_slice(data, offset, posting_length)
        decoded = decode_postings(memoryview(data)[posting_start:offset], record_count) if materialize else None
        actual_count = len(decoded) if decoded is not None else _validate_postings(data, posting_start, offset, record_count)
        if actual_count != posting_count:
            raise ValueError("posting count mismatch")
        yield key, (posting_start, offset, posting_count), decoded
    if offset != len(data):
        raise ValueError("trailing postings")


def _load_posting_entries(data: bytes, offset: int, count: int, record_count: int,
                          materialize: bool) -> PostingIndex:
    if _native_read_entries is not None:
        try:
            return _native_read_entries(data, offset, count, record_count, materialize)
        except OverflowError:
            # Retain arbitrary-width varint behavior for unusual valid inputs.
            pass
    if materialize:
        entries: PostingIndex = {}
        for key, _, decoded in _read_posting_entries(data, offset, count, record_count, True):
            if decoded is None:
                raise RuntimeError("materialized posting missing")
            entries[key] = decoded
        return entries
    return {key: location for key, location, _ in _read_posting_entries(data, offset, count, record_count, False)}


def load_ngram_index(
    path: Path,
    width: int,
    record_count: int,
    expected_digest: bytes,
) -> tuple[PostingIndex, bytes]:
    try:
        data = gzip.decompress(path.read_bytes())
        if not data.startswith(NGRAM_MAGIC) or len(data) < 37 or data[4] != width:
            return {}, b""
        if data[5:37] != expected_digest:
            return {}, b""
        offset = 37
        stored_record_count, offset = decode_varint(data, offset)
        count, offset = decode_varint(data, offset)
        if stored_record_count != record_count:
            return {}, b""
        postings = _load_posting_entries(data, offset, count, record_count, False)
        return postings, data
    except (OSError, ValueError, UnicodeDecodeError, EOFError, IndexError, OverflowError):
        return {}, b""


@overload
def load_word_index(path: Path, record_count: int, expected_digest: bytes,
                    materialize: Literal[False]) -> tuple[PostingIndex, bytes]: ...


@overload
def load_word_index(path: Path, record_count: int, expected_digest: bytes,
                    materialize: Literal[True] = True) -> PostingIndex: ...


def load_word_index(path: Path, record_count: int, expected_digest: bytes,
                     materialize: bool = True) -> PostingIndex | tuple[PostingIndex, bytes]:
    try:
        data = gzip.decompress(path.read_bytes())
        if not data.startswith(WORD_INDEX_MAGIC):
            return {} if materialize else ({}, b"")
        offset = len(WORD_INDEX_MAGIC)
        tokenizer_length, offset = decode_varint(data, offset)
        tokenizer_start, offset = _bounded_slice(data, offset, tokenizer_length)
        tokenizer = data[tokenizer_start:offset].decode("utf-8")
        digest_start, offset = _bounded_slice(data, offset, 32)
        if tokenizer != WORD_INDEX_TOKENIZER or data[digest_start:offset] != expected_digest:
            return {} if materialize else ({}, b"")
        stored_record_count, offset = decode_varint(data, offset)
        count, offset = decode_varint(data, offset)
        if stored_record_count != record_count:
            return {} if materialize else ({}, b"")
        entries = _load_posting_entries(data, offset, count, record_count, materialize)
        return entries if materialize else (entries, data)
    except (OSError, ValueError, UnicodeDecodeError, EOFError, IndexError, OverflowError):
        return {} if materialize else ({}, b"")


def resolve_postings(value: Posting | frozenset[int] | bytes | memoryview, buffer: bytes) -> set[int]:
    if isinstance(value, tuple):
        start, end, _ = value
        return decode_postings(memoryview(buffer)[start:end])
    return set(value) if isinstance(value, (set, frozenset)) else decode_postings(value)
