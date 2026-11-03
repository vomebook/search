"""Exercise scroll-anchor ownership against a real browser DOM."""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright


SOURCE = Path(__file__).resolve().parents[1] / "static/reader/ui/reader-scroll-anchor.js"


class ScrollAnchorBrowserTests(unittest.TestCase):
    def test_real_dom_preserves_position_and_disposes_pending_work(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
            try:
                page = browser.new_page()
                page.set_content('<div id="viewport" style="height:100px;width:200px;overflow:auto">'
                                 '<div style="height:100px"></div><p id="anchor" style="margin:0;height:20px">'
                                 'line</p><div style="height:1000px"></div></div>')
                page.add_script_tag(path=str(SOURCE))
                result = page.evaluate('''() => {
                  const viewport = document.querySelector('#viewport');
                  const anchor = document.querySelector('#anchor');
                  const frames = new Map(), timers = new Map();
                  let frameId = 0, timerId = 0;
                  const manager = VoiceOfMLReaderScroll.createScrollAnchorManager({
                    viewport, candidates: () => [anchor],
                    requestFrame: fn => { frames.set(++frameId, fn); return frameId; },
                    cancelFrame: id => frames.delete(id),
                    setTimer: fn => { timers.set(++timerId, fn); return timerId; },
                    clearTimer: id => timers.delete(id)
                  });
                  // An undefined anchor reaches the native Node.contains call.
                  manager.unobserve(anchor);
                  viewport.scrollTop = 80;
                  const snapshot = manager.capture();
                  manager.preserve(() => {
                    const gap = document.createElement('div'); gap.style.height = '25px';
                    anchor.parentNode.insertBefore(gap, anchor);
                  });
                  const offset = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
                  viewport.dispatchEvent(new Event('wheel'));
                  const before = viewport.scrollTop, scrolling = manager.scrolling;
                  const restored = manager.restore(manager.capture());
                  manager.dispose();
                  return {selected: snapshot.node === anchor, offsetError: Math.abs(offset - snapshot.offset),
                    scrolling, restored, before, after: viewport.scrollTop, frames: frames.size, timers: timers.size};
                }''')
                self.assertTrue(result["selected"])
                self.assertLess(result["offsetError"], 0.6)
                self.assertTrue(result["scrolling"])
                self.assertFalse(result["restored"])
                self.assertEqual(result["before"], result["after"])
                self.assertEqual((result["frames"], result["timers"]), (0, 0))
            finally:
                browser.close()
