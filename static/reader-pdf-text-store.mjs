export const PDF_TEXT_STORE_LIMITS = Object.freeze({bytes:64*1024*1024, entries:4096, entryBytes:512*1024, ttl:30*86400000});
export async function pdfTextStoreKey({source, version, pageCount, engine}) {
  if (!version || !source || !Number.isSafeInteger(pageCount) || pageCount < 1 || !globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(["pdf-search-han-space-v1",source,version,pageCount,engine]));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n=>n.toString(16).padStart(2,"0")).join("");
}

export function createPdfTextStore(key, {signal, limits = PDF_TEXT_STORE_LIMITS, now = Date.now} = {}) {
  let database, opening, disposed = false, writes = 0, pendingBytes = 0;
  const owners = new Set();
  const stats = {hits:0, misses:0, writes:0, skipped:0};
  const active = () => !disposed && !signal?.aborted && /^[0-9a-f]{64}$/.test(key || "");
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open("voiceofml-pdf-search-text", 1);
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(request.result);
      };
      const timer = setTimeout(()=>finish(new Error("PDF text cache open timeout")),500);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("pages", {keyPath:"id"}).createIndex("savedAt","savedAt");
        db.createObjectStore("budget", {keyPath:"id"});
      };
      request.onblocked = () => finish(new Error("PDF text cache blocked"));
      request.onerror = () => finish(request.error);
      request.onsuccess = () => {
        if (settled || !active()) { request.result.close(); finish(new Error("PDF text cache closed")); return; }
        database = request.result;
        database.onversionchange = () => { database.close(); database = null; opening = null; };
        finish();
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function operation(mode, budgetMs, work) {
    if (!active() || !globalThis.indexedDB) return null;
    const owner = new AbortController();
    owners.add(owner);
    let tx;
    const timer = setTimeout(()=>owner.abort(),budgetMs);
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => { try { tx?.abort(); } catch (_) {} resolve(null); };
        owner.signal.addEventListener("abort",abort,{once:true});
        open().then(db => {
          if (!active() || owner.signal.aborted) return resolve(null);
          tx = db.transaction(["pages","budget"],mode);
          let result = null;
          tx.oncomplete = () => resolve(result);
          tx.onabort = tx.onerror = () => resolve(null);
          work(tx, value => { result = value; });
        }).catch(reject);
      });
    } catch (_) { return null; }
    finally { clearTimeout(timer); owners.delete(owner); }
  }
  const idFor = page => key+":"+page;
  const cost = (id,text) => (id.length+text.length)*2+64;
  function valid(entry, page) {
    return entry?.schema === 1 && entry.id === idFor(page) && entry.key === key && entry.page === page &&
      typeof entry.text === "string" && entry.bytes === cost(entry.id,entry.text) && entry.bytes <= limits.entryBytes &&
      Number.isFinite(entry.savedAt) && entry.savedAt <= now() && now()-entry.savedAt < limits.ttl;
  }
  async function get(page) {
    if (!Number.isSafeInteger(page) || page < 1) return null;
    const text = await operation("readonly",150,(tx,finish) => {
      const request = tx.objectStore("pages").get(idFor(page));
      request.onsuccess = () => finish(valid(request.result,page) ? request.result.text : null);
    });
    if (text === null) stats.misses++; else stats.hits++;
    return text;
  }
  async function put(page, text) {
    const id = idFor(page), bytes = typeof text === "string" ? cost(id,text) : Infinity;
    if (!active() || !Number.isSafeInteger(page) || page < 1 || bytes > limits.entryBytes || bytes > limits.bytes ||
        writes >= 2 || pendingBytes+bytes > 1024*1024) { stats.skipped++; return false; }
    writes++; pendingBytes += bytes;
    try {
      // Page bodies and the global budget are committed atomically across tabs.
      const saved = await operation("readwrite",2000,(tx,finish) => {
        const pages = tx.objectStore("pages"), budgets = tx.objectStore("budget"), timestamp = now();
        const request = budgets.get("total");
        request.onsuccess = () => {
          let ledger = request.result;
          if (!ledger || !Number.isSafeInteger(ledger.bytes) || !Number.isSafeInteger(ledger.count) || ledger.bytes < 0 || ledger.count < 0) {
            pages.clear(); ledger = {id:"total",bytes:0,count:0,prunedAt:timestamp};
          }
          const previous = pages.get(id);
          previous.onsuccess = () => {
            if (previous.result) {
              ledger.bytes = Math.max(0,ledger.bytes-(previous.result.bytes || 0));
              ledger.count = Math.max(0,ledger.count-1); pages.delete(id);
            }
            const commit = () => {
              pages.put({schema:1,id,key,page,text,bytes,savedAt:timestamp});
              ledger.bytes += bytes; ledger.count++;
              budgets.put(ledger); finish(true);
            };
            const full = () => ledger.bytes+bytes > limits.bytes || ledger.count >= limits.entries;
            const prune = timestamp-ledger.prunedAt >= 3600000;
            if (!full() && !prune) return commit();
            const cursor = pages.index("savedAt").openCursor();
            cursor.onsuccess = () => {
              const row = cursor.result;
              if (row && (full() || (prune && timestamp-row.value.savedAt >= limits.ttl))) {
                ledger.bytes = Math.max(0,ledger.bytes-(row.value.bytes || 0));
                ledger.count = Math.max(0,ledger.count-1);
                row.delete(); row.continue(); return;
              }
              ledger.prunedAt = timestamp;
              if (!full()) commit();
            };
          };
        };
      });
      if (saved) stats.writes++; else stats.skipped++;
      return !!saved;
    } finally { writes--; pendingBytes -= bytes; }
  }
  function dispose() {
    disposed = true;
    for (const owner of owners) owner.abort();
    owners.clear(); database?.close(); database = null;
    signal?.removeEventListener("abort",dispose);
  }
  signal?.addEventListener("abort",dispose,{once:true});
  return Object.freeze({get,put,dispose,get stats(){return {...stats};}});
}
