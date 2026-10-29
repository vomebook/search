export function createReaderPdfTextRuntime(readerContext) {
  function pdfOcrSource() {
    return VoiceOfMLReader.pdfPageSource(readerContext.ocrManifestUrl, location.href,
      "https://voiceofml-search.hf.space", "ocr-manifest.json");
  }

  function v3ResourceUrl(ref) {
    if (ref?.kind === 'dataset-source') return readerContext.datasetPrimaryUrl(ref);
    readerContext.validateResource(ref);
    return new URL(readerContext.readerDownloadApiUrl(`/api/reader-bucket-resource?path=${encodeURIComponent(ref.path)}`), location.href).href;
  }

  function createPdfV3Repository(sourceSha, pageCount) {
    return readerContext.createV3Repository({ sourceSha, pageCount, signal: readerContext.readerAbortController.signal,
      resourceUrl: readerContext.v3ResourceUrl,
        readJson: (url, ref) => readerContext.readPdfOcrJson(url,
          VoiceOfMLReaderSecurity.LIMITS.chapterBytes, ref.sha256, ref.bytes),
       readBytes: async (url, ref, signal) => {
         const response = await readerContext.fetchReaderUrl(url, signal ? { signal } : {});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const packed = await VoiceOfMLReaderSecurity.readBytes(response, VoiceOfMLReaderSecurity.LIMITS.chapterBytes);
        const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", packed))]
          .map(value => value.toString(16).padStart(2, "0")).join("");
        if (packed.byteLength !== ref.bytes || actual !== ref.sha256) throw new Error("PDF_V3_HASH_MISMATCH");
        return packed;
      }
    });
  }

  async function readPdfOcrJson(url, limit = VoiceOfMLReaderSecurity.LIMITS.chapterBytes, digest = "", size = 0, priority = "auto") {
    const response = await readerContext.fetchReaderUrl(url, { priority });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let bytes = await VoiceOfMLReaderSecurity.readBytes(response, limit);
    if (size && bytes.byteLength !== size) throw new Error("PDF_OCR_SIZE_MISMATCH");
    if (digest) {
      const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0")).join("");
      if (actual !== digest) throw new Error("PDF_OCR_HASH_MISMATCH");
    }
    const parsed = new URL(url, location.href);
    if (/\.gz$/i.test(parsed.searchParams.get("path") || parsed.pathname)) {
      if (typeof DecompressionStream !== "function") throw new Error("PDF_OCR_GZIP_UNSUPPORTED");
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = await VoiceOfMLReaderSecurity.readBytes(new Response(stream), limit);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function loadPdfOcrManifest() {
    if (readerContext.pdfOcrManifest) return readerContext.pdfOcrManifest;
    if (!readerContext.ocrManifestUrl) return null;
    if (!readerContext.pdfOcrManifestPromise) {
      if (!readerContext.pdfOcrSource()) throw new Error("PDF_OCR_SOURCE_INVALID");
      readerContext.pdfOcrManifestPromise = readerContext.readPdfOcrJson(readerContext.ocrManifestUrl, VoiceOfMLReaderSecurity.LIMITS.manifestBytes, "", 0, "high").then((manifest) => {
        readerContext.assertReaderActive();
        if (manifest.page_count !== readerContext.documentState.pageCount) throw new Error("PDF_OCR_PAGE_COUNT_MISMATCH");
        readerContext.pdfOcrManifest = VoiceOfMLReaderSecurity.validatePdfOcrManifest(manifest);
        return readerContext.pdfOcrManifest;
      });
    }
    try { return await readerContext.pdfOcrManifestPromise; }
    catch (error) { readerContext.pdfOcrManifestPromise = null; throw error; }
  }

  function loadPdfOcrPage(page, priority = "high") {
    const cached = readerContext.cachedPdfOcrPage(page);
    if (cached) return Promise.resolve(cached);
    const pending = readerContext.pdfOcrPagePromises.get(page);
    if (pending) return pending;
    const task = Promise.resolve().then(() => {
      // OCR is published as its own manifest. The image page manifest may be
      // intentionally lean and contain only page_count.
      return readerContext.loadPdfOcrManifest().then((manifest) => {
        if (manifest?.text_layer) {
          readerContext.pdfTextLayerRepository ||= readerContext.createPdfV3Repository(manifest.source_sha256, manifest.page_count);
            return readerContext.pdfTextLayerRepository.textPage(manifest.text_layer, page).then(payload => {
            if (readerContext.pdfV3Map) {
              const geometry = readerContext.pdfV3Map.pages[page - 1];
              if (Math.abs((payload.geometry.width / payload.geometry.height) / (geometry.width / geometry.height) - 1) > .01)
                throw new Error("PDF_V3_TEXT_GEOMETRY_MISMATCH");
            }
            readerContext.assertReaderActive(); readerContext.cachePdfOcrPage(page, payload); return payload;
          });
        }
        const entry = manifest?.pages?.[page - 1];
        if (!entry || entry.p !== page) throw new Error("PDF_OCR_PAGE_MISSING");
        return readerContext.readPdfOcrJson(readerContext.pdfOcrSource().assetUrl(entry.o),
          VoiceOfMLReaderSecurity.LIMITS.chapterBytes, entry.os, entry.ob, priority).then((payload) => {
            VoiceOfMLReaderSecurity.validatePdfOcrPage(payload, page);
            readerContext.cachePdfOcrPage(page, payload);
            return payload;
          });
      });
    }).finally(() => readerContext.pdfOcrPagePromises.delete(page));
    readerContext.pdfOcrPagePromises.set(page, task);
    return task;
  }

  function estimatePdfTextContentBytes(content) {
    let bytes = 0;
    for (const item of content?.items || [])
      bytes += String(item.str || "").length * 2 + (item.transform?.length || 0) * 8 + 64;
    for (const style of Object.values(content?.styles || {}))
      bytes += Object.entries(style || {}).reduce(
        (total, [key, value]) => total + key.length + String(value).length * 2 + 16, 0
      );
    return Math.max(128, bytes);
  }

  function cachePdfTextContent(page, content) {
    const bytes = readerContext.estimatePdfTextContentBytes(content);
    if (bytes > readerContext.PDF_TEXT_CONTENT_CACHE_BYTES) return;
    const previous = readerContext.pdfTextContentCache.get(page);
    if (previous) readerContext.pdfTextContentCacheBytes -= previous.bytes;
    readerContext.pdfTextContentCache.delete(page);
    readerContext.pdfTextContentCache.set(page, { content, bytes });
    readerContext.pdfTextContentCacheBytes += bytes;
    while (readerContext.pdfTextContentCacheBytes > readerContext.PDF_TEXT_CONTENT_CACHE_BYTES) {
      const oldest = readerContext.pdfTextContentCache.keys().next().value;
      const removed = readerContext.pdfTextContentCache.get(oldest);
      readerContext.pdfTextContentCacheBytes -= removed.bytes;
      readerContext.pdfTextContentCache.delete(oldest);
    }
  }

  function cachedPdfTextContent(page) {
    const record = readerContext.pdfTextContentCache.get(page);
    if (!record) return null;
    readerContext.pdfTextContentCache.delete(page);
    readerContext.pdfTextContentCache.set(page, record);
    return record.content;
  }

  function loadPdfTextContent(page, pdfPage, generation = null) {
    readerContext.assertReaderActive();
    const cached = readerContext.cachedPdfTextContent(page);
    if (cached) return Promise.resolve(cached);
    const pending = readerContext.pdfTextContentPromises.get(page);
    if (pending) {
      if (generation === null) pending.request.demanded = true;
      else pending.request.generation = generation;
      readerContext.drainPdfTextWaiters();
      return pending;
    }
    // Rendering and search share extraction, but retain their own cancellation
    // and result ownership. Only active work lives here, not another text cache.
    const request = { demanded: generation === null, generation, page };
    const task = Promise.resolve().then(async () => {
      const background = await readerContext.acquirePdfTextSlot(request.demanded, request);
      try {
        readerContext.assertReaderActive();
        if (!request.demanded && !readerContext.isReaderGenerationCurrent("search", request.generation)) throw readerContext.readerAbortError();
        const text = await readerContext.awaitReader(pdfPage.getTextContent());
        readerContext.cachePdfTextContent(page, text);
        return text;
      } finally {
        readerContext.releasePdfTextSlot(background);
      }
    })
      .finally(() => {
        if (readerContext.pdfTextContentPromises.get(page) === task) readerContext.pdfTextContentPromises.delete(page);
      });
    task.request = request;
    readerContext.pdfTextContentPromises.set(page, task);
    return task;
  }

  function estimatePdfOcrPageBytes(payload) {
    if (payload?.kind === "pdf-text-layer") return Math.max(128, JSON.stringify(payload).length * 2);
    return Math.max(128, (payload?.blocks || []).reduce(
      (total, block) => total + String(block?.t || "").length * 2 + 48, 0
    ));
  }

  function cachePdfOcrPage(page, payload) {
    const bytes = readerContext.estimatePdfOcrPageBytes(payload);
    if (bytes > readerContext.PDF_OCR_PAGE_CACHE_BYTES) return;
    const previous = readerContext.pdfOcrPageCache.get(page);
    if (previous) readerContext.pdfOcrPageCacheBytes -= previous.bytes;
    readerContext.pdfOcrPageCache.delete(page);
    readerContext.pdfOcrPageCache.set(page, { payload, bytes });
    readerContext.pdfOcrPageCacheBytes += bytes;
    while (readerContext.pdfOcrPageCacheBytes > readerContext.PDF_OCR_PAGE_CACHE_BYTES) {
      const oldest = readerContext.pdfOcrPageCache.keys().next().value;
      const removed = readerContext.pdfOcrPageCache.get(oldest);
      readerContext.pdfOcrPageCacheBytes -= removed.bytes;
      readerContext.pdfOcrPageCache.delete(oldest);
    }
  }

  function cachedPdfOcrPage(page) {
    const record = readerContext.pdfOcrPageCache.get(page);
    if (!record) return null;
    readerContext.pdfOcrPageCache.delete(page);
    readerContext.pdfOcrPageCache.set(page, record);
    return record.payload;
  }

  async function renderPdfOcrText(shell) {
    if (shell.dataset.textReady === "1" || !readerContext.ocrManifestUrl) return;
    if (shell._ocrPromise) return shell._ocrPromise;
    const layer = shell.querySelector(".reader-pdf-text");
    if (!layer) return;
    const epoch = shell._textEpoch || 0;
    const task = (async () => {
      try {
         const page = Number(shell.dataset.page);
         await readerContext.acquirePdfTextSlot(readerContext.isPdfPageVisible(shell));
        try {
          if (epoch !== (shell._textEpoch || 0)) return;
          const payload = await readerContext.loadPdfOcrPage(page, readerContext.isPdfPageVisible(shell) ? "high" : "low");
          readerContext.assertReaderActive();
          if (epoch !== (shell._textEpoch || 0)) return;
          if (payload.kind === "pdf-text-layer") {
            readerContext.populateIndependentTextLayer(layer, payload);
            shell._bookmarkTextItems = payload.regions.map(region => ({ text: region.text, y: region.box[1] }));
          } else {
            VoiceOfMLReaderSecurity.validatePdfOcrPage(payload, page);
            readerContext.populateOcrTextLayer(layer, payload.blocks, payload.layout);
            shell._bookmarkTextItems = payload.blocks.map((block) => ({ text: block.t, y: block.b?.[1] || 0 }));
          }
          shell.dataset.textReady = "1";
          readerContext.highlightPdfText(shell);
        } finally {
          readerContext.releasePdfTextSlot();
        }
      } catch (error) {
        if (!readerContext.readerAbortController.signal.aborted)
          console.warn(`PDF page ${shell.dataset.page} OCR text failed`, error);
      }
    })().finally(() => { if (shell._ocrPromise === task) delete shell._ocrPromise; });
    shell._ocrPromise = task;
    return task;
  }

  async function renderPdfText(page, shell, signal = null) {
    if (readerContext.ocrManifestUrl) return readerContext.renderPdfOcrText(shell);
    if (shell.dataset.textReady === "1") return;
    const layer = shell.querySelector(".reader-pdf-text");
    if (!layer || typeof page.getTextContent !== "function") return;
    const epoch = shell._textEpoch || 0;
    try {
      const pageNumber = Number(shell.dataset.page);
      const text = await readerContext.loadPdfTextContent(pageNumber, page);
      readerContext.assertReaderActive();
      if (signal?.aborted) return;
      readerContext.cachePdfTextContent(pageNumber, text);
      if (epoch !== (shell._textEpoch || 0) || !shell.isConnected) return;
      const pdfViewport = page.getViewport({ scale: 1 });
      if (Array.isArray(text.readerTextZones)) {
        const raw = readerContext.pdfTextContent(text.items);
        const regions = text.readerTextZones.filter(zone => zone.end > zone.start &&
          zone.box[0] < zone.box[2] && zone.box[1] < zone.box[3]).map(zone => ({
            text:zone.text, start:zone.start, end:zone.end, box:zone.box,
            quad:[[zone.box[0],zone.box[1]],[zone.box[2],zone.box[1]],
              [zone.box[2],zone.box[3]],[zone.box[0],zone.box[3]]], writing_mode:'horizontal-tb'
          }));
        readerContext.populateIndependentTextLayer(layer,{text:raw,regions});
        shell._bookmarkTextItems=regions.map(region=>({text:region.text,y:region.box[1]}));
        shell.dataset.textReady="1";
        readerContext.highlightPdfText(shell);
        return;
      }
      shell._bookmarkTextItems = text.items
        .filter((item) => item.str && item.str.trim())
        .map((item) => {
          const point =
            item.transform && pdfViewport.convertToViewportPoint
              ? pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5])
              : null;
          return {
            text: item.str,
            y: point ? Math.max(0, Math.min(1, point[1] / Math.max(1, pdfViewport.height))) : 0
          };
        });
      readerContext.populatePdfTextLayer(layer, text.items, pdfViewport, text.styles);
      shell.dataset.textReady = "1";
      readerContext.highlightPdfText(shell);
    } catch (error) {
      if (!readerContext.readerAbortController.signal.aborted && !signal?.aborted)
        console.warn(`PDF page ${shell.dataset.page} text extraction failed`, error);
    }
  }

  function highlightPdfText(shell, query = readerContext.searchState.query) {
    if (!shell || readerContext.readerAbortController.signal.aborted || !query) return;
    const layer = shell.querySelector(".reader-pdf-text");
    if (!layer || layer.querySelector("mark")) return;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), runs = [];
    let raw = "";
    while (walker.nextNode()) {
      const node = walker.currentNode, start = raw.length;
      raw += node.data;
      runs.push({ node, start, end: raw.length });
    }
    const mapping = readerContext.pdfSearchText(raw);
    const hits = [];
    for (const hit of mapping.text.matchAll(new RegExp(readerContext.fullSearchEscape(readerContext.normalizePdfSearchText(query)), "giu"))) {
      hits.push(hit);
      if (hits.length === 100) break;
    }
    for (const hit of hits.reverse()) {
      const start = readerContext.pdfSourceOffset(mapping, hit.index), end = readerContext.pdfSourceOffset(mapping, hit.index + hit[0].length - 1) + 1;
      readerContext.highlightTextParts(runs.filter((run) => run.end > start && run.start < end).map((run) => ({
        node: run.node, start: Math.max(start, run.start) - run.start, end: Math.min(end, run.end) - run.start
      })));
    }
  }

  return {
    pdfOcrSource,
    v3ResourceUrl,
    createPdfV3Repository,
    readPdfOcrJson,
    loadPdfOcrManifest,
    loadPdfOcrPage,
    estimatePdfTextContentBytes,
    cachePdfTextContent,
    cachedPdfTextContent,
    loadPdfTextContent,
    estimatePdfOcrPageBytes,
    cachePdfOcrPage,
    cachedPdfOcrPage,
    renderPdfOcrText,
    renderPdfText,
    highlightPdfText
  };
}
