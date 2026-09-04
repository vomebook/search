(function (root) {
  "use strict";
  const DB_NAME = "voiceofml-reader";
  const STORE_NAME = "entries";
  const BOOKMARK_STORE_NAME = "bookmarks";
  const MAX_ENTRIES = 200;
  const SCHEMA_VERSION = 1;
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    const opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: "url" });
          store.createIndex("lastReadAt", "lastReadAt");
        }
        if (!database.objectStoreNames.contains(BOOKMARK_STORE_NAME)) {
          const bookmarks = database.createObjectStore(BOOKMARK_STORE_NAME, { keyPath: "id" });
          bookmarks.createIndex("url", "url");
          bookmarks.createIndex("createdAt", "createdAt");
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); if (databasePromise === opening) databasePromise = null; };
        if (databasePromise !== opening) { database.close(); return; }
        resolve(database);
      };
      request.onblocked = () => { if (databasePromise === opening) databasePromise = null; reject(new Error("Reader database upgrade was blocked by another tab")); };
      request.onerror = () => { if (databasePromise === opening) databasePromise = null; reject(request.error); };
    });
    databasePromise = opening;
    return databasePromise;
  }

  async function transaction(mode, callback) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, mode);
      const result = callback(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function hasFutureSchema(entry) { return Number(entry?.schemaVersion) > SCHEMA_VERSION; }
  function normalizeHistoryEntry(entry) { if (!entry || hasFutureSchema(entry) || typeof entry.url !== "string" || !entry.url) return null; return { ...entry, schemaVersion: SCHEMA_VERSION, title: String(entry.title || ""), extension: String(entry.extension || ""), lastReadAt: Number.isFinite(Number(entry.lastReadAt)) ? Number(entry.lastReadAt) : Date.now() }; }
  function normalizeBookmarkEntry(entry) { if (!entry || hasFutureSchema(entry) || typeof entry.id !== "string" || !entry.id || typeof entry.url !== "string" || !entry.url) return null; return { ...entry, schemaVersion: SCHEMA_VERSION, label: String(entry.label || "未命名书签"), createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now() }; }
  async function get(url) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readwrite"), store = tx.objectStore(STORE_NAME);
      const request = store.get(url);
      request.onsuccess = () => { const raw = request.result || null, entry = normalizeHistoryEntry(raw); if (raw && !entry && !hasFutureSchema(raw)) { store.delete(url); resolve(null); } else { if (entry && raw.schemaVersion !== SCHEMA_VERSION) store.put(entry); resolve(entry); } };
      request.onerror = () => reject(request.error);
    });
  }

  async function put(entry) {
    entry = normalizeHistoryEntry(entry); if (!entry) throw new TypeError("Invalid reader history entry");
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const existing = store.get(entry.url);
      existing.onsuccess = () => {
        if (existing.result) {
          if (Number(existing.result.lastReadAt) > Number(entry.lastReadAt)) return;
          store.put(entry);
          return;
        }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result < MAX_ENTRIES) {
            store.put(entry);
            return;
          }
          const oldest = store.index("lastReadAt").openCursor();
          oldest.onsuccess = () => {
            if (oldest.result) oldest.result.delete();
            store.put(entry);
          };
        };
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function list(limit = MAX_ENTRIES) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const entries = [];
      const tx = database.transaction(STORE_NAME, "readwrite"), store = tx.objectStore(STORE_NAME);
      const request = store.index("lastReadAt").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || entries.length >= limit) return resolve(entries);
        const entry = normalizeHistoryEntry(cursor.value); if (entry) { entries.push(entry); if (cursor.value.schemaVersion !== SCHEMA_VERSION) cursor.update(entry); } else if (!hasFutureSchema(cursor.value)) cursor.delete(); cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function remove(url) { await transaction("readwrite", (store) => store.delete(url)); }
  async function clearHistory() { await transaction("readwrite", (store) => store.clear()); }
  async function putBookmark(entry) {
    entry = normalizeBookmarkEntry(entry); if (!entry) throw new TypeError("Invalid reader bookmark entry");
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite");
      tx.objectStore(BOOKMARK_STORE_NAME).put(entry);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  async function listBookmarks(url) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const entries = [];
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite"), store = tx.objectStore(BOOKMARK_STORE_NAME);
      const request = store.index("url").openCursor(IDBKeyRange.only(url));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(entries.sort((a, b) => b.createdAt - a.createdAt));
        const entry = normalizeBookmarkEntry(cursor.value); if (entry) { entries.push(entry); if (cursor.value.schemaVersion !== SCHEMA_VERSION) cursor.update(entry); } else if (!hasFutureSchema(cursor.value)) cursor.delete(); cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async function listAllBookmarks() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const entries = [];
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite"), store = tx.objectStore(BOOKMARK_STORE_NAME);
      const request = store.index("createdAt").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(entries);
        const entry = normalizeBookmarkEntry(cursor.value); if (entry) { entries.push(entry); if (cursor.value.schemaVersion !== SCHEMA_VERSION) cursor.update(entry); } else if (!hasFutureSchema(cursor.value)) cursor.delete(); cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async function removeBookmark(id) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = database.transaction(BOOKMARK_STORE_NAME, "readwrite");
      tx.objectStore(BOOKMARK_STORE_NAME).delete(id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  root.VoiceOfMLReaderStore = Object.freeze({ DB_NAME, MAX_ENTRIES, SCHEMA_VERSION, get, put, list, remove, clearHistory, putBookmark, listBookmarks, listAllBookmarks, removeBookmark });
})(typeof self !== "undefined" ? self : window);
