// Shared IndexedDB session plumbing. The application supplies route policy;
// this module owns database opening and transaction completion only.
(function (root) {
    const DB_NAME = "voiceofml-search-state";
    const SESSION_TIMEOUT_MS = 1500;

    /** @returns {Promise<IDBDatabase>} */
    function openSearchSessionDB() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
        const request = indexedDB.open(DB_NAME, 1);
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
          if (settled) { db.close(); return; }
          settled = true;
          clearTimeout(timer);
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error("IndexedDB open blocked"));
      });
    }

    /** @template T @param {IDBRequest<T>} request @param {IDBTransaction} transaction @returns {Promise<T>} */
    function readSessionValue(request, transaction) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { transaction.abort(); } catch (_) {}
          reject(new Error("IndexedDB read timed out"));
        }, SESSION_TIMEOUT_MS);
        request.onsuccess = () => {
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(request.result);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(request.error);
        };
      });
    }

    /** @param {IDBTransaction} transaction @returns {Promise<void>} */
    function waitForTransaction(transaction) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { transaction.abort(); } catch (_) {}
          reject(new Error("IndexedDB transaction timed out"));
        }, SESSION_TIMEOUT_MS);
        transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
        transaction.onerror = transaction.onabort = () => { clearTimeout(timer); reject(transaction.error); };
      });
    }

    /** @param {{canPersist: () => boolean, canRestore: (target?: URL) => boolean}} options */
    function createSearchSession({ canPersist, canRestore }) {
      async function persistSearchSession() {
        if (!canPersist()) return;
        let db;
        try {
          db = await openSearchSessionDB();
          const transaction = db.transaction("session", "readwrite");
          transaction.objectStore("session").put(
            { version: 1, url: location.href, updatedAt: Date.now() },
            "last-search"
          );
          await waitForTransaction(transaction);
        } catch (_) {
          // Session persistence is best effort and must never block search.
        } finally {
          if (db) db.close();
        }
      }

      async function restoreSearchSession() {
        if (!canRestore()) return false;
        let db;
        try {
          db = await openSearchSessionDB();
          const transaction = db.transaction("session", "readonly");
          const request = transaction.objectStore("session").get("last-search");
          /** @type {unknown} */
          const saved = await readSessionValue(request, transaction);
          if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1 ||
              !("url" in saved) || typeof saved.url !== "string") return false;
          const target = new URL(saved.url);
          // A user may have navigated while IndexedDB was opening or reading.
          if (!canRestore() || !canRestore(target)) return false;
          history.replaceState(null, "", target.href);
          return true;
        } catch (_) {
          return false;
        } finally {
          if (db) db.close();
        }
      }

      return { openSearchSessionDB, persistSearchSession, restoreSearchSession };
    }

    Object.assign(root, { VoiceOfMLSearchSession: /** @satisfies {SearchSessionApi} */ ({ createSearchSession }) });
})(typeof self !== "undefined" ? self : globalThis);
