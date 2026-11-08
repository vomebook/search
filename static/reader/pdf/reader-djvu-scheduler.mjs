// One Worker executes one decode at a time. Visible demand outranks queued
// prefetch; completed pages are bounded by count and RGBA bytes.
/** @typedef {ReturnType<typeof import('./reader-djvu-worker.mjs').createDjvuWorkerAdapter>} DjvuDecoder */
/** @typedef {Awaited<ReturnType<DjvuDecoder['page']>>} DjvuPage */
/** @typedef {Awaited<ReturnType<DjvuDecoder['geometry']>>} DjvuGeometry */
/** @typedef {Awaited<ReturnType<DjvuDecoder['text']>>} DjvuText */
/** @typedef {Awaited<ReturnType<DjvuDecoder['outline']>>} DjvuOutline */
/** @template T @typedef {{resolve(value: T): void, reject(reason?: unknown): void,
 * signal?: AbortSignal | undefined, cancel?: (() => void) | undefined}} DjvuClient */
/** @typedef {{priority: number, seq: number}} DjvuTaskBase */
/** @typedef {DjvuTaskBase & {kind: 'page', page: number, clients: Set<DjvuClient<DjvuPage>>}} PageTask */
/** @typedef {DjvuTaskBase & {kind: 'outline', page: 'outline', clients: Set<DjvuClient<DjvuOutline>>}} OutlineTask */
/** @typedef {DjvuTaskBase & {kind: 'geometry', page: string, number: number, clients: Set<DjvuClient<DjvuGeometry>>}} GeometryTask */
/** @typedef {DjvuTaskBase & {kind: 'text', page: string, number: number, clients: Set<DjvuClient<DjvuText>>}} TextTask */
/** @typedef {PageTask | OutlineTask | GeometryTask | TextTask} DjvuTask */

/** @param {Pick<DjvuDecoder, 'page' | 'outline' | 'geometry' | 'text' | 'close'>} decoder
 * @param {{maxBytes?: number | undefined, maxPages?: number | undefined}} [options] */
export function createDjvuScheduler(decoder, { maxBytes = 64 * 1024 * 1024, maxPages = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1)
    throw new Error("DJVU_CACHE_LIMIT_INVALID");
  /** @type {Map<number, DjvuPage>} */
  const cache = new Map();
  /** @type {Map<number | string, DjvuTask>} */
  const pending = new Map();
  /** @type {DjvuTask | null} */
  let active = null;
  /** @type {{page: number, value: DjvuPage} | null} */
  let ephemeral = null;
  let closed = false, sequence = 0, retained = 0;
  const abort = () => new DOMException("DjVu render cancelled", "AbortError");
  /** @param {number} page */
  function drop(page) {
    const value = cache.get(page);
    if (value) { retained -= value.image.data.byteLength; cache.delete(page); }
  }
  /** @param {number} page */
  function touch(page) {
    const value = cache.get(page);
    if (!value) return null;
    cache.delete(page); cache.set(page, value); return value;
  }
  /** @template T @param {Set<DjvuClient<T>>} clients @param {T} value */
  function resolveClients(clients, value) {
    for (const client of clients) {
      if (client.cancel) client.signal?.removeEventListener("abort", client.cancel);
      client.resolve(value);
    }
    clients.clear();
  }
  /** @param {DjvuTask} task @param {unknown} error */
  function rejectClients(task, error) {
    for (const client of task.clients) {
      if (client.cancel) client.signal?.removeEventListener("abort", client.cancel);
      client.reject(error);
    }
    task.clients.clear();
  }
  /** @param {PageTask} task @param {DjvuPage} value */
  function finishPage(task, value) {
    if (!value?.image || !(value.image.data instanceof Uint8ClampedArray)) throw new Error("DJVU_DECODE_INVALID");
    const bytes = value.image.data.byteLength;
    // A decode that was already running cannot be interrupted without losing
    // the document worker, but canceled demand must not populate the cache.
    if (task.clients.size && bytes <= maxBytes) {
      drop(task.page); cache.set(task.page, value); retained += bytes;
      while (cache.size > maxPages || retained > maxBytes) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    } else if (task.clients.size) ephemeral = { page: task.page, value };
    resolveClients(task.clients, value);
  }
  /** @template T @param {DjvuTask} task @param {() => Promise<T>} decode @param {(value: T) => void} finish */
  function run(task, decode, finish) {
    Promise.resolve().then(() => {
      if (closed) throw abort();
      return decode();
    }).then(value => {
      if (!closed) finish(value);
    }).catch(error => { if (!closed) rejectClients(task, error); }).finally(() => {
      active = null;
      ephemeral = null;
      next();
    });
  }
  function next() {
    if (closed || active || !pending.size) return;
    const task = [...pending.values()].sort((a, b) => b.priority - a.priority || a.seq - b.seq)[0];
    if (!task) return;
    pending.delete(task.page); active = task;
    if (task.kind === 'page') run(task, () => decoder.page(task.page), value => finishPage(task, value));
    else if (task.kind === 'outline') run(task, () => decoder.outline(), value => resolveClients(task.clients, value));
    else if (task.kind === 'geometry') run(task, () => decoder.geometry(task.number), value => resolveClients(task.clients, value));
    else run(task, () => decoder.text(task.number), value => resolveClients(task.clients, value));
  }
  /** @param {number} page @param {number} priority @returns {PageTask} */
  function pageTask(page, priority) {
    let task = active?.page === page ? active : pending.get(page);
    if (!task) {
      task = { kind:'page', page, priority: Number(priority) || 0, seq: sequence++, clients: new Set() };
      pending.set(page, task);
    } else task.priority = Math.max(task.priority, Number(priority) || 0);
    if (task.kind !== 'page') throw new Error('DJVU_SCHEDULER_PROTOCOL');
    return task;
  }
  /** @param {PageTask} task @param {AbortSignal | undefined} signal @returns {Promise<DjvuPage>} */
  function pageClient(task, signal) {
    return new Promise((resolve, reject) => {
      /** @type {DjvuClient<DjvuPage>} */
      const client = { resolve, reject, signal };
      client.cancel = () => {
        if (client.cancel) signal?.removeEventListener("abort", client.cancel);
        task.clients.delete(client);
        reject(signal?.reason || abort());
        if (!task.clients.size && pending.get(task.page) === task) pending.delete(task.page);
      };
      task.clients.add(client);
      signal?.addEventListener("abort", client.cancel, { once: true });
      if (signal?.aborted) client.cancel();
    });
  }
  /** @param {number} page */
  function validPage(page) { return Number.isSafeInteger(page) && page >= 1; }
  /** @param {number} page @returns {DjvuPage | null} */
  function cachedPage(page) {
    const hit = touch(page);
    if (hit) return hit;
    return ephemeral?.page === page ? ephemeral.value : null;
  }
  /** @param {number} page @param {number} [priority] @param {{signal?: AbortSignal | undefined}} [options]
   * @returns {Promise<DjvuPage>} */
  function request(page, priority = 0, options = {}) {
    const { signal } = options;
    if (closed || signal?.aborted) return Promise.reject(signal?.reason || abort());
    if (!validPage(page)) return Promise.reject(new Error("DJVU_PAGE_INVALID"));
    const hit = cachedPage(page);
    if (hit) return Promise.resolve(hit);
    const promise = pageClient(pageTask(page,priority),signal);
    next(); return promise;
  }
  /** @template T @param {Set<DjvuClient<T>>} clients @returns {Promise<T>} */
  function passiveClient(clients) {
    return new Promise((resolve, reject) => clients.add({resolve,reject}));
  }
  /** @returns {Promise<DjvuOutline>} */
  function requestOutline() {
    if (closed) return Promise.reject(abort());
    const key = 'outline';
    let task = active?.kind === 'outline' ? active : pending.get(key);
    if (!task) {
      task = { kind:'outline', page:key, priority:-1, seq:sequence++, clients:new Set() };
      pending.set(key,task);
    }
    if (task.kind !== 'outline') throw new Error('DJVU_SCHEDULER_PROTOCOL');
    const promise = passiveClient(task.clients);
    next(); return promise;
  }
  /** @param {number} number @param {number} priority @returns {Promise<DjvuGeometry>} */
  function requestGeometry(number, priority) {
    const key = `geometry:${number}`;
    let task = active?.page === key ? active : pending.get(key);
    if (!task) {
      task = {kind:'geometry', page:key, number, priority:Number(priority) || 0, seq:sequence++, clients:new Set()};
      pending.set(key,task);
    } else task.priority = Math.max(task.priority, Number(priority) || 0);
    if (task.kind !== 'geometry') throw new Error('DJVU_SCHEDULER_PROTOCOL');
    const promise = passiveClient(task.clients);
    next(); return promise;
  }
  /** @param {number} number @param {number} priority @returns {Promise<DjvuText>} */
  function requestText(number, priority) {
    const key = `text:${number}`;
    let task = active?.page === key ? active : pending.get(key);
    if (!task) {
      task = {kind:'text', page:key, number, priority:Number(priority) || 0, seq:sequence++, clients:new Set()};
      pending.set(key,task);
    } else task.priority = Math.max(task.priority, Number(priority) || 0);
    if (task.kind !== 'text') throw new Error('DJVU_SCHEDULER_PROTOCOL');
    const promise = passiveClient(task.clients);
    next(); return promise;
  }
  /** @overload @param {'geometry'} operation @param {number} number @param {number} [priority] @returns {Promise<DjvuGeometry>} */
  /** @overload @param {'text'} operation @param {number} number @param {number} [priority] @returns {Promise<DjvuText>} */
  /** @param {'geometry' | 'text'} operation @param {number} number @param {number} [priority] */
  function requestMetadata(operation, number, priority = 0) {
    if (closed) return Promise.reject(abort());
    if (!['geometry','text'].includes(operation) || !Number.isSafeInteger(number) || number < 1)
      return Promise.reject(new Error('DJVU_PAGE_INVALID'));
    return operation === 'geometry' ? requestGeometry(number,priority) : requestText(number,priority);
  }
  function cancelSpeculation() {
    for (const [page, task] of pending) if (task.kind === 'page' && task.priority < 2) {
      pending.delete(page); rejectClients(task, abort());
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const task of pending.values()) rejectClients(task, abort());
    pending.clear();
    if (active) rejectClients(active, abort());
    cache.clear(); retained = 0; ephemeral = null; decoder.close();
  }
  return { request, requestOutline, requestMetadata, cancelSpeculation, close,
    stats: () => ({ retainedBytes: retained, pages: [...cache.keys()], queued: pending.size, active: active?.page || null }) };
}
