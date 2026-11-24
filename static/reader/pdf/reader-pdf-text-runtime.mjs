/** @template T @param {Map<number, T>} cache @param {number} page */
function touchPageCache(cache, page) {
  const record = cache.get(page);
  if (record !== undefined) {
    cache.delete(page);
    cache.set(page, record);
  }
  return record;
}

/** @template {{bytes: number}} T @param {Map<number, T>} cache @param {number} page
 * @param {T} record @param {number} total @param {number} limit */
function storePageCache(cache, page, record, total, limit) {
  // An oversized result must not evict valid cached pages, including its own.
  if (record.bytes > limit) return total;
  total += record.bytes - (cache.get(page)?.bytes ?? 0);
  cache.delete(page);
  cache.set(page, record);
  if (total > limit) {
    for (const [oldest, entry] of cache) {
      total -= entry.bytes;
      cache.delete(oldest);
      if (total <= limit) break;
    }
  }
  return total;
}

/** @param {import('../../../typings/reader-pdf-text-runtime-strict').Context} readerContext */
export function createReaderPdfTextRuntime(readerContext) {
  // Remounts and visibility changes must not spin on a failed OCR object.
  // Keep the existing retry after zoom, but bound retries per page even then.
  /** @type {Map<number, {zoom: number, attempts: number}>} */
  const failedOcrPages = new Map();
  /** @param {number} page */
  function automaticOcrBlocked(page) {
    const failed = failedOcrPages.get(page);
    return !!failed && (failed.attempts >= 3 || failed.zoom === readerContext.documentState.zoom);
  }
  /** @returns {import('../../../typings/reader-pdf-text-runtime-strict').OcrSource | null} */
  function pdfOcrSource() {
    return /** @type {import('../../../typings/reader-pdf-text-runtime-strict').OcrSource | null} */ (VoiceOfMLReader.pdfPageSource(readerContext.ocrManifestUrl, location.href, "https://voiceofml-search.hf.space", "ocr-manifest.json"));
  }

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').V3Resource} ref */
  function v3ResourceUrl(ref) {
    if (ref?.kind === 'dataset-source') return readerContext.datasetPrimaryUrl(/** @type {import('../../../typings/reader-v3-strict').DatasetPrimary} */ (ref));
    readerContext.validateResource(/** @type {import('../../../typings/reader-v3-strict').Resource} */ (ref));
    return new URL(readerContext.readerDownloadApiUrl(`/api/reader-bucket-resource?path=${encodeURIComponent(ref.path)}`), location.href).href;
  }

  /** @param {string} sourceSha @param {number} pageCount */
  function createPdfV3Repository(sourceSha, pageCount) {
    return readerContext.createV3Repository({ sourceSha, pageCount, signal: readerContext.readerAbortController.signal,
      resourceUrl: readerContext.v3ResourceUrl,
      readJson: (url, ref) => readerContext.readPdfOcrJson(url,
        VoiceOfMLReaderSecurity.LIMITS.chapterBytes, ref.sha256, ref.bytes)
    });
  }

  /** @param {string} url @param {number} [limit] @param {string} [digest] @param {number} [size] @param {RequestPriority} [priority] @returns {Promise<unknown>} */
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
        const validated = VoiceOfMLReaderSecurity.validatePdfOcrManifest(manifest);
        if (validated.page_count !== readerContext.documentState.pageCount) throw new Error("PDF_OCR_PAGE_COUNT_MISMATCH");
        readerContext.pdfOcrManifest = validated;
        return validated;
      });
    }
    try { return await readerContext.pdfOcrManifestPromise; }
    catch (error) { readerContext.pdfOcrManifestPromise = null; throw error; }
  }

  /** @param {number} page @param {RequestPriority} [priority] @param {boolean} [retry] */
  function loadPdfOcrPage(page, priority = "high", retry = false) {
    const cached = readerContext.cachedPdfOcrPage(page);
    if (cached) return Promise.resolve(cached);
    const pending = readerContext.pdfOcrPagePromises.get(page);
    if (pending) return pending;
    if (!retry && automaticOcrBlocked(page)) return Promise.reject(new Error("PDF_OCR_PAGE_UNAVAILABLE"));
    const attemptZoom = readerContext.documentState.zoom;
    const task = Promise.resolve().then(() => {
      // OCR is published as its own manifest. The image page manifest may be
      // intentionally lean and contain only page_count.
      return readerContext.loadPdfOcrManifest().then(/** @returns {Promise<import('../../../typings/reader-pdf-text-runtime-strict').OcrPayload>} */ (manifest) => {
        if (manifest?.text_layer) {
          const ref = manifest.text_layer;
          if (typeof ref !== 'object' || !('path' in ref) || typeof ref.path !== 'string' ||
              !('bucket' in ref) || typeof ref.bucket !== 'string' || !('role' in ref) || typeof ref.role !== 'string' ||
              !('sha256' in ref) || typeof ref.sha256 !== 'string' || !('bytes' in ref) || typeof ref.bytes !== 'number')
            throw new Error("PDF_OCR_MANIFEST_INVALID");
          readerContext.pdfTextLayerRepository ||= readerContext.createPdfV3Repository(manifest.source_sha256, manifest.page_count);
          return readerContext.pdfTextLayerRepository.textPage(/** @type {import('../../../typings/reader-v3-strict').Resource} */ (ref), page).then(payload => {
            if (readerContext.pdfV3Map) {
              const geometry = readerContext.pdfV3Map.pages[page - 1];
              if (!geometry || Math.abs((payload.geometry.width / payload.geometry.height) / (geometry.width / geometry.height) - 1) > .01)
                throw new Error("PDF_V3_TEXT_GEOMETRY_MISMATCH");
            }
            readerContext.assertReaderActive(); readerContext.cachePdfOcrPage(page, payload); return payload;
          });
        }
        const entry = manifest?.pages?.[page - 1];
        if (!entry || entry.p !== page) throw new Error("PDF_OCR_PAGE_MISSING");
        // Legacy manifests may omit integrity metadata for book search, not page fetches.
        if (typeof entry.os !== 'string' || !/^[0-9a-f]{64}$/.test(entry.os) ||
            typeof entry.ob !== 'number' || !Number.isSafeInteger(entry.ob) || entry.ob < 1)
          throw new Error("PDF_OCR_MANIFEST_INVALID");
        return readerContext.readPdfOcrJson((/** @type {import('../../../typings/reader-pdf-text-runtime-strict').OcrSource} */ (readerContext.pdfOcrSource())).assetUrl(entry.o),
          VoiceOfMLReaderSecurity.LIMITS.chapterBytes, entry.os, entry.ob, priority).then((payload) => {
            VoiceOfMLReaderSecurity.validatePdfOcrPage(payload, page);
            const validated = /** @type {import('../../../typings/reader-pdf-text-runtime-strict').OcrPage} */ (payload);
            readerContext.cachePdfOcrPage(page, validated);
            return validated;
          });
      });
    }).then(payload => {
      failedOcrPages.delete(page);
      return payload;
    }, error => {
      if (!readerContext.readerAbortController.signal.aborted && error?.name !== "AbortError")
        failedOcrPages.set(page, {zoom: attemptZoom, attempts: (failedOcrPages.get(page)?.attempts ?? 0) + 1});
      throw error;
    }).finally(() => readerContext.pdfOcrPagePromises.delete(page));
    readerContext.pdfOcrPagePromises.set(page, task);
    return task;
  }

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').TextContent} content */
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

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').PdfDocument | null} pdf @param {number} page @param {import('../../../typings/reader-pdf-text-runtime-strict').TextContent} content */
  function recordNativePdfTextEvidence(pdf, page, content) {
    // Do not fetch extra pages to decide this: only successful, already
    // extracted pages count. A blank cover alone says nothing about the book.
    if (!pdf || readerContext.capability?.mode !== "pdf" || readerContext.ocrManifestUrl || pdf !== readerContext.pdfDocument ||
        pdf._pdfInfo?.readerPageCountPending || !Number.isInteger(pdf.numPages) ||
        !Number.isInteger(page) || page < 1 || page > pdf.numPages || !Array.isArray(content?.items)) return;
    let evidence = pdf.readerNativeTextEvidence;
    if (!evidence || evidence.count !== pdf.numPages)
      evidence = pdf.readerNativeTextEvidence = {count: pdf.numPages, pages: new Set(), hasText: false};
    if (content.items.some(item => typeof item?.str === "string" && !!item.str.trim())) {
      evidence.hasText = true;
      evidence.pages.clear();
      if (pdf.readerNoSearchableText) {
        pdf.readerNoSearchableText = false;
        readerContext.fullSearchController.resetAvailability();
        readerContext.syncCapabilityControls();
      }
      return;
    }
    if (evidence.hasText) return;
    evidence.pages.add(page);
    if (evidence.pages.size === evidence.count &&
        !readerContext.readerAbortController.signal.aborted && readerContext.pdfDocument === pdf && !readerContext.ocrManifestUrl) {
      pdf.readerNoSearchableText = true;
      readerContext.syncCapabilityControls();
    }
  }

  /** @param {number} page @param {import('../../../typings/reader-pdf-text-runtime-strict').TextContent} content */
  function cachePdfTextContent(page, content) {
    const cache = readerContext.pdfTextContentCache;
    // Render may re-touch the same read-only extraction result. Keep its LRU
    // refresh, but only reuse the accounting if that exact result is resident.
    if (cache.get(page)?.content === content) {
      touchPageCache(cache, page);
      return;
    }
    const bytes = readerContext.estimatePdfTextContentBytes(content);
    readerContext.pdfTextContentCacheBytes = storePageCache(cache, page, { content, bytes },
      readerContext.pdfTextContentCacheBytes, readerContext.PDF_TEXT_CONTENT_CACHE_BYTES);
  }

  /** @param {number} page */
  function cachedPdfTextContent(page) {
    return touchPageCache(readerContext.pdfTextContentCache, page)?.content ?? null;
  }

  /** @param {number} page @param {import('../../../typings/reader-pdf-text-runtime-strict').PdfPage} pdfPage @param {number | null} [generation] */
  function loadPdfTextContent(page, pdfPage, generation = null) {
    readerContext.assertReaderActive();
    const sourcePdf = readerContext.pdfDocument;
    const cached = readerContext.cachedPdfTextContent(page);
    if (cached) { recordNativePdfTextEvidence(sourcePdf, page, cached); return Promise.resolve(cached); }
    const pending = readerContext.pdfTextContentPromises.get(page);
    if (pending && !pending.request.controller?.signal.aborted) {
      if (generation === null) pending.request.demanded = true;
      else pending.request.generation = generation;
      readerContext.drainPdfTextWaiters();
      return pending;
    }
    // Rendering and search share extraction, but retain their own cancellation
    // and result ownership. Only active work lives here, not another text cache.
    const request = { demanded: generation === null, generation, page,
      controller: pdfPage.readerDjvuText === true ? new AbortController() : null };
    const task = Object.assign(Promise.resolve().then(async () => {
      const background = await readerContext.acquirePdfTextSlot(request.demanded, request);
      try {
        readerContext.assertReaderActive();
        if (!request.demanded && !readerContext.isReaderGenerationCurrent("search", request.generation)) throw readerContext.readerAbortError();
        const text = await readerContext.awaitReader(request.controller
          ? pdfPage.getTextContent({signal: request.controller.signal}) : pdfPage.getTextContent());
        request.controller?.signal.throwIfAborted();
        readerContext.cachePdfTextContent(page, text);
        recordNativePdfTextEvidence(sourcePdf, page, text);
        return text;
      } finally {
        readerContext.releasePdfTextSlot(background);
      }
    })
      .finally(() => {
        if (readerContext.pdfTextContentPromises.get(page) === task) readerContext.pdfTextContentPromises.delete(page);
      }), { request });
    readerContext.pdfTextContentPromises.set(page, task);
    return task;
  }

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').OcrPayload} payload */
  function estimatePdfOcrPageBytes(payload) {
    if (payload?.kind === "pdf-text-layer") return Math.max(128, JSON.stringify(payload).length * 2);
    return Math.max(128, (payload?.blocks || []).reduce(
      (total, block) => total + String(block?.t || "").length * 2 + 48, 0
    ));
  }

  /** @param {number} page @param {import('../../../typings/reader-pdf-text-runtime-strict').OcrPayload} payload */
  function cachePdfOcrPage(page, payload) {
    const bytes = readerContext.estimatePdfOcrPageBytes(payload);
    readerContext.pdfOcrPageCacheBytes = storePageCache(readerContext.pdfOcrPageCache, page, { payload, bytes },
      readerContext.pdfOcrPageCacheBytes, readerContext.PDF_OCR_PAGE_CACHE_BYTES);
  }

  /** @param {number} page */
  function cachedPdfOcrPage(page) {
    return touchPageCache(readerContext.pdfOcrPageCache, page)?.payload ?? null;
  }

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').Shell} shell */
  function hasOcrText(shell) {
    return shell.dataset.textReady === "1" && shell.dataset.nativeTextFallback !== "1";
  }

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').Shell} shell @param {import('../../../typings/reader-pdf-text-runtime-strict').OcrPayload} [loaded] */
  async function renderPdfOcrText(shell, loaded) {
    if (hasOcrText(shell) || !readerContext.ocrManifestUrl) return;
    if (shell._ocrPromise) {
      await shell._ocrPromise;
      if (loaded) return renderPdfOcrText(shell, loaded);
      return;
    }
    const layer = shell.querySelector(".reader-pdf-text"), page = Number(shell.dataset.page);
    if (!layer || (!loaded && automaticOcrBlocked(page))) return;
    const epoch = shell._textEpoch || 0;
    // Native search offsets belong to the embedded text, not the OCR layer.
    const keepNative = () => {
      const search = readerContext.fullSearchController?.state;
      return shell.dataset.nativeTextFallback === "1" &&
        (readerContext.pdfSelectionIntersects?.(shell) || (search?.nativePdfSearch && search.highlightsEnabled));
    };
    const task = (async () => {
      try {
        if (keepNative()) return;
        await readerContext.acquirePdfTextSlot(readerContext.isPdfPageVisible(shell));
        try {
          if (epoch !== (shell._textEpoch || 0)) return;
          const payload = loaded ?? await readerContext.loadPdfOcrPage(page, readerContext.isPdfPageVisible(shell) ? "high" : "low");
          readerContext.assertReaderActive();
          if (epoch !== (shell._textEpoch || 0)) return;
          if (keepNative()) return;
          // An empty external layer must not mask text embedded in the original.
          if (payload.kind === "pdf-text-layer" ? !payload.text?.trim() :
              !(payload.blocks || []).some(block => String(block?.t || "").trim())) return;
          if (payload.kind === "pdf-text-layer") {
            readerContext.populateIndependentTextLayer(layer, payload);
            shell._bookmarkTextItems = payload.regions.flatMap(region => {
              const y = region.box[1];
              return y === undefined ? [] : [{ text: region.text, y }];
            });
          } else {
            VoiceOfMLReaderSecurity.validatePdfOcrPage(payload, page);
            readerContext.populateOcrTextLayer(layer, payload.blocks, payload.layout);
            shell._bookmarkTextItems = payload.blocks.map((block) => ({ text: block.t, y: block.b?.[1] || 0 }));
          }
          shell.dataset.textReady = "1";
          delete shell.dataset.nativeTextFallback;
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

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').PdfPage} page @param {import('../../../typings/reader-pdf-text-runtime-strict').Shell} shell @param {AbortSignal | null} [signal]
   * @param {() => boolean} [ownsNativeResult] */
  async function renderPdfText(page, shell, signal = null, ownsNativeResult) {
    if (readerContext.ocrManifestUrl && !ownsNativeResult) {
      await readerContext.renderPdfOcrText(shell);
      // If a historical external text object disappeared or failed to load,
      // the source's own text remains usable without creating another copy.
      if (signal?.aborted || hasOcrText(shell)) return;
    }
    const canRenderNative = () => (!ownsNativeResult || ownsNativeResult()) &&
      (shell.dataset.textReady !== "1" || (ownsNativeResult && readerContext.ocrManifestUrl &&
        shell.dataset.nativeTextFallback !== "1" && !readerContext.pdfSelectionIntersects?.(shell)));
    if (!canRenderNative()) return;
    const layer = /** @type {HTMLElement | null} */ (shell.querySelector(".reader-pdf-text"));
    if (!layer || typeof page.getTextContent !== "function") return;
    const epoch = shell._textEpoch || 0;
    try {
      const pageNumber = Number(shell.dataset.page);
      const text = await readerContext.loadPdfTextContent(pageNumber, page);
      readerContext.assertReaderActive();
      if (signal?.aborted) return;
      if (readerContext.ocrManifestUrl && !text.items?.some(item => String(item.str || "").trim())) return;
      if (!canRenderNative()) return;
      readerContext.cachePdfTextContent(pageNumber, text);
      if (epoch !== (shell._textEpoch || 0) || !shell.isConnected) return;
      if (ownsNativeResult && shell.dataset.textReady === "1") delete layer.dataset.textGeneration;
      const pdfViewport = page.getViewport({ scale: 1 });
      if (Array.isArray(text.readerTextZones)) {
        const raw = readerContext.pdfTextContent(text.items);
        const regions = text.readerTextZones.flatMap(zone => {
          const [x, y, right, bottom] = zone.box;
          if (x === undefined || y === undefined || right === undefined || bottom === undefined ||
              !(zone.end > zone.start && x < right && y < bottom)) return [];
          return [{ text: zone.text, start: zone.start, end: zone.end, y,
            quad: [[x,y],[right,y],[right,bottom],[x,bottom]], writing_mode: 'horizontal-tb' }];
        });
        readerContext.populateIndependentTextLayer(layer,{text:raw,regions});
        shell._bookmarkTextItems=regions.map(region=>({text:region.text,y:region.y}));
        if (readerContext.ocrManifestUrl) shell.dataset.nativeTextFallback="1";
        shell.dataset.textReady="1";
        readerContext.highlightPdfText(shell);
        return;
      }
      shell._bookmarkTextItems = text.items
        .filter((item) => item.str && item.str.trim())
        .map((item) => {
          const tx = item.transform?.[4], ty = item.transform?.[5];
          const y = tx !== undefined && ty !== undefined ? pdfViewport.convertToViewportPoint?.(tx, ty)?.[1] : undefined;
          return {
            text: item.str,
            y: y === undefined ? 0 : Math.max(0, Math.min(1, y / Math.max(1, pdfViewport.height)))
          };
        });
      readerContext.populatePdfTextLayer(layer, text.items, pdfViewport, text.styles);
      if (readerContext.ocrManifestUrl) shell.dataset.nativeTextFallback = "1";
      shell.dataset.textReady = "1";
      readerContext.highlightPdfText(shell);
    } catch (error) {
      if (!readerContext.readerAbortController.signal.aborted && !signal?.aborted)
        console.warn(`PDF page ${shell.dataset.page} text extraction failed`, error);
    }
  }

  /** @param {import('../../../typings/reader-pdf-text-runtime-strict').Shell | null} shell @param {string} [query] @param {{start: number, value: string}} [selected] */
  function highlightPdfText(shell, query = readerContext.searchState.query, selected) {
    if (!shell || readerContext.readerAbortController.signal.aborted ||
        (!selected && (!query || readerContext.fullSearchController?.state?.highlightsEnabled === false ||
          (readerContext.fullSearchController?.state?.nativePdfSearch && readerContext.ocrManifestUrl &&
            shell.dataset.nativeTextFallback !== "1")))) return;
    const layer = shell.querySelector(".reader-pdf-text");
    if (!layer || layer.querySelector("mark.full-search-highlight")) return;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), runs = [];
    let raw = "";
    while (walker.nextNode()) {
      const node = /** @type {Text} */ (walker.currentNode), start = raw.length;
      raw += node.data;
      runs.push({ node, start, end: raw.length });
    }
    const mapping = readerContext.pdfSearchText(raw);
    const hits = [];
    if (selected) {
      if (mapping.text.slice(selected.start, selected.start + selected.value.length) !== selected.value) return;
      hits.push(selected);
    } else {
      const pattern = new RegExp(readerContext.fullSearchEscape(readerContext.normalizePdfSearchText(query)), "giu");
      for (const hit of mapping.text.matchAll(pattern)) {
        hits.push({ start: hit.index, value: hit[0] });
        if (hits.length === 100) break;
      }
    }
    let target;
    for (const hit of hits.reverse()) {
      const start = readerContext.pdfSourceOffset(mapping, hit.start), end = readerContext.pdfSourceOffset(mapping, hit.start + hit.value.length - 1) + 1;
      // Runs have monotonically increasing boundaries; seek to the first
      // possible overlap instead of filtering every text node for each hit.
      let low = 0, high = runs.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((runs[middle]?.end ?? Infinity) <= start) low = middle + 1;
        else high = middle;
      }
      const parts = [];
      for (let index = low; index < runs.length; index++) {
        const run = runs[index];
        if (!run || run.start >= end) break;
        if (run.end <= start) continue;
        parts.push({ node: run.node, start: Math.max(start, run.start) - run.start,
          end: Math.min(end, run.end) - run.start });
      }
      [target] = readerContext.highlightTextParts(parts);
    }
    return target;
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
