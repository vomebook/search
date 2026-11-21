"""Exercise IndexedDB sessions and filter result snapshots in Chromium."""
import mimetypes
import os
from pathlib import Path
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from tests.reader.browser import test_reader_pdf_followup as support


class SearchSessionBrowserTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def open_session_fixture(self):
        self.page.route("**/search-session-fixture*", lambda route: route.fulfill(
            status=200, content_type="text/html", body="<!doctype html><title>Session</title>"))
        self.page.goto(self.origin + "/search-session-fixture?q=first")
        self.page.add_script_tag(url=self.origin + support.PREFIX + "/static/search/execution/application/session.js")

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
        self.page.wait_for_function('!!positionStorage.database', timeout=8000)
        result = self.page.evaluate('''async () => {
          positionStorage.close();
          const request=indexedDB.open('voice-search-positions',5);
          const blocker=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
          const deletion=indexedDB.deleteDatabase('voice-search-positions');
          let deleted=false; deletion.onsuccess=()=>{deleted=true};
          await initSearchPositions();
          const openedBefore=!!positionStorage.database;
          blocker.close();
          for(let i=0;i<50&&!deleted;i++) await new Promise(resolve=>setTimeout(resolve,20));
          await new Promise(resolve=>setTimeout(resolve,100));
          return {openedBefore,deleted,openedAfter:!!positionStorage.database};
        }''')
        self.assertEqual(result, {'openedBefore':False, 'deleted':True, 'openedAfter':False})

    def test_delayed_session_read_does_not_override_new_navigation(self):
        self.open_session_fixture()
        observed = self.page.evaluate("""async () => {
          history.replaceState(null, '', '?old');
          const allowed = () => !location.search || location.search === '?old';
          const session = VoiceOfMLSearchSession.createSearchSession({
            canPersist: () => true, canRestore: target => !target ? allowed() : target.origin === location.origin
          });
          await session.persistSearchSession();
          const nativeOpen = indexedDB.open.bind(indexedDB);
          let release;
          indexedDB.open = (...args) => {
            const actual = nativeOpen(...args), proxy = {};
            Object.defineProperties(proxy, {
              result: {get: () => actual.result}, error: {get: () => actual.error},
              onupgradeneeded: {set: handler => { actual.onupgradeneeded = handler; }},
              onerror: {set: handler => { actual.onerror = handler; }},
              onblocked: {set: handler => { actual.onblocked = handler; }},
              onsuccess: {set: handler => { actual.onsuccess = event => { release = () => handler(event); }; }}
            });
            return proxy;
          };
          try {
            const pending = session.restoreSearchSession();
            while (!release) await new Promise(resolve => setTimeout(resolve, 1));
            history.replaceState(null, '', '?new');
            release();
            return {restored: await pending, search: location.search};
          } finally { indexedDB.open = nativeOpen; }
        }""")
        self.assertEqual(observed, {"restored": False, "search": "?new"})


    def test_independent_position_and_session_databases_open_in_parallel(self):
        self.page.goto(self.origin + support.PREFIX + "/static/reader.html")
        test_page = self.context.new_page()
        errors = []
        test_page.on('pageerror', lambda error: errors.append(str(error)))
        test_page.add_init_script("""(() => {
          window.__dbOpenNames = [];
          const open = indexedDB.open.bind(indexedDB);
          indexedDB.open = function(name, ...args) {
            window.__dbOpenNames.push(name);
            const request = open(name, ...args);
            if (name !== 'voice-search-positions') return request;
            const proxy = {};
            for (const field of ['result','error','transaction','readyState'])
              Object.defineProperty(proxy, field, {get: () => request[field]});
            for (const field of ['onupgradeneeded','onerror','onblocked'])
              Object.defineProperty(proxy, field, {set: handler => { request[field] = handler; }});
            Object.defineProperty(proxy, 'onsuccess', {set: handler => {
              request.onsuccess = event => { window.__releasePositionOpen = () => handler(event); };
            }});
            return proxy;
          };
        })();""")
        try:
            shell = (support.ROOT / 'static/index.html').read_text()
            destination = self.origin + (support.PREFIX + '/' if support.PREFIX else '/')
            test_page.route(destination, lambda route: route.fulfill(content_type='text/html', body=shell))
            test_page.goto(destination, wait_until='domcontentloaded')
            test_page.wait_for_function("typeof window.__releasePositionOpen === 'function'")
            test_page.wait_for_function("window.__dbOpenNames.includes('voiceofml-search-state')", timeout=800)
            self.assertFalse(test_page.evaluate("routeInitialized"))
            test_page.evaluate('window.__releasePositionOpen()')
            test_page.wait_for_function('routeInitialized')
            self.assertEqual(errors, [])
        finally:
            test_page.close()


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


class FilterSnapshotBrowserTests(unittest.TestCase):
    def test_mirror_toggle_does_not_restore_pdf_for_txt_filter(self):
        root = Path(__file__).resolve().parents[3]
        origin = 'https://search-fixture.test'
        prefix = '/search'
        entry = '/search/#/?q=ownership&local=0'
        requests = []
        inventory = [{'name': ext, 'count': 1} for ext in ('pdf', 'txt')]
        rows = [dict(Repo='VoiceOfML/Test', File='ownership', Extension=ext, Folder=[], Size=1)
                for ext in ('pdf', 'txt')]

        def fulfill(route):
            url = urlsplit(route.request.url)
            path = url.path
            if path == '/api/search' and route.request.method == 'POST':
                body = route.request.post_data_json
                extensions = body.get('extensions', [])
                requests.append(extensions)
                results = [row for row in rows if not extensions or row['Extension'] in extensions]
                route.fulfill(json=dict(results=results, total=len(results), page=1, page_size=body['page_size']),
                              headers={'Access-Control-Allow-Origin': '*'})
            elif path == '/api/search' and route.request.method == 'OPTIONS':
                route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*',
                                                  'Access-Control-Allow-Headers': 'content-type'})
            elif path.startswith('/api/'):
                data = {'/api/extensions': inventory, '/api/repos': [],
                        '/api/bootstrap': {'repos': [], 'extensions': inventory}}
                route.fulfill(json=data.get(path, {}), headers={'Access-Control-Allow-Origin': '*'})
            elif url.hostname == 'search-fixture.test' and path == prefix + '/':
                route.fulfill(path=root / 'static/index.html', content_type='text/html')
            elif url.hostname == 'search-fixture.test' and path.startswith(prefix + '/static/'):
                asset = root / path.removeprefix(prefix).lstrip('/')
                if asset.is_file():
                    route.fulfill(path=asset, content_type=mimetypes.guess_type(asset)[0])
                else:
                    route.fulfill(status=404)
            else:
                route.abort()

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'),
                args=['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'])
            context = browser.new_context(service_workers='block', viewport={'width': 1280, 'height': 800})
            context.route('**/*', fulfill)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("Object.defineProperty(navigator, 'onLine', {get: () => true});")
            page.goto(origin + entry, wait_until='domcontentloaded')
            txt = page.locator('#filter-ext-list input[value="txt"]')
            txt.wait_for(state='attached', timeout=5000)
            pdf_row = page.locator('.result-item[aria-label="ownership.pdf"]')
            pdf_copy = pdf_row.locator('[data-action="copy"]')
            self.assertIn('hf-mirror.com', pdf_copy.get_attribute('data-link', timeout=5000))

            page.clock.install()
            page.clock.pause_at(page.evaluate('Date.now() + 100'))
            txt.evaluate('input => input.click()')
            self.assertTrue(page.evaluate('filterSearchTimer !== null'))
            page.locator('#mirror-links-toggle').evaluate('input => input.click()')
            self.assertEqual(urlsplit(pdf_copy.get_attribute('data-link')).hostname, 'huggingface.co')
            self.assertEqual(requests, [[]])

            page.clock.run_for(200)
            page.clock.resume()
            page.wait_for_function('filterSearchTimer === null && !STATE.isLoading', timeout=5000)
            self.assertEqual(
                (page.locator('.result-item').evaluate_all('rows => rows.map(row => row.ariaLabel)'), requests),
                (['ownership.txt'], [[], ['txt']]),
            )
            self.assertEqual(errors, [])
            context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
