"""Deterministic, synthetic DjVu source for offline Reader browser tests."""
import gzip
import hashlib
import json
import re
import struct
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

RAW = (Path(__file__).parent / "fixtures/synthetic-reader.djvu").read_bytes()
SHA256 = hashlib.sha256(RAW).hexdigest()
REVISION = "a" * 40
SOURCE = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/synthetic-reader.djvu"
PINNED = SOURCE.replace("/main/", f"/{REVISION}/")
ETAG = '"synthetic-reader"'
VERSION = "1234567890abcdef"


def payload(page, text):
    body = json.dumps({"version": 1, "kind": "pdf-ocr-page", "page": page,
                       "width": 96, "height": 128,
                       "blocks": [{"t": text, "b": [0.1, 0.15, 0.8, 0.3]}]},
                      ensure_ascii=False).encode()
    return gzip.compress(body, mtime=0)


def install(page, origin, *, prefix="", ocr=False, mismatch=False, fail_page_once=False, body=RAW,
            source_handler=None):
    """Serve actual DjVu bytes over Range or full-body fetch; no remote calls."""
    api = "https://voiceofml-search.hf.space" if prefix == "/search" else origin
    sha = "b" * 64 if mismatch else SHA256
    root = f"objects/{sha[:2]}/{sha}/{VERSION}"
    ocr_path = root + "/ocr-manifest.json"
    texts = ["OCR first preserved", "OCR second preserved", "OCR third preserved"]
    data = [payload(i, text) for i, text in enumerate(texts, 1)]
    book = gzip.compress(json.dumps({
        "version": 2, "kind": "pdf-book-text", "complete": True,
        "offset_unit": "unicode-codepoint", "source_sha256": sha, "page_count": 3,
        "pages": [{"page": i, "text": text, "layout": {"offset_unit": "unicode-codepoint"},
                   "text_spans": []} for i, text in enumerate(texts, 1)]
    }).encode(), mtime=0)
    entries = [{"p": i, "o": root + f"/ocr/page-{i:06d}.json.gz",
                "os": hashlib.sha256(packed).hexdigest(), "ob": len(packed)}
               for i, packed in enumerate(data, 1)]
    manifest = {"version": 1, "kind": "pdf-ocr", "complete": True,
                "source_sha256": sha, "profile": "test-layout-v1-synthetic", "page_count": 3,
                "pages": entries, "book_text": {"path": root + "/ocr/book-text.json.gz",
                                                    "bytes": len(book),
                                                    "sha256": hashlib.sha256(book).hexdigest()}}
    if ocr and body != RAW:
        raise ValueError("OCR fixture only authenticates the original synthetic document")
    state = {"source": [], "assets": [], "page_attempts": [], "texts": texts,
             "manifest": manifest, "ocr_path": ocr_path, "raw": body, "source_url": PINNED}

    def revision(route):
        target = parse_qs(urlsplit(route.request.url).query).get("url", [""])[0]
        revision = target.split('/resolve/', 1)[1].split('/', 1)[0] if '/resolve/' in target else ''
        if revision not in ('main', REVISION):
            route.fulfill(status=400)
            return
        route.fulfill(json={"url": PINNED, "revision": REVISION}, headers={"Access-Control-Allow-Origin": "*"})
    page.route("**/api/reader-source-revision?**", revision)

    def content(route):
        target = parse_qs(urlsplit(route.request.url).query).get("url", [""])[0]
        if target != PINNED:
            route.fulfill(status=404, body="unexpected source")
            return
        header = route.request.headers.get("range")
        state["source"].append({"url": target, "range": header,
                                "if_range": route.request.headers.get("if-range")})
        common = {"ETag": ETAG, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*",
                  "Access-Control-Expose-Headers": "ETag,Content-Range,Content-Length"}
        if not header:
            route.fulfill(status=200, body=body, content_type="image/vnd.djvu", headers=common)
            return
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", header)
        if not match:
            route.fulfill(status=416)
            return
        start, end = map(int, match.groups())
        end = min(end, len(body) - 1)
        if start > end:
            route.fulfill(status=416, headers={**common, "Content-Range": f"bytes */{len(body)}"})
            return
        route.fulfill(status=206, body=body[start:end + 1], content_type="image/vnd.djvu",
                      headers={**common, "Content-Range": f"bytes {start}-{end}/{len(body)}"})

    state["respond_source"] = content
    page.route("**/api/reader-content?**", source_handler or content)
    if ocr:
        def asset(route):
            path = parse_qs(urlsplit(route.request.url).query).get("path", [""])[0]
            state["assets"].append(path)
            if path == ocr_path:
                route.fulfill(json=manifest, headers={"Access-Control-Allow-Origin": "*"})
                return
            if path == manifest["book_text"]["path"]:
                route.fulfill(body=book, content_type="application/gzip",
                              headers={"Access-Control-Allow-Origin": "*"})
                return
            for index, entry in enumerate(entries):
                if path != entry["o"]:
                    continue
                state["page_attempts"].append(index + 1)
                if fail_page_once and index == 0 and state["page_attempts"].count(1) == 1:
                    route.fulfill(status=503, body="retry", headers={"Access-Control-Allow-Origin": "*"})
                else:
                    route.fulfill(body=data[index], content_type="application/gzip",
                                  headers={"Access-Control-Allow-Origin": "*"})
                return
            route.fulfill(status=404)
        page.route("**/api/reader-bucket-resource?**", asset)
    params = {"url": SOURCE, "ext": "djvu", "title": "Synthetic original"}
    if ocr:
        params["ocr_manifest"] = api + "/api/reader-bucket-resource?" + urlencode({"path": ocr_path})
    state["url"] = origin + prefix + "/static/reader.html?" + urlencode(params)
    return state


def separated_pages():
    """Place inert IFF chunks between pages, so each lies in a different 1 MiB range."""
    count = int.from_bytes(RAW[25:27], "big")
    if count != 3:
        raise ValueError("unexpected synthetic directory")
    offsets = [int.from_bytes(RAW[27 + 4*i:31 + 4*i], "big") for i in range(count)]
    gap = b"JUNK" + struct.pack(">I", 1024 * 1024) + bytes(1024 * 1024)
    result = bytearray(RAW[:offsets[1]] + gap + RAW[offsets[1]:offsets[2]] + gap + RAW[offsets[2]:])
    result[8:12] = (len(result) - 12).to_bytes(4, "big")
    for index, offset in enumerate(offsets):
        result[27 + 4*index:31 + 4*index] = (offset + len(gap)*index).to_bytes(4, "big")
    return bytes(result)
