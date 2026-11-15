const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {IDBFactory} = require('fake-indexeddb');

const filename = path.join(__dirname, '../../../static/search/search-session.js');
const source = fs.readFileSync(filename, 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail('IndexedDB checkpoint was not reached');
}

function fixture() {
  const factory = new IDBFactory();
  const timers = new Map();
  let nextTimer = 0;
  const h = {opens: 0, closes: 0, writes: [], terminals: [], openHook: null, transactionHook: null, openError: null};
  const location = {href: 'https://example.test/search/?q=first'};
  const history = {
    state: {foreign: {value: 7}}, replacements: [],
    replaceState(state, title, url) {
      this.state = state;
      this.replacements.push(url);
      location.href = url;
    }
  };
  const indexedDB = {
    open(...args) {
      h.opens++;
      if (h.openError) throw h.openError;
      const request = factory.open(...args);
      request.addEventListener('success', () => {
        const db = request.result;
        const close = db.close.bind(db);
        db.close = () => { h.closes++; close(); };
        const transaction = db.transaction.bind(db);
        db.transaction = (...txArgs) => {
          const tx = transaction(...txArgs);
          tx.addEventListener('complete', () => h.terminals.push('complete'));
          tx.addEventListener('abort', () => h.terminals.push('abort'));
          if (tx.mode === 'readwrite') {
            const objectStore = tx.objectStore.bind(tx);
            const instrumented = new WeakSet();
            tx.objectStore = name => {
              const store = objectStore(name);
              if (!instrumented.has(store)) {
                instrumented.add(store);
                const put = store.put.bind(store);
                store.put = (value, key) => { h.writes.push(value.url); return put(value, key); };
              }
              return store;
            };
          }
          return h.transactionHook ? h.transactionHook(tx) : tx;
        };
      });
      return h.openHook ? h.openHook(request) : request;
    }
  };
  const context = vm.createContext({
    indexedDB, window: Object.assign(new EventTarget(), {indexedDB}), location, history, URL,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context, {filename});
  h.create = (options = {}) => context.VoiceOfMLSearchSession.createSearchSession({
    canPersist: () => true, canRestore: () => true, ...options
  });
  h.session = h.create();
  h.location = location;
  h.history = history;
  h.timers = timers;
  h.expire = () => {
    for (const [id, callback] of [...timers]) {
      if (timers.delete(id)) callback();
    }
  };
  h.saved = async () => {
    const request = factory.open('voiceofml-search-state', 1);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction('session', 'readonly');
      const get = tx.objectStore('session').get('last-search');
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      return get.result;
    } finally { db.close(); }
  };
  return h;
}

// Delay delivery, not the fake IndexedDB backend: inspect final committed data too.
function holdOpen(h) {
  let release;
  h.openHook = request => new Proxy(request, {
    set(target, key, value) {
      if (key === 'onsuccess') target.onsuccess = event => { release = () => value(event); };
      else target[key] = value;
      return true;
    },
    get(target, key) { return target[key]; }
  });
  return {ready: () => !!release, release: () => { h.openHook = null; release(); }};
}

function holdTerminal(h, {abortThrows = false, failPut = false, requestError = false, preventError = false} = {}) {
  let release;
  let captured = false;
  let aborts = 0;
  h.transactionHook = tx => {
    if (captured || tx.mode !== 'readwrite') return tx;
    captured = true;
    let requestErrorEvent;
    tx.addEventListener('error', event => {
      requestErrorEvent = event;
      if (preventError) event.preventDefault();
    });
    return new Proxy(tx, {
      set(target, key, value) {
        if (key === 'oncomplete' || key === 'onabort') {
          target[key] = event => { release = () => value(event); };
        } else target[key] = value;
        return true;
      },
      get(target, key) {
        if (key === 'abort') return () => {
          aborts++;
          if (abortThrows) throw new Error('injected abort failure');
          target.abort();
          // fake-indexeddb 6.2.7 repeats the default abort even when an error
          // listener already aborted the transaction, then removes it twice.
          // Suppress only that redundant default after a successful explicit
          // abort; still require the real abort event and committed-data checks.
          requestErrorEvent?.preventDefault();
        };
        if (key === 'objectStore') return name => {
          const store = target.objectStore(name);
          if (failPut) store.put = () => { throw new Error('injected synchronous put failure'); };
          if (requestError) store.put = (value, entry) => store.add(value, entry);
          return store;
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  return {ready: () => !!release, release: () => release(), aborts: () => aborts};
}

const options = {timeout: 5000};

test('save captures its URL before the database opens', options, async () => {
  const h = fixture(), held = holdOpen(h);
  const before = h.location.href;
  const pending = h.session.persistSearchSession();
  await until(held.ready);
  h.location.href = 'https://example.test/reader/?book=next';
  held.release();
  await pending;
  assert.equal((await h.saved()).url, before);
  assert.deepEqual(h.writes, [before]);
});

test('delayed open serializes adapters and coalesces pending saves to the newest URL', options, async () => {
  const h = fixture(), held = holdOpen(h);
  const first = h.session.persistSearchSession();
  await until(held.ready);
  const other = h.create();
  h.location.href = 'https://example.test/search/?q=second';
  const pending = other.persistSearchSession();
  for (let i = 0; i < 2000; i++) {
    h.location.href = `https://example.test/search/?q=${i}`;
    assert.equal(h.session.persistSearchSession(), pending, 'one shared pending promise');
  }
  assert.equal(h.opens, 1);
  const latest = h.location.href;
  held.release();
  await Promise.all([first, pending]);
  assert.equal((await h.saved()).url, latest);
  assert.deepEqual(h.writes, ['https://example.test/search/?q=first', latest]);
});

test('timed out opens stay bounded, close late connections and resume only after native success', options, async () => {
  const h = fixture(), held = holdOpen(h);
  const first = h.session.persistSearchSession();
  await until(held.ready);
  h.expire();
  await first;
  h.location.href = 'https://example.test/search/?q=latest';
  const pending = h.session.persistSearchSession();
  h.expire();
  await pending;
  for (let i = 0; i < 2000; i++) assert.equal(h.session.persistSearchSession(), pending);
  assert.equal(h.opens, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.writes, []);
  held.release();
  await until(() => h.writes.length === 1 && h.terminals.length === 1);
  assert.equal((await h.saved()).url, h.location.href);
  assert.equal(h.closes, 2, 'late abandoned connection and successful writer both close');
});

for (const fault of [
  {name: 'timeout with throwing abort', abortThrows: true},
  {name: 'synchronous put failure', failPut: true},
  {name: 'request error', requestError: true},
  {name: 'cancelled request error with throwing abort', requestError: true, abortThrows: true, preventError: true}
]) {
  test(`${fault.name} cannot release a writer before native complete or abort delivery`, options, async () => {
    const h = fixture();
    if (fault.requestError) await h.session.persistSearchSession();
    const opens = h.opens;
    const held = holdTerminal(h, fault);
    const first = h.session.persistSearchSession();
    await until(held.ready);
    h.location.href = 'https://example.test/search/?q=newer';
    const pending = h.session.persistSearchSession();
    h.expire();
    await Promise.all([first, pending]);
    assert.equal(held.aborts(), 1);
    for (let i = 0; i < 2000; i++) assert.equal(h.session.persistSearchSession(), pending);
    assert.equal(h.opens, opens + 1, 'no replacement open before terminal delivery');
    assert.equal(h.timers.size, 0, 'stalled worker retains no growing timeout list');
    const terminalCount = h.terminals.length;
    held.release();
    await until(() => h.terminals.length > terminalCount);
    assert.equal((await h.saved()).url, h.location.href);
  });
}

test('timeout abort returning is not native abort completion', options, async t => {
  const h = fixture();
  let release;
  let aborts = 0;
  let heldTransaction;
  t.after(() => {
    // A failed checkpoint must not leave the emulator's keep-alive loop running.
    try { heldTransaction?.abort(); } catch (_) {}
  });
  h.transactionHook = tx => {
    h.transactionHook = null;
    heldTransaction = tx;
    // Hold a real transaction live with successive requests until abort().
    const store = tx.objectStore('session');
    function keepAlive() { store.get('keep-alive').onsuccess = keepAlive; }
    keepAlive();
    return new Proxy(tx, {
      set(target, key, value) {
        target[key] = key === 'onabort' ? event => { release = () => value(event); } : value;
        return true;
      },
      get(target, key) {
        if (key === 'abort') return () => { aborts++; target.abort(); };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  const first = h.session.persistSearchSession();
  await until(() => h.writes.length === 1);
  h.location.href = 'https://example.test/search/?q=after-abort';
  const pending = h.session.persistSearchSession();
  h.expire();
  await Promise.all([first, pending]);
  assert.equal(aborts, 1);
  assert.equal(h.opens, 1);
  await until(() => !!release);
  assert.equal(h.opens, 1);
  release();
  await until(() => h.writes.length === 2 && h.terminals.includes('complete'));
  assert.equal((await h.saved()).url, h.location.href);
});

test('read success followed by abort never restores a provisional URL', options, async () => {
  const h = fixture();
  await h.session.persistSearchSession();
  h.location.href = 'https://example.test/search/';
  h.transactionHook = tx => {
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const store = objectStore(name), get = store.get.bind(store);
      store.get = key => {
        const request = get(key);
        request.addEventListener('success', () => tx.abort());
        return request;
      };
      return store;
    };
    return tx;
  };
  assert.equal(await h.session.restoreSearchSession(), false);
  assert.deepEqual(h.history.replacements, []);
  assert.equal(h.location.href, 'https://example.test/search/');
});

test('restore waits for completion, rechecks policy and preserves current foreign history state', options, async () => {
  const h = fixture();
  const saved = h.location.href;
  await h.session.persistSearchSession();
  let release;
  h.transactionHook = tx => new Proxy(tx, {
    set(target, key, value) {
      target[key] = key === 'oncomplete' ? event => { release = () => value(event); } : value;
      return true;
    },
    get(target, key) {
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  h.location.href = 'https://example.test/search/';
  const pending = h.session.restoreSearchSession();
  await until(() => !!release);
  assert.deepEqual(h.history.replacements, []);
  const state = {foreign: ['updated', 42]};
  h.history.state = state;
  release();
  assert.equal(await pending, true);
  assert.equal(h.history.state, state);
  assert.equal(h.location.href, saved);

  release = null;
  let allowed = true;
  const guarded = h.create({canRestore: () => allowed});
  const stale = guarded.restoreSearchSession();
  await until(() => !!release);
  allowed = false;
  release();
  assert.equal(await stale, false);
  assert.equal(h.history.replacements.length, 1);
});

test('a read deadline prevents later completion from publishing', options, async () => {
  const h = fixture();
  await h.session.persistSearchSession();
  let release;
  h.transactionHook = tx => new Proxy(tx, {
    set(target, key, value) {
      target[key] = key === 'oncomplete' ? event => { release = () => value(event); } : value;
      return true;
    },
    get(target, key) {
      if (key === 'abort') return () => { throw new Error('already completing'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const pending = h.session.restoreSearchSession();
  await until(() => !!release);
  h.expire();
  assert.equal(await pending, false);
  release();
  await turn();
  assert.deepEqual(h.history.replacements, []);
});

test('unavailable storage and disabled policy settle without leaking work', options, async () => {
  const h = fixture();
  const disabled = h.create({canPersist: () => false, canRestore: () => false});
  await disabled.persistSearchSession();
  assert.equal(await disabled.restoreSearchSession(), false);
  assert.equal(h.opens, 0);
  h.openError = new Error('storage unavailable');
  await h.session.persistSearchSession();
  await h.session.persistSearchSession();
  assert.equal(await h.session.restoreSearchSession(), false);
});
