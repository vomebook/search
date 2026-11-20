(function (root) {
  "use strict";
  /** @typedef {import('../../../typings/reader-store-strict').StoreHistoryInput} StoreHistoryInput */
  /** @typedef {import('../../../typings/reader-store-strict').HistoryEntry} HistoryEntry */
  /** @typedef {import('../../../typings/reader-store-strict').BookmarkInput} BookmarkInput */
  /** @typedef {import('../../../typings/reader-store-strict').BookmarkEntry} BookmarkEntry */
  /** @typedef {import('../../../typings/reader-store-strict').StoreChange} StoreChange */
  /** @typedef {import('../../../typings/reader-store-strict').StoreMessage} StoreMessage */
  const DB_NAME = "voiceofml-reader";
  const STORE_NAME = "entries";
  const BOOKMARK_STORE_NAME = "bookmarks";
  // Unindexed array keys in the bookmarks store cannot collide with string
  // bookmark IDs. This keeps v3 readable and leaves history capacity unchanged.
  const HISTORY_ORDER_KEY = "reader-history-order-v1";
  const HISTORY_WRITE_STORES = [STORE_NAME, BOOKMARK_STORE_NAME];
  const MAX_ENTRIES = 200;
  const SCHEMA_VERSION = 1;
  const DB_VERSION = 3;
  const script = /** @type {HTMLScriptElement | null | undefined} */ (root.document?.currentScript);
  const STORE_VERSION = script?.dataset.readerStoreVersion ||
    /reader-store\.([0-9a-f]{12})\.js(?:\?|$)/.exec(script?.src || "")?.[1] || "";
  /** @type {Promise<IDBDatabase> | null} */
  let databasePromise = null;
  /** @type {Set<(change: StoreMessage) => void>} */
  const subscribers = new Set();
  const storeChannel =
    typeof root.BroadcastChannel === "function"
      ? new root.BroadcastChannel("voiceofml-reader-store-v1")
      : null;
  let disposed = false;
  if (storeChannel)
    storeChannel.onmessage = (event) => {
      if (disposed) return;
      /** @type {unknown} */
      const data = event.data;
      // The channel historically forwards any payload; this assertion only permits
      // the existing object spread, it does not validate or filter the payload.
      for (const listener of subscribers) listener({ .../** @type {object} */ (data), remote: true });
    };
  /** @param {StoreChange} change */
  function notify(change) {
    if (disposed) return;
    try {
      storeChannel?.postMessage(change);
    } catch (_) {}
    for (const listener of subscribers) listener({ ...change, remote: false });
  }
  /** @param {(change: StoreMessage) => void} listener */
  function subscribe(listener) {
    if (typeof listener !== "function")
      throw new TypeError("Reader store subscriber must be a function");
    if (disposed) return () => {};
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    subscribers.clear();
    try {
      storeChannel?.close?.();
    } catch (_) {}
  }

  /** @param {IDBDatabase} database */
  function validateLayout(database) {
    if (!database.objectStoreNames.contains(STORE_NAME) || !database.objectStoreNames.contains(BOOKMARK_STORE_NAME))
      throw new Error("Unsupported Reader database layout");
    const tx = database.transaction([STORE_NAME, BOOKMARK_STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME), bookmarks = tx.objectStore(BOOKMARK_STORE_NAME);
    if (store.keyPath !== "url" || bookmarks.keyPath !== "id")
      throw new Error("Unsupported Reader database key layout");
    const requiredIndexes = /** @type {[IDBObjectStore, string][]} */ (
      [[store, "lastReadAt"], [bookmarks, "url"], [bookmarks, "createdAt"]]
    );
    for (const [objectStore, name] of requiredIndexes) {
      if (!objectStore.indexNames.contains(name)) throw new Error("Unsupported Reader database indexes");
      const index = objectStore.index(name);
      if (index.keyPath !== name || index.unique || index.multiEntry)
        throw new Error("Unsupported Reader database indexes");
    }
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    const opening = /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const upgrade = request.transaction;
        if (!upgrade) throw new Error("Reader database upgrade has no transaction");
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? upgrade.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "url" });
        const bookmarks = database.objectStoreNames.contains(BOOKMARK_STORE_NAME)
          ? upgrade.objectStore(BOOKMARK_STORE_NAME)
          : database.createObjectStore(BOOKMARK_STORE_NAME, { keyPath: "id" });
        // Unknown historical layouts are not safely migratable here. Abort the
        // upgrade instead of deleting a store or silently creating new keys.
        if (store.keyPath !== "url" || bookmarks.keyPath !== "id") {
          upgrade.abort();
          return;
        }
        const requiredIndexes = /** @type {[IDBObjectStore, string][]} */ (
          [[store, "lastReadAt"], [bookmarks, "url"], [bookmarks, "createdAt"]]
        );
        for (const [objectStore, name] of requiredIndexes) {
          if (objectStore.indexNames.contains(name)) {
            const index = objectStore.index(name);
            if (index.keyPath !== name || index.unique || index.multiEntry) {
              upgrade.abort();
              return;
            }
          } else objectStore.createIndex(name, name);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          if (databasePromise === opening) databasePromise = null;
        };
        if (databasePromise !== opening) {
          database.close();
          return;
        }
        try {
          validateLayout(database);
        } catch (error) {
          database.close();
          databasePromise = null;
          reject(error);
          return;
        }
        resolve(database);
      };
      request.onblocked = () => {
        if (databasePromise === opening) databasePromise = null;
        reject(new Error("Reader database upgrade was blocked by another tab"));
      };
      request.onerror = () => {
        if (databasePromise === opening) databasePromise = null;
        reject(request.error);
      };
    }));
    databasePromise = opening;
    return databasePromise;
  }

  /** @param {StoreHistoryInput | null} entry @returns {HistoryEntry | null} */
  function normalizeHistoryEntry(entry) {
    if (!entry || typeof entry.url !== "string" || !entry.url)
      return null;
    return {
      ...entry,
      schemaVersion: SCHEMA_VERSION,
      title: String(entry.title || ""),
      extension: String(entry.extension || ""),
      lastReadAt: Number.isFinite(Number(entry.lastReadAt)) ? Number(entry.lastReadAt) : Date.now()
    };
  }
  /** @param {BookmarkInput | null} entry @returns {BookmarkEntry | null} */
  function normalizeBookmarkEntry(entry) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.url !== "string" ||
      !entry.url
    )
      return null;
    return {
      ...entry,
      schemaVersion: SCHEMA_VERSION,
      label: String(entry.label || "未命名书签"),
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now()
    };
  }
  /** @param {string} url @returns {Promise<HistoryEntry | null>} */
  async function get(url) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readonly"),
        store = tx.objectStore(STORE_NAME);
      const request = store.get(url);
      request.onsuccess = () => {
        const raw = request.result || null;
        // Pre-schema records are readable without rewriting the original bytes.
        // Unknown future versions stay untouched and must not be interpreted.
        resolve(raw && (raw.schemaVersion == null || raw.schemaVersion === SCHEMA_VERSION)
          ? normalizeHistoryEntry(raw) : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** @param {string} [url] */
  function historyOrderKey(url) {
    return url === undefined ? [HISTORY_ORDER_KEY] : [HISTORY_ORDER_KEY, url];
  }

  /** @param {IDBObjectStore} order @param {string} [url] */
  function recordHistoryDeletion(order, url) {
    const id = historyOrderKey(url), previous = order.get(id);
    const deletedAt = Date.now();
    previous.onsuccess = () => {
      const cutoff = Math.max(deletedAt, previous.result?.deletedAt ?? 0);
      order.put({ id, deletedAt: cutoff });
      if (url !== undefined) return;
      // Clear supersedes older per-book markers. Keep any newer ones if the
      // wall clock moved backwards, and leave all bookmark keys untouched.
      const books = order.openCursor(IDBKeyRange.bound(id, [HISTORY_ORDER_KEY, []], true, true));
      books.onsuccess = () => {
        const cursor = books.result;
        if (!cursor) return;
        const key = cursor.primaryKey;
        if (Array.isArray(key) && key.length === 2 && typeof key[1] === "string" &&
            cursor.value?.deletedAt <= cutoff) cursor.delete();
        cursor.continue();
      };
    };
  }

  /** @param {StoreHistoryInput} supplied */
  async function put(supplied) {
    const entry = normalizeHistoryEntry(supplied);
    if (!entry) throw new TypeError("Invalid reader history entry");
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      /** @type {Error | null} */
      let abortReason = null;
      let written = false;
      const tx = database.transaction(HISTORY_WRITE_STORES, "readwrite");
      const store = tx.objectStore(STORE_NAME), order = tx.objectStore(BOOKMARK_STORE_NAME);
      const cleared = order.get(historyOrderKey()), removed = order.get(historyOrderKey(entry.url));
      const existing = store.get(entry.url);
      existing.onsuccess = () => {
        // Compare capture time, not arrival time: the host can first load
        // this script after the deletion. Deletion wins same-ms ties.
        if (entry.lastReadAt <= (cleared.result?.deletedAt ?? -Infinity) ||
            entry.lastReadAt <= (removed.result?.deletedAt ?? -Infinity)) return;
        if (existing.result) {
          if (existing.result.schemaVersion != null && existing.result.schemaVersion !== SCHEMA_VERSION) {
            tx.abort();
            return;
          }
          const previous = normalizeHistoryEntry(existing.result);
          if (!previous) {
            tx.abort();
            return;
          }
          if (Number(previous.lastReadAt) > Number(entry.lastReadAt)) return;
          const merged = { ...previous, ...entry };
          // A partial update must not replace retained metadata with empty
          // defaults introduced only by normalization.
          if (!Object.prototype.hasOwnProperty.call(supplied, "title")) merged.title = previous.title;
          if (!Object.prototype.hasOwnProperty.call(supplied, "extension")) merged.extension = previous.extension;
          store.put(merged);
          written = true;
          return;
        }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result < MAX_ENTRIES) {
            store.put(entry);
            written = true;
            return;
          }
          // Refuse a new entry at the existing limit rather than evicting
          // someone else's reading progress to make room.
          abortReason = new Error("Reader history is full");
          abortReason.name = "ReaderHistoryFullError";
          tx.abort();
        };
      };
      tx.oncomplete = () => {
        if (written) notify({ type: "history", url: entry.url, lastReadAt: entry.lastReadAt });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortReason || tx.error || new Error("Reader history transaction aborted"));
    }));
  }

  /**
   * @template T, U
   * @param {string} storeName
   * @param {string} indexName
   * @param {(value: U) => T | null} normalize
   * @param {{query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection, limit?: number}} [options]
   * @returns {Promise<T[]>}
   */
  async function listEntries(
    storeName,
    indexName,
    normalize,
    { query = null, direction = "next", limit = Infinity } = {}
  ) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      /** @type {T[]} */
      const entries = [];
      const tx = database.transaction(storeName, "readonly"),
        store = tx.objectStore(storeName);
      const request = store.index(indexName).openCursor(query, direction);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || entries.length >= limit) return resolve(entries);
        const value = cursor.value;
        const entry = value && (value.schemaVersion == null || value.schemaVersion === SCHEMA_VERSION)
          ? normalize(/** @type {U} */ (value)) : null;
        if (entry) {
          entries.push(entry);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  function list(limit = MAX_ENTRIES) {
    return listEntries(STORE_NAME, "lastReadAt", normalizeHistoryEntry, {
      direction: "prev",
      limit
    });
  }
  async function isHistoryFull() {
    const database = await openDatabase();
    return /** @type {Promise<boolean>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readonly"), request = tx.objectStore(STORE_NAME).count();
      request.onsuccess = () => resolve(request.result >= MAX_ENTRIES);
      request.onerror = () => reject(request.error);
    }));
  }

  /** @param {string} url */
  async function remove(url) {
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(HISTORY_WRITE_STORES, "readwrite"), store = tx.objectStore(STORE_NAME);
      const request = store.get(url);
      request.onsuccess = () => {
        const value = request.result;
        if (value && ((value.schemaVersion != null && value.schemaVersion !== SCHEMA_VERSION)
            || !normalizeHistoryEntry(value))) return tx.abort();
        store.delete(url);
        recordHistoryDeletion(tx.objectStore(BOOKMARK_STORE_NAME), url);
      };
      tx.oncomplete = () => { notify({ type: "history-remove", url }); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Reader history cannot be removed safely"));
    }));
  }
  async function clearHistory() {
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(HISTORY_WRITE_STORES, "readwrite"), request = tx.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          recordHistoryDeletion(tx.objectStore(BOOKMARK_STORE_NAME));
          return;
        }
        const value = cursor.value;
        if (value && (value.schemaVersion == null || value.schemaVersion === SCHEMA_VERSION)
            && normalizeHistoryEntry(value) && typeof value.lastReadAt === "number"
            && Number.isFinite(value.lastReadAt)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => { notify({ type: "history-clear" }); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Reader history clear aborted"));
    }));
  }
  /** @param {BookmarkInput} supplied */
  async function putBookmark(supplied) {
    const entry = normalizeBookmarkEntry(supplied);
    if (!entry) throw new TypeError("Invalid reader bookmark entry");
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite");
      const store = tx.objectStore(BOOKMARK_STORE_NAME);
      const existing = store.get(entry.id);
      existing.onsuccess = () => {
        if (existing.result?.schemaVersion != null && existing.result.schemaVersion !== SCHEMA_VERSION) {
          tx.abort();
          return;
        }
        const previous = existing.result ? normalizeBookmarkEntry(existing.result) : null;
        if (existing.result && (!previous || previous.url !== entry.url)) {
          tx.abort();
          return;
        }
        const merged = { ...previous, ...entry };
        if (previous && !Object.prototype.hasOwnProperty.call(supplied, "label")) merged.label = previous.label;
        if (previous && !Object.prototype.hasOwnProperty.call(supplied, "createdAt")) merged.createdAt = previous.createdAt;
        store.put(merged);
      };
      tx.oncomplete = () => {
        notify({ type: "bookmark", url: entry.url, id: entry.id });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }
  /** @param {string} url */
  async function listBookmarks(url) {
    const entries = await listEntries(BOOKMARK_STORE_NAME, "url", normalizeBookmarkEntry, {
      query: IDBKeyRange.only(url)
    });
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }
  function listAllBookmarks() {
    return listEntries(BOOKMARK_STORE_NAME, "createdAt", normalizeBookmarkEntry, {
      direction: "prev"
    });
  }
  /** @param {string} id */
  async function removeBookmark(id) {
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite");
      const store = tx.objectStore(BOOKMARK_STORE_NAME), request = store.get(id);
      request.onsuccess = () => {
        const value = request.result;
        if (value && ((value.schemaVersion != null && value.schemaVersion !== SCHEMA_VERSION)
            || !normalizeBookmarkEntry(value))) return tx.abort();
        store.delete(id);
      };
      tx.oncomplete = () => {
        notify({ type: "bookmark-remove", id });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Reader bookmark cannot be removed safely"));
    }));
  }
  /** @satisfies {import('../../../typings/reader-store-strict').ReaderStoreStrictApi} */
  const api = Object.freeze({
    DB_NAME,
    DB_VERSION,
    MAX_ENTRIES,
    SCHEMA_VERSION,
    STORE_VERSION,
    get,
    put,
    list,
    isHistoryFull,
    remove,
    clearHistory,
    putBookmark,
    listBookmarks,
    listAllBookmarks,
    removeBookmark,
    subscribe,
    dispose
  });
  root.VoiceOfMLReaderStore = api;
})(typeof self !== "undefined" ? self : window);
