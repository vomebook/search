from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import time
import unittest
from datetime import datetime, timezone
from urllib.request import Request, urlopen

from tests.browser_support import local_server

RESULTS_PATH = os.path.join(os.path.dirname(__file__), "benchmark-results.json")
API_URL = os.environ.get("GITHUB_SEARCH_API_BASE_URL", "").rstrip("/")


def _git_sha():
    try:
        return subprocess.run(
            ["git", "log", "-1", "--format=%H"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return ""


def _save_results(project, queries):
    existing = {"results": []}
    if os.path.isfile(RESULTS_PATH):
        try:
            with open(RESULTS_PATH) as f:
                existing = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    existing.setdefault("results", []).append({
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "project": project,
        "git_sha": _git_sha(),
        "queries": queries,
    })
    existing["results"] = existing["results"][-50:]
    with open(RESULTS_PATH, "w") as f:
        json.dump(existing, f, indent=2, ensure_ascii=False)


def _print_and_collect(results_list, label, iterations, times):
    median = statistics.median(times)
    mn = min(times)
    mx = max(times)
    print(f"  {label:<46s} median={median:>8.3f}ms  min={mn:>8.3f}ms  max={mx:>8.3f}ms  (n={iterations})")
    results_list.append({
        "label": label.strip(),
        "iterations": iterations,
        "median_ms": round(median, 3),
        "min_ms": round(mn, 3),
        "max_ms": round(mx, 3),
    })


# ===== Live API benchmarks (hits external HF Search API) =====

@unittest.skipIf(not API_URL, "set GITHUB_SEARCH_API_BASE_URL")
class ApiSearchBenchmarkTests(unittest.TestCase):
    _results: list = []

    def _bench(self, label, path, payload=None, iterations=5):
        times = []
        for i in range(iterations + 1):
            body = json.dumps(payload).encode() if payload else None
            req = Request(API_URL + path, data=body,
                          headers={"Content-Type": "application/json"} if body else {})
            start = time.perf_counter()
            with urlopen(req, timeout=120) as r:
                r.read()
            elapsed = (time.perf_counter() - start) * 1000
            if i > 0:
                times.append(elapsed)
        _print_and_collect(self._results, label, iterations, times)

    def test_search_api_benchmarks(self):
        self._bench('"手机" normal', "/api/search", {"q": "手机"})
        self._bench('"手机" exact', "/api/search", {"q": "手机", "exact": True})
        self._bench('"文化革命" exact', "/api/search", {"q": "文化革命", "exact": True})
        self._bench('"文化 革命" normal', "/api/search", {"q": "文化 革命"})
        self._bench('"手。机" exact', "/api/search", {"q": "手。机", "exact": True})
        self._bench('"手*机" exact', "/api/search", {"q": "手*机", "exact": True})
        self._bench('"手?机" exact', "/api/search", {"q": "手?机", "exact": True})
        self._bench('"文" exact', "/api/search", {"q": "文", "exact": True})
        self._bench('"ABC" normal', "/api/search", {"q": "ABC"})
        self._bench('sources', "/api/sources")

    @classmethod
    def tearDownClass(cls):
        if cls._results:
            _save_results("github-Search-api", cls._results)


# ===== Browser benchmarks (Playwright, local static server) =====

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "install requirements-test.txt, run: playwright install chromium")
class BrowserSearchBenchmarkTests(unittest.TestCase):
    _results: list = []

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])

    @classmethod
    def tearDownClass(cls):
        if cls._results:
            _save_results("github-Search-browser", cls._results)
        cls.browser.close()
        cls.playwright.stop()

    def _bench_search(self, label, query, base_url, iterations=3):
        ctx = self.browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        times = []
        for i in range(iterations + 1):
            page.goto(base_url + "/search/")
            page.wait_for_selector("#results-list .result-item", timeout=30000)
            inp = page.locator("#search-input")
            start = time.perf_counter()
            inp.fill(query)
            page.wait_for_function(f"""
                location.hash.includes('q=' + encodeURIComponent({json.dumps(query)}))
            """, timeout=15000)
            elapsed = (time.perf_counter() - start) * 1000
            if i > 0:
                times.append(elapsed)
        ctx.close()
        _print_and_collect(self._results, label, iterations, times)

    def test_browser_search_benchmarks(self):
        with local_server() as (base_url, _state):
            self._bench_search('"手机" normal', "手机", base_url)
            self._bench_search('"文化革命" exact', "文化革命", base_url)
            self._bench_search('"手*机" exact', "手*机", base_url)
