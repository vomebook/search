"""Session-only native IndexedDB regressions; select Chromium or Firefox explicitly."""
import contextlib
import functools
import http.server
import os
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]


class SessionTransactionBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = contextlib.ExitStack()
        cls.addClassCleanup(stack.close)

        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(
            ('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(3)))
        cls.origin = f'http://127.0.0.1:{server.server_port}'
        playwright = stack.enter_context(sync_playwright())
        engine = os.environ.get('SEARCH_SESSION_BROWSER', 'chromium')
        if engine not in ('chromium', 'firefox'):
            raise ValueError('SEARCH_SESSION_BROWSER must be chromium or firefox')
        cls.browser = getattr(playwright, engine).launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.addCleanup(self.context.close)
        self.context.route('**/*', lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + '/') else route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        errors = []
        self.page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, []))
        self.page.route('**/session-fixture*', lambda route: route.fulfill(
            content_type='text/html', body='<!doctype html><title>Session transaction</title>'))
        self.page.goto(self.origin + '/session-fixture?q=first')
        self.page.add_script_tag(url=self.origin + '/static/search/search-session.js')
        self.page.evaluate('''() => {
          window.session = VoiceOfMLSearchSession.createSearchSession({
            canPersist: () => true, canRestore: target => !target || target.origin === location.origin
          });
          window.until = async predicate => {
            const deadline = performance.now() + 5000;
            while (!predicate()) {
              if (performance.now() > deadline) throw new Error('session checkpoint timed out');
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          };
          window.readSaved = async () => {
            const db = await session.openSearchSessionDB();
            try {
              const tx = db.transaction('session', 'readonly');
              const get = tx.objectStore('session').get('last-search');
              await new Promise((resolve, reject) => {
                tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
              });
              return get.result;
            } finally { db.close(); }
          };
        }''')

    def test_delayed_open_captures_url_and_coalesces_the_latest_save(self):
        result = self.page.evaluate('''async () => {
          const open = indexedDB.open.bind(indexedDB), put = IDBObjectStore.prototype.put;
          let release, opens = 0;
          const writes = [];
          IDBObjectStore.prototype.put = function(value, ...args) {
            writes.push(value.url); return put.call(this, value, ...args);
          };
          indexedDB.open = (...args) => {
            opens++;
            const request = open(...args);
            if (opens !== 1) return request;
            return new Proxy(request, {
              get: (target, key) => target[key],
              set(target, key, value) {
                target[key] = key === 'onsuccess' ? event => { release = () => value(event); } : value;
                return true;
              }
            });
          };
          try {
            const original = location.href;
            const first = session.persistSearchSession();
            await until(() => !!release);
            history.replaceState(null, '', '?q=second');
            const pending = session.persistSearchSession();
            let shared = true;
            for (let i = 0; i < 2000; i++) {
              // Only the final URL matters to persistence; avoid browser history rate limits.
              shared = shared && session.persistSearchSession() === pending;
            }
            history.replaceState(null, '', '?q=latest');
            shared = shared && session.persistSearchSession() === pending;
            const latest = location.href, beforeRelease = opens;
            release();
            await Promise.all([first, pending]);
            const saved = await readSaved();
            return {original, latest, beforeRelease, shared, writes, saved: saved.url};
          } finally { indexedDB.open = open; IDBObjectStore.prototype.put = put; }
        }''')
        self.assertEqual(result['beforeRelease'], 1)
        self.assertTrue(result['shared'])
        self.assertEqual(result['writes'], [result['original'], result['latest']])
        self.assertEqual(result['saved'], result['latest'])

    def test_read_success_followed_by_native_abort_does_not_restore(self):
        result = self.page.evaluate('''async () => {
          await session.persistSearchSession();
          history.replaceState({foreign: 7}, '', '?q=current');
          const get = IDBObjectStore.prototype.get;
          let succeeded = false, aborted = false;
          IDBObjectStore.prototype.get = function(...args) {
            const request = get.apply(this, args), tx = this.transaction;
            request.addEventListener('success', () => { succeeded = true; tx.abort(); });
            tx.addEventListener('abort', () => { aborted = true; });
            return request;
          };
          try {
            const restored = await session.restoreSearchSession();
            await until(() => aborted);
            return {restored, succeeded, aborted, search: location.search, state: history.state};
          } finally { IDBObjectStore.prototype.get = get; }
        }''')
        self.assertEqual(result, dict(restored=False, succeeded=True, aborted=True,
                                      search='?q=current', state={'foreign': 7}))

    def test_restore_waits_for_native_completion_and_keeps_foreign_state(self):
        result = self.page.evaluate('''async () => {
          await session.persistSearchSession();
          history.replaceState({foreign: ['keep', 42]}, '', '?q=current');
          const transaction = IDBDatabase.prototype.transaction;
          let release, nativeComplete = false;
          IDBDatabase.prototype.transaction = function(...args) {
            const tx = transaction.apply(this, args);
            tx.addEventListener('complete', () => { nativeComplete = true; });
            return new Proxy(tx, {
              get(target, key) {
                const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
              },
              set(target, key, value) {
                target[key] = key === 'oncomplete' ? event => { release = () => value(event); } : value;
                return true;
              }
            });
          };
          try {
            const pending = session.restoreSearchSession();
            await until(() => !!release);
            const beforeRelease = location.search;
            release();
            return {beforeRelease, nativeComplete, restored: await pending,
                    search: location.search, state: history.state};
          } finally { IDBDatabase.prototype.transaction = transaction; }
        }''')
        self.assertEqual(result, dict(beforeRelease='?q=current', nativeComplete=True,
                                      restored=True, search='?q=first', state={'foreign': ['keep', 42]}))

    def test_pending_restore_cancels_on_observed_navigation_and_input(self):
        for action in ('href', 'popstate', 'hashchange', 'pagehide', 'input',
                       'compositionstart', 'compositionupdate', 'compositionend', 'entry', 'traversal'):
            with self.subTest(action=action):
                result = self.page.evaluate('''async action => {
                  history.replaceState(null, '', '?q=saved');
                  await session.persistSearchSession();
                  history.replaceState({foreign:42}, '', '/session-fixture');
                  if (action === 'traversal') history.pushState(history.state, '', location.href);
                  const transaction = IDBDatabase.prototype.transaction;
                  let release;
                  IDBDatabase.prototype.transaction = function(...args) {
                    const tx = transaction.apply(this, args);
                    return new Proxy(tx, {
                      get(target, key) {
                        const value = target[key];
                        return typeof value === 'function' ? value.bind(target) : value;
                      },
                      set(target, key, value) {
                        target[key] = key === 'oncomplete' ? event => { release = () => value(event); } : value;
                        return true;
                      }
                    });
                  };
                  try {
                    const pending = session.restoreSearchSession();
                    await until(() => !!release);
                    const hasKey = !!window.navigation?.currentEntry?.key;
                    if (action === 'href') history.replaceState(history.state, '', '/session-fixture-other');
                    else if (action === 'traversal') {
                      await new Promise(resolve => {
                        window.addEventListener('popstate', resolve, {once:true});
                        history.back();
                      });
                    } else if (action === 'entry') {
                      history.pushState(history.state, '', location.href);
                      // Engines without entry keys rely on observable traversal.
                      if (!hasKey) window.dispatchEvent(new PopStateEvent('popstate'));
                    } else window.dispatchEvent(new Event(action));
                    const expected = location.href;
                    release();
                    const restored = await pending;
                    return {restored, unchanged:location.href === expected, state:history.state};
                  } finally { IDBDatabase.prototype.transaction = transaction; }
                }''', action)
                self.assertEqual(result, dict(restored=False, unchanged=True, state={'foreign': 42}))

    def test_restore_cancellation_listeners_are_removed_after_every_attempt(self):
        result = self.page.evaluate('''async () => {
          await session.persistSearchSession();
          const add = window.addEventListener, remove = window.removeEventListener;
          const live = new Map();
          window.addEventListener = function(type, listener, options) {
            if (options === true) live.set(type, listener);
            return add.call(this, type, listener, options);
          };
          window.removeEventListener = function(type, listener, options) {
            if (live.get(type) === listener) live.delete(type);
            return remove.call(this, type, listener, options);
          };
          try {
            const first = await session.restoreSearchSession();
            const afterSuccess = live.size;
            window.dispatchEvent(new Event('input'));
            const second = await session.restoreSearchSession();
            const open = indexedDB.open;
            indexedDB.open = () => { throw new Error('unavailable'); };
            let failed;
            try { failed = await session.restoreSearchSession(); }
            finally { indexedDB.open = open; }
            return {first, second, failed, afterSuccess, afterFailure:live.size};
          } finally { window.addEventListener = add; window.removeEventListener = remove; }
        }''')
        self.assertEqual(result, dict(first=True, second=True, failed=False, afterSuccess=0, afterFailure=0))

    def test_error_and_timeout_wait_for_native_abort_before_reopening(self):
        for failure in ('request-error', 'timeout'):
            with self.subTest(failure=failure):
                result = self.page.evaluate('''async failure => {
                  await session.persistSearchSession();
                  const transaction = IDBDatabase.prototype.transaction;
                  const open = indexedDB.open.bind(indexedDB);
                  let opens = 0, captured = false, release, nativeAbort = false, opensAtAbort;
                  indexedDB.open = (...args) => { opens++; return open(...args); };
                  IDBDatabase.prototype.transaction = function(...args) {
                    const tx = transaction.apply(this, args);
                    if (captured || tx.mode !== 'readwrite') return tx;
                    captured = true;
                    tx.addEventListener('abort', () => { nativeAbort = true; opensAtAbort = opens; });
                    const store = tx.objectStore('session');
                    if (failure === 'timeout') {
                      // Keep a native transaction active until the adapter's real deadline aborts it.
                      const keepAlive = () => { store.get('keep-alive').onsuccess = keepAlive; };
                      keepAlive();
                    }
                    return new Proxy(tx, {
                      get(target, key) {
                        if (key === 'objectStore') return name => {
                          const current = target.objectStore(name);
                          if (failure === 'request-error') current.put = current.add.bind(current);
                          return current;
                        };
                        const value = target[key];
                        return typeof value === 'function' ? value.bind(target) : value;
                      },
                      set(target, key, value) {
                        target[key] = key === 'onabort' ? event => { release = () => value(event); } : value;
                        return true;
                      }
                    });
                  };
                  try {
                    const first = session.persistSearchSession();
                    await until(() => captured);
                    history.replaceState(null, '', '?q=' + failure);
                    const next = session.persistSearchSession();
                    // Callers must settle while the adapter's native terminal
                    // handler is still held. Releasing it first hides deadlocks.
                    let deadline;
                    const callersSettledBeforeRelease = await Promise.race([
                      Promise.all([first, next]).then(() => true),
                      new Promise(resolve => { deadline = setTimeout(() => resolve(false), 3000); })
                    ]).finally(() => clearTimeout(deadline));
                    if (!callersSettledBeforeRelease) {
                      throw new Error('save callers did not settle within 3s while abort delivery was held');
                    }
                    await until(() => !!release);
                    const opensBeforeRelease = opens;
                    if (opensBeforeRelease !== 1) {
                      throw new Error('write queue reopened before held abort delivery');
                    }
                    release();
                    await until(() => opens === 2);
                    const saved = await readSaved();
                    return {nativeAbort, opensAtAbort, opensBeforeRelease, callersSettledBeforeRelease,
                            saved: new URL(saved.url).search};
                  } finally {
                    indexedDB.open = open;
                    IDBDatabase.prototype.transaction = transaction;
                  }
                }''', failure)
                self.assertEqual(result, dict(nativeAbort=True, opensAtAbort=1,
                                              opensBeforeRelease=1, callersSettledBeforeRelease=True,
                                              saved='?q=' + failure))


if __name__ == '__main__':
    unittest.main()
