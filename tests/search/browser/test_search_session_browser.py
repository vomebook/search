"""Exercise the actual IndexedDB session adapter in Chromium."""
import unittest

from tests.reader.browser import test_reader_pdf_followup as support


class SearchSessionBrowserTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def open_session_fixture(self):
        self.page.route("**/search-session-fixture*", lambda route: route.fulfill(
            status=200, content_type="text/html", body="<!doctype html><title>Session</title>"))
        self.page.goto(self.origin + "/search-session-fixture?q=first")
        self.page.add_script_tag(url=self.origin + support.PREFIX + "/static/search/search-session.js")

    def test_session_persist_and_restore_with_real_indexeddb(self):
        self.open_session_fixture()
        result = self.page.evaluate("""async () => {
          const session = VoiceOfMLSearchSession.createSearchSession({
            canPersist: () => true,
            canRestore: target => !target || target.origin === location.origin
          });
          const before = location.href;
          await session.persistSearchSession();
          history.replaceState(null, '', '?q=other');
          return {before, restored: await session.restoreSearchSession(), after: location.href};
        }""")
        self.assertTrue(result["restored"])
        self.assertEqual(result["after"], result["before"])

    def test_malformed_and_disallowed_entries_do_not_replace_history(self):
        self.open_session_fixture()
        result = self.page.evaluate("""async () => {
          const session = VoiceOfMLSearchSession.createSearchSession({
            canPersist: () => true,
            canRestore: target => !target || target.origin === location.origin
          });
          const values = [null, 1, [], {}, {version: 2, url: location.href},
            {version: 1, url: 42}, {version: 1, url: 'not a valid URL'},
            {version: 1, url: 'https://other.invalid/'}];
          const before = location.href, results = [];
          for (const value of values) {
            const db = await session.openSearchSessionDB();
            await new Promise((resolve, reject) => {
              const tx = db.transaction('session', 'readwrite');
              tx.objectStore('session').put(value, 'last-search');
              tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
            });
            db.close();
            results.push(await session.restoreSearchSession());
          }
          return {before, after: location.href, results};
        }""")
        self.assertEqual(result["results"], [False] * 8)
        self.assertEqual(result["after"], result["before"])

    def test_disabled_policy_does_not_create_or_restore_a_session(self):
        self.open_session_fixture()
        result = self.page.evaluate("""async () => {
          const session = VoiceOfMLSearchSession.createSearchSession({
            canPersist: () => false, canRestore: () => false
          });
          await session.persistSearchSession();
          const restored = await session.restoreSearchSession();
          return {restored, databases: (await indexedDB.databases()).map(item => item.name)};
        }""")
        self.assertFalse(result["restored"])
        self.assertNotIn("voiceofml-search-state", result["databases"])


if __name__ == "__main__":
    unittest.main()
