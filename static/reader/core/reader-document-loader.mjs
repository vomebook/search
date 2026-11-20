/**
 * @typedef {{ status?: number, name?: string, message?: string, code?: string }} ReaderLoaderError
 * @typedef {{manifestUrl?: string, manifest?: Promise<Response> | null}} ReaderManifestPreload
 * @typedef {{response: Promise<Response>, engines: Promise<unknown[]>}} PreparedReaderDocument
 * @typedef {object} ReaderDocumentLoaderContext
 * @property {() => void} assertReaderActive
 * @property {() => Error} readerAbortError
 * @property {(cleanup: () => void) => () => void} trackReaderResource
 * @property {ReaderRequestManager} readerRequestManager
 * @property {number} READER_PROXY_TIMEOUT_MS
 * @property {(error: unknown) => boolean} retryableReaderProxyError
 * @property {(delay: number) => Promise<void>} waitForReader
 * @property {<T>(promise: T | PromiseLike<T>, signal?: AbortSignal | null) => Promise<Awaited<T>>} awaitReader
 * @property {(rawUrl: string) => string} readerContentUrl
 * @property {(path: string) => string} readerDownloadApiUrl
 * @property {(url: string, timeoutMs?: number, requestInit?: ReaderRequestInit) => Promise<Response>} fetchWithReaderTimeout
 * @property {<T>(open: () => Promise<T>, signal?: AbortSignal | null) => Promise<T>} retryReaderProxy
 * @property {(url: string, requestInit?: RequestInit) => Promise<Response>} fetchReaderUrl
 * @property {() => Promise<Response>} fetchReaderResponse
 * @property {(tasks: Promise<unknown>[]) => PreparedReaderDocument} prepareReaderDocument
 * @property {(url: string) => Promise<void>} loadScript
 * @property {string} sourceUrl
 * @property {string | null | undefined} chapterManifestUrl
 * @property {string} MARKED_URL
 * @property {string} PURIFY_URL
 * @property {{title: string}} documentState
 * @property {AbortController} readerAbortController
 * @property {{load: (image: HTMLImageElement, url: string, signal: AbortSignal, deadline: number) => Promise<HTMLImageElement>}} imageLoader
 */
/** @param {ReaderDocumentLoaderContext} readerContext */
export function createReaderDocumentLoader(readerContext) {
  /** @param {string} url */
  function loadScript(url) {
    readerContext.assertReaderActive();
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false, timeout = 0, untrack = () => {};
      /** @param {Error} [error] */
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
    }));
  }

  /** @param {string} url @param {number} [timeoutMs] @param {ReaderRequestInit} [requestInit] */
  function fetchWithReaderTimeout(url, timeoutMs = readerContext.READER_PROXY_TIMEOUT_MS, requestInit = {}) {
    return readerContext.readerRequestManager.request(url, timeoutMs, requestInit);
  }

  /** @param {unknown} value */
  function retryableReaderProxyError(value) {
    const error = /** @type {ReaderLoaderError | null | undefined} */ (value);
    if (error?.name === "AbortError" || error?.code === "READER_BODY_INTERRUPTED") return false;
    if (typeof error?.status === "number") return [408, 429, 500, 502, 503, 504].includes(error.status);
    return /** @type {(string | undefined)[]} */ (["TypeError", "TimeoutError"]).includes(error?.name) ||
      /failed to fetch|network|timeout|HTTP\s*(?:408|429|5\d\d)|server response\s*\((?:408|429|5\d\d)\)/i.test(error?.message || "");
  }

  /** @template T @param {() => Promise<T>} open @param {AbortSignal | null} [signal] @returns {Promise<T>} */
  async function retryReaderProxy(open, signal) {
    for (let attempt = 0; ; attempt++) {
      readerContext.assertReaderActive();
      signal?.throwIfAborted();
      try {
        return await open();
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt >= 2 || /** @type {ReaderLoaderError | null | undefined} */ (error)?.code === "READER_PDF_RATE_LIMIT" || !readerContext.retryableReaderProxyError(error)) throw error;
        const backoff = readerContext.waitForReader(350 * (attempt + 1));
        await (signal ? readerContext.awaitReader(backoff, signal) : backoff);
      }
    }
  }

  /** @param {string} rawUrl @param {RequestInit} [requestInit] @param {{retryBucket?: boolean}} [policy] */
  function fetchReaderUrl(rawUrl, requestInit = {}, {retryBucket = false} = {}) {
    let proxyUrl = readerContext.readerContentUrl(rawUrl), alreadyProxied = false;
    // Some chapter URLs already name the deployed API, even on a local Space
    // origin. Don't interpret an arbitrary URL containing the route as a proxy.
    try {
      const base = typeof location === "undefined" ? "https://voiceofml-search.hf.space" : location.href;
      const target = new URL(rawUrl, base);
      const proxyOrigin = new URL(readerContext.readerDownloadApiUrl("/api/reader-bucket-resource"), base).origin;
      if (["https://voiceofml-search.hf.space", proxyOrigin].includes(target.origin) &&
          !target.username && !target.password && !target.hash && target.pathname === "/api/reader-bucket-resource" &&
          target.searchParams.getAll("path").length === 1 && [...target.searchParams.keys()].every(key => key === "path")) {
        alreadyProxied = true;
        if (/^https?:\/\//.test(rawUrl)) proxyUrl = target.href;
      }
    } catch (_) {}
    // OCR and other sidecars already own their own recovery policy.
    if (alreadyProxied && !retryBucket)
      return readerContext.fetchWithReaderTimeout(proxyUrl, readerContext.READER_PROXY_TIMEOUT_MS, requestInit);
    return readerContext.retryReaderProxy(async () => {
      const response = await readerContext.fetchWithReaderTimeout(proxyUrl, readerContext.READER_PROXY_TIMEOUT_MS, requestInit);
      if (response.ok) return response;
      void response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }, requestInit.signal).catch(error => {
      readerContext.assertReaderActive();
      requestInit.signal?.throwIfAborted();
      throw error;
    });
  }

  /** @param {string} target @param {ReaderManifestPreload | undefined} early */
  function takeMatchingManifestPreload(target, early) {
    if (!early) return null;
    const pending = early.manifest;
    if (!pending) return null;
    if (early.manifestUrl !== new URL(target, location.href).href) return null;
    early.manifest = null;
    return pending;
  }

  /** @param {string} target @param {ReaderManifestPreload | undefined} early */
  function fetchManifestWithPreload(target, early) {
    const pending = takeMatchingManifestPreload(target, early);
    const fallback = () => readerContext.fetchReaderUrl(target);
    if (!pending) return fallback();
    return pending.then(response => {
      if (response?.ok) return response;
      void response?.body?.cancel().catch(() => {});
      return fallback();
    }, fallback);
  }

  function fetchReaderResponse() {
    return fetchManifestWithPreload(readerContext.sourceUrl, window.__VOICE_PDF_PRELOAD__);
  }

  /** @param {Promise<unknown>[]} engineTasks @returns {PreparedReaderDocument} */
  function prepareReaderDocument(engineTasks) {
    const engines = Promise.all(engineTasks);
    const response = Promise.race([readerContext.fetchReaderResponse(), engines.then(() => new Promise(() => {}))]);
    // Rendering owns both promises; early rejection must not become unhandled.
    response.catch(() => {});
    engines.catch(() => {});
    return {response, engines};
  }

  /** @param {Promise<Response>} response @param {Promise<unknown>} engines @param {number} [limit] */
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

  /** @param {string} [target] */
  async function loadImageDocument(target = readerContext.sourceUrl) {
    const deadline = performance.now() + readerContext.READER_PROXY_TIMEOUT_MS;
    const image = new Image();
    image.className = "reader-image";
    image.alt = readerContext.documentState.title;
    image.decoding = "async";
    readerContext.assertReaderActive();
    // Do not fall through to the dataset URL. huggingface.co does not open on
    // this network, so a failed proxy must stay on the proxied URL.
    return readerContext.imageLoader.load(image, readerContext.readerContentUrl(target), readerContext.readerAbortController.signal, deadline);
  }

  function loadChapterManifestDocument() {
    const target = readerContext.chapterManifestUrl || readerContext.sourceUrl;
    return fetchManifestWithPreload(target, window.__VOICE_READER_CHAPTER_PRELOAD__);
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
