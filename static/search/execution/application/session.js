// Shared IndexedDB session plumbing. The application supplies route policy;
// this module owns database opening and transaction completion only.
(function (root) {
    const DB_NAME = "voiceofml-search-state";
    const SESSION_TIMEOUT_MS = 1500;

    // A deadline settles the caller, but only a native terminal event retires
    // the operation. In particular, blocked opens cannot be cancelled.
    function startSessionOpen() {
      /** @type {() => void} */
      let finish = () => {};
      /** @type {Promise<void>} */
      const finished = new Promise(resolve => { finish = resolve; });
      /** @type {Promise<IDBDatabase>} */
      const result = new Promise((resolve, reject) => {
        /** @type {IDBOpenDBRequest} */
        let request;
        try {
          if (!window.indexedDB) throw new Error("IndexedDB unavailable");
          request = indexedDB.open(DB_NAME, 1);
        } catch (error) {
          finish();
          reject(error);
          return;
        }
        let settled = false;
        const timer = setTimeout(() => fail(new Error("IndexedDB open timed out")), SESSION_TIMEOUT_MS);
        /** @param {unknown} error */
        function fail(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error || new Error("IndexedDB unavailable"));
        }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("session")) request.result.createObjectStore("session");
        };
        request.onsuccess = () => {
          const db = request.result;
          finish();
          if (settled) { db.close(); return; }
          settled = true;
          clearTimeout(timer);
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => { finish(); fail(request.error); };
        request.onblocked = () => fail(new Error("IndexedDB open blocked"));
      });
      return { result, finished };
    }

    /** @returns {Promise<IDBDatabase>} */
    function openSearchSessionDB() {
      return startSessionOpen().result;
    }

    /** @param {IDBTransaction} transaction */
    function watchTransaction(transaction) {
      /** @type {(success: boolean) => void} */
      let settle = () => {};
      /** @type {() => void} */
      let finish = () => {};
      /** @type {Promise<boolean>} */
      const result = new Promise(resolve => { settle = resolve; });
      /** @type {Promise<void>} */
      const finished = new Promise(resolve => { finish = resolve; });
      let failed = false;
      function fail() {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        settle(false);
        // abort() may throw or return before onabort. Neither releases a writer.
        try { transaction.abort(); } catch (_) {}
      }
      const timer = setTimeout(fail, SESSION_TIMEOUT_MS);
      transaction.onerror = fail;
      transaction.onabort = () => { clearTimeout(timer); settle(false); finish(); };
      transaction.oncomplete = () => { clearTimeout(timer); settle(!failed); finish(); };
      return { result, finished, fail };
    }

    /** @typedef {{version: number, url: string, updatedAt: number}} SessionSnapshot */
    /** @typedef {{snapshot: SessionSnapshot, result: Promise<void>, settle: () => void}} SaveBatch */
    // Shared by adapters in this document: one active operation and one latest
    // pending snapshot, with a shared (bounded) wait for every pending caller.
    /** @type {SaveBatch | null} */
    let pendingSave = null;
    let saving = false;

    /** @param {SessionSnapshot} snapshot @returns {SaveBatch} */
    function createSaveBatch(snapshot) {
      /** @type {() => void} */
      let settle = () => {};
      /** @type {Promise<void>} */
      const result = new Promise(resolve => {
        const timer = setTimeout(resolve, SESSION_TIMEOUT_MS);
        settle = () => { clearTimeout(timer); resolve(); };
      });
      return { snapshot, result, settle };
    }

    async function drainSaves() {
      saving = true;
      try {
        while (pendingSave) {
          const batch = pendingSave;
          pendingSave = null;
          const opening = startSessionOpen();
          /** @type {IDBDatabase | undefined} */
          let db;
          /** @type {ReturnType<typeof watchTransaction> | undefined} */
          let completion;
          try {
            db = await opening.result;
            const transaction = db.transaction("session", "readwrite");
            const watched = watchTransaction(transaction);
            completion = watched;
            try {
              const store = transaction.objectStore("session");
              const request = store.get("last-search");
              request.onerror = watched.fail;
              request.onsuccess = () => {
                // Other documents have independent queues. Compare and write
                // under the same transaction so a late open cannot regress it.
                // A future timestamp is not authoritative after clock rollback.
                const saved = request.result;
                if (saved && typeof saved.updatedAt === "number" &&
                    Number.isFinite(saved.updatedAt) && saved.updatedAt > batch.snapshot.updatedAt &&
                    saved.updatedAt <= Date.now()) return;
                try {
                  store.put(batch.snapshot, "last-search");
                } catch (_) {
                  watched.fail();
                }
              };
            } catch (_) {
              watched.fail();
            }
            await completion.result;
          } catch (_) {
            // Persistence is best effort. A failed open/transaction must not
            // leak a rejection into the search UI.
          } finally {
            if (db) db.close();
            batch.settle();
          }
          // A permanently stalled native operation parks this single worker.
          // New saves replace the one pending snapshot; no promise chain grows.
          await opening.finished;
          if (completion) await completion.finished;
        }
      } finally {
        saving = false;
      }
    }

    /** @param {{canPersist: () => boolean, canRestore: (target?: URL) => boolean}} options */
    function createSearchSession({ canPersist, canRestore }) {
      function persistSearchSession() {
        if (!canPersist()) return Promise.resolve();
        // Capture eligibility and the immutable value together, before any await.
        const snapshot = { version: 1, url: location.href, updatedAt: Date.now() };
        if (pendingSave) pendingSave.snapshot = snapshot;
        else pendingSave = createSaveBatch(snapshot);
        const result = pendingSave.result;
        if (!saving) void drainSaves();
        return result;
      }

      async function restoreSearchSession() {
        if (!canRestore()) return false;
        const startingHref = location.href;
        // Navigation entry identity is independent of classic history.state.
        const navigation = /** @type {Window & {navigation?: {currentEntry?: {key?: string} | null}}} */ (window).navigation;
        const startingKey = navigation?.currentEntry?.key;
        let cancelled = false;
        const cancel = () => { cancelled = true; };
        const events = ["popstate", "hashchange", "pagehide", "input", "compositionstart", "compositionupdate", "compositionend"];
        let db;
        try {
          for (const type of events) window.addEventListener(type, cancel, true);
          db = await openSearchSessionDB();
          const transaction = db.transaction("session", "readonly");
          const completion = watchTransaction(transaction);
          /** @type {unknown} */
          let saved;
          try {
            const request = transaction.objectStore("session").get("last-search");
            request.onsuccess = () => { saved = request.result; };
            request.onerror = completion.fail;
          } catch (_) {
            completion.fail();
          }
          // Request success is provisional: an abort later in the same
          // transaction must never publish a saved URL.
          if (!await completion.result) return false;
          if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1 ||
              !("url" in saved) || typeof saved.url !== "string") return false;
          const target = new URL(saved.url);
          // A user may have navigated while IndexedDB was opening or reading.
          if (cancelled || location.href !== startingHref ||
              (startingKey !== undefined && navigation?.currentEntry?.key !== startingKey) ||
              !canRestore() || !canRestore(target)) return false;
          history.replaceState(history.state, "", target.href);
          return true;
        } catch (_) {
          return false;
        } finally {
          for (const type of events) window.removeEventListener(type, cancel, true);
          if (db) db.close();
        }
      }

      return { openSearchSessionDB, persistSearchSession, restoreSearchSession };
    }

    Object.assign(root, { VoiceOfMLSearchSession: /** @satisfies {SearchSessionApi} */ ({ createSearchSession, watchTransaction }) });
})(typeof self !== "undefined" ? self : globalThis);
