export function createReaderFormatController(readerContext) {
  // Fixed identities are test fixtures only, not a production trust source.
  const localReviewedBooks = new Map([
    ["29b1i0i45mj7g", ["chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/bc50c5be8c985411/chapter-manifest.json", "6b68299f415c8bd629b03c80961d3a55b8260f960dbd662891f28266e5112d5f"]],
    ["0bkdmor8l52rg", ["chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/bc50c5be8c985411/chapter-manifest.json", "23f33136458f715f5425fd35dff3975a5eb03a062668cb7b3d155fc56ea4deee"]],
    ["1nd5z6md7qzl6", ["chapters/ebook/chm/a30c4f7dc0d7ee59778e252ec4e49757d8ab4cf142d2798257030c483c09f4e0/1d4db6aed8930887/chapter-manifest.json", "a55a438fb5b401ee82ea5fc109c07ff8ada364456ffc1b521b38ee22453626bf"]],
    ["13i6hffuvzujn", ["chapters/ebook/chm/a72ce4c104a891febdfdb90f1a40171b0edb7435b8e6251801a43989c67a88f1/551923a5166cf5b8/chapter-manifest.json", "755fc096ef0aa82cd9c450c6e2783375b4e4a37fd11e2abb306bde1d70363ae4"]]
  ]);

  async function verifyLocalReviewedBook(id, source, manifest, download) {
    if (!["127.0.0.1", "localhost"].includes(location.hostname)) return;
    if (!localReviewedBooks.has(id)) {
      if ([source, manifest].some(url => VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(url) ||
          VoiceOfMLReaderStore.localLegacyChapterUrl?.(url)))
        throw new Error("本地 CHM 测试：未确认书目身份");
      return;
    }
    const [reviewedPath, expected] = localReviewedBooks.get(id);
    const old = `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(reviewedPath)}`;
    const matches = raw => {
      const legacy = VoiceOfMLReaderStore.localLegacyChapterUrl?.(raw) || raw;
      return VoiceOfMLReaderStore.localSameLegacyChapter?.(legacy, old);
    };
    if (!matches(source) || (manifest && !matches(manifest)))
      throw new Error("本地 CHM 测试：书目章节身份不匹配");
    try {
      const url = new URL(download);
      if (url.protocol !== "https:" || url.host !== "huggingface.co" || url.username || url.password ||
          url.search || url.hash || !/^\/datasets\/VoiceOfML\/[^/]+\/resolve\/main\/.+\.chm$/i.test(url.pathname) ||
          typeof VoiceOfMLReader.shortSourceId !== "function" || typeof VoiceOfMLReader.canonicalSourceUrl !== "function" ||
          VoiceOfMLReader.shortSourceId(url.href) !== id || !crypto?.subtle) throw new Error("source identity differs");
      const canonical = VoiceOfMLReader.canonicalSourceUrl(url.href);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      readerContext.assertReaderActive();
      const hex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (hex !== expected) throw new Error("source URL fingerprint differs");
    } catch (_) {
      readerContext.assertReaderActive();
      throw new Error("本地 CHM 测试：原始文件身份不匹配");
    }
  }

  async function prepareLocalDirectSource() {
    const {readerId, sourceUrl, chapterManifestUrl, downloadUrl} = readerContext;
    if (readerId) {
      await verifyLocalReviewedBook(readerId, sourceUrl, chapterManifestUrl, downloadUrl);
      // Explicit ID+old URL would otherwise write to an obsolete shared key.
      if (VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(sourceUrl))
        throw new Error("本地 CHM 测试：请使用书目入口打开");
    }
    const oldManifest = chapterManifestUrl || sourceUrl;
    // Never give two different books the same synthetic direct-history key.
    // An explicitly supplied manifest must belong to the old source bundle.
    if (!readerId && VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(sourceUrl) && chapterManifestUrl) {
      const manifestOld = VoiceOfMLReaderStore.localLegacyChapterUrl?.(chapterManifestUrl) || chapterManifestUrl;
      if (!VoiceOfMLReaderStore.localSameLegacyChapter?.(sourceUrl, manifestOld))
        throw new Error("本地 CHM 测试：旧章节身份不一致");
    }
    const split = VoiceOfMLReaderStore.localSplitChapterUrl?.(oldManifest);
    if (!readerId && split) {
      if (VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(sourceUrl) &&
          !VoiceOfMLReaderStore.localSameLegacyChapter?.(sourceUrl, oldManifest))
        throw new Error("本地 CHM 测试：旧章节身份不一致");
      readerContext.chapterManifestUrl = split;
    }
  }

  function disposeFormatResources(mode) {
    if (mode === "epub-chapters") {
      readerContext.chapterManifestCleanup?.();
      readerContext.chapterManifestCleanup = null;
    }
    if (mode === "swf") {
      readerContext.swfPlayer?.remove();
      readerContext.swfPlayer = null;
    }
    if (["pdf", "pdf-pages", "image-pages"].includes(mode)) {
      readerContext.fullSearchController.resetAvailability();
      readerContext.pdfDocument = null;
      readerContext.pdfPageManifest = null;
      readerContext.pdfOcrManifest = null;
      readerContext.pdfOcrManifestPromise = null;
      readerContext.pdfV3Repository?.dispose(); readerContext.pdfTextLayerRepository?.dispose();
      readerContext.pdfV3Repository = readerContext.pdfTextLayerRepository = null;
      readerContext.pdfV3Manifest = readerContext.pdfV3Map = null;
      readerContext.pdfTextContentCache.clear();
      readerContext.pdfTextContentPromises.clear();
      readerContext.pdfTextContentCacheBytes = 0;
      readerContext.pdfOcrPageCache.clear();
      readerContext.pdfOcrPageCacheBytes = 0;
      readerContext.clearPdfManifestPrefetches();
      readerContext.pdfBookSearchClient?.dispose();
      readerContext.pdfBookSearchClient = null;
      readerContext.pdfShellWindow?.dispose();
      readerContext.pdfFirstPagePreload?.removeAttribute("src");
      readerContext.pdfFirstPagePreload = null;
      for (const canvas of readerContext.content.querySelectorAll(".reader-page canvas")) {
        canvas.width = 0;
        canvas.height = 0;
      }
      for (const image of readerContext.content.querySelectorAll(".reader-page img")) image.removeAttribute("src");
    }
    if (mode === "foliate") {
      readerContext.foliateSectionObserver?.disconnect();
      readerContext.foliateSectionObserver = null;
      readerContext.foliateSectionVirtualizer?.dispose();
      readerContext.foliateChapterRepository?.dispose();
      readerContext.foliateSectionVirtualizer = null;
      readerContext.foliateChapterRepository = null;
      readerContext.foliateSectionLoader = null;
      readerContext.foliateSectionSettler = null;
      try {
        const closing = readerContext.epubRendition?.close?.();
        closing?.catch?.(() => {});
      } catch (_) {}
      readerContext.epubRendition = null;
      readerContext.epubBook = null;
    }
    if (mode === "html") {
      readerContext.htmlFrame?.remove();
      readerContext.htmlFrame = null;
      readerContext.content.classList.remove("reader-content--spreadsheet");
    }
    if (["audio", "video"].includes(mode) && readerContext.mediaElement) {
      readerContext.mediaElement.pause();
      readerContext.mediaElement.removeAttribute("src");
      readerContext.mediaElement.load();
      readerContext.mediaElement = null;
    }
  }

  function registerReaderFormatAdapters() {
    const formats = {
      "pdf-pages": [
        () => {
          return readerContext.fetchReaderResponse();
        },
        readerContext.renderPdfPages
      ],
      "image-pages": [
        () => readerContext.fetchReaderResponse(),
        readerContext.renderImagePages
      ],
      pdf: [() => {
        if (readerContext.extension !== "djvu") return readerContext.loadPdfDocument();
        readerContext.releasePdfWorker?.();
        return import("/search/static/reader/pdf/reader-djvu-loader.mjs").then(module => module.openNativeDjvu(readerContext));
      }, readerContext.renderPdf],
      image: [readerContext.loadImageDocument, readerContext.renderImageDocument],
      text: [readerContext.loadTextDocument, readerContext.renderTextDocument],
      markdown: [readerContext.loadMarkdownDocument, readerContext.renderMarkdownDocument],
      html: [readerContext.loadHtmlDocument, readerContext.renderHtml],
      "epub-chapters": [readerContext.loadChapterManifestDocument, readerContext.renderChapterManifest],
      audio: [readerContext.loadMediaDocument, () => readerContext.renderMedia("audio")],
      video: [readerContext.loadMediaDocument, () => readerContext.renderMedia("video")],
      swf: [readerContext.loadSwfDocument, readerContext.renderSwf],
      foliate: [readerContext.loadMediaDocument, readerContext.renderFoliate]
    };
    for (const [mode, [open, render]] of Object.entries(formats))
      readerContext.formatAdapters.register(mode, {
        open,
        render,
        restore: (entry, generation) => readerContext.restoreFormat(mode, entry, generation),
        dispose: () => readerContext.disposeFormatResources(mode)
      });
  }

  async function resolveReaderSource() {
    if (!readerContext.readerId || readerContext.sourceUrl) {
      await prepareLocalDirectSource();
      return;
    }
    readerContext.setReaderStage("resolve");
    let resolved = readerContext.cachedReaderData;
    // LOCAL EXPERIMENT ONLY. Session handoffs can retain one of the three
    // oversized manifests even after a route switches. Do not guess a new URL
    // from the old record or fall back to stale metadata on lookup failure.
    const localOldSources = [readerContext.cachedReaderData, readerContext.localReaderData]
      .flatMap(data => [data?.url, data?.chapter_manifest])
      .map(url => typeof url === "string" ? readerContext.normalizeSourceUrl(url) : "")
      .filter(url => VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(url));
    if (localOldSources.length) {
      // The early inline resolver is not marked no-store. Do not consume a
      // potentially cached response, and abort it if this Reader owns it.
      const early = window.__VOICE_READER_RESOLVE__;
      if (early?.id === readerContext.readerId) {
        window.__VOICE_READER_RESOLVE__ = null;
        early.dispose();
      }
      if (!localOldSources.every(url => VoiceOfMLReaderStore.localSameLegacyChapter?.(url, localOldSources[0])))
        throw new Error("本地 CHM 测试：旧缓存来源冲突");
      const endpoint = `https://voiceofml-search.hf.space/api/reader-resolve?id=${encodeURIComponent(readerContext.readerId)}`;
      const response = await readerContext.readerRequestManager.requestBuffered(
        endpoint, readerContext.READER_PROXY_TIMEOUT_MS, VoiceOfMLReaderSecurity.LIMITS.manifestBytes,
        {cache: "no-store", credentials: "omit"});
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`本地 CHM 测试：解析失败 HTTP ${response.status}`);
      }
      const fresh = await response.json();
      readerContext.assertReaderActive();
      const source = readerContext.normalizeSourceUrl(typeof fresh?.url === "string" ? fresh.url : "");
      const manifest = readerContext.normalizeSourceUrl(typeof fresh?.chapter_manifest === "string" ? fresh.chapter_manifest : "");
      const candidateOld = VoiceOfMLReaderStore.localLegacyChapterUrl?.(source) || "";
      const manifestOld = manifest ? VoiceOfMLReaderStore.localLegacyChapterUrl?.(manifest) || "" : candidateOld;
      if (String(fresh?.extension || "").toLowerCase() !== "epub-chapters" ||
          String(fresh?.original_extension || "").toLowerCase().replace(/^\./, "") !== "chm" ||
          !VoiceOfMLReaderStore.localSameLegacyChapter?.(localOldSources[0], candidateOld) ||
          !VoiceOfMLReaderStore.localSameLegacyChapter?.(localOldSources[0], manifestOld))
        throw new Error("本地 CHM 测试：解析结果与旧缓存不匹配");
      // A shared manifest is not a unique book identity. This registry is an
      // intentionally local test fixture, not an authority for production.
      const reviewed = localReviewedBooks.get(readerContext.readerId);
      const reviewedPath = reviewed?.[0];
      if (!reviewedPath || !VoiceOfMLReaderStore.localSameLegacyChapter?.(localOldSources[0],
          `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(reviewedPath)}`))
        throw new Error("本地 CHM 测试：书目身份不匹配");
      await verifyLocalReviewedBook(readerContext.readerId, source, manifest, fresh?.download);
      resolved = fresh;
    } else if (!resolved?.url) {
      try {
        resolved = await readerContext.resolveReaderId(readerContext.readerId);
      } catch (error) {
        readerContext.assertReaderActive();
        if (!readerContext.localReaderData?.url) throw error;
        resolved = readerContext.localReaderData;
      }
    }
    readerContext.assertReaderActive();
    await verifyLocalReviewedBook(readerContext.readerId, resolved.url, resolved.chapter_manifest, resolved.download);
    readerContext.assertReaderActive();
    if (String(resolved.original_extension || '').toLowerCase().replace(/^\./,'') === 'djvu' &&
        String(resolved.extension || '').toLowerCase() === 'pdf-pages') {
      // Links saved before the direct reader may still resolve to an old page
      // stream. Use their original download URL, never the legacy page images.
      if (!readerContext.validSource(resolved.download) || !/\.djvu$/i.test(new URL(resolved.download).pathname))
        throw new Error('DJVU_ORIGINAL_SOURCE_REQUIRED');
      resolved = {...resolved,url:resolved.download,extension:'djvu'};
    }
    readerContext.sourceUrl = readerContext.normalizeSourceUrl(resolved.url || "");
    readerContext.contentUrl = readerContext.readerContentUrl(readerContext.sourceUrl);
    readerContext.downloadUrl = resolved.download || readerContext.sourceUrl;
    readerContext.chapterManifestUrl = resolved.chapter_manifest || "";
    if (resolved.extension) readerContext.extension = String(resolved.extension).toLowerCase();
    if (
      readerContext.extension === "pdf" &&
      readerContext.sourceUrl.includes("/api/reader-bucket-resource?") &&
      new URL(readerContext.sourceUrl).searchParams.get("path")?.endsWith("page-manifest.json")
    )
      readerContext.extension = "pdf-pages";
    readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
    if (readerContext.capability.mode !== "pdf" && !readerContext.pdfPrimarySource()) readerContext.releasePdfWorker?.();
    readerContext.readerRuntime.update("source", {
      url: readerContext.sourceUrl,
      contentUrl: readerContext.contentUrl,
      downloadUrl: readerContext.downloadUrl,
      extension: readerContext.extension,
      metadata: resolved
    });
    readerContext.applyReaderMetadata(resolved);
  }

  async function start() {
    const generation = readerContext.readerRuntime.currentGeneration("navigation");
    // Resolve the original source and import its known engine concurrently.
    if (readerContext.extension === "pdf" || /\.pdf(?:$|[?#])/i.test(readerContext.sourceUrl)) readerContext.preloadPdfEngine().catch(() => {});
    readerContext.readerSourcePromise = readerContext.measurePdf(readerContext.resolveReaderSource(), "resolve");
    await readerContext.readerSourcePromise;
    readerContext.assertReaderActive();
    if (readerContext.readerId && /\/calibre-chm-epub-[^/]+\/document\.epub(?:$|\?)/i.test(readerContext.sourceUrl)) {
      readerContext.extension = "epub";
      readerContext.readerRuntime.update("source", { extension: readerContext.extension });
      readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
      readerContext.content.dataset.mode = readerContext.capability.mode;
      /** @type {HTMLElement} */ (document.querySelector(".page-controls")).hidden = true;
    }
    readerContext.syncCapabilityControls();
    readerContext.downloadButton.href = readerContext.readerDownloadUrl(readerContext.documentState.title, readerContext.downloadUrl);
    if (
      (!readerContext.validSource(readerContext.sourceUrl) && !readerContext.validSource(readerContext.chapterManifestUrl) && !readerContext.readerId) ||
      readerContext.capability.readerMode === VoiceOfMLReader.ReaderMode.UNSUPPORTED
    )
      return readerContext.fail("此文件暂不支持在线阅读，请下载原文件。", "READER_UNSUPPORTED");
    readerContext.formatAdapters.activate(readerContext.capability.mode);
    readerContext.applyReaderMetadata(readerContext.resolvedReaderData);
    try {
      if (readerContext.capability.mode === "foliate") {
        readerContext.setReaderStage("foliate");
        readerContext.foliateContinuous = true;
        const restorationPromise = readerContext.loadReaderRestoration();
        readerContext.readerRestorationPromise = restorationPromise;
        await readerContext.awaitReader(readerContext.renderFoliate());
        readerContext.assertReaderActive();
        const restored = await readerContext.awaitReader(restorationPromise);
        await readerContext.applyInitialRestoration(restored, generation);
        readerContext.initialReaderTargetSection = null;
        readerContext.assertReaderActive();
        if (!readerContext.setReaderPhase("ready")) return;
        readerContext.updateDocumentState({ restorationReady: !readerContext.restorationFailed });
        readerContext.scheduleSave();
        return;
      }
      readerContext.setReaderStage("prepare");
      const restorationPromise = readerContext.loadReaderRestoration();
      readerContext.readerRestorationPromise = restorationPromise;
      const prepareResources = new Set(readerContext.readerResources);
      try {
        const prepared = await readerContext.awaitReader(readerContext.formatAdapters.active.open());
        readerContext.assertReaderActive();
        await readerContext.formatAdapters.active.render(prepared);
      } catch (error) {
        readerContext.assertReaderActive();
        const originalExtension = String(readerContext.resolvedReaderData?.original_extension || "").toLowerCase();
        if (readerContext.capability.mode !== "image-pages" || !readerContext.validSource(readerContext.downloadUrl) ||
            !["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(originalExtension)) throw error;
        for (const cleanup of [...readerContext.readerResources]) {
          if (prepareResources.has(cleanup)) continue;
          cleanup();
          readerContext.readerResources.delete(cleanup);
        }
        readerContext.formatAdapters.dispose();
        readerContext.content.replaceChildren();
        readerContext.extension = originalExtension;
        readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
        readerContext.readerRuntime.update("source", { extension: readerContext.extension });
        readerContext.updateDocumentState({ page: 1, pageCount: 0 });
        readerContext.formatAdapters.activate(readerContext.capability.mode);
        readerContext.syncCapabilityControls();
        await readerContext.renderImageDocument(await readerContext.loadImageDocument(readerContext.downloadUrl));
      }
      readerContext.assertReaderActive();
      readerContext.markReaderContentReady();
      const restored = await readerContext.awaitReader(restorationPromise);
      await readerContext.applyInitialRestoration(restored, generation);
      readerContext.assertReaderActive();
      // A Markdown cross-document link may request a specific anchor. It takes
      // precedence over saved progress, unless the user navigated during load.
      if (readerContext.capability.mode === "markdown" && location.hash &&
          readerContext.isReaderGenerationCurrent("navigation", generation)) {
        try {
          const id = decodeURIComponent(location.hash.slice(1));
          const article = readerContext.content.querySelector(".reader-markdown");
          const target = [...(article?.querySelectorAll("[id], [name]") || [])]
            .find(element => element.id === id || element.getAttribute("name") === id);
          target?.scrollIntoView({ block: "start" });
        } catch (_) {}
      }
      if (!readerContext.setReaderPhase("ready")) return;
      readerContext.updateDocumentState({ restorationReady: !readerContext.restorationFailed });
      readerContext.schedulePdfBookSearchPrefetch();
      readerContext.updateProgressTools();
      if (readerContext.fullSearchInput.value.trim()) readerContext.runFullSearch();
      readerContext.scheduleSave();
    } catch (error) {
      if (readerContext.readerAbortController.signal.aborted || error?.name === "AbortError") return;
      console.error(error);
      readerContext.fail(
        error?.code === "READER_PDF_RATE_LIMIT" ? "请求过于频繁，请稍后重试加载。" :
          error && error.message ? error.message : "原文件加载失败",
        readerContext.classifyReaderError(error, readerContext.capability.mode === "foliate" ? "READER_CORRUPT" : "READER_PARSE")
      );
    }
  }

  function syncCapabilityControls() {
    readerContext.content.dataset.mode = readerContext.capability.mode || "unsupported";
    readerContext.pageInvertToggle.hidden = !["pdf", "pdf-pages"].includes(readerContext.capability.mode);
    /** @type {HTMLElement} */ (document.querySelector(".page-controls")).hidden = !readerContext.capability.features.pagination;
    /** @type {HTMLElement} */ (document.querySelector(".zoom-controls")).hidden = !readerContext.capability.features.zoom;
    readerContext.mediaTab.hidden = !readerContext.capability.features.media;
    const noNativeText = !!readerContext.pdfDocument?.readerNoSearchableText && !readerContext.ocrManifestUrl;
    const searchOpen = readerContext.panelState.selected === "full-search";
    if (noNativeText && !searchOpen && document.activeElement === readerContext.fullSearchButton)
      /** @type {HTMLElement} */ (document.querySelector("#history")).focus({ preventScroll: true });
    readerContext.fullSearchButton.hidden = !readerContext.capability.features.search || (noNativeText && !searchOpen);
    readerContext.bookmarkRibbon.hidden = !readerContext.capability.features.bookmarks;
    readerContext.readingProgressSummary.querySelector(".reader-progress-bookmark").hidden =
      !readerContext.capability.features.bookmarks;
    if (readerContext.panelState.selected === "full-search" && readerContext.fullSearchButton.hidden)
      readerContext.closeFullSearchView();
    if (
      (readerContext.panelState.selected === "media" && readerContext.mediaTab.hidden) ||
      (readerContext.panelState.selected === "full-search" && readerContext.fullSearchButton.hidden)
    )
      readerContext.selectPanel("toc");
  }

  return {
    disposeFormatResources,
    registerReaderFormatAdapters,
    resolveReaderSource,
    start,
    syncCapabilityControls
  };
}
