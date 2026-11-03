(function (root) {
  "use strict";

  /**
   * @typedef {{ controller: AbortController, timeout: number | null,
   *   promise: Promise<Response> | null, responseClaimed: boolean, settled: boolean,
   *   abortBody: ((reason: unknown) => void) | null, clearAttempt?: () => void,
   *   removeCallerAbort?: () => void }} RequestRecord
   */
  /** @param {ReaderRequestManagerOptions} [options] @returns {Readonly<ReaderRequestManager>} */
  function createReaderRequestManager(options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const AbortControllerImpl = options.AbortControllerImpl || root.AbortController;
    const setTimer = options.setTimer || root.setTimeout.bind(root);
    const clearTimer = options.clearTimer || root.clearTimeout.bind(root);
    const initialIdleMs = options.initialIdleMs || 10000;
    /** @type {Map<string | object, RequestRecord>} */
    const pending = new Map();
    /** @type {Set<RequestRecord>} */
    const active = new Set();
    let disposed = false;

    /** @param {RequestRecord} record */
    function settle(record) {
      if (record.settled) return;
      record.settled = true;
      clearTimer(/** @type {number} */ (record.timeout));
      record.clearAttempt?.();
      record.removeCallerAbort?.();
      active.delete(record);
    }

    /** @param {RequestRecord} record @param {unknown} reason */
    function abort(record, reason) {
      if (record.settled) return;
      record.controller.abort(reason);
      record.abortBody?.(reason);
      settle(record);
    }

    /** @param {RequestRecord} record */
    function responseForCaller(record) {
      // Called only after request installs the promise in the pending record.
      return /** @type {Promise<Response>} */ (record.promise).then((response) => {
        if (!record.responseClaimed) {
          record.responseClaimed = true;
          return response;
        }
        return typeof response?.clone === "function" ? response.clone() : response;
      });
    }

    /** @param {RequestRecord} record @param {Response} response
     * @param {ReadableStreamDefaultReader<Uint8Array> | null} [sourceReader]
     * @param {ReadableStreamReadResult<Uint8Array> | null} [firstChunk] */
    function wrapResponse(record, response, sourceReader = null, firstChunk = null) {
      const ResponseImpl = root.Response || (typeof Response === "function" ? Response : null);
      const ReadableStreamImpl =
        root.ReadableStream || (typeof ReadableStream === "function" ? ReadableStream : null);
      if (!response?.body?.getReader || !ResponseImpl || !ReadableStreamImpl) {
        settle(record);
        return response;
      }
      const reader = sourceReader || response.body.getReader();
      const stream = new ReadableStreamImpl({
        start(controller) {
          record.abortBody = (reason) => {
            controller.error(reason);
            reader.cancel(reason).catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const result = firstChunk || await reader.read();
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
          return reader.cancel(reason);
        }
      });
      return new ResponseImpl(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    /** @param {RequestInfo | URL} url @param {number} timeoutMs @param {RequestInit} [requestInit]
     * @param {number | null} [bufferLimit] @returns {Promise<Response>} */
    function request(url, timeoutMs, requestInit = {}, bufferLimit = null) {
      if (disposed) return Promise.reject(new DOMException("Reader disposed", "AbortError"));
      const callerSignal = requestInit.signal;
      if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
      // Share plain GETs only. Other options can change the body, validators,
      // range or cancellation owner even when the URL is identical.
      const shareable = typeof url === "string" && Object.keys(requestInit).every((key) => key === "priority");
      const key = shareable ? JSON.stringify([String(url), timeoutMs, bufferLimit]) : {};
      if (pending.has(key)) return responseForCaller(/** @type {RequestRecord} */ (pending.get(key)));
      const controller = new AbortControllerImpl();
      const recoverInitial = typeof url === "string" && timeoutMs > initialIdleMs * 2 &&
        Object.keys(requestInit).every(key => key === "priority" || key === "signal");
      /** @type {RequestRecord} */
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
          /** @type {number | undefined} */
          let idle;
          /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
          let sourceReader = null;
          const cancel = () => transport.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", cancel, { once: true });
          record.clearAttempt = () => {
            clearTimer(idle);
            controller.signal.removeEventListener("abort", cancel);
          };
          const arm = () => {
            clearTimer(idle);
            if (recoverInitial && attempt === 0) idle = setTimer(() => transport.abort(
              new DOMException("Reader initial response stalled", "TimeoutError")
            ), initialIdleMs);
          };
          /** @template T @param {PromiseLike<T>} promise @param {(value: T) => void} [onLate] @returns {Promise<T>} */
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
            // Bounded metadata is unpublished until EOF, so a failed body can
            // be replaced in full without replaying any caller-visible bytes.
            if (bufferLimit !== null && response.ok && response.body?.getReader) {
              const tooLarge = () => Object.assign(new Error("READER_RESOURCE_LIMIT"), {code:"READER_RESOURCE_LIMIT"});
              if (Number(response.headers.get("Content-Length")) > bufferLimit) {
                response.body.cancel().catch(() => {});
                throw tooLarge();
              }
              sourceReader = response.body.getReader();
              const chunks = [];
              let length = 0;
              while (true) {
                arm();
                const chunk = await owned(sourceReader.read());
                if (chunk.done) break;
                length += chunk.value.byteLength;
                if (length > bufferLimit) throw tooLarge();
                chunks.push(chunk.value);
              }
              controller.signal.throwIfAborted();
              sourceReader.releaseLock();
              sourceReader = null;
              const bytes = new Uint8Array(length);
              let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
              const complete = new root.Response(bytes, {
                status:response.status, statusText:response.statusText, headers:response.headers
              });
              settle(record);
              return complete;
            }
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
            /** @type {() => void} */ (record.clearAttempt)();
            transport.abort(error);
            if (sourceReader) {
              const reader = sourceReader;
              reader.cancel(error).catch(() => {}).finally(() => reader.releaseLock());
            }
            controller.signal.throwIfAborted();
            if (!recoverInitial || attempt || !["TimeoutError", "TypeError"].includes(
              /** @type {{name: string}} */ (error)?.name)) throw error;
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
      /** @param {RequestInfo | URL} url @param {number} timeoutMs @param {number} limit
       * @param {RequestInit} [requestInit] @returns {Promise<Response>} */
      requestBuffered(url, timeoutMs, limit, requestInit = {}) {
        if (!Number.isSafeInteger(limit) || limit < 0) return Promise.reject(new RangeError("Invalid response limit"));
        return request(url, timeoutMs, requestInit, limit);
      },
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
