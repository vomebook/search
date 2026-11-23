(/** @param {import('../../../typings/reader-contract-strict').ContractRoot} root */ function (root) {
  "use strict";
  function preloadPdfOpeningResources() {
    // Classic-script and module consumers share the same in-flight preload.
    if (root.__VOICE_PDF_PRELOAD__) return;
    try {
      const params = new URLSearchParams(location.search);
      const id = params.get("id") || "";
      let source = params.get("url") || "";
      if (!source && id) {
        for (const key of [`reader-source:${id}`, `reader-resolve:${id}`]) {
          const value = /** @type {import('../../../typings/reader-contract-strict').StoredSource | null} */ (JSON.parse(sessionStorage.getItem(key) || "null"));
          if (value?.url) {
            source = value.url;
            break;
          }
        }
      }
      if (source.startsWith("/api/")) source = `https://voiceofml-search.hf.space${source}`;
      if (!source) return;
      const manifestUrl = new URL(source, location.origin);
      const sourceInfo = pdfPageSource(
        manifestUrl.href,
        location.origin,
        "https://voiceofml-search.hf.space"
      );
      if (!sourceInfo) return;
      const security = root.VoiceOfMLReaderSecurity;
      if (!security) return;
      const controller = new AbortController(),
        directSource = ["huggingface.co", "hf-mirror.com"].includes(manifestUrl.hostname),
        timer = setTimeout(() => controller.abort(), directSource ? 1500 : 10000);
      let disposed = false;
      let preload;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        controller.abort();
        root.removeEventListener?.("pagehide", onPageHide);
      };
      /** @param {PageTransitionEvent} event */
      const onPageHide = (event) => {
        if (!event.persisted) dispose();
      };
      const manifestRequest = fetch(manifestUrl.href, {
        priority: "low",
        signal: controller.signal
      })
        .then(async (response) => {
          const bytes = await security.readBytes(response, security.LIMITS.manifestBytes);
          return new Response(bytes, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        })
        .finally(() => clearTimeout(timer));
      preload = {
        manifestUrl: manifestUrl.href,
        manifest: manifestRequest,
        dispose
      };
      preload.manifest.catch(() => {});
      root.addEventListener?.("pagehide", onPageHide);
      root.__VOICE_PDF_PRELOAD__ = preload;
    } catch (_) {}
  }

  function preloadChapterOpeningResources() {
    if (root.__VOICE_READER_CHAPTER_PRELOAD__) return;
    try {
      if (!location.pathname.endsWith("/reader.html")) return;
      const params = new URLSearchParams(location.search), id = params.get("id") || "";
      let source = params.get("chapter_manifest") || params.get("url") || "";
      if (!source && id) {
        for (const key of [`reader-source:${id}`, `reader-resolve:${id}`]) {
          const value = /** @type {import('../../../typings/reader-contract-strict').StoredSource | null} */ (JSON.parse(sessionStorage.getItem(key) || "null"));
          if (value?.url) { source = value.chapter_manifest || value.url; break; }
        }
      }
      if (source.startsWith("/api/")) source = `https://voiceofml-search.hf.space${source}`;
      const url = new URL(source, location.href), path = url.searchParams.get("path") || "";
      if ((url.origin !== location.origin && url.origin !== "https://voiceofml-search.hf.space") ||
          url.username || url.password || url.hash || url.pathname !== "/api/reader-bucket-resource" ||
          [...url.searchParams.keys()].length !== 1 || !isBucketPath(path, true) ||
          !path.startsWith("chapters/ebook/") || !path.endsWith("/chapter-manifest.json")) return;
      const security = root.VoiceOfMLReaderSecurity;
      if (!security) return;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      let disposed = false;
      /** @param {PageTransitionEvent} event */
      const onPageHide = event => { if (!event.persisted) dispose(); };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        controller.abort();
        root.removeEventListener?.("pagehide", onPageHide);
        root.removeEventListener?.("voice-reader-dispose", dispose);
      };
      const manifest = fetch(url.href, { signal: controller.signal, priority: "high", credentials: "omit" })
        .then(async response => {
          const bytes = await security.readBytes(response, security.LIMITS.manifestBytes);
          return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
        }).finally(() => clearTimeout(timer));
      manifest.catch(() => {});
      root.__VOICE_READER_CHAPTER_PRELOAD__ = { manifestUrl: url.href, manifest, dispose };
      root.addEventListener?.("pagehide", onPageHide);
      root.addEventListener?.("voice-reader-dispose", dispose);
    } catch (_) {}
  }

  const ReaderMode = Object.freeze({
    UNSUPPORTED: 0,
    ORIGINAL: 1,
    CONVERTED: 2,
    PENDING: 3,
    FAILED: 4
  });
  /** @type {Readonly<Record<string, string>>} */
  const modes = Object.freeze({
    pdf: "pdf",
    "pdf-pages": "pdf-pages",
    "image-pages": "image-pages",
    image: "image",
    "epub-chapters": "epub-chapters",
    html: "html",
    htm: "html",
    txt: "text",
    md: "markdown",
    markdown: "markdown",
    vcf: "text",
    ini: "text",
    jpg: "image",
    jpeg: "image",
    png: "image",
    gif: "image",
    bmp: "image",
    tif: "image",
    tiff: "image",
    webp: "image",
    mp3: "audio",
    wav: "audio",
    m4a: "audio",
    flac: "audio",
    mpga: "audio",
    wma: "audio",
    ape: "audio",
    amr: "audio",
    audio: "audio",
    mp4: "video",
    mov: "video",
    video: "video",
    swf: "swf"
  });
  const articleExtensions = Object.freeze([...Object.keys(modes), "djvu"]);
  /** @type {Readonly<Record<string, {toc: boolean, search: boolean, zoom: boolean, bookmarks: boolean, pagination: boolean, media: boolean}>>} */
  const features = Object.freeze({
    pdf: { toc: true, search: true, zoom: true, bookmarks: true, pagination: true, media: false },
    "pdf-pages": {
      toc: true,
      search: true,
      zoom: true,
      bookmarks: true,
      pagination: true,
      media: false
    },
    "image-pages": {
      toc: false,
      search: false,
      zoom: true,
      bookmarks: true,
      pagination: true,
      media: false
    },
    "epub-chapters": {
      toc: true,
      search: true,
      zoom: true,
      bookmarks: true,
      pagination: false,
      media: false
    },
    html: { toc: true, search: true, zoom: true, bookmarks: true, pagination: false, media: false },
    text: {
      toc: false,
      search: true,
      zoom: true,
      bookmarks: true,
      pagination: false,
      media: false
    },
    markdown: {
      toc: true,
      search: true,
      zoom: true,
      bookmarks: true,
      pagination: false,
      media: false
    },
    image: {
      toc: false,
      search: false,
      zoom: true,
      bookmarks: true,
      pagination: false,
      media: false
    },
    audio: {
      toc: false,
      search: false,
      zoom: false,
      bookmarks: true,
      pagination: false,
      media: true
    },
    unsupported: {
      toc: false,
      search: false,
      zoom: false,
      bookmarks: false,
      pagination: false,
      media: false
    },
    video: {
      toc: false,
      search: false,
      zoom: false,
      bookmarks: true,
      pagination: false,
      media: true
    },
    swf: {
      toc: false,
      search: false,
      zoom: false,
      bookmarks: true,
      pagination: false,
      media: true
    }
  });

  /** @param {string | null | undefined} extension */
  function capability(extension) {
    const normalized = String(extension || "").toLowerCase();
    // Native DjVu reuses the paginated document UI but never PDF.js.
    const mode = normalized === "djvu" ? "pdf" : modes[normalized];
    return Object.freeze({
      extension: normalized,
      mode: mode || null,
      readerMode: mode ? ReaderMode.ORIGINAL : ReaderMode.UNSUPPORTED,
      article: !!mode,
      features: Object.freeze({
        ...(mode && features[mode] || features.unsupported)
      })
    });
  }

  /** @param {unknown} value @param {number} minimum @param {number} maximum @param {number} fallback */
  function clampNumber(value, minimum, maximum, fallback) {
    const numeric = Math.round(Number(value));
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
  }

  const assetRoot = String.raw`objects/[0-9a-f]{2}/[0-9a-f]{64}/`;
  const v3BucketPathPattern = new RegExp(`^${assetRoot}[0-9a-f]{16}/(?:reading-manifest\\.json|page-map\\.json\\.gz|text-layer-manifest\\.json|text-review-manifest\\.json|text/(?:page-[0-9]{6}\\.json\\.gz|book-text\\.json\\.gz|search-[0-9]{6}-[0-9]{6}\\.json\\.gz|partition-[0-9]{6}-[0-9]{6}-manifest\\.json)|preview/(?:page-[0-9]{6}\\.(?:png|webp|jpeg|svg|jxl)|partition-[0-9]{6}-[0-9]{6}-manifest\\.json))$`);
  const assetVersion = String.raw`(?:[0-9a-f]{16}/)?`;
  const assetPages = String.raw`(?:page-manifest\.json|pages/page-[0-9]{6}\.(?:webp|jxl|png))`;
  const assetOcr = String.raw`(?:ocr-manifest\.json|ocr/(?:page-[0-9]{6}\.json\.gz|book-text\.json\.gz))`;
  const v2ChapterPathPattern = new RegExp(`^chapters/ebook/(?:epub|mobi|azw3|fb2|chm)/[0-9a-f]{64}/[0-9a-f]{16}/(?:chapter-manifest\\.json|epub-search-index\\.json\\.gz|chapters/chapter-[0-9]{4}\\.xhtml|resources/(?!\\.{1,2}(?:/|$))[^/]+(?:/(?!\\.{1,2}(?:/|$))[^/]+)*)$`);
  const bucketPathPattern = new RegExp(`^${assetRoot}${assetVersion}(?:${assetPages}|${assetOcr})$`);
  const staticBucketPathPattern = new RegExp(`^(?:${assetRoot}(?:[0-9a-f]{16}/)?(?:[a-z0-9-]+/)?(?:document\\.(?:html|txt|md|webp|jpg|jpeg|png|gif|bmp|swf)|audio\\.(?:mp3|wav|m4a|flac|mpga)|video\\.(?:mp4|mov))|documents/(?:text|web|spreadsheet|office|pdf)/[a-z0-9_-]+/[0-9a-f]{64}/document\\.(?:txt|md|html|pdf|vcf|ini)|media/(?:audio|video|swf)/[a-z0-9_-]+/[0-9a-f]{64}/(?:audio\\.[a-z0-9]+|video\\.[a-z0-9]+|document\\.swf)|pages/image/(?:jpg|jpeg|png|bmp|tif|tiff|webp|gif)/[0-9a-f]{64}/(?:document\\.webp|page-manifest\\.json|pages/page-[0-9]{6}\\.webp)|derived/[A-Za-z0-9._-]+/[a-z0-9]{32}/document\\.pdf|chapters/ebook/(?:epub|mobi|azw3|fb2|chm)/[0-9a-f]{64}/[0-9a-f]{16}/(?:chapter-manifest\\.json|epub-search-index\\.json\\.gz))$`);
  const imageRoot = String.raw`pages/image/(?:jpg|jpeg|png|bmp|tif|tiff|webp|gif)/[0-9a-f]{64}/`;
  const imageAvifDocumentPathPattern = new RegExp(`^${imageRoot}document\\.avif$`);
  const imageAvifPagePathPattern = new RegExp(`^${imageRoot}pages/page-(?!000000)[0-9]{6}\\.avif$`);
  const versionedBucketPathPattern = new RegExp(`^${assetRoot}[0-9a-f]{16}/(?:${assetPages}|${assetOcr})$`);
  /** @type {Readonly<Record<string, string>>} */
  const assetModes = Object.freeze({
    p: "pdf",
    e: "epub-chapters",
    h: "html",
    t: "txt",
    k: "md",
    i: "webp",
    a: "audio",
    v: "video",
    f: "swf"
  });

  /** @param {string} path @param {boolean} [versioned] @param {string} [bucket] */
  function isBucketPath(path, versioned = false, bucket = "vomebook/pdf-pages-v2") {
    if (bucket === "vomebook/reader-assets-v2") return staticBucketPathPattern.test(path) || v2ChapterPathPattern.test(path) ||
      bucketPathPattern.test(path) || imageAvifDocumentPathPattern.test(path);
    if (bucket !== "vomebook/pdf-pages-v2") return false;
    return /^objects\/([0-9a-f]{2})\/\1[0-9a-f]{62}\/[0-9a-f]{16}\/document\.djvu$/.test(path) ||
      /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16}\/document\.pdf$/.test(path) ||
      (versioned ? versionedBucketPathPattern : bucketPathPattern).test(path) ||
      v3BucketPathPattern.test(path) || staticBucketPathPattern.test(path);
  }

  // One parser for opening preload, manifest validation and page navigation.
  // Bucket paths require a 16-hex version segment.
  /** @param {string} raw @param {string} base @param {string} bucketOrigin @param {string} [filename] @param {string} [bucketName] @returns {import('../../../typings/reader-contract-strict').PageSource | null} */
  function pdfPageSource(raw, base, bucketOrigin, filename = "page-manifest.json", bucketName = "vomebook/pdf-pages-v2") {
    try {
      const url = new URL(raw, base);
      if (url.username || url.password || url.hash) return null;
      const bucket = [bucketOrigin, "https://voiceofml-search.hf.space"].includes(url.origin) &&
        url.pathname === "/api/reader-bucket-resource";
      const bucketPrefix = `/buckets/${bucketName}/resolve/`;
      const directBucket = url.origin === "https://huggingface.co" &&
        url.pathname.startsWith(bucketPrefix) && !url.search;
      let path;
      if (bucket) {
        if (url.searchParams.getAll("path").length !== 1 ||
            [...url.searchParams.keys()].some((key) => key !== "path")) return null;
        path = url.searchParams.get("path") || "";
      } else if (directBucket) {
        path = decodeURIComponent(url.pathname.slice(bucketPrefix.length));
      } else {
        return null;
      }
      if (!isBucketPath(path, true, bucketName)) return null;
      if (!["page-manifest.json", "ocr-manifest.json", "reading-manifest.json"].includes(filename) ||
          !path.endsWith(`/${filename}`)) return null;
      const rootPath = path.slice(0, -filename.length - 1);
      const imagePages = bucketName === "vomebook/reader-assets-v2" && filename === "page-manifest.json";
      /** @type {import('../../../typings/reader-contract-strict').PageSource} */
      const source = {
        root: rootPath,
        assetUrl(relativePath) {
          // AVIF pages are not standalone sources. Only an image stream can
          // derive these paths; the renderer supplies the required proxy pins.
          const allowedPath = isBucketPath(relativePath, true, bucketName) ||
            (imagePages && imageAvifPagePathPattern.test(relativePath));
          const prefix = imagePages ? `${rootPath}/pages/` : rootPath.split("/").slice(0, 3).join("/") + "/";
          if (!allowedPath || !relativePath.startsWith(prefix))
            throw new Error("PDF_ASSET_INVALID");
          // Image streams always fetch through the proxy, even with a raw
          // bucket manifest URL.
          const target = directBucket && imagePages
            ? new URL("/api/reader-bucket-resource", bucketOrigin) : new URL(url.href);
          if (bucket || imagePages) target.searchParams.set("path", relativePath);
          else target.pathname = `${bucketPrefix}${relativePath}`;
          return target.href;
        }
      };
      if (imagePages) {
        source.pageUrl = (page, format = "webp") => {
          if (!Number.isInteger(page) || page < 1 || page > 999999)
            throw new Error("PDF_PAGE_INVALID");
          if (format !== "webp" && format !== "avif") throw new Error("PDF_ASSET_INVALID");
          const filename = `pages/page-${String(page).padStart(6, "0")}.${format}`;
          return source.assetUrl(`${rootPath}/${filename}`);
        };
      }
      return source;
    } catch (_) {
      return null;
    }
  }

  /** @param {string} raw @param {string} base @param {string} bucketOrigin */
  function imagePageSource(raw, base, bucketOrigin) {
    return pdfPageSource(raw, base, bucketOrigin, "page-manifest.json", "vomebook/reader-assets-v2");
  }

  /** @param {import('../../../typings/reader-contract-strict').Asset} asset @param {string} bucketBase */
  function pdfDocumentUrl(asset, bucketBase) {
    const { pd, pdb } = asset;
    return typeof pd === "string" && (pdb === "vomebook/reader-assets-v2" || pdb === "vomebook/pdf-pages-v2") &&
      pd.endsWith("/document.pdf") && isBucketPath(pd, true, pdb)
      ? `${bucketBase}?path=${encodeURIComponent(pd)}` : "";
  }

  /** @param {import('../../../typings/reader-contract-strict').Asset | null | undefined} asset @param {string} bucketBase @param {string} [originalExtension] @returns {import('../../../typings/reader-contract-strict').AssetFields | null} */
  function assetFields(asset, bucketBase, originalExtension = "") {
    if (!asset) return null;
    const path = String(asset.p || "");
    const ocrPath = String(asset.o || "");
    const ocrBucket = asset.b === "vomebook/pdf-pages-v2" || asset.ob === "vomebook/pdf-pages-v2";
    const ocrUrl = ocrPath.endsWith("/ocr-manifest.json") && ocrBucket && isBucketPath(ocrPath, true)
      ? `${bucketBase}?path=${encodeURIComponent(ocrPath)}`
      : "";
    const ocr = ocrUrl ? { ReaderOcrManifest: ocrUrl, ReaderOcrMode: String(asset.om || "") } : null;
    if (asset.s === 3) return ocr;
    if (asset.s !== 2) return null;
    if (originalExtension.toLowerCase().replace(/^\./, "") === "djvu") return ocr;
    if (asset.m === "p" && !asset.c && originalExtension && path.endsWith("/page-manifest.json")) {
      const pdfUrl = pdfDocumentUrl(asset, bucketBase);
      return pdfUrl ? { ...ocr, ReaderLink: pdfUrl, ReaderExtension: "pdf" } : ocr;
    }
    const bucketName = String(asset.b || "vomebook/reader-assets-v2");
    const bucket = isBucketPath(path, true, bucketName);
    const avif = imageAvifDocumentPathPattern.test(path);
    if (avif && (asset.m !== "i" || asset.c)) return null;
    const chapterBucket = asset.cb === "vomebook/reader-assets-v2" &&
      v2ChapterPathPattern.test(String(asset.c || ""));
    if (
      path.endsWith(".djvu") ||
      !Object.prototype.hasOwnProperty.call(assetModes, /** @type {string} */ (asset.m)) ||
      !bucket ||
      (asset.b && bucketName !== "vomebook/pdf-pages-v2" && bucketName !== "vomebook/reader-assets-v2") ||
      (asset.cb && !chapterBucket)
    )
      return null;
    if (asset.m === "e" && !chapterBucket) return ocr;
    const extension =
      asset.m === "p" && /\/(?:page|reading)-manifest\.json$/.test(path)
        ? "pdf-pages"
        : asset.m === "i" && (path.endsWith("document.webp") || avif)
          ? "image"
          : asset.m === "i" && path.endsWith("page-manifest.json")
            ? "image-pages"
            : assetModes[/** @type {string} */ (asset.m)];
    const readerExtension = asset.c ? "epub-chapters" : extension;
    if (!readerExtension) return {};
    return {
      ReaderLink: `${bucketBase}?path=${encodeURIComponent(/** @type {string} */ (chapterBucket ? asset.c : path))}`,
      ReaderExtension: readerExtension,
      ReaderChapterManifest: asset.c ? `${bucketBase}?path=${encodeURIComponent(asset.c)}` : "",
      ReaderOcrManifest: ocrUrl,
      ReaderOcrMode: String(asset.om || ""),
      ReaderPdfDocument: pdfDocumentUrl(asset, bucketBase)
    };
  }

  /** @param {import('../../../typings/reader-contract-strict').ReaderRecord | null | undefined} record @param {string} [basePath] */
  function readerUrl(record, basePath) {
    if (!record) return "";
    const originalLink = record.Link || record.link;
    const originalExtension = record.Extension || record.extension;
    const source = record.ReaderLink || record.readerLink || originalLink;
    const ext = record.ReaderExtension || record.readerExtension || originalExtension || "";
    if (!source || capability(ext).readerMode === ReaderMode.UNSUPPORTED) return "";
    const download = record.DownloadLink || record.downloadLink;
    const originalSource = download || originalLink || "";
    const title = (record.File || record.name || "") + (originalExtension ? "." + originalExtension : "");
    const base = basePath || "/search/static/reader.html";
    if (/^https:\/\/huggingface\.co\/datasets\/VoiceOfML\//.test(originalSource)) {
      return base + "?" + new URLSearchParams({ id: shortSourceId(originalSource), title, ext });
    }
    const params = new URLSearchParams({ url: source, title, ext });
    const repo = String(record.Repo || record.repo || "").split("/").pop();
    const folders = record.Folder || record.folder;
    const folder = Array.isArray(folders) ? folders.join("/") : "";
    const extras = {
      download,
      ocr_manifest: record.ReaderOcrManifest || record.readerOcrManifest,
      pdf_document: record.ReaderPdfDocument,
      chapter_manifest: record.ReaderChapterManifest || record.readerChapterManifest || record.ChapterManifest || record.chapterManifest,
      return: record.ReturnUrl || record.returnUrl,
      path: repo && (folder ? `${repo}/${folder}` : repo),
      folder_url: record.FolderUrl || record.folderUrl
    };
    for (const [key, value] of Object.entries(extras)) {
      if (value) params.set(key, value);
    }
    return base + "?" + params.toString();
  }
  /** @param {string} value */
  function canonicalSourceUrl(value) {
    // Normalize path bytes, not decoded URLs: %2F must remain distinct from /,
    // and %2528 must never become %28. Query/fragment delimiters stay intact.
    return value.replace(/^(https:\/\/huggingface\.co\/datasets\/VoiceOfML\/)([^?#]*)/, (_, prefix, path) => {
      // Canonical paths need no per-escape replacement. A lowercase/invalid
      // escape, percent-encoded unreserved byte, or raw unsafe character must
      // still take the established normalization and URI-error path below.
      if (!/%(?![0-9A-F]{2})|%(?:2[DE]|3[0-9]|4[1-9A-F]|5[0-9AF]|6[1-9A-F]|7[0-9AE])|[^A-Za-z0-9._~/%-]/.test(path))
        return prefix + path;
      return prefix + path.replace(/%[0-9a-fA-F]{2}|[^A-Za-z0-9._~/-]/gu, /** @param {string} token */ (token) => {
        if (/^%[0-9a-f]{2}$/i.test(token)) {
          const char = String.fromCharCode(parseInt(token.slice(1), 16));
          return /^[A-Za-z0-9._~-]$/.test(char) ? char : token.toUpperCase();
        }
        return encodeURIComponent(token).replace(/[!'()*]/g, (char) =>
          "%" + char.charCodeAt(0).toString(16).toUpperCase());
      });
    });
  }
  const FNV32_MASK = 0xffffffffn;
  /** @param {string} value */
  function shortSourceId(value) {
    // Two 32-bit halves avoid per-byte BigInt multiplication while preserving
    // the exact FNV-1a 64-bit wraparound and the established stable IDs.
    let hash = 1469598103934665603n;
    let high = Number(hash >> 32n), low = Number(hash & FNV32_MASK);
    for (const byte of new TextEncoder().encode(canonicalSourceUrl(value))) {
      low = (low ^ byte) >>> 0;
      const product = low * 435;
      const carry = Math.floor(product / 4294967296);
      high = (Math.imul(high, 435) + Math.imul(low, 256) + carry) >>> 0;
      low = product >>> 0;
    }
    hash = (BigInt(high) << 32n) | BigInt(low);
    return hash.toString(36).padStart(13, "0");
  }

  root.VoiceOfMLReader = Object.freeze({
    ReaderMode,
    articleExtensions,
    capability,
    features,
    clampNumber,
    assetFields,
    isBucketPath,
    pdfPageSource,
    imagePageSource,
    canonicalSourceUrl,
    shortSourceId,
    readerUrl
  });
  preloadPdfOpeningResources();
  preloadChapterOpeningResources();
})(typeof self !== "undefined" ? self : window);
