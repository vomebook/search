// Owns the connection and native transaction lifetime; callers keep memory fallback.
(function () {
  /** @param {IDBObjectStore} store @param {number} limit @param {number} ttl */
  function pruneContent(store, limit, ttl) {
    const index = store.index("savedAt");
    const expired = index.openKeyCursor(IDBKeyRange.upperBound(Date.now() - ttl, true));
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
    };
    let skipped = false;
    const retained = index.openKeyCursor(null, "prev");
    retained.onsuccess = () => {
      const cursor = retained.result;
      if (!cursor) return;
      if (!skipped) { skipped = true; cursor.advance(limit); return; }
      store.delete(cursor.primaryKey); cursor.continue();
    };
  }

  /** @param {SearchPosition[]} values @param {(position: SearchPosition) => void} [discard] */
  function retainPositions(values, discard) {
    // Invalid timestamps must not affect the order of otherwise valid rows.
    const valid = values.filter(value => {
      if (VoiceOfMLPositionPolicy.validPosition(value)) return true;
      discard?.(value);
      return false;
    }).sort((a, b) => b.savedAt - a.savedAt);
    const limit = VoiceOfMLPositionPolicy.POSITION_MAX;
    if (discard) for (const value of valid.slice(limit)) discard(value);
    return valid.slice(0, limit);
  }

  /** @returns {SearchPositionStorage} */
  function create() {
    /** @type {IDBDatabase | null} */
    let database = null;
    let revision = 0;
    function close() { revision++; database?.close(); database = null; }
    /** @param {(values: SearchPosition[]) => void} accept */
    function init(accept) {
      close();
      const owner = revision;
      return /** @type {Promise<void>} */ (new Promise(resolve => {
        let expired = false;
        const finish = () => { expired = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, 1500);
        try {
          const request = indexedDB.open("voice-search-positions", 5);
          request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of ["positions", "viewports", "recent-pages"]) {
              const keyPath = name === "recent-pages" ? "id" : "key";
              let store = db.objectStoreNames.contains(name) ? /** @type {IDBTransaction} */ (request.transaction).objectStore(name) : null;
              // An incompatible key ABI cannot safely be read or rewritten in place.
              if (store && (store.keyPath !== keyPath || store.autoIncrement)) {
                db.deleteObjectStore(name);
                store = null;
              }
              if (!store) store = db.createObjectStore(name, {keyPath});
              if (store.indexNames.contains("savedAt")) {
                const index = store.index("savedAt");
                if (index.keyPath !== "savedAt" || index.unique || index.multiEntry) store.deleteIndex("savedAt");
              }
              if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt");
            }
          };
          request.onerror = request.onblocked = finish;
          request.onsuccess = () => {
            const db = request.result;
            if (expired || owner !== revision) { db.close(); return; }
            database = db;
            db.onversionchange = () => { db.close(); if (database === db) close(); };
            try {
              const transaction = db.transaction("positions", "readonly");
              const completion = VoiceOfMLSearchSession.watchTransaction(transaction);
              const read = transaction.objectStore("positions").getAll();
              void completion.result.then(success => {
                // A committed late read can still fill missing keys, but only
                // for the current connection. Startup need not wait for deletes.
                if (success && owner === revision && database === db) {
                  const values = /** @type {SearchPosition[]} */ (read.result);
                  const retained = retainPositions(values);
                  accept(retained);
                  if (retained.length < values.length) setTimeout(() => {
                    if (owner !== revision || database !== db) return;
                    // Recheck current values within the write transaction: a
                    // different tab may have refreshed a row since the read.
                    try {
                      const store = db.transaction("positions", "readwrite").objectStore("positions");
                      const latest = store.getAll();
                      latest.onsuccess = () => retainPositions(latest.result, value => store.delete(value.key));
                    } catch (_) {}
                  }, 0);
                }
                finish();
              });
            } catch (_) { finish(); }
          };
        } catch (_) { finish(); }
      }));
    }
    /** @param {string} name @param {IDBValidKey} key @param {number} [timeoutMs]
     * @param {AbortSignal | null} [signal] @returns {Promise<unknown>} */
    function read(name, key, timeoutMs = 150, signal = null) {
      if (!database?.objectStoreNames.contains(name) || signal?.aborted) return Promise.resolve(null);
      return new Promise(resolve => {
        let settled = false;
        /** @type {unknown} */
        let value = null;
        /** @param {unknown} result */
        const finish = result => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result);
        };
        const abort = () => finish(null);
        const timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener("abort", abort, {once: true});
        try {
          const transaction = /** @type {IDBDatabase} */ (database).transaction(name);
          const request = transaction.objectStore(name).get(key);
          request.onsuccess = () => { value = request.result; };
          request.onerror = transaction.onerror = transaction.onabort = abort;
          transaction.oncomplete = () => finish(value);
        } catch (_) { abort(); }
      });
    }
    /** @param {string} name @param {object[]} values @param {number} limit @param {number} ttl */
    function writeContent(name, values, limit, ttl) {
      if (!values.length || !database?.objectStoreNames.contains(name)) return;
      try {
        const store = database.transaction(name, "readwrite").objectStore(name);
        for (const value of values) store.put(value);
        pruneContent(store, limit, ttl);
      } catch (_) {}
    }
    /** @param {SearchPosition} position @param {boolean} prune */
    function writePosition(position, prune) {
      if (!database) return;
      try {
        const transaction = database.transaction("positions", "readwrite");
        const store = transaction.objectStore("positions");
        store.put(position);
        let count = 0;
        if (prune) {
          const request = store.index("savedAt").openCursor(null, "prev");
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (!VoiceOfMLPositionPolicy.validPosition(cursor.value) || ++count > VoiceOfMLPositionPolicy.POSITION_MAX) cursor.delete();
            cursor.continue();
          };
        }
        transaction.onabort = () => {}; // Memory restoration remains available.
      } catch (_) {}
    }
    return {get database() { return database; }, close, init, read, writeContent, writePosition};
  }
  Object.assign(globalThis, {VoiceOfMLPositionStorage: {create}});
})();
