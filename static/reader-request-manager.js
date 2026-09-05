(function(root) {
  "use strict";

  function createReaderRequestManager(options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const AbortControllerImpl = options.AbortControllerImpl || root.AbortController;
    const setTimer = options.setTimer || root.setTimeout.bind(root);
    const clearTimer = options.clearTimer || root.clearTimeout.bind(root);
    const pending = new Map();
    let disposed = false;

    function responseForCaller(record) {
      return record.promise.then((response) => {
        if (!record.responseClaimed) {
          record.responseClaimed = true;
          return response;
        }
        return typeof response?.clone === "function" ? response.clone() : response;
      });
    }

    function wrapResponse(record, response) {
      const ResponseImpl = root.Response || (typeof Response === "function" ? Response : null);
      const ReadableStreamImpl = root.ReadableStream || (typeof ReadableStream === "function" ? ReadableStream : null);
      if (!response?.body?.getReader || !ResponseImpl || !ReadableStreamImpl) {
        clearTimer(record.timeout);
        return response;
      }
      const sourceReader = response.body.getReader();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimer(record.timeout);
      };
      const stream = new ReadableStreamImpl({
        async pull(controller) {
          try {
            const result = await sourceReader.read();
            if (result.done) {
              settle();
              controller.close();
            } else {
              controller.enqueue(result.value);
            }
          } catch (error) {
            settle();
            controller.error(error);
          }
        },
        cancel(reason) {
          settle();
          return sourceReader.cancel(reason);
        },
      });
      return new ResponseImpl(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    function request(url, timeoutMs) {
      if (disposed) return Promise.reject(new DOMException("Reader disposed", "AbortError"));
      if (pending.has(url)) return responseForCaller(pending.get(url));
      const controller = new AbortControllerImpl();
      const timeout = setTimer(() => controller.abort(), timeoutMs);
      const record = { controller, timeout, promise: null, responseClaimed: false };
      record.promise = Promise.resolve()
        .then(() => fetchImpl(url, { signal: controller.signal }))
        .then((response) => wrapResponse(record, response))
        .catch((error) => {
          clearTimer(timeout);
          throw error;
        })
        .finally(() => {
          if (pending.get(url) === record) pending.delete(url);
        });
      pending.set(url, record);
      return responseForCaller(record);
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
