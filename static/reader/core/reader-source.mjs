/**
 * @typedef {{[key: string]: unknown}} ReaderMetadata
 * @typedef {{url: URL, prefix: string, bucket: boolean, bucketPath: string}} AssetFamily
 * @typedef {object} ReaderSourceContext
 * @property {ReaderMetadata | null} resolvedReaderData
 * @property {string} downloadUrl
 * @property {Promise<unknown> | null} readerSourcePromise
 * @property {{title: string}} documentState
 * @property {{disposed: boolean}} readerLifecycle
 * @property {(message: string, duration?: number) => void} showDownloadFeedback
 * @property {(path: string) => string} readerDownloadApiUrl
 * @property {(filename: string, link: string) => string} readerDownloadUrl
 * @property {(dispose: () => void) => () => void} trackReaderResource
 * @property {<T>(promise: Promise<T>) => Promise<T>} awaitReader
 * @property {() => void} assertReaderActive
 * @property {(ms: number) => Promise<void>} waitForReader
 * @property {{requestBuffered: (url: string, timeout: number, limit: number) => Promise<Response>}} readerRequestManager
 * @property {number} READER_PROXY_TIMEOUT_MS
 * @property {string} ocrManifestUrl
 * @property {URLSearchParams} params
 * @property {{update: (key: 'source', value: {metadata: ReaderMetadata | null}) => void}} readerRuntime
 * @property {string} sourceName
 * @property {string} extension
 * @property {(state: {title: string}) => void} updateDocumentState
 * @property {() => boolean} isReaderOverlayFrame
 * @property {string} readerPathLabel
 * @property {URL | null} folderNavigationTarget
 * @property {string} folderReturnUrl
 * @property {HTMLButtonElement} readerPath
 * @property {(raw: string) => AssetFamily | null} readerAssetObjectFamily
 * @param {ReaderSourceContext} readerContext
 */
export function createReaderSource(readerContext) {
  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** @param {unknown} value @returns {ReaderMetadata} */
  function parseMetadata(value) {
    if (!isRecord(value)) throw new Error("Invalid reader metadata");
    return value;
  }

  /** @param {unknown} error @param {string} key @returns {string | undefined} */
  function errorField(error, key) {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") return undefined;
    try {
      const value = /** @type {Record<string, unknown>} */ (error)[key];
      return typeof value === "string" ? value : undefined;
    } catch (_) {
      return undefined;
    }
  }
  /** @param {string} url */
  function readerContentUrl(url) {
    try {
      const parsed = new URL(url, "https://voiceofml-search.hf.space");
      if (parsed.origin === "https://voiceofml-search.hf.space" &&
          parsed.pathname === "/api/reader-bucket-resource")
        return parsed.href;
      if (parsed.origin === "https://huggingface.co" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        const prefix = /^\/buckets\/(vomebook\/(?:pdf-pages-v2|reader-assets-v2))\/resolve\//.exec(parsed.pathname);
        const path = prefix && decodeURIComponent(parsed.pathname.slice(prefix[0].length));
        if (path && VoiceOfMLReader.isBucketPath(path, true, prefix[1]))
          return `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
      }
    } catch (_) {}
    return `https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(url)}`;
  }

  /** @param {string} path */
  function readerDownloadApiUrl(path) {
    return `https://voiceofml-search.hf.space${path}`;
  }

  /** @param {string} fallback */
  function readerOriginalFilename(fallback) {
    // Do not infer a filename from the display title: the indexed stem can
    // itself end in the same suffix and can contain meaningful spaces/case.
    const name = readerContext.resolvedReaderData?.filename;
    return typeof name === "string" && name.trim() && !/[\/\\\x00-\x1f\x7f]/.test(name)
      ? name : fallback;
  }

  /** @param {string} filename @param {string} link */
  function readerDownloadUrl(filename, link) {
    return readerContext.readerDownloadApiUrl(`/api/download?file=${encodeURIComponent(readerOriginalFilename(filename || "file"))}&link=${encodeURIComponent(link || "")}`);
  }

  let readerDownloadAttempt = 0;

  /** @param {Event} event */
  async function startReaderDownload(event) {
    event.preventDefault();
    const button = event.currentTarget;
    if (!(button instanceof Element) || button.hasAttribute("aria-busy")) return;
    const attempt = ++readerDownloadAttempt;
    readerContext.showDownloadFeedback("正在准备下载…", 0);
    const controller = new AbortController();
    let timer;
    button.setAttribute("aria-busy", "true");
    try {
      // ID-only links share the Reader's in-flight resolution, not its render phase.
      if (!readerContext.downloadUrl) await readerContext.readerSourcePromise;
      if (!readerContext.downloadUrl) throw new Error("无法获取原文件地址");
      const filename = readerContext.documentState.title || "file";
      const checkUrl = readerContext.readerDownloadApiUrl(`/api/download/check?link=${encodeURIComponent(readerContext.downloadUrl)}`);
      timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(checkUrl, { signal: controller.signal, cache: "no-store" });
      /** @type {unknown} */
      const result = await response.json().catch(() => null);
      if (!response.ok || !isRecord(result) || result.ok !== true)
        throw new Error(isRecord(result) && typeof result.error === "string" && result.error || "下载检查失败，请重试");
      if (readerContext.readerLifecycle.disposed) return;
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("sandbox", "allow-downloads");
      frame.src = readerContext.readerDownloadUrl(filename, readerContext.downloadUrl);
      const cleanup = setTimeout(() => frame.remove(), 60000);
      // An attachment goes to the browser; a proxy error loads a document.
      // No DOM access to the (possibly cross-origin) response is needed.
      frame.addEventListener("load", () => {
        clearTimeout(cleanup);
        frame.remove();
        if (attempt === readerDownloadAttempt && !readerContext.readerLifecycle.disposed)
          readerContext.showDownloadFeedback("下载失败，请重试（已发起下载，未收到附件）");
      }, { once: true });
      document.body.appendChild(frame);
      // Request handed off, not server acceptance or download completion.
      readerContext.showDownloadFeedback("已发起下载");
    } catch (error) {
      if (!readerContext.readerLifecycle.disposed) {
        readerContext.showDownloadFeedback(errorField(error, "name") === "AbortError" ? "下载检查超时，请重试" : (errorField(error, "message") || "下载失败，请重试"));
      }
    } finally {
      clearTimeout(timer);
      button.removeAttribute("aria-busy");
    }
  }

  /** @param {string} url */
  function normalizeSourceUrl(url) {
    return url.startsWith("/api/reader-bucket-resource?")
      ? new URL(url, "https://voiceofml-search.hf.space").href
      : url;
  }

  /** @param {string} id */
  async function resolveReaderId(id) {
    const endpoint = `https://voiceofml-search.hf.space/api/reader-resolve?id=${encodeURIComponent(id)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const early = /** @type {{id: string, promise: Promise<{ok: boolean, status: number, data: unknown}>, dispose: () => void} | null | undefined} */ (window.__VOICE_READER_RESOLVE__);
      if (!attempt && early?.id === id) {
        window.__VOICE_READER_RESOLVE__ = null;
        const untrack = readerContext.trackReaderResource(early.dispose);
        let result;
        try { result = await readerContext.awaitReader(early.promise); }
        catch (error) {
          readerContext.assertReaderActive();
          const name = errorField(error, "name");
          if (name !== "TimeoutError" && name !== "TypeError") throw error;
          continue;
        }
        finally { untrack(); early.dispose(); }
        if (result.ok) return parseMetadata(result.data);
        if (![408, 429, 500, 502, 503, 504].includes(result.status))
          throw new Error(`HTTP ${result.status}`);
        await readerContext.waitForReader(350);
        continue;
      }
      const response = await readerContext.readerRequestManager.requestBuffered(
        endpoint, readerContext.READER_PROXY_TIMEOUT_MS, VoiceOfMLReaderSecurity.LIMITS.manifestBytes);
      if (response.ok) {
        /** @type {unknown} */
        const data = await response.json();
        return parseMetadata(data);
      }
      await response.body?.cancel();
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt)
        throw new Error(`HTTP ${response.status}`);
      await readerContext.waitForReader(350);
    }
    throw new Error("Reader ID resolution failed");
  }

  /** @param {unknown} input */
  function applyReaderMetadata(input) {
    const data = input == null ? null : parseMetadata(input);
    if (data) readerContext.resolvedReaderData = { ...(readerContext.resolvedReaderData || {}), ...data };
    if (data?.ReaderOcrManifest || data?.ocr_manifest) {
      readerContext.ocrManifestUrl = /** @type {string} */ (data.ReaderOcrManifest || data.ocr_manifest);
      readerContext.params.set("ocr_manifest", readerContext.ocrManifestUrl);
    }
    readerContext.readerRuntime.update("source", { metadata: readerContext.resolvedReaderData });
    const title = String(readerContext.resolvedReaderData?.title || readerContext.params.get("title") || readerContext.sourceName).trim();
    const suffix = String(
      readerContext.resolvedReaderData?.original_extension || (readerContext.extension === "pdf-pages" ? "pdf" : readerContext.extension)
    )
      .toLowerCase()
      .replace(/^\./, "");
    const value = title + (suffix && !title.toLowerCase().endsWith(`.${suffix}`) ? `.${suffix}` : "");
    readerContext.updateDocumentState({ title: value });
    // Prefer the exact original name when metadata supplies it. The display
    // title can omit a repeated suffix or normalize meaningful whitespace.
    const displayName = readerOriginalFilename(value);
    const heading = /** @type {HTMLElement} */ (document.querySelector("#title"));
    if (heading.textContent !== displayName) {
      heading.textContent = displayName;
      heading.scrollLeft = 0;
    }
    heading.title = displayName;
    document.title = displayName;
    if (readerContext.isReaderOverlayFrame())
      window.parent.postMessage({ type: "voice-reader-title", title: document.title }, location.origin);
    applyReaderPathMetadata(readerContext.resolvedReaderData);
  }

  /** @param {string | null | undefined} rawUrl */
  function normalizeReaderReturnUrl(rawUrl) {
    try {
      const target = new URL(rawUrl || "/search/", location.origin);
      if (target.origin === location.origin && target.pathname === "/")
        return new URL("/search/", location.origin).href;
      return target.href;
    } catch (_) {
      return new URL("/search/", location.origin).href;
    }
  }

  /** @param {unknown} input */
  function applyReaderPathMetadata(input) {
    const data = input == null ? null : parseMetadata(input);
    const folder = Array.isArray(data?.folder) ? data.folder.join("/") : String(data?.folder || "");
    const value = String(
      data?.path || [data?.repo, folder].filter(Boolean).join("/") || readerContext.readerPathLabel
    ).replace(/^\/+|\/+$/g, "");
    readerContext.folderNavigationTarget = null;
    try {
      const target = new URL(readerContext.folderReturnUrl, location.origin);
      if (
        readerContext.folderReturnUrl &&
        target.origin === location.origin &&
        target.pathname === "/search/" &&
        target.hash.startsWith("#/")
      ) {
        // Legacy explicit targets only carry the direct-folder filter. Keep
        // that filter authoritative and mirror it into the sidebar route.
        const split = target.hash.indexOf("?");
        const route = split < 0 ? target.hash : target.hash.slice(0, split);
        const query = new URLSearchParams(split < 0 ? "" : target.hash.slice(split + 1));
        const direct = query.getAll("folder_self");
        if (direct.length === 1 && !query.has("folder_subtree") && !query.has("folder")) {
          if (direct[0]) query.set("path", direct[0]);
          else query.delete("path");
          target.hash = route + (query.size ? "?" + query.toString() : "");
        }
        readerContext.folderNavigationTarget = target;
      }
    } catch (_) {}
    if (!readerContext.folderNavigationTarget && data?.repo) {
      readerContext.folderNavigationTarget = new URL("/search/", location.origin);
      const query = new URLSearchParams();
      if (folder) {
        query.set("folder_self", folder);
        query.set("path", folder);
      }
      readerContext.folderNavigationTarget.hash =
        "#/" + encodeURIComponent(String(data.repo)) + (query.size ? "?" + query.toString() : "");
    }
    readerContext.readerPath.textContent = value;
    readerContext.readerPath.hidden = !value;
    readerContext.readerPath.disabled = !readerContext.folderNavigationTarget;
    readerContext.readerPath.setAttribute("aria-label", `筛选文件夹：${value}`);
    const panelPath = /** @type {HTMLButtonElement | null} */ (document.querySelector("#reader-panel-path"));
    if (panelPath) {
      const folderLabel = value || "不可用";
      /** @type {Element} */ (panelPath.querySelector(".reader-panel-folder")).textContent = `所在目录：${folderLabel}`;
      panelPath.disabled = !value || !readerContext.folderNavigationTarget;
      panelPath.setAttribute("aria-label", `${panelPath.disabled ? "所在目录" : "打开所在目录"}：${folderLabel}`);
      panelPath.title = value;
    }
  }

  /** @param {string} raw */
  function validSource(raw) {
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.hash) return false;
      const bucketPath = url.searchParams.get("path") || "";
      if (
        url.origin === "https://voiceofml-search.hf.space" &&
        url.pathname === "/api/reader-bucket-resource" &&
        url.searchParams.getAll("path").length === 1 &&
        [...url.searchParams.keys()].every((key) => key === "path") &&
         (VoiceOfMLReader.isBucketPath(bucketPath, true, "vomebook/pdf-pages-v2") ||
          VoiceOfMLReader.isBucketPath(bucketPath, true, "vomebook/reader-assets-v2"))
      )
        return true;
      if (url.protocol === "https:" && url.hostname === "huggingface.co" &&
          (url.pathname.startsWith("/buckets/vomebook/pdf-pages-v2/resolve/") ||
           url.pathname.startsWith("/buckets/vomebook/reader-assets-v2/resolve/")) && !url.search) {
        const prefix = url.pathname.startsWith("/buckets/vomebook/pdf-pages-v2/resolve/")
          ? "/buckets/vomebook/pdf-pages-v2/resolve/"
          : "/buckets/vomebook/reader-assets-v2/resolve/";
        const path = decodeURIComponent(url.pathname.slice(prefix.length));
        const bucket = prefix.includes("pdf-pages-v2") ? "vomebook/pdf-pages-v2" : "vomebook/reader-assets-v2";
        return VoiceOfMLReader.isBucketPath(path, true, bucket);
      }
      if (url.protocol !== "https:" || !["huggingface.co", "hf-mirror.com"].includes(url.hostname))
        return false;
      return /^\/datasets\/VoiceOfML\/[^/]+\/(resolve|raw)\//.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  /** @param {string} raw @param {string} [base] */
  function readerAssetObjectFamily(raw, base = location.href) {
    try {
      const url = new URL(raw, base);
      if (url.origin !== "https://voiceofml-search.hf.space" || url.pathname !== "/api/reader-bucket-resource")
        return null;
      const bucketPath = url.searchParams.get("path") || "";
      const match = bucketPath.match(/^(chapters\/ebook\/(?:epub|mobi|azw3|fb2|chm)\/[0-9a-f]{64}\/[0-9a-f]{16}\/)/);
      if (url.hash || url.searchParams.getAll("path").length !== 1 ||
          [...url.searchParams.keys()].some((key) => key !== "path") || !match?.[1] ||
          !VoiceOfMLReader.isBucketPath(bucketPath, true, "vomebook/reader-assets-v2")) return null;
      return { url, prefix: match[1], bucket: true, bucketPath };
    } catch (_) {
      return null;
    }
  }

  /** @type {{raw: string, family: AssetFamily} | null} */
  let manifestFamily = null;
  /** @type {{raw: string, family: AssetFamily} | null} */
  let chapterFamily = null;

  // The rewrite pass resolves many attributes against the same two bases.
  // Keep just the latest validated manifest and chapter bases. Only reuse
  // exact absolute URLs: relative inputs still depend on location.href.
  /** @param {string} raw @param {boolean} isManifest */
  function chapterAssetFamily(raw, isManifest) {
    const cached = isManifest ? manifestFamily : chapterFamily;
    if (cached && raw === cached.raw) return cached.family;
    const family = readerContext.readerAssetObjectFamily(raw);
    if (family && raw === family.url.href) {
      if (isManifest) manifestFamily = { raw, family };
      else chapterFamily = { raw, family };
    }
    return family;
  }

  /** @param {string} raw */
  function trustedReaderAssetManifestUrl(raw) {
    const family = chapterAssetFamily(raw, true);
    return family && /\/chapter-manifest\.json$/i.test(family.bucketPath || "")
      ? family.url.href
      : null;
  }

  /** @param {string} raw @param {string} base */
  function trustedChapterUrl(raw, base) {
    const manifest = chapterAssetFamily(base, true);
    if (!manifest || !/\/chapter-manifest\.json$/i.test(manifest.bucketPath || ""))
      return null;
    try {
      const url = new URL(String(raw || ""), `https://bucket.invalid/${manifest.bucketPath}`);
      const path = decodeURIComponent(url.pathname.slice(1));
      if (url.origin !== "https://bucket.invalid" || url.search || url.hash ||
          !path.startsWith(manifest.prefix) ||
          !/(?:\/chapters\/chapter-[0-9]{4}\.xhtml|\/epub-search-index\.json\.gz)$/i.test(path) ||
          !VoiceOfMLReader.isBucketPath(path, true, "vomebook/reader-assets-v2")) return null;
      return `${manifest.url.origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
    } catch (_) {
      return null;
    }
  }

  /** @param {string} raw @param {string} base @param {string} manifestBase */
  function trustedChapterReferenceUrl(raw, base, manifestBase) {
    const family = chapterAssetFamily(manifestBase, true);
    const current = chapterAssetFamily(base, false);
    if (!family || !current) return null;
    try {
      const url = new URL(String(raw || ""), `https://bucket.invalid/${current.bucketPath}`);
      const path = decodeURIComponent(url.pathname.slice(1));
      if (url.origin !== "https://bucket.invalid" || url.search ||
          !path.startsWith(family.prefix) || !/\/chapters\/chapter-[0-9]{4}\.xhtml$/i.test(path) ||
          !VoiceOfMLReader.isBucketPath(path, true, "vomebook/reader-assets-v2")) return null;
      return { url: `${family.url.origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`,
               fragment: url.hash };
    } catch (_) {
      return null;
    }
  }

  /** @param {string} raw @param {string} base @param {string} manifestBase */
  function trustedChapterResourceUrl(raw, base, manifestBase) {
    const value = String(raw || "").trim();
    if (!value || /^(?:data:|mailto:|tel:|javascript:)/i.test(value)) return null;
    // Chapters and resources can be siblings within the manifest's asset directory.
    const family = chapterAssetFamily(manifestBase, true);
    const current = chapterAssetFamily(base, false);
    if (!family || !current) return null;
    try {
      const url = new URL(value, `https://bucket.invalid/${current.bucketPath}`);
      const path = decodeURIComponent(url.pathname.slice(1));
      if (url.origin !== "https://bucket.invalid" || url.search || url.hash ||
          !path.startsWith(family.prefix) || !VoiceOfMLReader.isBucketPath(path, true, "vomebook/reader-assets-v2")) return null;
      return `${family.url.origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
    } catch (_) {
      return null;
    }
  }

  return {
    readerContentUrl,
    readerDownloadApiUrl,
    readerDownloadUrl,
    startReaderDownload,
    normalizeSourceUrl,
    resolveReaderId,
    applyReaderMetadata,
    normalizeReaderReturnUrl,
    validSource,
    readerAssetObjectFamily,
    trustedReaderAssetManifestUrl,
    trustedChapterUrl,
    trustedChapterReferenceUrl,
    trustedChapterResourceUrl
  };
}
