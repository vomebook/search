export function createReaderDocumentLoader(readerContext) {
  function loadScript(url) {
    readerContext.assertReaderActive();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false, timeout = 0, untrack = () => {};
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        untrack();
        script.onload = script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else resolve();
      };
      const networkError = () => Object.assign(
        new Error("阅读组件下载失败，请检查网络后重试加载，或下载原文件。"),
        { code: "READER_ENGINE_NETWORK" }
      );
      untrack = readerContext.trackReaderResource(() => finish(readerContext.readerAbortError()));
      // Download sibling engines concurrently, execute in dependency order.
      script.async = false;
      script.src = url;
      script.onload = () => finish();
      script.onerror = () => finish(networkError());
      timeout = setTimeout(() => finish(networkError()), 20000);
      document.head.appendChild(script);
    });
  }

  function fetchWithReaderTimeout(url, timeoutMs = readerContext.READER_PROXY_TIMEOUT_MS, requestInit = {}) {
    return readerContext.readerRequestManager.request(url, timeoutMs, requestInit);
  }

  function retryableReaderProxyError(error) {
    return [408, 429, 500, 502, 503, 504].includes(error?.status) ||
      ["TypeError", "TimeoutError"].includes(error?.name) ||
      /failed to fetch|network|timeout|HTTP\s*(?:408|429|5\d\d)|server response\s*\((?:408|429|5\d\d)\)/i.test(error?.message || "");
  }

  async function retryReaderProxy(open) {
    for (let attempt = 0; ; attempt++) {
      readerContext.assertReaderActive();
      try {
        return await open();
      } catch (error) {
        if (attempt >= 2 || !readerContext.retryableReaderProxyError(error)) throw error;
        await readerContext.waitForReader(350 * (attempt + 1));
      }
    }
  }

  function fetchReaderUrl(rawUrl, requestInit = {}) {
    if (String(rawUrl).includes("/api/reader-bucket-resource?"))
      return readerContext.fetchWithReaderTimeout(rawUrl, readerContext.READER_PROXY_TIMEOUT_MS, requestInit);
    const proxyUrl = readerContext.readerContentUrl(rawUrl);
    return readerContext.retryReaderProxy(async () => {
        const response = await readerContext.fetchWithReaderTimeout(proxyUrl, readerContext.READER_PROXY_TIMEOUT_MS, requestInit);
      if (response.ok) return response;
      await response.body?.cancel();
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }).catch((error) => {
      readerContext.assertReaderActive();
      requestInit.signal?.throwIfAborted();
      if (readerContext.retryableReaderProxyError(error)) throw error;
      return readerContext.fetchWithReaderTimeout(rawUrl, readerContext.READER_PROXY_TIMEOUT_MS, requestInit);
    });
  }

  function fetchReaderResponse() {
    const early = window.__VOICE_PDF_PRELOAD__;
    if (early?.manifest && early.manifestUrl === new URL(readerContext.sourceUrl, location.href).href) {
      const pending = early.manifest;
      early.manifest = null;
      return pending.then(
        (response) => (response?.ok ? response : readerContext.fetchReaderUrl(readerContext.sourceUrl)),
        () => readerContext.fetchReaderUrl(readerContext.sourceUrl)
      );
    }
    return readerContext.fetchReaderUrl(readerContext.sourceUrl);
  }

  function prepareReaderDocument(engineTasks) {
    const engines = Promise.all(engineTasks);
    const response = Promise.race([readerContext.fetchReaderResponse(), engines.then(() => new Promise(() => {}))]);
    // Rendering owns both promises; early rejection must not become unhandled.
    response.catch(() => {});
    engines.catch(() => {});
    return {response, engines};
  }

  function readPreparedBytes(response, engines, limit = VoiceOfMLReaderSecurity.LIMITS.documentBytes) {
    return Promise.all([Promise.resolve(response).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return VoiceOfMLReaderSecurity.readBytes(response,limit);
    }), engines]).then(([bytes]) => bytes);
  }

  function loadTextDocument() {
    return readerContext.fetchReaderResponse().then((response) => ({ response }));
  }

  function loadMarkdownDocument() {
    return readerContext.prepareReaderDocument([readerContext.loadScript(readerContext.MARKED_URL), readerContext.loadScript(readerContext.PURIFY_URL)]);
  }

  function loadHtmlDocument() {
    const {response, engines} = readerContext.prepareReaderDocument([readerContext.loadScript(readerContext.PURIFY_URL)]);
    return {response, engine:engines};
  }

  function loadMediaDocument() {
    return Promise.resolve(null);
  }

  async function loadImageDocument(target = readerContext.sourceUrl) {
    const deadline = performance.now() + readerContext.READER_PROXY_TIMEOUT_MS;
    const image = new Image();
    image.className = "reader-image";
    image.alt = readerContext.documentState.title;
    image.decoding = "async";
    try {
      return await readerContext.imageLoader.load(image, readerContext.readerContentUrl(target), readerContext.readerAbortController.signal, deadline);
    } catch (error) {
      readerContext.assertReaderActive();
      if (error?.code === "READER_RESOURCE_LIMIT") throw error;
      return readerContext.imageLoader.load(image, target, readerContext.readerAbortController.signal, deadline);
    }
  }

  function loadChapterManifestDocument() {
    const target = readerContext.chapterManifestUrl || readerContext.sourceUrl, early = window.__VOICE_READER_CHAPTER_PRELOAD__;
    if (early?.manifest && early.manifestUrl === new URL(target, location.href).href) {
      const pending = early.manifest;
      early.manifest = null;
      return pending.then(response => response.ok ? response : readerContext.fetchReaderUrl(target), () => readerContext.fetchReaderUrl(target));
    }
    return readerContext.fetchReaderUrl(target);
  }

  return {
    loadScript,
    fetchWithReaderTimeout,
    retryableReaderProxyError,
    retryReaderProxy,
    fetchReaderUrl,
    fetchReaderResponse,
    prepareReaderDocument,
    readPreparedBytes,
    loadTextDocument,
    loadMarkdownDocument,
    loadHtmlDocument,
    loadMediaDocument,
    loadImageDocument,
    loadChapterManifestDocument
  };
}
