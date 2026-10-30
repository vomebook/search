"""Offline smoke checks for the DjVu benchmark; timings are not pass thresholds."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

from scripts.benchmarks import benchmark_djvu as bench
from scripts.benchmarks import compare_djvu


ROOT = Path(__file__).resolve().parents[1]
PREFIX = '/search' if '/search/static/' in (ROOT / 'static/reader.html').read_text() else ''


class DjvuBenchmarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    def run_benchmark(self, **options):
        with bench.local_server(ROOT, PREFIX) as origin:
            return bench.measure(self.browser, origin, fixture='long', prefix=PREFIX,
                                 mode='normal', stall_ms=0, target=20, timeout=30000,
                                 trace_path=None, **options)

    def test_normal_run_measures_canvas_text_and_avoids_page_images(self):
        result = self.run_benchmark()
        self.assertEqual(result['first']['count'], 24)
        self.assertGreater(result['first']['marks']['firstCanvas'], 0)
        self.assertGreater(result['jump']['ms'], 0)
        self.assertGreater(result['target_text_characters'], 0)
        self.assertRegex(result['target_canvas_sha256'], r'^[0-9a-f]{64}$')
        self.assertFalse(any(row['kind'] == 'reading_image' for row in result['requests']))
        self.assertTrue(any(row['kind'] == 'source' and row['status'] == 206 for row in result['source_at_first']))

    def test_already_pinned_source_avoids_revision_request(self):
        result = self.run_benchmark(pinned_revision='a' * 40)
        self.assertFalse(any(row['kind'] == 'revision' for row in result['requests']))
        self.assertTrue(any(row['kind'] == 'source' and row['status'] == 206 for row in result['requests']))

    def test_stall_and_trace_are_distinct_modes(self):
        with tempfile.TemporaryDirectory() as directory, bench.local_server(ROOT, PREFIX) as origin:
            stalled = bench.measure(self.browser, origin, fixture='small', prefix=PREFIX,
                                    mode='stall', stall_ms=250, target=2, timeout=30000, trace_path=None)
            self.assertTrue(any(row['kind'] == 'source' and
                                row.get('headers_ms', 0) - row['start_ms'] >= 200
                                for row in stalled['requests']))
            path = Path(directory) / 'trace.zip'
            traced = bench.measure(self.browser, origin, fixture='small', prefix=PREFIX,
                                   mode='trace', stall_ms=0, target=2, timeout=30000, trace_path=path)
            self.assertTrue(path.is_file())
            self.assertGreater(path.stat().st_size, 0)
            self.assertGreater(traced['first']['marks']['firstCanvas'], 0)

    def test_ocr_mismatch_does_not_fetch_external_page(self):
        with bench.local_server(ROOT, PREFIX) as origin:
            result = bench.measure(self.browser, origin, fixture='ocr', prefix=PREFIX, mode='normal',
                                   stall_ms=0, target=2, timeout=30000, trace_path=None, ocr_mismatch=True)
        self.assertTrue(all(row['range'] is None for row in result['requests'] if row['kind'] == 'source'))
        self.assertTrue(result['target_text_characters'])

    def test_comparison_preserves_pixel_and_text_equality(self):
        sample = {'target_canvas_sha256': 'a'*64, 'target_text_sha256': 'b'*64,
                  'target_text_characters': 10, 'live_source_validator_sha256': None,
                  'first': {'marks': {'firstCanvas': 100}}, 'jump': {'width': 10, 'height': 20, 'ms': 30}}
        compare_djvu.assert_same_output({'baseline':sample,'candidate':dict(sample)})
        with self.assertRaisesRegex(ValueError, 'target_canvas_sha256'):
            compare_djvu.assert_same_output({'baseline':sample,'candidate':{**sample,'target_canvas_sha256':'c'*64}})
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'comparison.json'
            subprocess.run([sys.executable,'-B',str(ROOT/'scripts/benchmarks/compare_djvu.py'),
                            '--baseline-root',str(ROOT),'--candidate-root',str(ROOT),'--pairs','1',
                            '--fixture','small','--target','2','--output',str(output)],
                           cwd=ROOT, check=True, capture_output=True, timeout=60)
            report = json.loads(output.read_text())
        self.assertTrue(report['complete'])
        self.assertEqual(len(report['pairs']),1)
        self.assertEqual(report['pairs'][0]['baseline']['target_canvas_sha256'],
                         report['pairs'][0]['candidate']['target_canvas_sha256'])


if __name__ == '__main__':
    unittest.main()
