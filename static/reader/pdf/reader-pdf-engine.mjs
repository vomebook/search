export function createReaderPdfEngine(readerContext) {
  let pdfModulePreload = null, pdfWorkerPreloadOwner = null;

  function loadPdfTaskWithTimeout(pdfjs, options, url, initial = null) {
    readerContext.assertReaderActive();
    let task = null, documentReady = false;
    const owner = new AbortController();
    return new Promise((resolve, reject) => {
      let timeout = 0,
        destroyed = false;
      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        owner.abort(readerContext.readerAbortError());
        clearTimeout(timeout);
        try {
          task?.destroy()?.catch?.(() => {});
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
        limit:VoiceOfMLReaderSecurity.LIMITS.documentBytes,
        rangeLimit:VoiceOfMLReaderSecurity.LIMITS.pdfRangeDocumentBytes,
        boundedMetadata: !!documentOptions.worker?.readerFirstPageWorker,
        ratePriority: (begin,end) => readerContext.pdfFetchPolicy?.prioritizeRange?.(begin,end,url),
        canPrefetchOpening: () => !!readerContext.pdfV3Manifest && readerContext.readerRestorationLoaded &&
          (!readerContext.readerRestorationEntry || Number(readerContext.readerRestorationEntry.page) <= 1),
        canPrefetchFirstPage: () => readerContext.capability?.mode === "pdf" &&
          readerContext.readerRestorationLoaded && !readerContext.restorationFailed &&
          (!readerContext.readerRestorationEntry || Number(readerContext.readerRestorationEntry.page) === 1),
        onError(error) {
          if (!documentReady || readerContext.readerAbortController.signal.aborted) return;
          if (readerContext.capability.mode !== "pdf") return;
          // Page retries cannot revive a destroyed PDF.js document. Capture an
          // eligible position before failure stops work; reload owns recovery.
          readerContext.saveProgress();
          readerContext.fail("PDF 数据读取失败，请重试加载。", "READER_PDF_TRANSPORT");
        }
      }).then(opened => {
        task = opened;
        if (destroyed) {task.destroy()?.catch?.(() => {});throw readerContext.readerAbortError();}
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
    });
  }

  function loadPdfWithTimeout(pdfjs, options, target = readerContext.sourceUrl, proxy = readerContext.contentUrl, takeInitial = (_url) => null) {
    return readerContext.retryReaderProxy(() => readerContext.loadPdfTaskWithTimeout(pdfjs, options, proxy, takeInitial(proxy))).catch((error) => {
      readerContext.assertReaderActive();
      if (error && error.name === "AbortError") throw error;
      if (readerContext.retryableReaderProxyError(error)) throw error;
      return readerContext.loadPdfTaskWithTimeout(pdfjs, options, target);
    });
  }

  function preloadPdfEngine() {
    if (!readerContext.pdfEnginePreload) {
      pdfWorkerPreloadOwner = new AbortController();
      const signal = pdfWorkerPreloadOwner.signal;
      pdfModulePreload = readerContext.loadPdfEngine();
      readerContext.pdfEnginePreload = pdfModulePreload.then(pdfjs => readerContext.preparePdfWorker(pdfjs, false, signal));
    }
    return readerContext.pdfEnginePreload;
  }

  async function preparePdfWorker(pdfjs, firstPage = false, signal = null) {
    for (let attempt = 0; attempt < 3; attempt++) {
      readerContext.assertReaderActive();
      if (signal?.aborted) throw readerContext.readerAbortError();
      if (attempt && !firstPage) await readerContext.awaitReader(readerContext.waitForReader(attempt * 500), signal);
      try {
        return await readerContext.preparePdfWorkerAttempt(pdfjs, attempt, firstPage, signal);
      } catch (error) {
        readerContext.assertReaderActive();
        if (signal?.aborted) throw readerContext.readerAbortError();
        if (error?.code !== "READER_ENGINE_NETWORK" || attempt === 2) throw error;
      }
    }
  }

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
    let nativeWorker = null, worker;
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
    let timer, destroyed = false;
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
            import(url),
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
          error?.name === "TimeoutError" ||
          /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
            error?.message || ""
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
    /** @type {{value: {page?: number | string, pageOffset?: number | string, id?: string} | null | undefined} | null} */
    let settledRestoration = null;
    readerContext.readerRestorationPromise?.then(entry => {
      settledRestoration = {value:entry};
      pageOneKnown = readerContext.capability?.mode === "pdf" && !readerContext.restorationFailed &&
        (!entry || Number(entry.page) === 1);
    }).catch(() => {});
    // This is the first demand, not extra speculation or a larger/full download.
    // Keep it owned while engine preparation is pending and consume it only once.
    let initial = readerContext.preparePdfInitialRange({url:proxyUrl, rangeChunkSize:262144}, {
      signal:AbortSignal.any([owner.signal, readerContext.readerAbortController.signal]),
      readBytes:VoiceOfMLReaderSecurity.readBytes, limit:VoiceOfMLReaderSecurity.LIMITS.documentBytes,
      rangeLimit:VoiceOfMLReaderSecurity.LIMITS.pdfRangeDocumentBytes,
      canPrefetchFirstPage: () => pageOneKnown && !owner.signal.aborted &&
        navigation === readerContext.readerRuntime?.currentGeneration("navigation")
    });
    initial.catch(() => {});
    let initialHandedOff = false, rangeTransportAvailable = false;
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
      if (!workerPreloadOwner?.signal.aborted || error?.name !== "AbortError") reject(error);
    }));
    const selectingEngine = (pdfModulePreload || workerPreload).then(async pdfjs => {
      readerContext.assertReaderActive();
      rangeTransportAvailable = typeof pdfjs.PDFDataRangeTransport === "function";
      const restoration = readerContext.readerRestorationPromise;
      const eligible = rangeTransportAvailable && readerContext.capability?.mode === "pdf" &&
        readerContext.extension === "pdf" && restoration && !readerContext.ocrManifestUrl &&
        !readerContext.pdfV3Manifest;
      if (eligible) {
        const optional = promise => {
          let timer;
          return readerContext.awaitReader(new Promise((resolve, reject) => {
            timer = setTimeout(() => resolve(null), 5000);
            Promise.resolve(promise).then(resolve, reject);
          })).finally(() => clearTimeout(timer));
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
              if (error?.name === "AbortError" || error?.code === "READER_PDF_RATE_LIMIT" || !readerContext.retryableReaderProxyError(error) || attempt === 2) throw error;
              await readerContext.waitForReader(350 * (attempt + 1));
              readerContext.assertReaderActive();
              if (initial !== pending) return null;
              initial = readerContext.preparePdfInitialRange({url:proxyUrl, rangeChunkSize:262144}, {
                signal:AbortSignal.any([owner.signal, readerContext.readerAbortController.signal]),
                readBytes:VoiceOfMLReaderSecurity.readBytes, limit:VoiceOfMLReaderSecurity.LIMITS.documentBytes,
                rangeLimit:VoiceOfMLReaderSecurity.LIMITS.pdfRangeDocumentBytes,
                canPrefetchFirstPage: () => pageOneKnown && !owner.signal.aborted &&
                  navigation === readerContext.readerRuntime?.currentGeneration("navigation")
              });
              initial.catch(() => {});
            }
          }
          return null;
        };
        let first = null, saved = null;
        try {
          [first, saved] = await Promise.all([
            initial ? initialRange() : null,
            optional(Promise.resolve(restoration).then(value => ({value})))
          ]);
        } catch (_) { readerContext.assertReaderActive(); }
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
        const stagedCandidate = first && !first.complete && first.bytes instanceof Uint8Array &&
          first.bytes[0] === 0x25 && first.bytes[1] === 0x50 && first.bytes[2] === 0x44 &&
          first.bytes[3] === 0x46 && first.bytes[4] === 0x2d && (
          readerContext.isFirstPageCandidate(first.bytes, first.total, first.rangeChunkSize) ||
          (freshPageOne && first.total >= 8 * 1024 * 1024));
        if (stagedCandidate && saved && !readerContext.restorationFailed &&
            navigation === readerContext.readerRuntime?.currentGeneration("navigation")) {
          workerPreloadOwner?.abort();
          await workerPreload.catch(error => { if (error?.name !== "AbortError") throw error; });
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
      return readerContext.measurePdf(readerContext.loadPdfWithTimeout(pdfjs, options, target, proxyUrl, takeInitial), "document")
        .catch(async error => {
          readerContext.assertReaderActive();
          if (!stagedWorker || error?.name === "AbortError" || readerContext.retryableReaderProxyError(error) ||
              /PDF_SOURCE_CHANGED|PDF_RANGE_INVALID|READER_RESOURCE_LIMIT/i.test(`${error?.code || ""} ${error?.message || ""}`))
            throw error;
          // A document requiring full PDF.js recovery must reopen through the
          // original worker, not silently accept provisional page identities.
          readerContext.releasePdfWorker?.();
          await readerContext.preparePdfWorker(pdfjs);
          return readerContext.loadPdfWithTimeout(pdfjs, options, target, proxyUrl, takeInitial);
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
