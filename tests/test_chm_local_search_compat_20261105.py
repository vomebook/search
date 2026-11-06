"""Run the existing loopback-only CHM fixture against this isolated checkout.

No remote Reader, real browser profile or production object is touched.  The
shared fixture and candidate bundle files are reused read-only, never edited.
"""
import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parents[1]
FIXTURE = Path('/tmp/opencode/chm-search-integration-pages-20261102/tests/test_chm_local_search_integration.py')
spec = importlib.util.spec_from_file_location('chm_existing_loopback_fixture', FIXTURE)
if spec is None or spec.loader is None:
    raise RuntimeError('existing CHM fixture unavailable')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.CHECKOUT = HERE
fixture.PREFIX = '/search' if '/search/static/' in (HERE / 'static/reader.html').read_text() else ''
LocalChmSearchIntegration = fixture.LocalChmSearchIntegration
