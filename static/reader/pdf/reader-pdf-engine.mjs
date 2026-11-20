/** @typedef {import("../../../typings/reader-pdf-engine-strict").EngineContext} EngineContext */
/** @typedef {import("../../../typings/reader-pdf-engine-strict").PdfModule} PdfModule */
/** @typedef {import("../../../typings/reader-pdf-engine-strict").PdfOptions} PdfOptions */
/** @typedef {import("../../../typings/reader-pdf-engine-strict").Initial} Initial */
/** @typedef {import("../../../typings/reader-pdf-engine-strict").PdfTask} PdfTask */
/** @param {EngineContext} readerContext */
export function createReaderPdfEngine(readerContext) {
  /** @type {Promise<PdfModule> | null} */
  let pdfModulePreload = null;
  /** @type {AbortController | null} */
  let pdfWorkerPreloadOwner = null;

  /** @param {PdfModule} pdfjs @param {(url: string) => PdfOptions} options @param {string} url @param {Initial} initial */
  function loadPdfTaskWithTimeout(pdfjs, options, url, initial = null) {
    readerContext.assertReaderActive();
    /** @type {PdfTask | null} */
    let task = null;
    let documentReady = false;
    const owner = new AbortController();
    return new Promise(/** @type {(resolve: (document: import("../../../typings/reader-pdf-engine-strict").PdfDocument) => void, reject: (error: unknown) => void) => void} */ ((resolve, reject) => {
      let timeout = 0,
        destroyed = false;
      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        owner.abort(readerContext.readerAbortError());
        clearTimeout(timeout);
        try {
          if (task) Promise.resolve(task.destroy()).catch(() => {});
        } catch (_) {}
        reject(readerContext.readerAbortError());
      };
      const untrack = readerContext.trackReaderResource(destroy);
      timeout = setTimeout(() => {
        reject(new Error("reader PDF timeout"));
        untrack();
        destroy();
      }, readerContext.READER_PROXY_TIMEOUT_MS);
      const documentOptions = options(url);
      readerContext.openPdfRangeTask(pdfjs, documentOptions, {
        signal:owner.signal, readBytes:VoiceOfMLReaderSecurity.readBytes, initial,
        limit:VoiceOfMLReaderSecurity.LIMITS.pdfDocumentBytes,
        rangeLimit:VoiceOfMLReaderSecurity.LIMITS.pdfDocumentBytes,
        boundedMetadata: !!documentOptions.worker?.readerFirstPageWorker,
        ratePriority: (begin,end) => readerContext.pdfFetchPolicy?.prioritizeRange?.(begin,end,url),
        canPrefetchOpening: () => !!readerContext.pdfV3Manifest && readerContext.readerRestorationLoaded &&
          (!readerContext.readerRestorationEntry || Number(readerContext.readerRestorationEntry.page) <= 1),
        canPrefetchFirstPage: () => readerContext.capability?.mode === "pdf" &&
          readerContext.readerRestorationLoaded && !readerContext.restorationFailed &&
          (!readerContext.readerRestorationEntry || Number(readerContext.readerRestorationEntry.page) === 1),
        onError() {
          if (!documentReady || readerContext.readerAbortController.signal.aborted) return;
          if (readerContext.capability.mode !== "pdf") return;
          // Page retries cannot revive a destroyed PDF.js document. Capture an
          // eligible position before failure stops work; reload owns recovery.
          readerContext.saveProgress();
          readerContext.fail("PDF 数据读取失败，请重试加载。", "READER_PDF_TRANSPORT");
        }
      }).then(opened => {
        task = opened;
        if (destroyed) {Promise.resolve(task.destroy()).catch(() => {});throw readerContext.readerAbortError();}
        return task.promise;
      }).then(
        (document) => {
          clearTimeout(timeout);
          documentReady = true;
          if (readerContext.readerAbortController.signal.aborted) {
            destroy();
            return;
          }
          if (typeof task?.prioritizeRange === "function" && document._pdfInfo?.readerPageCountPending) {
            document._transport.messageHandler.on("ReaderPrioritizeRange", range => task?.prioritizeRange?.(range));
          }
          resolve(document);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
          untrack();
          destroy();
        }
      );
    }));
  }

  /** @param {PdfModule} pdfjs @param {(url: string) => PdfOptions} options @param {string} proxyUrl @param {(url: string) => Initial} [takeInitial] */
  function loadPdfWithTimeout(pdfjs, options, proxyUrl, takeInitial = () => null) {
    // Retry the proxy URL only; never fall back to the original source URL.
    return readerContext.retryReaderProxy(() => readerContext.loadPdfTaskWithTimeout(pdfjs, options, proxyUrl, takeInitial(proxyUrl)));
  }

  function preloadPdfEngine() {
    if (!readerContext.pdfEnginePreload) {
      pdfWorkerPreloadOwner = new AbortController();
      const signal = pdfWorkerPreloadOwner.signal;
      pdfModulePreload = readerContext.measurePdf(readerContext.loadPdfEngine(), "engine-module");
      readerContext.pdfEnginePreload = pdfModulePreload.then(pdfjs => readerContext.preparePdfWorker(pdfjs, false, signal));
    }
    return readerContext.pdfEnginePreload;
  }

  /** @param {PdfModule} pdfjs @param {boolean} firstPage @param {AbortSignal | null} signal */
  async function preparePdfWorker(pdfjs, firstPage = false, signal = null) {
    for (let attempt = 0; attempt < 3; attempt++) {
      readerContext.assertReaderActive();
      if (signal?.aborted) throw readerContext.readerAbortError();
      if (attempt && !firstPage) await readerContext.awaitReader(readerContext.waitForReader(attempt * 500), signal);
      try {
        return await readerContext.measurePdf(readerContext.preparePdfWorkerAttempt(pdfjs, attempt, firstPage, signal),
          firstPage && attempt === 0 ? "engine-worker-staged" : "engine-worker");
      } catch (error) {
        readerContext.assertReaderActive();
        if (signal?.aborted) throw readerContext.readerAbortError();
        if ((/** @type {{code?: string} | null | undefined} */ (error))?.code !== "READER_ENGINE_NETWORK" || attempt === 2) throw error;
      }
    }
    throw new Error("PDF worker preparation exhausted retries");
  }

  /** @param {PdfModule} pdfjs @param {number} attempt @param {boolean} firstPage @param {AbortSignal | null} signal */
  async function preparePdfWorkerAttempt(pdfjs, attempt, firstPage = false, signal = null) {
    readerContext.assertReaderActive();
    if (signal?.aborted) throw readerContext.readerAbortError();
    if (readerContext.capability.mode !== "pdf" && !readerContext.pdfPrimarySource()) return pdfjs;
    const query = new URLSearchParams();
    if (firstPage && attempt === 0) query.set("reader-first-page", "1");
    if (attempt) query.set("reader-worker-retry", String(attempt));
    pdfjs.GlobalWorkerOptions.workerSrc = readerContext.PDFJS_WORKER_URL + (query.size ? `?${query}` : "");
    // PDF.js 6.5.438 does not expose or terminate its native Worker until the
    // ready handshake completes. Capture that synchronously-created Worker so
    // cancellation can also release a stalled handshake. Restore the global
    // constructor immediately; PDF.js still owns initialization and fallback.
    const NativeWorker = globalThis.Worker;
    /** @type {Worker | null} */
    let nativeWorker = null;
    let worker;
    if (typeof NativeWorker === "function") {
      globalThis.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const instance = Reflect.construct(target, args);
          nativeWorker ||= instance;
          return instance;
        }
      });
    }
    try { worker = new pdfjs.PDFWorker(); }
    finally { if (typeof NativeWorker === "function") globalThis.Worker = NativeWorker; }
    worker.readerFirstPageWorker = firstPage && attempt === 0;
    readerContext.pdfWorker = worker;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      const port = worker.port;
      try { worker.destroy(); }
      finally { if (nativeWorker && nativeWorker !== port) nativeWorker.terminate(); }
      if (readerContext.pdfWorker === worker) {
        readerContext.pdfWorker = null;
        readerContext.releasePdfWorker = null;
      }
    };
    readerContext.releasePdfWorker = destroy;
    const untrack = readerContext.trackReaderResource(destroy);
    try {
      await readerContext.awaitReader(Promise.race([
        worker.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("PDF worker timeout")), 20000);
        })
      ]), signal);
      readerContext.assertReaderActive();
      return pdfjs;
    } catch (error) {
      untrack();
      destroy();
      readerContext.assertReaderActive();
      if (signal?.aborted) throw readerContext.readerAbortError();
      throw Object.assign(new Error("PDF 阅读组件下载失败，请检查网络后重试加载，或下载原文件。"),
        { code: "READER_ENGINE_NETWORK", cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadPdfEngine() {
    for (let attempt = 0; attempt < 3; attempt++) {
      readerContext.assertReaderActive();
      if (attempt) await readerContext.waitForReader(attempt * 500);
      readerContext.assertReaderActive();
      // Browsers can retain a rejected import for the life of this document.
      // Use two bounded retry URLs for the same pinned bytes, never a random URL.
      const url = attempt ? `${readerContext.PDFJS_URL}?reader-module-retry=${attempt}` : readerContext.PDFJS_URL;
      let timer;
      try {
        const pdfjs = await readerContext.awaitReader(
          Promise.race([
            /** @type {Promise<PdfModule>} */ (/** @type {unknown} */ (import(url))),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new DOMException("PDF engine timeout", "TimeoutError")),
                20000
              );
            })
          ])
        );
        readerContext.assertReaderActive();
        return pdfjs;
      } catch (error) {
        readerContext.assertReaderActive();
        const networkFailure =
          (/** @type {{name?: string} | null | undefined} */ (error))?.name === "TimeoutError" ||
          /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
            (/** @type {{message?: string} | null | undefined} */ (error))?.message || ""
          );
        if (!networkFailure) throw error;
        if (attempt === 2)
          throw Object.assign(
            new Error("PDF 阅读组件下载失败，请检查网络后重试加载，或下载原文件。"),
            { code: "READER_ENGINE_NETWORK", cause: error }
          );
      } finally {
        clearTimeout(timer);
      }
    }
  }

  function loadPdfDocument(target = readerContext.sourceUrl) {
    readerContext.assertReaderActive();
    const proxyUrl = readerContext.readerContentUrl(target);
    if (!readerContext.pdfFetchPolicy) {
      readerContext.pdfFetchPolicy = readerContext.createPdfFetchPolicy();
      readerContext.trackReaderResource(() => { readerContext.pdfFetchPolicy?.dispose(); readerContext.pdfFetchPolicy = null; });
    }
    readerContext.pdfFetchPolicy.add([target, proxyUrl]);
    const owner = new AbortController();
    const untrack = readerContext.trackReaderResource(() => owner.abort(readerContext.readerAbortError()));
    let pageOneKnown = false;
    const navigation = readerContext.readerRuntime?.currentGeneration("navigation");
    // Keep the actual restoration outcome independently of the short opening
    // timeout. It can settle while the initial range is still being retried.
    /** @type {{value: import("../../../typings/reader-pdf-engine-strict").Restoration | null} | null} */
    let settledRestoration = null;
    readerContext.readerRestorationPromise?.then(entry => {
      settledRestoration = {value:entry};
      pageOneKnown = readerContext.capability?.mode === "pdf" && !readerContext.restorationFailed &&
        (!entry || Number(entry.page) === 1);
    }).catch(() => {});
    // This is the first demand, not extra speculation or a larger/full download.
    // Keep it owned while engine preparation is pending and consume it only once.
    const prepareInitial = () => {
      const pending = readerContext.measurePdf(readerContext.preparePdfInitialRange({url:proxyUrl, rangeChunkSize:262144}, {
        signal:AbortSignal.any([owner.signal, readerContext.readerAbortController.signal]),
        readBytes:VoiceOfMLReaderSecurity.readBytes, limit:VoiceOfMLReaderSecurity.LIMITS.pdfDocumentBytes,
        rangeLimit:VoiceOfMLReaderSecurity.LIMITS.pdfDocumentBytes,
        canPrefetchFirstPage: () => pageOneKnown && !owner.signal.aborted &&
          navigation === readerContext.readerRuntime?.currentGeneration("navigation")
      }), "initial-range");
      pending.catch(() => {});
      return pending;
    };
    /** @type {Initial} */
    let initial = prepareInitial();
    let initialHandedOff = false, rangeTransportAvailable = false;
    /** @param {string} url @returns {Initial} */
    const takeInitial = url => {
      if (url !== proxyUrl) return null;
      const pending = initial;
      initial = null;
      if (pending && rangeTransportAvailable) initialHandedOff = true;
      return pending;
    };
    const workerPreload = readerContext.preloadPdfEngine();
    const workerPreloadOwner = pdfWorkerPreloadOwner;
    // Fail immediately if the ordinary preloader genuinely fails while range
    // or restoration is slow. An intentionally superseded preload is not an
    // engine failure; the selected first-page Worker still has to initialize.
    const workerFailure = new Promise((_, reject) => workerPreload.catch(error => {
      if (!workerPreloadOwner?.signal.aborted || (/** @type {{name?: string} | null | undefined} */ (error))?.name !== "AbortError") reject(error);
    }));
    const selectingEngine = (pdfModulePreload || workerPreload).then(async pdfjs => {
      readerContext.assertReaderActive();
      rangeTransportAvailable = typeof pdfjs.PDFDataRangeTransport === "function";
      const restoration = readerContext.readerRestorationPromise;
      const eligible = rangeTransportAvailable && readerContext.capability?.mode === "pdf" &&
        readerContext.extension === "pdf" && restoration && !readerContext.ocrManifestUrl &&
        !readerContext.pdfV3Manifest;
      if (eligible) {
        let releaseHistoryWait = () => {};
        /** @template T @param {Promise<T>} promise @returns {Promise<T | null>} */
        const optional = promise => {
          /** @type {ReturnType<typeof setTimeout> | undefined} */
          let timer;
          return readerContext.awaitReader(new Promise(/** @type {(resolve: (value: T | null) => void, reject: (error: unknown) => void) => void} */ ((resolve, reject) => {
            timer = setTimeout(() => resolve(null), 5000);
            releaseHistoryWait = () => resolve(null);
            Promise.resolve(promise).then(resolve, reject);
          }))).finally(() => clearTimeout(timer));
        };
        const initialRange = async () => {
          // If the initial strong-ETag range times out or fails transiently,
          // retry it while the engine is preparing. The old fallback could
          // permanently select the serial stock worker on a slow connection,
          // even if the next range attempt recovered moments later.
          for (let attempt = 0; attempt < 3 && initial; attempt++) {
            const pending = initial;
            try { return await readerContext.awaitReader(pending); }
            catch (error) {
              readerContext.assertReaderActive();
              if ((/** @type {{name?: string} | null | undefined} */ (error))?.name === "AbortError" || (/** @type {{code?: string} | null | undefined} */ (error))?.code === "READER_PDF_RATE_LIMIT" || !readerContext.retryableReaderProxyError(error) || attempt === 2) throw error;
              await readerContext.waitForReader(350 * (attempt + 1));
              readerContext.assertReaderActive();
              if (initial !== pending) return null;
              initial = prepareInitial();
            }
          }
          return null;
        };
        // Start the same bounded history window in parallel with the range.
        // Only wait for it when the response can actually use staging.
        const historyWait = optional(Promise.resolve(restoration).then(value => ({value})));
        historyWait.catch(() => {});
        let first = null;
        try { first = initial ? await initialRange() : null; }
        catch (_) { readerContext.assertReaderActive(); }
        if (!first || first.complete || typeof first.total !== "number" || !(first.total >= 8 * 1024 * 1024) ||
            !(first.bytes instanceof Uint8Array) || first.bytes[0] !== 0x25 || first.bytes[1] !== 0x50 ||
            first.bytes[2] !== 0x44 || first.bytes[3] !== 0x46 || first.bytes[4] !== 0x2d) {
          releaseHistoryWait();
          return await workerPreload;
        }
        let saved = await historyWait.catch(() => { readerContext.assertReaderActive(); return null; });
        saved ||= settledRestoration;
        if (first && !saved && !readerContext.restorationFailed &&
            navigation === readerContext.readerRuntime?.currentGeneration("navigation")) {
          // If the bounded history wait elapsed while the ordinary preloader
          // is still initializing, either can finish first. A settled history
          // can still authorize the staged path; a ready or failed ordinary
          // Worker keeps the previous fallback/failure behavior. Never infer
          // an empty history from the timeout itself.
          const outcome = await readerContext.awaitReader(Promise.race([
            Promise.resolve(restoration).then(value => ({saved:{value}})),
            workerPreload.then(() => ({saved:null}))
          ]));
          saved = outcome.saved || settledRestoration;
        }
        // All sufficiently large, strongly versioned native PDFs can use the
        // same staged parser on a fresh page-one open. Object numbers, xref
        // offsets, catalog layout and producer strings are not evidence of
        // page identity: the worker traverses the current PDF.js tree.
        // Keep the existing targeted path for saved deep pages; broadening
        // that path needs a separate restoration performance evaluation.
        const entry = saved?.value;
        const freshPageOne = saved && (!entry || (Number(entry.page) === 1 &&
          Number(entry.pageOffset || 0) === 0 && !entry.id));
        const stagedCandidate = freshPageOne ||
          readerContext.isFirstPageCandidate(first.bytes, first.total, first.rangeChunkSize);
        if (stagedCandidate && saved && !readerContext.restorationFailed &&
            navigation === readerContext.readerRuntime?.currentGeneration("navigation")) {
          workerPreloadOwner?.abort();
          await workerPreload.catch(error => { if ((/** @type {{name?: string} | null | undefined} */ (error))?.name !== "AbortError") throw error; });
          readerContext.releasePdfWorker?.();
          await readerContext.preparePdfWorker(pdfjs, true);
          return pdfjs;
        }
      }
      return workerPreload;
    });
    const openingEngine = Promise.race([selectingEngine, workerFailure]);
    return readerContext.measurePdf(openingEngine, "engine").then(pdfjs => {
      readerContext.assertReaderActive();
      const stagedWorker = readerContext.pdfWorker?.readerFirstPageWorker;
      /** @param {string} url @returns {PdfOptions} */
      const options = (url) => ({
        url,
        worker: readerContext.pdfWorker,
        // Bound demand reads for original and converted PDFs alike. Streaming
        // otherwise keeps the full download running alongside these ranges.
        rangeChunkSize: 262144,
        disableAutoFetch: true,
        disableStream: true,
        wasmUrl: readerContext.PDFJS_WASM_URL,
        cMapUrl: readerContext.PDFJS_CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: readerContext.PDFJS_STANDARD_FONT_URL,
        withCredentials: false
      });
      return readerContext.measurePdf(readerContext.loadPdfWithTimeout(pdfjs, options, proxyUrl, takeInitial), "document")
        .catch(async error => {
          readerContext.assertReaderActive();
          if (!stagedWorker || (/** @type {{name?: string} | null | undefined} */ (error))?.name === "AbortError" || readerContext.retryableReaderProxyError(error) ||
              /PDF_SOURCE_CHANGED|PDF_RANGE_INVALID|READER_RESOURCE_LIMIT/i.test(`${(/** @type {{code?: string} | null | undefined} */ (error))?.code || ""} ${(/** @type {{message?: string} | null | undefined} */ (error))?.message || ""}`))
            throw error;
          // A document requiring full PDF.js recovery must reopen through the
          // original worker, not silently accept provisional page identities.
          readerContext.releasePdfWorker?.();
          await readerContext.preparePdfWorker(pdfjs);
          return readerContext.loadPdfWithTimeout(pdfjs, options, proxyUrl, takeInitial);
        });
    }).finally(() => {
      initial = null;
      untrack();
      // A validated first-page section can still be serving getPage/render
      // after the document promise resolves. The transport now owns those
      // reads through cancelInitial; only an unhanded bootstrap ends here.
      if (!initialHandedOff) owner.abort(readerContext.readerAbortError());
    });
  }

  return {
    loadPdfTaskWithTimeout,
    loadPdfWithTimeout,
    preloadPdfEngine,
    preparePdfWorker,
    preparePdfWorkerAttempt,
    loadPdfEngine,
    loadPdfDocument
  };
}
