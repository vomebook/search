(function(root) {
  "use strict";

  function createReaderRequestManager(options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const AbortControllerImpl = options.AbortControllerImpl || root.AbortController;
    const setTimer = options.setTimer || root.setTimeout.bind(root);
    const clearTimer = options.clearTimer || root.clearTimeout.bind(root);
    const pending = new Map();
    let disposed = false;

    function request(url, timeoutMs) {
      if (disposed) return Promise.reject(new DOMException("Reader disposed", "AbortError"));
      if (pending.has(url)) return pending.get(url).promise;
      const controller = new AbortControllerImpl();
      const timeout = setTimer(() => controller.abort(), timeoutMs);
      const record = { controller, timeout, promise: null };
      record.promise = Promise.resolve()
        .then(() => fetchImpl(url, { signal: controller.signal }))
        .finally(() => {
          clearTimer(timeout);
          if (pending.get(url) === record) pending.delete(url);
        });
      pending.set(url, record);
      return record.promise;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of pending.values()) {
        clearTimer(record.timeout);
        record.controller.abort();
      }
      pending.clear();
    }

    return Object.freeze({ request, dispose, get pendingCount() { return pending.size; }, get disposed() { return disposed; } });
  }

  root.VoiceOfMLReaderRequests = Object.freeze({ createReaderRequestManager });
})(typeof self !== "undefined" ? self : globalThis);
