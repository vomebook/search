export function createReaderPdfEngine(readerContext) {
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
      readerContext.openPdfRangeTask(pdfjs, options(url), {
        signal:owner.signal, readBytes:VoiceOfMLReaderSecurity.readBytes, initial,
        limit:VoiceOfMLReaderSecurity.LIMITS.documentBytes,
        canPrefetchOpening: () => !!readerContext.pdfV3Manifest && readerContext.readerRestorationLoaded &&
          (!readerContext.readerRestorationEntry || Number(readerContext.readerRestorationEntry.page) <= 1),
        onError() {
          if (!documentReady || readerContext.readerAbortController.signal.aborted || readerContext.capability.mode !== "pdf") return;
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

  function loadPdfWithTimeout(pdfjs, options, target = readerContext.sourceUrl, proxy = readerContext.contentUrl, takeInitial = () => null) {
    return readerContext.retryReaderProxy(() => readerContext.loadPdfTaskWithTimeout(pdfjs, options, proxy, takeInitial(proxy))).catch((error) => {
      readerContext.assertReaderActive();
      if (error && error.name === "AbortError") throw error;
      if (readerContext.retryableReaderProxyError(error)) throw error;
      return readerContext.loadPdfTaskWithTimeout(pdfjs, options, target);
    });
  }

  function preloadPdfEngine() {
    if (!readerContext.pdfEnginePreload) readerContext.pdfEnginePreload = readerContext.loadPdfEngine().then(readerContext.preparePdfWorker);
    return readerContext.pdfEnginePreload;
  }

  async function preparePdfWorker(pdfjs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      readerContext.assertReaderActive();
      if (attempt) await readerContext.waitForReader(attempt * 500);
      try {
        return await readerContext.preparePdfWorkerAttempt(pdfjs, attempt);
      } catch (error) {
        readerContext.assertReaderActive();
        if (error?.code !== "READER_ENGINE_NETWORK" || attempt === 2) throw error;
      }
    }
  }

  async function preparePdfWorkerAttempt(pdfjs, attempt) {
    readerContext.assertReaderActive();
    if (readerContext.capability.mode !== "pdf" && !readerContext.pdfPrimarySource()) return pdfjs;
    pdfjs.GlobalWorkerOptions.workerSrc = attempt
      ? `${readerContext.PDFJS_WORKER_URL}?reader-worker-retry=${attempt}` : readerContext.PDFJS_WORKER_URL;
    const worker = new pdfjs.PDFWorker();
    readerContext.pdfWorker = worker;
    let timer, destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      worker.destroy();
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
      ]));
      readerContext.assertReaderActive();
      return pdfjs;
    } catch (error) {
      untrack();
      destroy();
      readerContext.assertReaderActive();
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
    // This is the first demand, not extra speculation or a larger/full download.
    // Keep it owned while engine preparation is pending and consume it only once.
    let initial = readerContext.preparePdfInitialRange({url:proxyUrl, rangeChunkSize:262144}, {
      signal:AbortSignal.any([owner.signal, readerContext.readerAbortController.signal]),
      readBytes:VoiceOfMLReaderSecurity.readBytes, limit:VoiceOfMLReaderSecurity.LIMITS.documentBytes
    });
    initial.catch(() => {});
    const takeInitial = url => {
      if (url !== proxyUrl) return null;
      const pending = initial;
      initial = null;
      return pending;
    };
    return readerContext.measurePdf(readerContext.preloadPdfEngine(), "engine").then((pdfjs) => {
      readerContext.assertReaderActive();
      pdfjs.GlobalWorkerOptions.workerSrc = readerContext.PDFJS_WORKER_URL;
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
      return readerContext.measurePdf(readerContext.loadPdfWithTimeout(pdfjs, options, target, proxyUrl, takeInitial), "document");
    }).finally(() => {
      initial = null;
      untrack();
      owner.abort(readerContext.readerAbortError());
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
