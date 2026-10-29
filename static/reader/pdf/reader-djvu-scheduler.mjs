// One Worker executes one decode at a time. Visible demand outranks queued
// prefetch; completed pages are bounded by count and RGBA bytes.
export function createDjvuScheduler(decoder, { maxBytes = 64 * 1024 * 1024, maxPages = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1)
    throw new Error("DJVU_CACHE_LIMIT_INVALID");
  const cache = new Map(), pending = new Map();
  let active = null, closed = false, sequence = 0, retained = 0, ephemeral = null;
  const abort = () => new DOMException("DjVu render cancelled", "AbortError");
  function drop(page) {
    const value = cache.get(page);
    if (value) { retained -= value.image.data.byteLength; cache.delete(page); }
  }
  function touch(page) {
    const value = cache.get(page);
    if (!value) return null;
    cache.delete(page); cache.set(page, value); return value;
  }
  function settle(task, error, value) {
    for (const client of task.clients) {
      client.signal?.removeEventListener("abort", client.cancel);
      if (error) client.reject(error); else client.resolve(value);
    }
    task.clients.clear();
  }
  function next() {
    if (closed || active || !pending.size) return;
    const task = [...pending.values()].sort((a, b) => b.priority - a.priority || a.seq - b.seq)[0];
    pending.delete(task.page); active = task;
    Promise.resolve().then(() => {
      if (closed) throw abort();
      return task.outline ? decoder.outline() : task.operation === 'geometry' ? decoder.geometry(task.number) :
        task.operation === 'text' ? decoder.text(task.number) : decoder.page(task.page);
    }).then(value => {
      if (closed) return;
      if (task.outline || task.operation) { settle(task, null, value); return; }
      if (!value?.image || !(value.image.data instanceof Uint8ClampedArray)) throw new Error("DJVU_DECODE_INVALID");
      const bytes = value.image.data.byteLength;
      // A decode that was already running cannot be interrupted without losing
      // the document worker, but canceled demand must not populate the cache.
      if (task.clients.size && bytes <= maxBytes) {
        drop(task.page); cache.set(task.page, value); retained += bytes;
        while (cache.size > maxPages || retained > maxBytes) drop(cache.keys().next().value);
      } else if (task.clients.size) ephemeral = { page: task.page, value };
      settle(task, null, value);
    }).catch(error => { if (!closed) settle(task, error); }).finally(() => {
      active = null;
      ephemeral = null;
      next();
    });
  }
  function request(page, priority = 0, { signal } = {}) {
    if (closed || signal?.aborted) return Promise.reject(signal?.reason || abort());
    if (!Number.isSafeInteger(page) || page < 1) return Promise.reject(new Error("DJVU_PAGE_INVALID"));
    const hit = touch(page);
    if (hit) return Promise.resolve(hit);
    if (ephemeral?.page === page) return Promise.resolve(ephemeral.value);
    let task = active?.page === page ? active : pending.get(page);
    if (!task) {
      task = { page, priority: Number(priority) || 0, seq: sequence++, clients: new Set() };
      pending.set(page, task);
    } else task.priority = Math.max(task.priority, Number(priority) || 0);
    const promise = new Promise((resolve, reject) => {
      const client = { resolve, reject, signal };
      client.cancel = () => {
        signal?.removeEventListener("abort", client.cancel);
        task.clients.delete(client);
        reject(signal?.reason || abort());
        if (!task.clients.size && pending.get(page) === task) pending.delete(page);
      };
      task.clients.add(client);
      signal?.addEventListener("abort", client.cancel, { once: true });
      if (signal?.aborted) client.cancel();
    });
    next(); return promise;
  }
  function requestOutline() {
    if (closed) return Promise.reject(abort());
    const key = 'outline';
    let task = active?.outline ? active : pending.get(key);
    if (!task) {
      task = { page:key, outline:true, priority:-1, seq:sequence++, clients:new Set() };
      pending.set(key,task);
    }
    const promise = new Promise((resolve,reject)=>task.clients.add({resolve,reject}));
    next(); return promise;
  }
  function requestMetadata(operation, number, priority = 0) {
    if (closed) return Promise.reject(abort());
    if (!['geometry','text'].includes(operation) || !Number.isSafeInteger(number) || number < 1)
      return Promise.reject(new Error('DJVU_PAGE_INVALID'));
    const key = `${operation}:${number}`;
    let task = active?.page === key ? active : pending.get(key);
    if (!task) {
      task = {page:key, number, operation, priority:Number(priority) || 0, seq:sequence++, clients:new Set()};
      pending.set(key,task);
    } else task.priority = Math.max(task.priority, Number(priority) || 0);
    const promise = new Promise((resolve,reject)=>task.clients.add({resolve,reject}));
    next(); return promise;
  }
  function cancelSpeculation() {
    for (const [page, task] of pending) if (!task.outline && !task.operation && task.priority < 2) {
      pending.delete(page); settle(task, abort());
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const task of pending.values()) settle(task, abort());
    pending.clear();
    if (active) settle(active, abort());
    cache.clear(); retained = 0; ephemeral = null; decoder.close();
  }
  return { request, requestOutline, requestMetadata, cancelSpeculation, close,
    stats: () => ({ retainedBytes: retained, pages: [...cache.keys()], queued: pending.size, active: active?.page || null }) };
}
