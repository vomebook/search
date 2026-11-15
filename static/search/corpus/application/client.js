// Owns the Worker transport and its shared startup/recovery epochs. The host
// publishes corpus metadata and owns local-mode UI/load completion.
(function () {
  /** @param {string} code @param {string} [message] */
  function makeWorkerError(code, message) {
    return Object.assign(new Error(message || code), {code});
  }

  /** @param {VoiceOfMLCorpusDependencies} deps */
  function create(deps) {
    const WORKER_PROTOCOL_VERSION = deps.protocol;
    const WORKER_REQUEST_TIMEOUT = deps.requestTimeout;
    const WORKER_LOAD_TIMEOUT = deps.loadTimeout;
    /** @type {Worker | null} */
    let corpusWorker = null;
    /** @type {Promise<Worker> | null} */
    let corpusWorkerStartPromise = null;
    /** @type {VoiceOfMLCorpusEpoch | null} */
    let corpusWorkerEpoch = null;
    let corpusWorkerRequestId = 0;
    let corpusWorkerRestartCount = 0;
    let corpusWorkerConsecutiveRestarts = 0;
    const CORPUS_WORKER_MAX_CONSECUTIVE_RESTARTS = 1;
    /** @type {Map<number, VoiceOfMLCorpusPending>} */
    const corpusWorkerPending = new Map();

    /** @param {unknown} error */
    function rejectCorpusWorkerPending(error) {
      corpusWorkerPending.forEach(function(entry) {
        clearTimeout(entry.timer);
        entry.cleanup?.();
        entry.reject(error);
      });
      corpusWorkerPending.clear();
    }

    /** @param {unknown} [error] @param {Worker | null} [worker] */
    function terminateCorpusWorker(error, worker = corpusWorker) {
      // A timeout/error from a retired instance must not destroy its replacement.
      if (worker !== corpusWorker) return;
      corpusWorker = null;
      corpusWorkerStartPromise = null;
      if (worker) worker.terminate();
      rejectCorpusWorkerPending(error || makeWorkerError("WORKER_TERMINATED", "Search Worker terminated"));
    }

    /** @type {VoiceOfMLCorpusClient['post']} */
    function postCorpusWorkerRequest(type, payload, timeoutMs, signal, worker = corpusWorker) {
      if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
      if (!worker || worker !== corpusWorker) return Promise.reject(makeWorkerError("WORKER_UNAVAILABLE", "Search Worker is unavailable"));
      const id = ++corpusWorkerRequestId;
      return new Promise(function(resolve, reject) {
        const expire = function() {
          if (!corpusWorkerPending.has(id)) return;
          clearTimeout(timer);
          cleanup();
          corpusWorkerPending.delete(id);
          const error = makeWorkerError("WORKER_TIMEOUT", "Search Worker request timed out");
          terminateCorpusWorker(error, worker);
          reject(error);
        };
        const duration = timeoutMs || WORKER_REQUEST_TIMEOUT;
        const timer = setTimeout(expire, duration);
        const cancel = () => {
          if (!corpusWorkerPending.has(id)) return;
          corpusWorkerPending.delete(id); clearTimeout(timer); cleanup();
          // Cancellation must settle even if structured cloning/posting fails.
          try {
            if (worker === corpusWorker) worker.postMessage({protocol: WORKER_PROTOCOL_VERSION, type: "cancel-search", id: ++corpusWorkerRequestId, payload: {requestId: id}});
          } catch (_) {}
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        corpusWorkerPending.set(id, { worker, resolve, reject, timer, expire, cleanup, deadline: Date.now() + duration });
        signal?.addEventListener("abort", cancel, {once: true});
        try {
          worker.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: type, id: id, payload: payload || {} });
        } catch (error) {
          corpusWorkerPending.delete(id); clearTimeout(timer); cleanup();
          reject(error);
        }
        if (signal?.aborted) cancel();
      });
    }

    function ensureCorpusWorker() {
      if (corpusWorkerStartPromise) return corpusWorkerStartPromise;
      if (corpusWorker) return Promise.resolve(corpusWorker);
      /** @type {VoiceOfMLCorpusEpoch} */
      const epoch = { worker: null, recovery: null, bootstrap: null };
      corpusWorkerEpoch = epoch;
      /** @type {Worker | null} */
      let worker;
      try {
        worker = deps.createWorker();
        if (!worker) return Promise.reject(makeWorkerError("WORKER_UNAVAILABLE", "Web Workers are unavailable"));
      } catch (error) {
        return Promise.reject(error);
      }
      epoch.worker = worker;
      corpusWorker = worker;
      worker.addEventListener("message", function(event) {
        if (worker !== corpusWorker) return;
        const message = event.data || {};
        if (message.type !== "response") return;
        const pending = corpusWorkerPending.get(message.id);
        if (!pending || pending.worker !== worker) return;
        corpusWorkerPending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanup?.();
        if (message.protocol !== WORKER_PROTOCOL_VERSION) {
          pending.reject(makeWorkerError("PROTOCOL_MISMATCH", "Refresh required: app/Worker protocol mismatch"));
          return;
        }
        if (!message.ok) pending.reject(makeWorkerError(message.error && message.error.code || "WORKER_ERROR", message.error && message.error.message));
        else pending.resolve(message.result);
      });
      /** @param {Event & {message?: string}} event */
      function fail(event) {
        const error = makeWorkerError("WORKER_ERROR", event && event.message || "Search Worker failed");
        terminateCorpusWorker(error, worker);
      }
      worker.addEventListener("error", fail, { once: true });
      worker.addEventListener("messageerror", fail, { once: true });
      // Publish the shared startup promise before posting, including synchronous failures.
      corpusWorkerStartPromise = Promise.resolve().then(function() {
        return postCorpusWorkerRequest("handshake", {}, WORKER_REQUEST_TIMEOUT, null, worker);
      }).then(function(result) {
        if (!result || result.protocol !== WORKER_PROTOCOL_VERSION) throw makeWorkerError("PROTOCOL_MISMATCH", "Refresh required: app/Worker protocol mismatch");
        if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
        corpusWorkerStartPromise = null;
        return worker;
      }).catch(function(error) {
        terminateCorpusWorker(error, worker);
        throw error;
      });
      return corpusWorkerStartPromise;
    }

    /** @type {VoiceOfMLCorpusClient['request']} */
    async function corpusWorkerRequest(type, payload, timeoutMs, signal) {
      const checkCancelled = () => {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      };
      checkCancelled();
      const start = ensureCorpusWorker();
      const epoch = /** @type {VoiceOfMLCorpusEpoch} */ (corpusWorkerEpoch);
      try {
        const worker = await start;
        checkCancelled();
        const metadata = epoch.bootstrap ? await epoch.bootstrap : null;
        checkCancelled();
        const result = metadata && type === "load-corpus" && payload?.url === deps.corpusURL()
          ? metadata : await postCorpusWorkerRequest(type, payload, timeoutMs, signal, worker);
        checkCancelled();
        if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
        corpusWorkerConsecutiveRestarts = 0;
        return result;
      } catch (error) {
        checkCancelled();
        const failure = /** @type {{name?: string, code?: string} | null} */ (error);
        if (failure?.name === "AbortError" || failure?.code === "PROTOCOL_MISMATCH") throw error;
        // All failed waiters on an epoch join one recovery, including late catch callbacks.
        if (!epoch.recovery) {
          if (corpusWorkerConsecutiveRestarts >= CORPUS_WORKER_MAX_CONSECUTIVE_RESTARTS) throw error;
          corpusWorkerConsecutiveRestarts++;
          corpusWorkerRestartCount++;
          epoch.recovery = Promise.resolve().then(async function() {
            terminateCorpusWorker(error, epoch.worker);
            const ready = ensureCorpusWorker();
            const replacement = /** @type {VoiceOfMLCorpusEpoch} */ (corpusWorkerEpoch);
            if (!replacement.bootstrap) {
              replacement.bootstrap = ready.then(worker => postCorpusWorkerRequest("load-corpus", {
                url: deps.corpusURL(),
              }, WORKER_LOAD_TIMEOUT, null, worker));
            }
            const bootstrap = replacement.bootstrap;
            try {
              const metadata = await bootstrap;
              return { worker: replacement.worker, metadata };
            } finally {
              // A rejected load must not poison this live instance permanently.
              // Release only our bootstrap; retain the exhausted automatic retry
              // budget until a later explicit request actually succeeds.
              if (replacement.bootstrap === bootstrap) replacement.bootstrap = null;
            }
          });
        }
        // Bootstrap belongs to the shared replacement; cancelling one waiter must
        // not cancel it for the remaining callers.
        const { worker, metadata } = await epoch.recovery.catch(function(recoveryError) {
          checkCancelled();
          throw recoveryError;
        });
        checkCancelled();
        if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
        const result = type === "load-corpus" && payload?.url === deps.corpusURL()
          ? metadata : await postCorpusWorkerRequest(type, payload, timeoutMs, signal, worker);
        checkCancelled();
        if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
        corpusWorkerConsecutiveRestarts = 0;
        return result;
      }
    }

    function expireRequests() {
      const now = Date.now();
      corpusWorkerPending.forEach(entry => { if (now >= entry.deadline) entry.expire(); });
    }

    // Detached diagnostics: no pending entries, callbacks, or epoch objects escape.
    function inspect() {
      return {
        worker: corpusWorker, starting: !!corpusWorkerStartPromise,
        bootstrapping: !!corpusWorkerEpoch?.bootstrap,
        restartCount: corpusWorkerRestartCount, consecutiveRestarts: corpusWorkerConsecutiveRestarts,
        pending: Array.from(corpusWorkerPending, ([id, entry]) => ({id, deadline: entry.deadline})),
      };
    }
    return { request: corpusWorkerRequest, post: postCorpusWorkerRequest,
      ensure: ensureCorpusWorker, terminate: terminateCorpusWorker, expireRequests, inspect };
  }
  globalThis.VoiceOfMLCorpusClient = { create, makeWorkerError };
})();
