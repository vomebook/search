/// <reference path="../../../typings/reader-pdf-search-strict.d.ts" />

// One shared, bounded per-query checkpoint budget. Checkpoints are hints only:
// if extracted text is replaced or the budget fills, retain the complete scan.
const PDF_SEARCH_CHECKPOINT_STRIDE = 2048;
const PDF_SEARCH_CHECKPOINT_MAX = 4096;
const PDF_SEARCH_CHECKPOINT_PAGE_BYTES = 512 * 1024;
const PDF_SEARCH_CHECKPOINT_BYTES = 4 * 1024 * 1024;

/** @param {ReaderPdfSearch.Context} readerContext */
export function createReaderPdfSearch(readerContext) {
  /** @type {Promise<typeof import('../search/reader-pdf-hit-projection.mjs')> | undefined} */
  let hitProjection;
  let projectionRequest = 0;

  async function loadHitProjection() {
    const source = "/search/static/reader/search/reader-pdf-hit-projection.mjs";
    for (let attempt = 0; ; attempt++) {
      if (attempt) await readerContext.waitForReader(attempt * 500);
      readerContext.assertReaderActive();
      // This is a leaf: a fresh URL bypasses Chromium's rejected module entry
      // without leaving a failed static dependency (such as the validator).
      const request = projectionRequest++;
      const url = request ? `${source}?reader-module-retry=${request}` : source;
      try {
        return await readerContext.awaitReader(/** @type {Promise<typeof import('../search/reader-pdf-hit-projection.mjs')>} */ (import(url)));
      } catch (error) {
        if (attempt === 2 || !(error instanceof TypeError) ||
            !/failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(error.message)) throw error;
      }
    }
  }

  function getHitProjection() {
    // Keep successful modules and share in-flight work, but let another explicit
    // result click start a fresh, bounded batch after a transport failure.
    return hitProjection ||= loadHitProjection().catch(error => {
      hitProjection = undefined;
      throw error;
    });
  }

  /** @param {Element} shell @param {Element} mark */
  function scrollToHit(shell, mark) {
    // Keep the hit visible without leaving the previous page under the ribbon.
    const viewport = readerContext.viewport;
    const view = viewport.getBoundingClientRect();
    const ribbon = readerContext.bookmarkRibbon.getBoundingClientRect().bottom - view.top;
    const pageTop = readerContext.readerPageScrollTop(shell);
    const desired = pageTop + mark.getBoundingClientRect().top - shell.getBoundingClientRect().top - viewport.clientHeight / 2;
    viewport.scrollTop = Math.max(pageTop - Math.max(0, ribbon) + 1, desired);
  }

  /** @param {ReaderPdfSearch.Manifest} manifest */
  async function ensurePdfBookSearchClient(manifest) {
    let textUrl = "";
    let partitioned = null;
    if (manifest?.text_layer) {
      const ref = manifest.text_layer;
      if (typeof ref !== 'object' || !('path' in ref) || typeof ref.path !== 'string' ||
          !('bucket' in ref) || typeof ref.bucket !== 'string' || !('role' in ref) || typeof ref.role !== 'string' ||
          !('sha256' in ref) || typeof ref.sha256 !== 'string' || !('bytes' in ref) || typeof ref.bytes !== 'number')
        throw new Error("PDF_OCR_MANIFEST_INVALID");
      readerContext.pdfTextLayerRepository ||= readerContext.createPdfV3Repository(manifest.source_sha256, manifest.page_count);
      const index = await readerContext.pdfTextLayerRepository.textIndex(/** @type {ReaderPdfSearch.Resource} */ (ref));
      manifest = { ...manifest, book_text: index.book_text };
      textUrl = readerContext.v3ResourceUrl(index.book_text);
      if (index.search_partitions) partitioned = {generation: index.generation,
        partitions: index.search_partitions.map(part => ({start: part.start, end: part.end,
          url: readerContext.v3ResourceUrl(part.resource), bytes: part.resource.bytes, sha256: part.resource.sha256}))};
    }
    if (!manifest?.book_text?.path) throw new Error("本书集中全文尚未生成");
    if (!readerContext.pdfBookSearchModulePromise)
      readerContext.pdfBookSearchModulePromise = import("/search/static/reader/search/reader-pdf-book-search.mjs").catch(error => {
        readerContext.pdfBookSearchModulePromise = null;
        throw error;
    });
    const module = await readerContext.pdfBookSearchModulePromise;
    readerContext.assertReaderActive();
    if (readerContext.pdfBookSearchClient?.failed) {
      readerContext.pdfBookSearchClient.dispose();
      readerContext.pdfBookSearchClient = null;
    }
    if (!readerContext.pdfBookSearchClient) {
      let url = textUrl;
      if (!url) {
        const source = readerContext.pdfOcrSource();
        if (!source) throw new Error("PDF_OCR_SOURCE_INVALID");
        url = source.assetUrl(manifest.book_text.path);
      }
      readerContext.pdfBookSearchClient = module.createPdfBookSearch({
        url,
        sha256: manifest.book_text.sha256,
        bytes: manifest.book_text.bytes,
        pageCount: readerContext.documentState.pageCount,
        sourceSha: manifest.source_sha256,
        ...partitioned
      });
    }
    return readerContext.pdfBookSearchClient;
  }

  async function prefetchPdfBookSearch() {
    if (readerContext.readerAbortController.signal.aborted || readerContext.pdfBookSearchPrefetchPromise || !readerContext.ocrManifestUrl ||
        !["pdf", "pdf-pages"].includes(/** @type {string} */ (readerContext.capability.mode)) || navigator.connection?.saveData) return;
    const connection = navigator.connection;
    if (["slow-2g", "2g"].includes(/** @type {string} */ (connection?.effectiveType))) return;
    readerContext.pdfBookSearchPrefetchPromise = (async () => {
      const manifest = await readerContext.loadPdfOcrManifest();
      const bytes = Number(manifest?.book_text?.bytes);
      if (!manifest || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > readerContext.PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES) return;
      const client = await readerContext.ensurePdfBookSearchClient(manifest);
      await client.prefetch();
    })().catch(() => {});
  }

  function schedulePdfBookSearchPrefetch() {
    if (readerContext.pdfBookSearchPrefetchTimer || readerContext.pdfBookSearchPrefetchPromise || !readerContext.ocrManifestUrl ||
        !["pdf", "pdf-pages"].includes(/** @type {string} */ (readerContext.capability.mode)) || navigator.connection?.saveData) return;
    readerContext.pdfBookSearchPrefetchTimer = setTimeout(() => {
      readerContext.pdfBookSearchPrefetchTimer = 0;
      const idle = window.requestIdleCallback || ((callback) => setTimeout(callback, 0));
      idle(() => readerContext.prefetchPdfBookSearch(), { timeout: 1500 });
    }, readerContext.PDF_BOOK_SEARCH_PREFETCH_DELAY);
  }

  /** @param {string} query @param {number} generation */
  async function searchConcentratedPdf(query, generation) {
    const manifest = await readerContext.loadPdfOcrManifest();
    if (!manifest) throw new Error("本书集中全文尚未生成");
    const client = await readerContext.ensurePdfBookSearchClient(manifest);
    /** @type {(ReaderPdfSearch.Hit & ReaderPdfSearch.Result)[]} */
    let firstPageResults = [];
    /** @param {ReaderPdfSearch.Page<ReaderPdfSearch.Hit>} page */
    const attach = (page) => {
      const results = page.results.map((hit, position) => {
        const previous = page.offset === 0 ? firstPageResults[position] : null;
        if (previous?.page === hit.page && previous.start === hit.start && previous.length === hit.length)
          return previous;
        return { ...hit, location: `第 ${hit.page} 页`, activate: async (/** @type {number} */ nav) => {
          const search = readerContext.readerRuntime.currentGeneration("search");
          const current = () => readerContext.isReaderGenerationCurrent("navigation", nav) &&
            readerContext.isReaderGenerationCurrent("search", search);
          if (!await readerContext.goToPage(hit.page, nav) || !current()) return false;
          readerContext.clearFullSearchMarks();
          const shell = /** @type {HTMLElement | null} */ (readerContext.content.querySelector(`.reader-page[data-page="${hit.page}"]`));
          if (shell && (hit.boxes.length || hit.textGeneration)) {
            const { hitBoxes, paintTextHit } = await getHitProjection();
            if (!current() || !shell.isConnected) return false;
            let boxes = hit.boxes;
            if (hit.textGeneration || (readerContext.pdfV3Manifest && manifest.text_layer)) {
              let layer;
              try {
                layer = await readerContext.loadPdfOcrPage(hit.page, "high", true);
              } catch (error) {
                // Legacy book hits already have geometry. Keep that fallback
                // even if the optional OCR text object is unavailable.
                if (hit.textGeneration || !boxes.length) throw error;
              }
              if (!current() || !shell.isConnected) return false;
              if (hit.textGeneration) {
                if (layer?.kind !== "pdf-text-layer" || layer.generation !== hit.textGeneration)
                  throw new Error("PDF_V3_GENERATION_CHANGED");
                boxes = hitBoxes({text: layer.text, text_spans: layer.regions.map(region => ({
                  start: region.start, end: region.end, box: region.box,
                  precision: "mapping_precision" in region && typeof region.mapping_precision === "string"
                    ? region.mapping_precision : undefined
                }))}, hit.start, hit.length);
              }
              if (layer) await readerContext.renderPdfOcrText(shell, layer);
            } else if (readerContext.pdfV3Manifest) await readerContext.renderPdfOcrText(shell);
            // A virtual page can leave the DOM while the module or OCR loads.
            if (!current() || !shell.isConnected) return false;
            paintTextHit(shell, boxes, hit);
            const mark = shell.querySelector(".reader-text-hit-box");
            if (mark) scrollToHit(shell, mark);
          }
          return true;
        } };
      });
      if (page.offset === 0) firstPageResults = results;
      return { ...page, results };
    };
    readerContext.fullSearchSession.pageLoader = async offset => attach(await client.page(offset));
    const page = await client.search(query, partial => {
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return;
      const partialPage = attach(partial);
      readerContext.fullSearchSession.page = partialPage;
      readerContext.updateSearchState({ results: partialPage.results });
      readerContext.renderFullSearchResults();
      readerContext.fullSearchStatus.textContent = partial.total
        ? `${partial.total} 个结果（正在搜索… ${partial.scanned} / ${partial.pages} 页）`
        : `正在搜索正文… ${partial.scanned} / ${partial.pages} 页`;
    });
    if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
    const resultPage = attach(page);
    readerContext.fullSearchSession.page = resultPage;
    return resultPage.results;
  }

  /** @param {number} page @param {string} text @param {number} start @param {string} value @returns {ReaderPdfSearch.Result} */
  function nativeResult(page, text, start, value) {
    return {
      location: `第 ${page} 页`,
      snippet: readerContext.fullSearchSnippet(text, start, value.length),
      async activate(nav) {
        const search = readerContext.readerRuntime.currentGeneration("search");
        const current = () => readerContext.isReaderGenerationCurrent("navigation", nav) &&
          readerContext.isReaderGenerationCurrent("search", search);
        if (!await readerContext.goToPage(page, nav) || !current()) return false;
        const shell = /** @type {HTMLElement | null} */ (readerContext.content.querySelector(`.reader-page[data-page="${page}"]`));
        if (!shell?.isConnected) return false;
        if (shell.dataset.textReady !== "1") {
          const pdf = readerContext.pdfDocument;
          if (!pdf) return false;
          const pdfPage = await readerContext.awaitReader(pdf.getPage(page));
          if (!current() || !shell.isConnected || pdf !== readerContext.pdfDocument) return false;
          await readerContext.renderPdfText(pdfPage, shell);
        }
        if (!current() || !shell.isConnected) return false;
        readerContext.clearFullSearchMarks();
        const mark = readerContext.highlightPdfText(shell, undefined, { start, value });
        if (!mark) return false;
        scrollToHit(shell, mark);
        return true;
      }
    };
  }

  /** @param {ReaderPdfSearch.Group[]} groups @param {number} total @param {RegExp} pattern @param {ReaderPdfSearch.Result[]} firstPage */
  function makePdfSearchPageLoader(groups, total, pattern, firstPage) {
    const pdf = readerContext.pdfDocument;
    return async (/** @type {number} */ requestedOffset, generation = readerContext.readerRuntime.currentGeneration("search")) => {
      const pageSize = 50, results = [];
      const offset = readerContext.fullSearchPageOffset(total, requestedOffset, pageSize);
      if (!offset) return { total, offset, pageSize, results: firstPage.slice() };
      let skipped = 0;
      for (const group of groups) {
        if (skipped + group.count <= offset) {
          skipped += group.count;
          continue;
        }
        const text = await readerContext.loadPdfSearchText(/** @type {ReaderPdfSearch.PdfDocument} */ (pdf), group.page, generation);
        let examined = 0, start = 0, accelerated = false;
        if (group.checkpoints?.length && text === group.checkpointText) {
          const requestedInPage = offset - skipped;
          let low = 0, high = group.checkpoints.length;
          while (low < high) {
            const middle = (low + high) >> 1;
            if (/** @type {{ordinal: number, start: number}} */ (group.checkpoints[middle]).ordinal <= requestedInPage) low = middle + 1;
            else high = middle;
          }
          if (low) {
            const checkpoint = /** @type {{ordinal: number, start: number}} */ (group.checkpoints[low - 1]);
            skipped += checkpoint.ordinal;
            start = checkpoint.start;
            accelerated = true;
          }
        }
        // Preserve a cancellation opportunity for a deep jump, even when
        // checkpoints remove the previous long skip loop.
        if (accelerated) {
          await readerContext.waitForReader();
          if (!readerContext.isReaderGenerationCurrent("search", generation))
            throw new DOMException("Search cancelled", "AbortError");
        }
        for (const match of text.slice(start).matchAll(pattern)) {
          if (++examined % 2048 === 0) {
            await readerContext.waitForReader();
            if (!readerContext.isReaderGenerationCurrent("search", generation))
              throw new DOMException("Search cancelled", "AbortError");
          }
          if (skipped++ < offset) continue;
          results.push(nativeResult(group.page, text, start + match.index, match[0]));
          if (results.length === pageSize) break;
        }
        if (results.length === pageSize) break;
      }
      return { total, offset, pageSize, results };
    };
  }

  /** @param {number} generation @param {ReaderPdfSearch.Group[]} groups @param {number} total @param {RegExp} pattern @param {ReaderPdfSearch.Result[]} firstPage @param {number} scanned @param {number} pages */
  function publishPdfSearchProgress(generation, groups, total, pattern, firstPage, scanned, pages) {
    if (!readerContext.isReaderGenerationCurrent("search", generation)) return false;
    readerContext.fullSearchSession.pageLoader = readerContext.makePdfSearchPageLoader(groups, total, pattern, firstPage);
    readerContext.fullSearchSession.page = { total, offset: 0, pageSize: 50, results: firstPage.slice() };
    readerContext.updateSearchState({ results: firstPage.slice() });
    readerContext.renderFullSearchResults();
    readerContext.fullSearchStatus.textContent = total
      ? `${total} 个结果（正在搜索… ${scanned} / ${pages} 页）`
      : `正在搜索正文… ${scanned} / ${pages} 页，暂未找到匹配`;
    return true;
  }

  /** @param {ReaderPdfSearch.PdfDocument} pdf */
  async function getPdfPersistentTextStore(pdf) {
    const version = readerContext.pdfFetchPolicy?.identity;
    if (!version || readerContext.ocrManifestUrl || readerContext.readerAbortController.signal.aborted) return null;
    if (readerContext.pdfPersistentTextVersion !== version) {
      readerContext.pdfPersistentTextStore?.dispose();
      readerContext.pdfPersistentTextStore = null;
      readerContext.pdfPersistentTextVersion = version;
      /** @type {Promise<ReaderPdfSearch.Store | null> | undefined} */
      let pending;
      pending = (async () => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
        const module = await readerContext.awaitReader(Promise.race([import("/search/static/reader/pdf/reader-pdf-text-store.mjs"),
          new Promise(resolve => {timer=setTimeout(()=>resolve(null),1000);})])).finally(()=>clearTimeout(timer));
        if (!module) return null;
        const key = await module.pdfTextStoreKey({source:readerContext.sourceUrl,version,pageCount:pdf.numPages,
          engine:(/** @type {ReaderPdfSearch.ResourceGlobals} */ (/** @type {unknown} */ (globalThis))).VoiceOfMLReaderResources.vendors.pdf.sha256});
        if (!key || readerContext.readerAbortController.signal.aborted || readerContext.pdfFetchPolicy?.identity !== version || readerContext.pdfPersistentTextOpening !== pending) return null;
        return readerContext.pdfPersistentTextStore = module.createPdfTextStore(key,{signal:readerContext.readerAbortController.signal});
      })().catch(() => null);
      readerContext.pdfPersistentTextOpening = pending;
    }
    return readerContext.pdfPersistentTextStore || readerContext.pdfPersistentTextOpening;
  }

  /** @param {number} page @param {string} text */
  function cachePdfSearchText(page, text) {
    const bytes = text.length * 2;
    if (bytes > readerContext.PDF_SEARCH_TEXT_CACHE_BYTES) return;
    const previous = readerContext.pdfSearchTextCache.get(page);
    if (previous !== undefined) {
      readerContext.pdfSearchTextCacheBytes -= previous.length * 2;
      readerContext.pdfSearchTextCache.delete(page);
    }
    readerContext.pdfSearchTextCache.set(page, text);
    readerContext.pdfSearchTextCacheBytes += bytes;
    while (readerContext.pdfSearchTextCacheBytes > readerContext.PDF_SEARCH_TEXT_CACHE_BYTES) {
      const oldest = /** @type {number} */ (readerContext.pdfSearchTextCache.keys().next().value);
      readerContext.pdfSearchTextCacheBytes -= (/** @type {string} */ (readerContext.pdfSearchTextCache.get(oldest))).length * 2;
      readerContext.pdfSearchTextCache.delete(oldest);
    }
  }

  /** @param {ReaderPdfSearch.PdfDocument} pdf @param {number} page @param {number} generation */
  async function loadPdfSearchText(pdf, page, generation) {
    if (!readerContext.isReaderGenerationCurrent("search", generation))
      throw new DOMException("Search cancelled", "AbortError");
    let text = readerContext.pdfSearchTextCache.get(page);
    if (text !== undefined) {
      readerContext.pdfSearchTextCache.delete(page);
      readerContext.pdfSearchTextCache.set(page, text);
      return text;
    }
    const store = await readerContext.getPdfPersistentTextStore(pdf);
    const version = readerContext.pdfFetchPolicy?.identity;
    const stored = store ? await store.get(page).catch(() => null) : null;
    if (!readerContext.isReaderGenerationCurrent("search", generation)) throw readerContext.readerAbortError();
    if (stored !== null && version && version === readerContext.pdfFetchPolicy?.identity) {
      readerContext.cachePdfSearchText(page, stored);
      return stored;
    }
    const pdfPage = await readerContext.awaitReader(pdf.getPage(page));
    if (!readerContext.isReaderGenerationCurrent("search", generation))
      throw new DOMException("Search cancelled", "AbortError");
    const textContent = await readerContext.loadPdfTextContent(page, pdfPage, generation);
    if (!readerContext.isReaderGenerationCurrent("search", generation))
      throw new DOMException("Search cancelled", "AbortError");
    text = readerContext.normalizePdfSearchText(readerContext.pdfTextContent(textContent.items));
    readerContext.cachePdfSearchText(page, text);
    if (store && version && version === readerContext.pdfFetchPolicy?.identity) store.put(page,text).catch(() => {});
    return text;
  }

  /** @param {string} query @param {number} generation */
  async function fullSearchPdfMatches(query, generation) {
    /** @type {ReaderPdfSearch.Group[]} */ const groups = [];
    /** @type {ReaderPdfSearch.Result[]} */ const firstPage = [];
    const pdf = readerContext.pdfDocument,
      pattern = new RegExp(readerContext.fullSearchEscape(readerContext.normalizePdfSearchText(query)), "giu");
    if (!pdf) return [];
    // The preview's PDF.js count is provisional: do not publish or persist a
    // partial page-one search as if it covered the complete document.
    if (pdf._pdfInfo?.readerPageCountPending) throw new Error("正在检查文档，请稍后搜索全文");
    /** @type {Map<number, Promise<{text?: string, error?: unknown}>>} */
    const pending = new Map();
    let nextPage = 1;
    const fill = () => {
      while (pending.size < 2 && nextPage <= pdf.numPages && readerContext.isReaderGenerationCurrent("search", generation)) {
        const page = nextPage++;
        pending.set(page, readerContext.loadPdfSearchText(pdf, page, generation).then(
          text => ({ text }), error => ({ error })));
      }
    };
    fill();
    let total = 0, hasText = false, checkpointCount = 0, checkpointBytes = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
      const result = /** @type {{text?: string, error?: unknown}} */ (await pending.get(page));
      pending.delete(page);
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
      if (result.error) throw result.error;
      const text = /** @type {string} */ (result.text);
      fill();
      hasText ||= !!text.trim();
      let count = 0;
      const checkpoints = [];
      // Keep sparse checkpoints only for small-enough normalized pages and
      // cap total retained text separately from the regular LRU caches.
      const canCheckpoint = text.length * 2 <= PDF_SEARCH_CHECKPOINT_PAGE_BYTES &&
        checkpointBytes + text.length * 2 <= PDF_SEARCH_CHECKPOINT_BYTES;
      for (const match of text.matchAll(pattern)) {
        count++;
        if (count % PDF_SEARCH_CHECKPOINT_STRIDE === 0 && canCheckpoint &&
            checkpointCount + checkpoints.length < PDF_SEARCH_CHECKPOINT_MAX)
          checkpoints.push({ ordinal: count - 1, start: match.index });
        if (firstPage.length < 50) firstPage.push(nativeResult(page, text, match.index, match[0]));
        if (count % 2048 === 0) {
          await readerContext.waitForReader();
          if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
        }
      }
      if (count) {
        if (checkpoints.length) {
          checkpointCount += checkpoints.length;
          checkpointBytes += text.length * 2;
          groups.push({ page, count, checkpoints, checkpointText: text });
        } else groups.push({ page, count });
        total += count;
        readerContext.highlightPdfText(readerContext.content.querySelector(`.reader-page[data-page="${page}"]`), query);
      }
      // Publish the page that fills the first batch even if it crosses 50 hits.
      if (page === 1 || (count && total - count < 50) || page % 8 === 0 || page === pdf.numPages) {
        if (!readerContext.publishPdfSearchProgress(generation, groups, total, pattern, firstPage, page, pdf.numPages)) return [];
        await readerContext.waitForReader(0, true);
      }
    }
    if (!hasText) {
      if (readerContext.readerAbortController.signal.aborted || readerContext.pdfDocument !== pdf ||
          !readerContext.isReaderGenerationCurrent("search", generation))
        return [];
      const verified = !readerContext.ocrManifestUrl;
      if (verified) {
        pdf.readerNoSearchableText = true;
        readerContext.syncCapabilityControls();
      }
      throw Object.assign(new Error(verified ? "此文件没有可搜索文字" : "当前未能找到可搜索文字"),
        {code:verified ? "READER_NO_SEARCHABLE_TEXT" : "READER_TEXT_UNCONFIRMED"});
    }
    readerContext.publishPdfSearchProgress(generation, groups, total, pattern, firstPage, pdf.numPages, pdf.numPages);
    return firstPage;
  }

  return {
    ensurePdfBookSearchClient,
    prefetchPdfBookSearch,
    schedulePdfBookSearchPrefetch,
    searchConcentratedPdf,
    makePdfSearchPageLoader,
    publishPdfSearchProgress,
    getPdfPersistentTextStore,
    cachePdfSearchText,
    loadPdfSearchText,
    fullSearchPdfMatches
  };
}
