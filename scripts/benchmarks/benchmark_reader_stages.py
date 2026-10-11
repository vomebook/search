"""Opt-in, read-only PDF image Reader timing in isolated Chromium contexts."""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright


FIRST_PAGE_MARKS = """(() => {
  const marks = window.__readerStageMarks = { firstImage: null, firstOcr: null };
  function check() {
    const shell = document.querySelector('.reader-page[data-page="1"]');
    const image = shell?.querySelector('img.ready');
    if (marks.firstImage === null && image?.complete && image.naturalWidth > 0)
      marks.firstImage = performance.now();
    if (marks.firstOcr === null && shell?.dataset.textReady === '1' &&
        shell.querySelector('.reader-pdf-text')?.textContent.trim())
      marks.firstOcr = performance.now();
    if (marks.firstImage === null || marks.firstOcr === null) requestAnimationFrame(check);
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', check, { once: true });
  else check();
})()"""

JUMP_MARKS = """async ({ target, timeout }) => {
  const input = document.querySelector('#page-number');
  const viewport = document.querySelector('#viewport');
  const started = performance.now();
  let positioned = null, imageReady = null, ocrReady = null;
  const initial = document.querySelector(`.reader-page[data-page="${target}"] img.ready`);
  const cachedBeforeJump = Boolean(initial?.complete && initial.naturalWidth > 0);
  input.value = String(target);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return new Promise((resolve, reject) => {
    function check() {
      const shell = document.querySelector(`.reader-page[data-page="${target}"]`);
      if (document.documentElement.dataset.readerPhase === 'failed')
        return reject(new Error(`Reader failed: ${document.querySelector('#content')?.dataset.errorCode}`));
      if (shell && input.value === String(target) &&
          Math.abs(viewport.scrollTop - Math.min(shell.offsetTop,
            viewport.scrollHeight - viewport.clientHeight)) < 4 && positioned === null)
        positioned = performance.now() - started;
      const image = shell?.querySelector('img.ready');
      if (imageReady === null && image?.complete && image.naturalWidth > 0)
        imageReady = performance.now() - started;
      if (ocrReady === null && shell?.dataset.textReady === '1' &&
          shell.querySelector('.reader-pdf-text')?.textContent.trim())
        ocrReady = performance.now() - started;
      if (positioned !== null && imageReady !== null && ocrReady !== null)
        return resolve({ positionMs: positioned, imageMs: imageReady,
          ocrMs: ocrReady, imageReadyBeforeJump: cachedBeforeJump });
      if (performance.now() - started > timeout)
        return reject(new Error(`Jump timed out: position=${positioned}, image=${imageReady}, OCR=${ocrReady}`));
      requestAnimationFrame(check);
    }
    check();
  });
}"""

SEARCH_MARKS = """async ({ query, timeout }) => {
  const input = document.querySelector('#full-search-input');
  const status = document.querySelector('#full-search-status');
  const started = performance.now();
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise((resolve, reject) => {
    function check() {
      const result = /^(\\d+) 个结果$/.exec(status.textContent.trim());
      if (result) return resolve({ completeMs: performance.now() - started,
        total: Number(result[1]) });
      if (performance.now() - started > timeout)
        return reject(new Error(`Search timed out: ${status.textContent.trim()}`));
      requestAnimationFrame(check);
    }
    check();
  });
}"""


def measure(page, reader_url, target, query, timeout):
    pending = set()
    page.on("request", lambda request: pending.add(request))
    page.on("requestfinished", lambda request: pending.discard(request))
    page.on("requestfailed", lambda request: pending.discard(request))
    page.add_init_script(FIRST_PAGE_MARKS)
    page.goto(reader_url, wait_until="domcontentloaded", timeout=timeout)
    try:
        page.wait_for_function("""() => {
          const marks = window.__readerStageMarks;
          return document.documentElement.dataset.readerPhase === 'failed' ||
            (document.documentElement.dataset.readerPhase === 'ready' &&
             marks?.firstImage != null && marks?.firstOcr != null);
        }""", timeout=timeout)
    except PlaywrightTimeoutError as error:
        state = page.evaluate("""() => ({phase: document.documentElement.dataset.readerPhase,
          status: document.querySelector('#status')?.textContent,
          error: document.querySelector('#content')?.dataset.errorCode,
          marks: window.__readerStageMarks})""")
        outstanding = sorted({urlsplit(request.url).netloc + urlsplit(request.url).path
                              for request in pending})[:8]
        raise RuntimeError(f"First-page image/OCR timed out: {state}; pending={outstanding}") from error
    state = page.evaluate("""() => ({
      phase: document.documentElement.dataset.readerPhase,
      mode: document.querySelector('#content')?.dataset.mode,
      error: document.querySelector('#content')?.dataset.errorCode,
      pageCount: Number(document.querySelector('#page-number')?.max),
      marks: window.__readerStageMarks
    })""")
    if state["phase"] != "ready" or state["mode"] != "pdf-pages":
        raise RuntimeError(f"Expected a ready pdf-pages Reader: {state}")
    if target > state["pageCount"]:
        raise RuntimeError(f"Target page {target} exceeds {state['pageCount']}")
    if page.locator("#full-search-toggle").evaluate("node => node.hidden"):
        raise RuntimeError("Full-text search is unavailable; use a PDF with a complete OCR index")
    jump = page.evaluate(JUMP_MARKS, {"target": target, "timeout": timeout})
    page.locator("#history").click(timeout=timeout)
    page.locator("#full-search-toggle").click(timeout=timeout)
    search = page.evaluate(SEARCH_MARKS, {"query": query, "timeout": timeout})
    if search["total"] < 1:
        raise RuntimeError("The query produced no results; use a known index term")
    return {
        "pageCount": state["pageCount"],
        "firstImageMs": round(state["marks"]["firstImage"], 1),
        "firstOcrMs": round(state["marks"]["firstOcr"], 1),
        "jumpPositionMs": round(jump["positionMs"], 1),
        "targetImageMs": round(jump["imageMs"], 1),
        "targetOcrMs": round(jump["ocrMs"], 1),
        "targetImageReadyBeforeJump": jump["imageReadyBeforeJump"],
        "searchCompleteMs": round(search["completeMs"], 1),
        "searchTotal": search["total"],
    }


def clear_reader_progress(context, origin):
    page = context.new_page()
    page.route("**/__reader_stage_baseline__", lambda route: route.fulfill(
        status=200, content_type="text/plain", body="baseline"))
    try:
        page.goto(origin + "/__reader_stage_baseline__")
        page.evaluate("""() => new Promise((resolve, reject) => {
          const request = indexedDB.open('voiceofml-reader');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('entries')) {
              db.close();
              return reject(new Error('Reader progress store is missing'));
            }
            const transaction = db.transaction('entries', 'readwrite');
            transaction.objectStore('entries').clear();
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => { db.close(); reject(transaction.error); };
          };
        })""")
    finally:
        page.close()


def run(reader_url, target, query, pairs=1, timeout=120000, width=1440, height=900,
        configure_page=None):
    parsed = urlsplit(reader_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("--reader-url must be an HTTP(S) URL")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    report = {"capturedAt": datetime.now(timezone.utc).isoformat(), "origin": origin,
              "readerUrlSha256": hashlib.sha256(reader_url.encode()).hexdigest(),
              "targetPage": target, "querySha256": hashlib.sha256(query.encode()).hexdigest(),
              "viewport": {"width": width, "height": height}, "serviceWorkers": "blocked",
              "runs": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            report["chromiumVersion"] = browser.version
            for pair in range(1, pairs + 1):
                context = browser.new_context(viewport={"width": width, "height": height},
                                              service_workers="block")
                try:
                    for cache in ("cold", "warm"):
                        if cache == "warm":
                            clear_reader_progress(context, origin)
                        page = context.new_page()
                        try:
                            if configure_page:
                                configure_page(page)
                            result = measure(page, reader_url, target, query, timeout)
                        finally:
                            page.close()
                        report["runs"].append({"pair": pair, "cache": cache, **result})
                finally:
                    context.close()
        finally:
            browser.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reader-url", required=True, help="PDF-pages Reader URL with OCR metadata")
    parser.add_argument("--page", type=int, required=True, help="target page (at least 2)")
    parser.add_argument("--query", required=True, help="known OCR index term with at least one hit")
    parser.add_argument("--pairs", type=int, default=1, help="fresh cold/warm context pairs (default: 1)")
    parser.add_argument("--timeout-ms", type=int, default=120000)
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    args = parser.parse_args()
    if args.page < 2 or args.pairs < 1 or args.timeout_ms < 1000 or args.width < 320 or args.height < 320 or not args.query.strip():
        parser.error("invalid page, pairs, timeout, viewport or query")
    print(json.dumps(run(args.reader_url, args.page, args.query.strip(), args.pairs,
                         args.timeout_ms, args.width, args.height), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
