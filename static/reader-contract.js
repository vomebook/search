(function (root) {
  "use strict";

  (function preloadPdfOpeningResources() {
    try {
      const params = new URLSearchParams(location.search);
      const id = params.get("id") || "";
      let source = params.get("url") || "";
      if (!source && id) {
        for (const key of [`reader-source:${id}`, `reader-resolve:${id}`]) {
          const value = JSON.parse(sessionStorage.getItem(key) || "null");
          if (value?.url) {
            source = value.url;
            break;
          }
        }
      }
      if (source.startsWith("/api/")) source = `https://voiceofml-search.hf.space${source}`;
      if (!source) return;
      const manifestUrl = new URL(source, location.origin);
      const path = manifestUrl.searchParams.get("path") || "";
      const bucket =
        manifestUrl.origin === "https://voiceofml-search.hf.space" &&
        manifestUrl.pathname === "/api/reader-bucket-resource" &&
        /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16}\/page-manifest\.json$/.test(path);
      const direct =
        ["huggingface.co", "hf-mirror.com"].includes(manifestUrl.hostname) &&
        /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16}\/page-manifest\.json$/.test(
          manifestUrl.pathname
        );
      if (!bucket && !direct) return;
      const security = root.VoiceOfMLReaderSecurity;
      if (!security) return;
      const pageUrl = new URL(manifestUrl.href);
      if (bucket)
        pageUrl.searchParams.set(
          "path",
          path.replace(/\/page-manifest\.json$/, "/pages/page-000001.webp")
        );
      else
        pageUrl.pathname = manifestUrl.pathname.replace(
          /\/page-manifest\.json$/,
          "/pages/page-000001.webp"
        );
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 120000);
      let disposed = false;
      let preload;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        controller.abort();
        if (preload?.image) {
          preload.image.src = "";
          preload.image = null;
        }
        root.removeEventListener?.("pagehide", onPageHide);
      };
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
        pageUrl: pageUrl.href,
        image: null,
        dispose
      };
      preload.manifest.catch(() => {});
      if (!navigator.connection?.saveData) {
        preload.image = new Image();
        preload.image.decoding = "async";
        preload.image.fetchPriority = "low";
        preload.image.src = pageUrl.href;
      }
      root.addEventListener?.("pagehide", onPageHide);
      root.__VOICE_PDF_PRELOAD__ = preload;
    } catch (_) {}
  })();

  const ReaderMode = Object.freeze({
    UNSUPPORTED: 0,
    ORIGINAL: 1,
    CONVERTED: 2,
    PENDING: 3,
    FAILED: 4
  });
  const modes = Object.freeze({
    pdf: "pdf",
    "pdf-pages": "pdf-pages",
    epub: "foliate",
    mobi: "foliate",
    azw: "foliate",
    azw3: "foliate",
    fb2: "foliate",
    fbz: "foliate",
    "epub-chapters": "epub-chapters",
    docx: "docx",
    html: "html",
    htm: "html",
    txt: "text",
    md: "markdown",
    markdown: "markdown",
    jpg: "image",
    jpeg: "image",
    png: "image",
    gif: "image",
    bmp: "image",
    webp: "image",
    mp3: "audio",
    wav: "audio",
    m4a: "audio",
    flac: "audio",
    mpga: "audio",
    audio: "audio",
    mp4: "video",
    mov: "video",
    video: "video"
  });
  const articleExtensions = Object.freeze(Object.keys(modes));
  const features = Object.freeze({
    pdf: { toc: true, search: true, zoom: true, bookmarks: true, pagination: true, media: false },
    "pdf-pages": {
      toc: true,
      search: false,
      zoom: true,
      bookmarks: true,
      pagination: true,
      media: false
    },
    foliate: {
      toc: true,
      search: true,
      zoom: true,
      bookmarks: true,
      pagination: false,
      media: false
    },
    "epub-chapters": {
      toc: true,
      search: false,
      zoom: true,
      bookmarks: true,
      pagination: false,
      media: false
    },
    docx: { toc: true, search: true, zoom: true, bookmarks: true, pagination: true, media: false },
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
    video: {
      toc: false,
      search: false,
      zoom: false,
      bookmarks: true,
      pagination: false,
      media: true
    }
  });

  function capability(extension) {
    const normalized = String(extension || "").toLowerCase();
    const mode = modes[normalized];
    return Object.freeze({
      extension: normalized,
      mode: mode || null,
      readerMode: mode ? ReaderMode.ORIGINAL : ReaderMode.UNSUPPORTED,
      article: !!mode,
      features: Object.freeze({
        ...(features[mode] || {
          toc: false,
          search: false,
          zoom: false,
          bookmarks: false,
          pagination: false,
          media: false
        })
      })
    });
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const numeric = Math.round(Number(value));
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
  }

  function readerUrl(record, basePath) {
    const source = record && (record.ReaderLink || record.readerLink || record.Link || record.link);
    const readerExtension =
      record &&
      (record.ReaderExtension || record.readerExtension || record.Extension || record.extension);
    if (!source || capability(readerExtension).readerMode === ReaderMode.UNSUPPORTED) return "";
    const assetMatch = source.match(
      /(?:^|[\/=])objects\/[0-9a-f]{2}\/([0-9a-f]{16})[0-9a-f]{48}(?:\/[0-9a-f]{16})?\//i
    );
    const shortId = assetMatch
      ? assetMatch[1]
      : /^https:\/\/huggingface\.co\/datasets\//i.test(source)
        ? shortSourceId(source)
        : "";
    const title =
      (record.File || record.name || "") +
      (record.Extension || record.extension ? "." + (record.Extension || record.extension) : "");
    const params = new URLSearchParams(
      shortId
        ? { id: shortId, title, ext: readerExtension || "" }
        : { url: source, title, ext: readerExtension || "" }
    );
    if (!shortId && (record.DownloadLink || record.downloadLink))
      params.set("download", record.DownloadLink || record.downloadLink);
    if (!shortId && (record.OcrUrl || record.ocrUrl))
      params.set("ocr", record.OcrUrl || record.ocrUrl);
    if (!shortId && (record.ReaderFallback || record.readerFallback))
      params.set("fallback", record.ReaderFallback || record.readerFallback);
    if (
      !shortId &&
      (record.ReaderChapterManifest ||
        record.readerChapterManifest ||
        record.ChapterManifest ||
        record.chapterManifest)
    )
      params.set(
        "chapter_manifest",
        record.ReaderChapterManifest ||
          record.readerChapterManifest ||
          record.ChapterManifest ||
          record.chapterManifest
      );
    if (!shortId && (record.ReturnUrl || record.returnUrl))
      params.set("return", record.ReturnUrl || record.returnUrl);
    const repo = String(record.Repo || record.repo || "")
      .split("/")
      .pop();
    const folder = Array.isArray(record.Folder || record.folder)
      ? (record.Folder || record.folder).join("/")
      : "";
    if (!shortId && repo) params.set("path", repo + (folder ? "/" + folder : ""));
    if (!shortId && (record.FolderUrl || record.folderUrl))
      params.set("folder_url", record.FolderUrl || record.folderUrl);
    return (basePath || "/search/static/reader.html") + "?" + params.toString();
  }
  function shortSourceId(value) {
    let hash = 1469598103934665603n;
    for (const byte of new TextEncoder().encode(value)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 1099511628211n);
    }
    return hash.toString(36).padStart(13, "0");
  }

  root.VoiceOfMLReader = Object.freeze({
    ReaderMode,
    articleExtensions,
    capability,
    features,
    clampNumber,
    readerUrl
  });
})(typeof self !== "undefined" ? self : window);
