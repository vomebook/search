export function createReaderSource(readerContext) {
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

  function readerDownloadApiUrl(path) {
    return `https://voiceofml-search.hf.space${path}`;
  }

  function readerDownloadUrl(filename, link) {
    return readerContext.readerDownloadApiUrl(`/api/download?file=${encodeURIComponent(filename || "file")}&link=${encodeURIComponent(link || "")}`);
  }

  async function startReaderDownload(event) {
    event.preventDefault();
    const button = event.currentTarget;
    if (button.hasAttribute("aria-busy")) return;
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
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.error || "下载检查失败，请重试");
      if (readerContext.readerLifecycle.disposed) return;
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.src = readerContext.readerDownloadUrl(filename, readerContext.downloadUrl);
      document.body.appendChild(frame);
      setTimeout(() => frame.remove(), 60000);
      readerContext.showDownloadFeedback("已发起下载");
    } catch (error) {
      if (!readerContext.readerLifecycle.disposed) {
        readerContext.showDownloadFeedback(error?.name === "AbortError" ? "下载检查超时，请重试" : (error.message || "下载失败，请重试"));
      }
    } finally {
      clearTimeout(timer);
      button.removeAttribute("aria-busy");
    }
  }

  function normalizeSourceUrl(url) {
    return url.startsWith("/api/reader-bucket-resource?")
      ? new URL(url, "https://voiceofml-search.hf.space").href
      : url;
  }

  async function resolveReaderId(id) {
    const endpoint = `https://voiceofml-search.hf.space/api/reader-resolve?id=${encodeURIComponent(id)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const early = window.__VOICE_READER_RESOLVE__;
      if (!attempt && early?.id === id) {
        window.__VOICE_READER_RESOLVE__ = null;
        const untrack = readerContext.trackReaderResource(early.dispose);
        let result;
        try { result = await readerContext.awaitReader(early.promise); }
        catch (error) {
          readerContext.assertReaderActive();
          if (!["TimeoutError", "TypeError"].includes(error?.name)) throw error;
          continue;
        }
        finally { untrack(); early.dispose(); }
        if (result.ok) return result.data;
        if (![408, 429, 500, 502, 503, 504].includes(result.status))
          throw new Error(`HTTP ${result.status}`);
        await readerContext.waitForReader(350);
        continue;
      }
      const response = await readerContext.readerRequestManager.requestBuffered(
        endpoint, readerContext.READER_PROXY_TIMEOUT_MS, VoiceOfMLReaderSecurity.LIMITS.manifestBytes);
      if (response.ok) return response.json();
      await response.body?.cancel();
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt)
        throw new Error(`HTTP ${response.status}`);
      await readerContext.waitForReader(350);
    }
    throw new Error("Reader ID resolution failed");
  }

  function applyReaderMetadata(data) {
    if (data) readerContext.resolvedReaderData = { ...(readerContext.resolvedReaderData || {}), ...data };
    if (data?.ReaderOcrManifest || data?.ocr_manifest) {
      readerContext.ocrManifestUrl = data.ReaderOcrManifest || data.ocr_manifest;
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
    document.querySelector("#title").textContent = value;
    document.title = `${value} - VoiceOfML Reader`;
    readerContext.applyReaderPathMetadata(readerContext.resolvedReaderData);
  }

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

  function applyReaderPathMetadata(data) {
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
      )
        readerContext.folderNavigationTarget = target;
    } catch (_) {}
    if (!readerContext.folderNavigationTarget && data?.repo) {
      readerContext.folderNavigationTarget = new URL("/search/", location.origin);
      const query = new URLSearchParams();
      if (folder) query.set("folder_self", folder);
      readerContext.folderNavigationTarget.hash =
        "#/" + encodeURIComponent(data.repo) + (query.size ? "?" + query.toString() : "");
    }
    readerContext.readerPath.textContent = value;
    readerContext.readerPath.hidden = !value;
    readerContext.readerPath.disabled = !readerContext.folderNavigationTarget;
    readerContext.readerPath.setAttribute("aria-label", `筛选文件夹：${value}`);
  }

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
      const readerAsset = VoiceOfMLReader.isAssetSourcePath(url.pathname);
      if (readerContext.extension === "docx") return readerAsset;
      return /^\/datasets\/VoiceOfML\/[^/]+\/(resolve|raw)\//.test(url.pathname) || readerAsset;
    } catch (_) {
      return false;
    }
  }

  function validOcr(raw) {
    try {
      const url = new URL(raw);
      return (
        url.protocol === "https:" &&
        url.hostname === "voiceofml-search.hf.space" &&
        url.pathname.startsWith("/txt/")
      );
    } catch (_) {
      return false;
    }
  }

  function validFallback(raw) {
    try {
      const url = new URL(raw);
      return (
        url.protocol === "https:" &&
        ["huggingface.co", "hf-mirror.com"].includes(url.hostname) &&
        /\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:linearized\.pdf|(?:[a-z0-9-]+\/)?document\.pdf)$/.test(
          url.pathname
        )
      );
    } catch (_) {
      return false;
    }
  }

  function readerAssetObjectFamily(raw, base = location.href) {
    try {
      const url = new URL(raw, base);
      if (url.origin === "https://voiceofml-search.hf.space" && url.pathname === "/api/reader-bucket-resource") {
        const bucketPath = url.searchParams.get("path") || "";
         const match = bucketPath.match(/^(chapters\/ebook\/(?:epub|mobi|azw3|fb2|chm)\/[0-9a-f]{64}\/[0-9a-f]{16}\/)/);
        if (url.hash || url.searchParams.getAll("path").length !== 1 ||
             [...url.searchParams.keys()].some((key) => key !== "path") || !match ||
             !VoiceOfMLReader.isBucketPath(bucketPath, true, "vomebook/reader-assets-v2")) return null;
        return { url, prefix: match[1], bucket: true, bucketPath };
      }
      if (
        url.protocol !== "https:" ||
        !["huggingface.co", "hf-mirror.com"].includes(url.hostname) ||
        url.username ||
        url.password
      )
        return null;
      const match = url.pathname.match(
        /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/(objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:[a-z0-9-]+\/)?)/
      );
      return match
        ? { url, prefix: url.pathname.slice(0, url.pathname.indexOf(match[1])) + match[1], bucket: false }
        : null;
    } catch (_) {
      return null;
    }
  }

  function trustedReaderAssetManifestUrl(raw) {
    const family = readerContext.readerAssetObjectFamily(raw);
    const manifestPath = family?.bucket ? family.bucketPath : family?.url.pathname;
    return family &&
      (family.bucket || family.url.search === "") &&
      (family.bucket || !family.url.hash) &&
      /\/chapter-manifest\.json$/i.test(manifestPath || "")
      ? family.url.href
      : null;
  }

  function trustedChapterUrl(raw, base) {
    const manifest = readerContext.readerAssetObjectFamily(base);
    const manifestPath = manifest?.bucket ? manifest.bucketPath : new URL(base, location.href).pathname;
    if (!manifest || !/\/chapter-manifest\.json$/i.test(manifestPath))
      return null;
    try {
      if (manifest.bucket) {
        const url = new URL(String(raw || ""), `https://bucket.invalid/${manifest.bucketPath}`);
        const path = decodeURIComponent(url.pathname.slice(1));
        if (url.origin !== "https://bucket.invalid" || url.search || url.hash ||
            !path.startsWith(manifest.prefix) ||
            !/(?:\/chapters\/chapter-[0-9]{4}\.xhtml|\/epub-search-index\.json\.gz)$/i.test(path) ||
             !VoiceOfMLReader.isBucketPath(path, true, "vomebook/reader-assets-v2")) return null;
        return `${manifest.url.origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
      }
      const url = new URL(raw, base);
      return !url.search &&
        !url.hash &&
        url.origin === manifest.url.origin &&
        url.pathname.startsWith(manifest.prefix) &&
         /(?:\.(?:xhtml?|html?)|\/epub-search-index\.json\.gz)$/i.test(url.pathname)
        ? url.href
        : null;
    } catch (_) {
      return null;
    }
  }

  function trustedChapterReferenceUrl(raw, base, manifestBase) {
    const family = readerContext.readerAssetObjectFamily(manifestBase);
    if (!family) return null;
    try {
      if (family.bucket) {
        const current = readerContext.readerAssetObjectFamily(base);
        if (!current?.bucket) return null;
        const url = new URL(String(raw || ""), `https://bucket.invalid/${current.bucketPath}`);
        const path = decodeURIComponent(url.pathname.slice(1));
        if (url.origin !== "https://bucket.invalid" || url.search ||
             !path.startsWith(family.prefix) || !/\/chapters\/chapter-[0-9]{4}\.xhtml$/i.test(path) ||
             !VoiceOfMLReader.isBucketPath(path, true, "vomebook/reader-assets-v2")) return null;
        return { url: `${family.url.origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`,
                 fragment: url.hash };
      }
      const url = new URL(raw, base);
      return !url.search && url.origin === family.url.origin && url.pathname.startsWith(family.prefix) &&
        /\/(?:chapters\/)?[^/]+\.xhtml?$/i.test(url.pathname)
        ? { url: url.href, fragment: url.hash } : null;
    } catch (_) {
      return null;
    }
  }

  function trustedChapterResourceUrl(raw, base, attribute, manifestBase) {
    const value = String(raw || "").trim();
    if (!value || /^(?:data:|mailto:|tel:|javascript:)/i.test(value)) return null;
    // Chapters and resources can be siblings within the manifest's asset directory.
    const family = readerContext.readerAssetObjectFamily(manifestBase);
    if (!family) return null;
    try {
      if (family.bucket) {
        const current = readerContext.readerAssetObjectFamily(base);
        if (!current?.bucket) return null;
        const url = new URL(value, `https://bucket.invalid/${current.bucketPath}`);
        const path = decodeURIComponent(url.pathname.slice(1));
        if (url.origin !== "https://bucket.invalid" || url.search || url.hash ||
             !path.startsWith(family.prefix) || !VoiceOfMLReader.isBucketPath(path, true, "vomebook/reader-assets-v2")) return null;
        return `${family.url.origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
      }
      const url = new URL(value, base),
        path = url.pathname.toLowerCase();
      if (url.origin !== family.url.origin || !url.pathname.startsWith(family.prefix)) return null;
      const allowed =
        attribute === "href"
          ? /\.(?:x?html?|css|svg|png|jpe?g|gif|webp|woff2?|ttf|otf|mp3|mp4|m4a|webm|ogg)$/i.test(
              path
            )
          : /\.(?:svg|png|jpe?g|gif|webp|woff2?|ttf|otf|mp3|mp4|m4a|webm|ogg)$/i.test(path);
      return allowed ? url.href : null;
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
    applyReaderPathMetadata,
    validSource,
    validOcr,
    validFallback,
    readerAssetObjectFamily,
    trustedReaderAssetManifestUrl,
    trustedChapterUrl,
    trustedChapterReferenceUrl,
    trustedChapterResourceUrl
  };
}
