(function (root) {
  "use strict";
  const DB_NAME = "voiceofml-reader";
  const STORE_NAME = "entries";
  const BOOKMARK_STORE_NAME = "bookmarks";
  const MAX_ENTRIES = 200;
  const SCHEMA_VERSION = 1;
  // LOCAL NEW-CLIENT EXPERIMENT: an additive upgrade blocks fixed-v3 clients
  // rather than keeping them compatible. No records or stores are copied or
  // deleted. Do not deploy until upgrade, blocked tabs and rollback are tested.
  const DB_VERSION = ["127.0.0.1", "localhost"].includes(root.location?.hostname) ? 4 : 3;
  // Read-only, loopback-only diagnostics for three exact historical CHM
  // paths. Not a storage fence: old tabs can still mutate these records.
  const LOCAL_CHM_OLD = new Set([
    "chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/bc50c5be8c985411/chapter-manifest.json",
    "chapters/ebook/chm/a30c4f7dc0d7ee59778e252ec4e49757d8ab4cf142d2798257030c483c09f4e0/1d4db6aed8930887/chapter-manifest.json",
    "chapters/ebook/chm/a72ce4c104a891febdfdb90f1a40171b0edb7435b8e6251801a43989c67a88f1/551923a5166cf5b8/chapter-manifest.json"
  ]);
  const LOCAL_CHM_ALIASES = new Map([
    ["chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/18ba3952389e349e/chapter-manifest.json",
     "chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/bc50c5be8c985411/chapter-manifest.json"],
    ["chapters/ebook/chm/a30c4f7dc0d7ee59778e252ec4e49757d8ab4cf142d2798257030c483c09f4e0/ec25ac797cc0bee4/chapter-manifest.json",
     "chapters/ebook/chm/a30c4f7dc0d7ee59778e252ec4e49757d8ab4cf142d2798257030c483c09f4e0/1d4db6aed8930887/chapter-manifest.json"],
    ["chapters/ebook/chm/a72ce4c104a891febdfdb90f1a40171b0edb7435b8e6251801a43989c67a88f1/f71b585b61ea8b3b/chapter-manifest.json",
     "chapters/ebook/chm/a72ce4c104a891febdfdb90f1a40171b0edb7435b8e6251801a43989c67a88f1/551923a5166cf5b8/chapter-manifest.json"]
  ]);
  function localChmPath(raw) {
    if (!["127.0.0.1", "localhost"].includes(root.location?.hostname) || typeof raw !== "string") return null;
    try {
      const url = new URL(raw), keys = [...url.searchParams.keys()];
      return url.protocol === "https:" && url.host === "voiceofml-search.hf.space" &&
        !url.username && !url.password && !url.hash && url.pathname === "/api/reader-bucket-resource" &&
        keys.length === 1 && keys[0] === "path" ? url.searchParams.get("path") : null;
    } catch (_) { return null; }
  }
  function localLegacyChapterUrl(newUrl) {
    const old = LOCAL_CHM_ALIASES.get(localChmPath(newUrl));
    return old ? `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${old}` : "";
  }
  function localSplitChapterUrl(oldUrl) {
    const oldPath = localChmPath(oldUrl);
    for (const [split, old] of LOCAL_CHM_ALIASES)
      if (oldPath && oldPath === old)
        return `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(split)}`;
    return "";
  }
  function isLocalLegacyChapterUrl(raw) { return LOCAL_CHM_OLD.has(localChmPath(raw)); }
  function isLocalLegacyChapterRecord(record) {
    return Boolean(record && (isLocalLegacyChapterUrl(record.url) || isLocalLegacyChapterUrl(record.chapterManifest)));
  }
  function localSameLegacyChapter(left, right) {
    const path = localChmPath(left);
    return LOCAL_CHM_OLD.has(path) && path === localChmPath(right);
  }
  function localSameSplitChapter(left, right) {
    const leftPath = localChmPath(left), rightPath = localChmPath(right);
    return Boolean(leftPath && LOCAL_CHM_ALIASES.has(leftPath) && leftPath === rightPath);
  }
  // New-client-only test namespace for the two records sharing the same
  // derived manifest. Resource URLs remain untouched; the key is never used
  // for fetching or downloading. Unrecognized IDs keep the existing key.
  function localBookRecordKey(id, resource) {
    const path = localChmPath(resource);
    // A direct old manifest has no proven bibliographic owner. Give it a
    // distinct key instead of replacing either the old or shared records.
    const directOldPath = LOCAL_CHM_OLD.has(path) ? path : LOCAL_CHM_ALIASES.get(path);
    if (!id && directOldPath) return `urn:voiceofml:reader-direct-chm:${directOldPath}`;
    if (path !== "chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/18ba3952389e349e/chapter-manifest.json" ||
        !["29b1i0i45mj7g", "0bkdmor8l52rg"].includes(id)) return resource;
    return `urn:voiceofml:reader-book:${id}`;
  }
  function isLocalSharedSplitRecord(entry) {
    return localChmPath(entry?.url) ===
      "chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/18ba3952389e349e/chapter-manifest.json";
  }
  const script = /** @type {HTMLScriptElement | null | undefined} */ (root.document?.currentScript);
  const STORE_VERSION = script?.dataset.readerStoreVersion ||
    /reader-store\.([0-9a-f]{12})\.js(?:\?|$)/.exec(script?.src || "")?.[1] || "";
  let databasePromise = null;
  const subscribers = new Set();
  const storeChannel =
    typeof root.BroadcastChannel === "function"
      ? new root.BroadcastChannel("voiceofml-reader-store-v1")
      : null;
  let disposed = false;
  if (storeChannel)
    storeChannel.onmessage = (event) => {
      if (disposed) return;
      for (const listener of subscribers) listener({ ...event.data, remote: true });
    };
  function notify(change) {
    if (disposed) return;
    try {
      storeChannel?.postMessage(change);
    } catch (_) {}
    for (const listener of subscribers) listener({ ...change, remote: false });
  }
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
    const opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const upgrade = request.transaction;
        if (!upgrade) throw new Error("Reader database upgrade has no transaction");
        // A blocked request may become unblocked after its promise was already
        // rejected. Abort that now-stale upgrade before changing the schema.
        if (databasePromise !== opening) {
          upgrade.abort();
          return;
        }
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
    });
    databasePromise = opening;
    return databasePromise;
  }

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

  async function put(entry) {
    const supplied = entry;
    entry = normalizeHistoryEntry(entry);
    if (!entry) throw new TypeError("Invalid reader history entry");
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      let abortReason = null;
      const tx = database.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const existing = store.get(entry.url);
      existing.onsuccess = () => {
        if (existing.result) {
          // LOCAL DIAGNOSTIC: perform the old/new guard inside the write
          // transaction, not in the earlier asynchronous UI lookup.
          const oldAfter = localLegacyChapterUrl(entry.chapterManifest || "");
          if (oldAfter && !localSameSplitChapter(existing.result.chapterManifest, entry.chapterManifest)) {
            abortReason = new Error("Local CHM legacy history is read-only");
            abortReason.name = "LocalLegacyHistoryError";
            tx.abort();
            return;
          }
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
          return;
        }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result < MAX_ENTRIES) {
            store.put(entry);
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
        notify({ type: "history", url: entry.url, lastReadAt: entry.lastReadAt });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortReason || tx.error || new Error("Reader history transaction aborted"));
    }));
  }

  async function listEntries(
    storeName,
    indexName,
    normalize,
    { query = null, direction = "next", limit = Infinity } = {}
  ) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const entries = [];
      const tx = database.transaction(storeName, "readonly"),
        store = tx.objectStore(storeName);
      const request = store.index(indexName).openCursor(query, direction);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || entries.length >= limit) return resolve(entries);
        const value = cursor.value;
        const entry = value && (value.schemaVersion == null || value.schemaVersion === SCHEMA_VERSION)
          ? normalize(value) : null;
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

  async function remove(url) {
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readwrite"), store = tx.objectStore(STORE_NAME);
      const request = store.get(url);
      request.onsuccess = () => {
        const value = request.result;
        if (value && ((value.schemaVersion != null && value.schemaVersion !== SCHEMA_VERSION)
            || !normalizeHistoryEntry(value))) return tx.abort();
        store.delete(url);
      };
      tx.oncomplete = () => { notify({ type: "history-remove", url }); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Reader history cannot be removed safely"));
    }));
  }
  async function clearHistory() {
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readwrite"), request = tx.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
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
  async function localLegacyHistoryCount() {
    if (!["127.0.0.1", "localhost"].includes(root.location?.hostname)) return 0;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      let count = 0;
      const tx = database.transaction(STORE_NAME, "readonly"), request = tx.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (isLocalLegacyChapterUrl(cursor.primaryKey) || isLocalLegacyChapterRecord(cursor.value)) count++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Local CHM history count failed"));
    });
  }
  async function localClearHistoryIfNoLegacy() {
    if (!["127.0.0.1", "localhost"].includes(root.location?.hostname))
      throw new Error("Local CHM experiment only");
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      let abortReason = null;
      const tx = database.transaction(STORE_NAME, "readwrite"), request = tx.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (isLocalLegacyChapterUrl(cursor.primaryKey) || isLocalLegacyChapterRecord(value)) {
          abortReason = new Error("Local CHM legacy history is present");
          abortReason.name = "LocalLegacyHistoryError";
          tx.abort();
          return;
        }
        if (value && (value.schemaVersion == null || value.schemaVersion === SCHEMA_VERSION) &&
            normalizeHistoryEntry(value) && typeof value.lastReadAt === "number" && Number.isFinite(value.lastReadAt))
          cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => { notify({ type: "history-clear" }); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(abortReason || tx.error || new Error("Local CHM history clear aborted"));
    });
  }
  async function putBookmark(entry) {
    const supplied = entry;
    entry = normalizeBookmarkEntry(entry);
    if (!entry) throw new TypeError("Invalid reader bookmark entry");
    const database = await openDatabase();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      let abortReason = null;
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite");
      const store = tx.objectStore(BOOKMARK_STORE_NAME);
      const existing = store.get(entry.id);
      existing.onsuccess = () => {
        const oldAfter = localLegacyChapterUrl(entry.chapterManifest || "");
        if (existing.result && oldAfter && !localSameSplitChapter(existing.result.chapterManifest, entry.chapterManifest)) {
          abortReason = new Error("Local CHM legacy bookmark is read-only");
          abortReason.name = "LocalLegacyBookmarkError";
          tx.abort();
          return;
        }
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
      tx.onabort = () => reject(abortReason || tx.error || new Error("Reader bookmark transaction aborted"));
    }));
  }
  async function listBookmarks(url) {
    const entries = await listEntries(BOOKMARK_STORE_NAME, "url", normalizeBookmarkEntry, {
      query: IDBKeyRange.only(url)
    });
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }
  async function localLegacyRecords(url) {
    if (!isLocalLegacyChapterUrl(url)) throw new TypeError("Unreviewed local CHM history");
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const records = {history: [], bookmarks: []};
      const tx = database.transaction([STORE_NAME, BOOKMARK_STORE_NAME], "readonly");
      for (const [storeName, field, normalize] of [
        [STORE_NAME, "history", normalizeHistoryEntry],
        [BOOKMARK_STORE_NAME, "bookmarks", normalizeBookmarkEntry]
      ]) {
        const request = tx.objectStore(storeName).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const raw = cursor.value;
          if (raw && (raw.schemaVersion == null || raw.schemaVersion === SCHEMA_VERSION) &&
              (localSameLegacyChapter(raw.url, url) || localSameLegacyChapter(raw.chapterManifest, url))) {
            const value = normalize(raw);
            if (value) records[field].push(value);
          }
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve(records);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Local CHM records could not be read"));
    });
  }
  function listAllBookmarks() {
    return listEntries(BOOKMARK_STORE_NAME, "createdAt", normalizeBookmarkEntry, {
      direction: "prev"
    });
  }
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
  root.VoiceOfMLReaderStore = Object.freeze({
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
    localLegacyChapterUrl,
    localSplitChapterUrl,
    isLocalLegacyChapterUrl,
    isLocalLegacyChapterRecord,
    isLocalSharedSplitRecord,
    localBookRecordKey,
    localSameLegacyChapter,
    localLegacyRecords,
    localLegacyHistoryCount,
    localClearHistoryIfNoLegacy,
    listAllBookmarks,
    removeBookmark,
    subscribe,
    dispose
  });
})(typeof self !== "undefined" ? self : window);
