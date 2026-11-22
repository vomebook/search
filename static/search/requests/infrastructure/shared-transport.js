// Owns network entries, deadlines and subscribers independently of page state.
(function () {
  /** @param {VoiceOfMLSearchTransportDependencies} deps */
  function create(deps) {
    /** @type {Map<string, VoiceOfMLSearchRequestEntry>} */
    const pending = new Map();
    /** @param {string} cacheKey @param {string} url @param {VoiceOfMLSearchRequestBody} body @param {number} timeoutMs */
    function createRequest(cacheKey, url, body, timeoutMs) {
      const controller = new AbortController();
      /** @type {VoiceOfMLSearchRequestEntry} */
      const entry = { controller, deadline: Date.now() + timeoutMs, listeners: new Map(), nextListenerId: 0,
        expire() {}, promise: Promise.resolve(undefined) };
      // Only the rejection side participates in the race.
      const stopped = new Promise((...[, reject]) => {
        entry.expire = () => {
          reject(new Error("API_TIMEOUT"));
          controller.abort();
        };
        controller.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      });
      const timer = setTimeout(entry.expire, timeoutMs);
      const request = deps.fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      }).then(async response => {
        if (!response.ok) throw Object.assign(new Error("HTTP " + response.status), { status: response.status });
        const data = await response.json();
        if (!deps.validate(data, body.page, body.page_size)) throw new Error("INVALID_API_RESPONSE");
        return data;
      });
      entry.promise = Promise.race([request, stopped]).finally(() => {
        clearTimeout(timer);
        entry.listeners.forEach(({ owner, cancel }) => { if (owner && cancel) owner.removeEventListener("abort", cancel); });
        entry.listeners.clear();
        // A late completion must never remove a replacement for this key.
        if (pending.get(cacheKey) === entry) pending.delete(cacheKey);
      });
      pending.set(cacheKey, entry);
      return entry;
    }
    /** @param {string} cacheKey @param {string} url @param {VoiceOfMLSearchRequestBody} body @param {AbortSignal | null | undefined} signal @param {number} timeoutMs */
    function fetchPage(cacheKey, url, body, signal, timeoutMs) {
      if (signal && signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
      let entry = pending.get(cacheKey);
      if (entry && Date.now() >= entry.deadline) entry.expire();
      if (!entry || entry.controller.signal.aborted) entry = createRequest(cacheKey, url, body, timeoutMs);
      if (!signal) {
        // Signal-less callers retain ownership until the shared promise settles.
        entry.listeners.set(++entry.nextListenerId, { owner: null, cancel: null });
        return entry.promise;
      }
      const listenerId = ++entry.nextListenerId;
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener("abort", cancel);
          entry.listeners.delete(listenerId);
        };
        const cancel = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new DOMException("Cancelled", "AbortError"));
          if (!entry.listeners.size && !entry.controller.signal.aborted) entry.controller.abort();
        };
        entry.listeners.set(listenerId, { owner: signal, cancel });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        entry.promise.then(data => {
          if (settled) return;
          settled = true; cleanup(); resolve(data);
        }, error => {
          if (settled) return;
          settled = true; cleanup(); reject(error);
        });
      });
    }
    function expire() {
      const now = Date.now();
      pending.forEach(entry => { if (now >= entry.deadline) entry.expire(); });
    }
    return { pending, fetchPage, expire };
  }
  globalThis.VoiceOfMLSearchTransport = { create };
})();
