(function (root) {
  "use strict";
  if (root.VoiceOfMLReader?.pdfPageSource && root.VoiceOfMLReader?.txtRelativePath) return;

  function preloadPdfOpeningResources() {
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
      const sourceInfo = pdfPageSource(
        manifestUrl.href,
        location.origin,
        "https://voiceofml-search.hf.space"
      );
      if (!sourceInfo) return;
      const security = root.VoiceOfMLReaderSecurity;
      if (!security) return;
      const pageUrl = new URL(sourceInfo.pageUrl(1));
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
  }

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
      search: true,
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
        ...(features[mode] || features.unsupported)
      })
    });
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const numeric = Math.round(Number(value));
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
  }

  const assetRoot = String.raw`objects/[0-9a-f]{2}/[0-9a-f]{64}/`;
  const assetVersion = String.raw`(?:[0-9a-f]{16}/)?`;
  const assetPages = String.raw`(?:page-manifest\.json|pages/page-[0-9]{6}\.webp)`;
  const assetDocument = String.raw`(?:linearized\.pdf|document\.(?:pdf|epub|mobi|azw|azw3|fb2|docx|html)|book\.epub|audio\.mp3|video\.mp4)`;
  const assetChapters = String.raw`(?:chapter-manifest\.json|epub-chapters/(?:chapter-manifest\.json|chapters/chapter-[0-9]{4}\.xhtml|resources/[A-Za-z0-9._~%+\-/]+|epub-search-index\.json\.gz))`;
  const assetPrimaryPattern = new RegExp(
    `^${assetRoot}${assetVersion}(?:${assetPages}|(?:[a-z0-9-]+/)?${assetDocument})$`
  );
  const assetSourcePattern = new RegExp(
    `^(?:pdf_manifest\\.json|${assetRoot}${assetVersion}(?:${assetPages}|(?:[a-z0-9-]+/)?(?:${assetDocument}|${assetChapters})))$`
  );
  const bucketPathPattern = new RegExp(`^${assetRoot}${assetVersion}${assetPages}$`);
  const versionedBucketPathPattern = new RegExp(`^${assetRoot}[0-9a-f]{16}/${assetPages}$`);
  const assetBase = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/";
  const assetModes = Object.freeze({
    p: "pdf",
    e: "epub",
    d: "docx",
    h: "html",
    a: "audio",
    v: "video"
  });

  function isBucketPath(path, versioned = false) {
    return (versioned ? versionedBucketPathPattern : bucketPathPattern).test(path);
  }

  function isAssetSourcePath(path) {
    const prefix = /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\//.exec(path);
    return !!prefix && assetSourcePattern.test(path.slice(prefix[0].length));
  }

  // One parser for opening preload, manifest validation and page navigation.
  // Dataset assets may be unversioned; the Bucket API requires a version.
  function pdfPageSource(raw, base, bucketOrigin) {
    try {
      const url = new URL(raw, base);
      if (url.username || url.password || url.hash) return null;
      const bucket = url.origin === bucketOrigin && url.pathname === "/api/reader-bucket-resource";
      let path;
      if (bucket) {
        path = url.searchParams.get("path") || "";
        if (!isBucketPath(path, true)) return null;
      } else {
        if (
          url.protocol !== "https:" ||
          !["huggingface.co", "hf-mirror.com"].includes(url.hostname) ||
          url.search
        )
          return null;
        const prefix = /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\//.exec(url.pathname);
        if (!prefix) return null;
        path = decodeURIComponent(url.pathname.slice(prefix[0].length));
        if (!isBucketPath(path)) return null;
      }
      if (!path.endsWith("/page-manifest.json")) return null;
      const rootPath = path.slice(0, -"/page-manifest.json".length);
      return {
        root: rootPath,
        pageUrl(page) {
          if (!Number.isInteger(page) || page < 1 || page > 999999)
            throw new Error("PDF_PAGE_INVALID");
          const target = new URL(url.href);
          const filename = `pages/page-${String(page).padStart(6, "0")}.webp`;
          if (bucket) target.searchParams.set("path", `${rootPath}/${filename}`);
          else target.pathname = target.pathname.replace(/page-manifest\.json$/, filename);
          return target.href;
        }
      };
    } catch (_) {
      return null;
    }
  }

  function txtRelativePath(path) {
    const value = String(path || "");
    const dot = value.lastIndexOf(".");
    return (dot > value.lastIndexOf("/") ? value.slice(0, dot) : value) + ".txt";
  }

  function assetFields(asset, bucketBase) {
    const path = String(asset?.p || "");
    const bucket = isBucketPath(path, true);
    if (
      !asset ||
      asset.s !== 2 ||
      !Object.prototype.hasOwnProperty.call(assetModes, asset.m) ||
      !assetPrimaryPattern.test(path) ||
      (bucket && asset.b !== "vomebook/pdf-pages")
    )
      return null;
    const nativeExtension =
      /(?:^|\/)document\.(epub|mobi|azw|azw3|fb2)$/i.exec(path)?.[1]?.toLowerCase() || "epub";
    const extension =
      asset.m === "e"
        ? nativeExtension
        : asset.m === "p" && path.endsWith("page-manifest.json")
          ? "pdf-pages"
          : assetModes[asset.m];
    return {
      ReaderLink: bucket ? `${bucketBase}?path=${encodeURIComponent(path)}` : assetBase + path,
      ReaderExtension: asset.c ? "epub-chapters" : extension,
      ReaderChapterManifest: asset.c ? assetBase + asset.c : "",
      ReaderFallback: asset.f ? assetBase + asset.f : ""
    };
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
    assetFields,
    isAssetSourcePath,
    isBucketPath,
    pdfPageSource,
    txtRelativePath,
    shortSourceId,
    readerUrl
  });
  preloadPdfOpeningResources();
})(typeof self !== "undefined" ? self : window);
