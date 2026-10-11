export function createReaderPdfEngine(readerContext) {
  function loadPdfTaskWithTimeout(pdfjs, options, url) {
    readerContext.assertReaderActive();
    const task = pdfjs.getDocument(options(url));
    return new Promise((resolve, reject) => {
      let timeout = 0,
        destroyed = false;
      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(timeout);
        try {
          task.destroy()?.catch?.(() => {});
        } catch (_) {}
        reject(readerContext.readerAbortError());
      };
      const untrack = readerContext.trackReaderResource(destroy);
      timeout = setTimeout(() => {
        reject(new Error("reader PDF timeout"));
        untrack();
        destroy();
      }, readerContext.READER_PROXY_TIMEOUT_MS);
      task.promise.then(
        (document) => {
          clearTimeout(timeout);
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

  function loadPdfWithTimeout(pdfjs, options, target = readerContext.sourceUrl, proxy = readerContext.contentUrl) {
    return readerContext.retryReaderProxy(() => readerContext.loadPdfTaskWithTimeout(pdfjs, options, proxy)).catch((error) => {
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
    return readerContext.measurePdf(readerContext.preloadPdfEngine(), "engine").then((pdfjs) => {
      readerContext.assertReaderActive();
      if (!readerContext.pdfFetchPolicy) {
        readerContext.pdfFetchPolicy = readerContext.createPdfFetchPolicy();
        readerContext.trackReaderResource(() => { readerContext.pdfFetchPolicy?.dispose(); readerContext.pdfFetchPolicy = null; });
      }
      readerContext.pdfFetchPolicy.add([target, readerContext.readerContentUrl(target)]);
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
      return readerContext.measurePdf(readerContext.loadPdfWithTimeout(pdfjs, options, target, readerContext.readerContentUrl(target)), "document");
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
