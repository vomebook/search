// Shared IndexedDB session plumbing. The application supplies route policy;
// this module owns database opening and transaction completion only.
(function (root) {
    const DB_NAME = "voiceofml-search-state";

    /** @returns {Promise<IDBDatabase>} */
    function openSearchSessionDB() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("session")) request.result.createObjectStore("session");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    /** @param {IDBTransaction} transaction @returns {Promise<void>} */
    function waitForTransaction(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
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
          const saved = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1 ||
              !("url" in saved) || typeof saved.url !== "string") return false;
          const target = new URL(saved.url);
          if (!canRestore(target)) return false;
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

    Object.assign(root, { VoiceOfMLSearchSession: { createSearchSession } });
})(typeof self !== "undefined" ? self : globalThis);
