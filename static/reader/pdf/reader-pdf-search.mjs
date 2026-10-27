export function createReaderPdfSearch(readerContext) {
  async function ensurePdfBookSearchClient(manifest) {
    let textUrl = "";
    let partitioned = null;
    if (manifest?.text_layer) {
      readerContext.pdfTextLayerRepository ||= readerContext.createPdfV3Repository(manifest.source_sha256, manifest.page_count);
      const index = await readerContext.pdfTextLayerRepository.textIndex(manifest.text_layer);
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
    if (!readerContext.pdfBookSearchClient)
      readerContext.pdfBookSearchClient = module.createPdfBookSearch({
        url: textUrl || readerContext.pdfOcrSource().assetUrl(manifest.book_text.path),
        sha256: manifest.book_text.sha256,
        bytes: manifest.book_text.bytes,
        pageCount: readerContext.documentState.pageCount,
        sourceSha: manifest.source_sha256,
        ...partitioned
      });
    return readerContext.pdfBookSearchClient;
  }

  async function prefetchPdfBookSearch() {
    if (readerContext.readerAbortController.signal.aborted || readerContext.pdfBookSearchPrefetchPromise || !readerContext.ocrManifestUrl ||
        !["pdf", "pdf-pages"].includes(readerContext.capability.mode) || navigator.connection?.saveData) return;
    const connection = navigator.connection;
    if (["slow-2g", "2g"].includes(connection?.effectiveType)) return;
    readerContext.pdfBookSearchPrefetchPromise = (async () => {
      const manifest = await readerContext.loadPdfOcrManifest();
      const bytes = Number(manifest?.book_text?.bytes);
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > readerContext.PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES) return;
      const client = await readerContext.ensurePdfBookSearchClient(manifest);
      await client.prefetch();
    })().catch(() => {});
  }

  function schedulePdfBookSearchPrefetch() {
    if (readerContext.pdfBookSearchPrefetchTimer || readerContext.pdfBookSearchPrefetchPromise || !readerContext.ocrManifestUrl ||
        !["pdf", "pdf-pages"].includes(readerContext.capability.mode) || navigator.connection?.saveData) return;
    readerContext.pdfBookSearchPrefetchTimer = setTimeout(() => {
      readerContext.pdfBookSearchPrefetchTimer = 0;
      const idle = window.requestIdleCallback || ((callback) => setTimeout(callback, 0));
      idle(() => readerContext.prefetchPdfBookSearch(), { timeout: 1500 });
    }, readerContext.PDF_BOOK_SEARCH_PREFETCH_DELAY);
  }

  async function searchConcentratedPdf(query, generation) {
    const manifest = await readerContext.loadPdfOcrManifest();
    const client = await readerContext.ensurePdfBookSearchClient(manifest);
    let firstPageResults = [];
    const attach = (page) => {
      const results = page.results.map((hit, position) => {
        const previous = page.offset === 0 ? firstPageResults[position] : null;
        if (previous?.page === hit.page && previous.start === hit.start && previous.length === hit.length)
          return previous;
        return { ...hit, location: `第 ${hit.page} 页`, activate: async nav => {
          if (!await readerContext.goToPage(hit.page, nav) || !readerContext.isReaderGenerationCurrent("navigation", nav))
            return false;
          readerContext.content.querySelectorAll(".reader-text-hit-box").forEach(node => node.remove());
          const shell = readerContext.content.querySelector(`.reader-page[data-page="${hit.page}"]`);
          if (shell && (hit.boxes.length || hit.textGeneration)) {
            let boxes = hit.boxes;
            if (hit.textGeneration) {
              const layer = await readerContext.pdfTextLayerRepository.textPage(manifest.text_layer, hit.page);
              if (!readerContext.isReaderGenerationCurrent("navigation", nav)) return false;
              if (layer.generation !== hit.textGeneration) throw new Error("PDF_V3_GENERATION_CHANGED");
              boxes = readerContext.hitBoxes({text: layer.text, text_spans: layer.regions.map(region => ({
                start: region.start, end: region.end, box: region.box, precision: region.mapping_precision
              }))}, hit.start, hit.length);
            }
            if (readerContext.pdfV3Manifest) {
              await readerContext.renderPdfOcrText(shell);
              if (!readerContext.isReaderGenerationCurrent("navigation", nav)) return false;
            }
            readerContext.paintTextHit(shell, boxes, hit);
            const mark = shell.querySelector(".reader-text-hit-box");
            if (mark) {
              // Keep the search hit visible without leaving the previous page
              // under the ribbon on short mobile pages.
              const viewport = readerContext.viewport;
              const view = viewport.getBoundingClientRect();
              const ribbon = readerContext.bookmarkRibbon.getBoundingClientRect().bottom - view.top;
              const desired = readerContext.readerPageScrollTop(shell) +
                mark.getBoundingClientRect().top - shell.getBoundingClientRect().top - viewport.clientHeight / 2;
              const earliest = readerContext.readerPageScrollTop(shell) - Math.max(0, ribbon) + 1;
              viewport.scrollTop = Math.max(earliest, desired);
            }
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
      readerContext.fullSearchSession.page = attach(partial);
      readerContext.updateSearchState({ results: readerContext.fullSearchSession.page.results, index: -1 });
      readerContext.renderFullSearchResults();
      readerContext.fullSearchStatus.textContent = partial.total
        ? `${partial.total} 个结果（正在搜索… ${partial.scanned} / ${partial.pages} 页）`
        : `正在搜索正文… ${partial.scanned} / ${partial.pages} 页`;
    });
    if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
    readerContext.fullSearchSession.page = attach(page);
    return readerContext.fullSearchSession.page.results;
  }

  function makePdfSearchPageLoader(groups, total, pattern, firstPage) {
    const pdf = readerContext.pdfDocument;
    return async (requestedOffset, generation = readerContext.readerRuntime.currentGeneration("search")) => {
      const pageSize = 50, results = [];
      const offset = readerContext.fullSearchPageOffset(total, requestedOffset, pageSize);
      if (!offset) return { total, offset, pageSize, results: firstPage.slice() };
      let skipped = 0;
      for (const group of groups) {
        if (skipped + group.count <= offset) {
          skipped += group.count;
          continue;
        }
        const text = await readerContext.loadPdfSearchText(pdf, group.page, generation);
        let examined = 0;
        for (const match of text.matchAll(pattern)) {
          if (++examined % 2048 === 0) {
            await readerContext.waitForReader();
            if (!readerContext.isReaderGenerationCurrent("search", generation))
              throw new DOMException("Search cancelled", "AbortError");
          }
          if (skipped++ < offset) continue;
          results.push({
            location: `第 ${group.page} 页`,
            snippet: readerContext.fullSearchSnippet(text, match.index, match[0].length),
            activate: (navigationGeneration) => readerContext.goToPage(group.page, navigationGeneration)
          });
          if (results.length === pageSize) break;
        }
        if (results.length === pageSize) break;
      }
      return { total, offset, pageSize, results };
    };
  }

  function publishPdfSearchProgress(generation, groups, total, pattern, firstPage, scanned, pages) {
    if (!readerContext.isReaderGenerationCurrent("search", generation)) return false;
    readerContext.fullSearchSession.pageLoader = readerContext.makePdfSearchPageLoader(groups, total, pattern, firstPage);
    readerContext.fullSearchSession.page = { total, offset: 0, pageSize: 50, results: firstPage.slice() };
    readerContext.updateSearchState({ results: readerContext.fullSearchSession.page.results, index: -1 });
    readerContext.renderFullSearchResults();
    readerContext.fullSearchStatus.textContent = total
      ? `${total} 个结果（正在搜索… ${scanned} / ${pages} 页）`
      : `正在搜索正文… ${scanned} / ${pages} 页，暂未找到匹配`;
    return true;
  }

  async function getPdfPersistentTextStore(pdf) {
    const version = readerContext.pdfFetchPolicy?.identity;
    if (!version || readerContext.ocrManifestUrl || readerContext.readerAbortController.signal.aborted) return null;
    if (readerContext.pdfPersistentTextVersion !== version) {
      readerContext.pdfPersistentTextStore?.dispose();
      readerContext.pdfPersistentTextStore = null;
      readerContext.pdfPersistentTextVersion = version;
      const pending = (async () => {
        let timer;
        const module = await readerContext.awaitReader(Promise.race([import("/search/static/reader/pdf/reader-pdf-text-store.mjs"),
          new Promise(resolve => {timer=setTimeout(()=>resolve(null),1000);})])).finally(()=>clearTimeout(timer));
        if (!module) return null;
        const key = await module.pdfTextStoreKey({source:readerContext.sourceUrl,version,pageCount:pdf.numPages,
          engine:VoiceOfMLReaderResources.vendors.pdf.sha256});
        if (!key || readerContext.readerAbortController.signal.aborted || readerContext.pdfFetchPolicy?.identity !== version || readerContext.pdfPersistentTextOpening !== pending) return null;
        return readerContext.pdfPersistentTextStore = module.createPdfTextStore(key,{signal:readerContext.readerAbortController.signal});
      })().catch(() => null);
      readerContext.pdfPersistentTextOpening = pending;
    }
    return readerContext.pdfPersistentTextStore || readerContext.pdfPersistentTextOpening;
  }

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
      const oldest = readerContext.pdfSearchTextCache.keys().next().value;
      readerContext.pdfSearchTextCacheBytes -= readerContext.pdfSearchTextCache.get(oldest).length * 2;
      readerContext.pdfSearchTextCache.delete(oldest);
    }
  }

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

  async function fullSearchPdfMatches(query, generation) {
    const pdf = readerContext.pdfDocument, groups = [], firstPage = [],
      pattern = new RegExp(readerContext.fullSearchEscape(readerContext.normalizePdfSearchText(query)), "giu");
    if (!pdf) return [];
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
    let total = 0, hasText = false;
    for (let page = 1; page <= pdf.numPages; page++) {
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
      const result = await pending.get(page);
      pending.delete(page);
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
      if (result.error) throw result.error;
      const text = result.text;
      fill();
      hasText ||= !!text.trim();
      let count = 0;
      for (const match of text.matchAll(pattern)) {
        count++;
        if (firstPage.length < 50) firstPage.push({
          location: `第 ${page} 页`,
          snippet: readerContext.fullSearchSnippet(text, match.index, match[0].length),
          activate: (navigationGeneration) => readerContext.goToPage(page, navigationGeneration)
        });
        if (count % 2048 === 0) {
          await readerContext.waitForReader();
          if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
        }
      }
      if (count) {
        groups.push({ page, count });
        total += count;
        readerContext.highlightPdfText(readerContext.content.querySelector(`.reader-page[data-page="${page}"]`), query);
      }
      if (page === 1 || (count && total <= 50) || page % 8 === 0 || page === pdf.numPages) {
        if (!readerContext.publishPdfSearchProgress(generation, groups, total, pattern, firstPage, page, pdf.numPages)) return [];
        await readerContext.waitForReader(0, true);
      }
    }
    if (!hasText) throw new Error("此 PDF 尚无可搜索文字层，需要完成 OCR 后才能搜索正文");
    readerContext.publishPdfSearchProgress(generation, groups, total, pattern, firstPage, pdf.numPages, pdf.numPages);
    return readerContext.fullSearchSession.page.results;
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
