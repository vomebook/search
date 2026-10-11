(function (root) {
  "use strict";

  function createReaderRequestManager(options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const AbortControllerImpl = options.AbortControllerImpl || root.AbortController;
    const setTimer = options.setTimer || root.setTimeout.bind(root);
    const clearTimer = options.clearTimer || root.clearTimeout.bind(root);
    const initialIdleMs = options.initialIdleMs || 10000;
    const pending = new Map();
    const active = new Set();
    let disposed = false;

    function settle(record) {
      if (record.settled) return;
      record.settled = true;
      clearTimer(record.timeout);
      record.clearAttempt?.();
      record.removeCallerAbort?.();
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

    function wrapResponse(record, response, sourceReader = null, firstChunk = null) {
      const ResponseImpl = root.Response || (typeof Response === "function" ? Response : null);
      const ReadableStreamImpl =
        root.ReadableStream || (typeof ReadableStream === "function" ? ReadableStream : null);
      if (!response?.body?.getReader || !ResponseImpl || !ReadableStreamImpl) {
        settle(record);
        return response;
      }
      sourceReader ||= response.body.getReader();
      const stream = new ReadableStreamImpl({
        start(controller) {
          record.abortBody = (reason) => {
            controller.error(reason);
            sourceReader.cancel(reason).catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const result = firstChunk || await sourceReader.read();
            firstChunk = null;
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

    function request(url, timeoutMs, requestInit = {}) {
      if (disposed) return Promise.reject(new DOMException("Reader disposed", "AbortError"));
      const callerSignal = requestInit.signal;
      if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
      // Share plain GETs only. Other options can change the body, validators,
      // range or cancellation owner even when the URL is identical.
      const shareable = typeof url === "string" && Object.keys(requestInit).every((key) => key === "priority");
      const key = shareable ? JSON.stringify([String(url), timeoutMs]) : {};
      if (pending.has(key)) return responseForCaller(pending.get(key));
      const controller = new AbortControllerImpl();
      const recoverInitial = typeof url === "string" && timeoutMs > initialIdleMs * 2 &&
        Object.keys(requestInit).every(key => key === "priority" || key === "signal");
      const record = {
        controller,
        timeout: null,
        promise: null,
        responseClaimed: false,
        settled: false,
        abortBody: null
      };
      async function open() {
        for (let attempt = 0; ; attempt++) {
          controller.signal.throwIfAborted();
          const transport = new AbortControllerImpl();
          let idle, sourceReader = null;
          const cancel = () => transport.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", cancel, { once: true });
          record.clearAttempt = () => {
            clearTimer(idle);
            controller.signal.removeEventListener("abort", cancel);
          };
          const arm = () => {
            clearTimer(idle);
            if (recoverInitial) idle = setTimer(() => transport.abort(
              new DOMException("Reader initial response stalled", "TimeoutError")
            ), initialIdleMs);
          };
          const owned = (promise, onLate) => new Promise((resolve, reject) => {
            const signal = transport.signal;
            const aborted = () => reject(signal.reason);
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
            Promise.resolve(promise).then(value => {
              if (signal.aborted) onLate?.(value);
              else resolve(value);
            }, reject).finally(() => signal.removeEventListener("abort", aborted));
          });
          try {
            arm();
            const response = await owned(fetchImpl(url, { ...requestInit,
              ...(attempt ? { cache: "reload" } : {}), signal: transport.signal }),
              response => response.body?.cancel(transport.signal.reason).catch(() => {}));
            let firstChunk = null;
            // Do not publish headers from a stalled attempt: a restart can then
            // replace the entire response without mixing versions or body bytes.
            if (recoverInitial && response.ok && response.body?.getReader) {
              sourceReader = response.body.getReader();
              arm();
              firstChunk = await owned(sourceReader.read());
            }
            clearTimer(idle);
            controller.signal.throwIfAborted();
            return wrapResponse(record, response, sourceReader, firstChunk);
          } catch (error) {
            record.clearAttempt();
            transport.abort(error);
            sourceReader?.cancel(error).catch(() => {});
            controller.signal.throwIfAborted();
            if (!recoverInitial || attempt || !["TimeoutError", "TypeError"].includes(error?.name)) throw error;
          }
        }
      }
      if (callerSignal) {
        const onAbort = () => abort(record, callerSignal.reason);
        callerSignal.addEventListener("abort", onAbort, { once: true });
        record.removeCallerAbort = () => callerSignal.removeEventListener("abort", onAbort);
      }
      record.timeout = setTimer(
        () => abort(record, new DOMException("Reader request timed out", "TimeoutError")),
        timeoutMs
      );
      active.add(record);
      record.promise = Promise.resolve()
        .then(open)
        .catch((error) => {
          settle(record);
          controller.signal.throwIfAborted();
          throw error;
        })
        .finally(() => {
          if (pending.get(key) === record) pending.delete(key);
        });
      pending.set(key, record);
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
