"""Run the local CHM navigation control with pristine chapter/search modules.

The content is the same exact existing offline candidate as the experiment.
Only loopback and Playwright local fulfillments are permitted by the parent
fixture. This compares controls without changing the shared test worktree.
"""
import subprocess

from tests import test_chm_webkit_boundary_diagnostic_20261105 as diagnostic


class PristineWebkitControl(diagnostic.WebkitBoundaryDiagnostic):
    def setUp(self):
        super().setUp()
        self.pristine_fulfilled = []
        for relative in ('formats/reader-chapter-format.mjs', 'search/reader-search-backends.mjs'):
            path = 'static/reader/' + relative
            raw = subprocess.check_output(['git', 'show', 'HEAD:' + path], cwd=diagnostic.compat.HERE)
            def handler(route, request, *, body=raw, name=path):
                self.pristine_fulfilled.append(name)
                route.fulfill(status=200, content_type='text/javascript', body=body)
            self.page.route('**/' + path, handler)

    def test_trace_third_candidate(self):
        self.skipTest('the pristine control does not provide the local legacy search bridge')

    def test_toc_navigation_without_search_bridge_acquisition(self):
        try:
            return super().test_toc_navigation_without_search_bridge_acquisition()
        finally:
            print('pristine-modules-fulfilled', sorted(self.pristine_fulfilled), flush=True)
