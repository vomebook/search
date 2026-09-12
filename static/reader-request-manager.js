(function (root) {
  "use strict";

  function createReaderRequestManager(options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const AbortControllerImpl = options.AbortControllerImpl || root.AbortController;
    const setTimer = options.setTimer || root.setTimeout.bind(root);
    const clearTimer = options.clearTimer || root.clearTimeout.bind(root);
    const pending = new Map();
    const active = new Set();
    let disposed = false;

    function settle(record) {
      if (record.settled) return;
      record.settled = true;
      clearTimer(record.timeout);
      active.delete(record);
    }

    function abort(record, reason) {
      if (record.settled) return;
      record.controller.abort(reason);
      record.abortBody?.(reason);
      settle(record);
    }

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
      const ReadableStreamImpl =
        root.ReadableStream || (typeof ReadableStream === "function" ? ReadableStream : null);
      if (!response?.body?.getReader || !ResponseImpl || !ReadableStreamImpl) {
        settle(record);
        return response;
      }
      const sourceReader = response.body.getReader();
      const stream = new ReadableStreamImpl({
        start(controller) {
          record.abortBody = (reason) => {
            controller.error(reason);
            sourceReader.cancel(reason).catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const result = await sourceReader.read();
            if (record.settled) return;
            if (result.done) {
              settle(record);
              controller.close();
            } else {
              controller.enqueue(result.value);
            }
          } catch (error) {
            if (record.settled) return;
            settle(record);
            controller.error(error);
          }
        },
        cancel(reason) {
          settle(record);
          return sourceReader.cancel(reason);
        }
      });
      return new ResponseImpl(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    function request(url, timeoutMs) {
      if (disposed) return Promise.reject(new DOMException("Reader disposed", "AbortError"));
      if (pending.has(url)) return responseForCaller(pending.get(url));
      const controller = new AbortControllerImpl();
      const record = {
        controller,
        timeout: null,
        promise: null,
        responseClaimed: false,
        settled: false,
        abortBody: null
      };
      record.timeout = setTimer(
        () => abort(record, new DOMException("Reader request timed out", "TimeoutError")),
        timeoutMs
      );
      active.add(record);
      record.promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return fetchImpl(url, { signal: controller.signal });
        })
        .then(async (response) => {
          if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            try {
              await response.body?.cancel?.(reason);
            } catch (_) {}
            throw reason;
          }
          return wrapResponse(record, response);
        })
        .catch((error) => {
          settle(record);
          controller.signal.throwIfAborted();
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
      for (const record of active) abort(record, new DOMException("Reader disposed", "AbortError"));
      pending.clear();
    }

    return Object.freeze({
      request,
      dispose,
      get pendingCount() {
        return pending.size;
      },
      get activeCount() {
        return active.size;
      },
      get disposed() {
        return disposed;
      }
    });
  }

  root.VoiceOfMLReaderRequests = Object.freeze({ createReaderRequestManager });
})(typeof self !== "undefined" ? self : globalThis);
