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
          const request = indexedDB.open("voice-search-positions", 4);
          request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
            for (const name of ["positions", "viewports", "recent-pages"]) {
              const store = db.createObjectStore(name, {keyPath: name === "recent-pages" ? "id" : "key"});
              store.createIndex("savedAt", "savedAt");
            }
          };
          request.onerror = request.onblocked = finish;
          request.onsuccess = () => {
            const db = request.result;
            if (expired || owner !== revision) { db.close(); return; }
            database = db;
            db.onversionchange = () => { db.close(); if (database === db) close(); };
            try {
              const transaction = db.transaction("positions", "readwrite");
              const completion = VoiceOfMLSearchSession.watchTransaction(transaction);
              const store = transaction.objectStore("positions");
              /** @type {SearchPosition[]} */
              const retained = [];
              const read = store.getAll();
              read.onsuccess = () => {
                let count = 0;
                const values = /** @type {SearchPosition[]} */ (read.result).sort((a, b) => b.savedAt - a.savedAt);
                for (const value of values) {
                  if (!VoiceOfMLPositionPolicy.validPosition(value) || ++count > VoiceOfMLPositionPolicy.POSITION_MAX) store.delete(value.key);
                  else retained.push(value);
                }
              };
              void completion.result.then(success => {
                // The startup deadline releases its waiter, not this connection's
                // hydration. A committed late read must still fill missing keys.
                if (success && owner === revision && database === db) accept(retained);
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
  Object.assign(globalThis, {VoiceOfMLPositionStorage: {create, pruneContent}});
})();
