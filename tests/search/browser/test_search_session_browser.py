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

    def test_blocked_open_does_not_leave_a_late_database_connection(self):
        self.open_session_fixture()
        result = self.page.evaluate('''async () => {
          const open = indexedDB.open.bind(indexedDB);
          const request = open('voiceofml-search-state', 1);
          const blocker = await new Promise((resolve, reject) => {
            request.onupgradeneeded = () => request.result.createObjectStore('session');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          const deletion = indexedDB.deleteDatabase('voiceofml-search-state');
          const blocked = new Promise(resolve => { deletion.onblocked = resolve; });
          await blocked;
          const session = VoiceOfMLSearchSession.createSearchSession({canPersist:()=>true,canRestore:()=>true});
          let lateClosed = false, lateOpened = false;
          const close = IDBDatabase.prototype.close;
          IDBDatabase.prototype.close = function() { lateClosed = true; return close.call(this); };
          indexedDB.open = (...args) => {
            const pending = open(...args);
            pending.addEventListener('success', () => { lateOpened = true; });
            return pending;
          };
          const retry = session.openSearchSessionDB().then(()=>'opened',error=>error.message);
          const outcome = await retry;
          close.call(blocker);
          for (let i=0; i<50 && !lateOpened; i++) await new Promise(resolve => setTimeout(resolve, 20));
          indexedDB.open = open;
          IDBDatabase.prototype.close = close;
          return {outcome, lateClosed, lateOpened};
        }''')
        self.assertRegex(result['outcome'], 'blocked|timed out')
        self.assertTrue(result['lateOpened'])
        self.assertTrue(result['lateClosed'])

    def test_search_initializes_when_browser_storage_is_unavailable(self):
        self.page.route(self.origin + '/search/', lambda route: route.fulfill(
            content_type='text/html', body=(support.ROOT / 'static/index.html').read_text()))
        self.page.route('**/api/search**', lambda route: route.fulfill(status=200, content_type='application/json',
            body='{"results":[],"total":0,"page":1,"page_size":100}'))
        self.page.add_init_script('''(() => {
          const open = indexedDB.open.bind(indexedDB);
          indexedDB.open = (name, version) => {
            if (name !== 'voiceofml-search-state') return open(name, version);
            const request = {onblocked:null}; setTimeout(() => request.onblocked?.({}), 0); return request;
          };
          for (const name of ['getItem','setItem']) {
            const original = Storage.prototype[name];
            Storage.prototype[name] = function(...args) {
              if (this === window.localStorage) throw new DOMException('blocked', 'SecurityError');
              return original.apply(this,args);
            };
          }
        })()''')
        self.page.goto(self.origin + '/search/', wait_until='domcontentloaded')
        self.page.wait_for_function("typeof DOM !== 'undefined' && !!DOM.searchInput && DOM.themeBtn?.getAttribute('aria-label')", timeout=5000)
        self.page.locator('#search-input').fill('storage-proof')
        self.page.wait_for_function("STATE.query === 'storage-proof'", timeout=5000)
        self.page.evaluate('toggleTheme(); toggleMobile();')
        self.assertEqual(self.page.evaluate('STATE.query'), 'storage-proof')

    def test_expired_position_open_does_not_retain_a_late_connection(self):
        self.page.route(self.origin + '/search/', lambda route: route.fulfill(
            content_type='text/html', body=(support.ROOT / 'static/index.html').read_text()))
        self.page.goto(self.origin + '/search/', wait_until='domcontentloaded')
        self.page.wait_for_function('!!searchPositionDB', timeout=8000)
        result = self.page.evaluate('''async () => {
          searchPositionDB.close(); searchPositionDB=null;
          const request=indexedDB.open('voice-search-positions',4);
          const blocker=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
          const deletion=indexedDB.deleteDatabase('voice-search-positions');
          let deleted=false; deletion.onsuccess=()=>{deleted=true};
          await initSearchPositions();
          const openedBefore=!!searchPositionDB;
          blocker.close();
          for(let i=0;i<50&&!deleted;i++) await new Promise(resolve=>setTimeout(resolve,20));
          await new Promise(resolve=>setTimeout(resolve,100));
          return {openedBefore,deleted,openedAfter:!!searchPositionDB};
        }''')
        self.assertEqual(result, {'openedBefore':False, 'deleted':True, 'openedAfter':False})

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
