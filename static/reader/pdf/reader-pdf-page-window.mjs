import { pdfTextRunCaret } from "./reader-pdf-text.js";

/** @param {import('../../../typings/reader-page-window-strict').PageWindowContext} readerContext */
export function createReaderPdfPageWindow(readerContext) {
  /** @param {number} page @param {string} target */
  function startOpeningImage(page, target) {
    const url = new URL(target, location.href).href;
    if (readerContext.pdfFirstPagePreload?.src === url) return;
    readerContext.pdfFirstPagePreload?.removeAttribute("src");
    const image = readerContext.pdfFirstPagePreload = new Image();
    readerContext.pdfFirstPagePreloadPage = page;
    image.alt = `第 ${page} 页`;
    image.decoding = "async";
    image.fetchPriority = "high";
    image.src = url;
  }

  function pdfManifestSource() {
    if (String(readerContext.sourceUrl).includes("reading-manifest.json"))
      return VoiceOfMLReader.pdfPageSource(readerContext.sourceUrl, location.href, location.origin, "reading-manifest.json");
    return readerContext.capability.mode === "image-pages"
      ? VoiceOfMLReader.imagePageSource(readerContext.sourceUrl, location.href, "https://voiceofml-search.hf.space")
      : VoiceOfMLReader.pdfPageSource(
          readerContext.sourceUrl,
          location.href,
          "https://voiceofml-search.hf.space"
        );
  }

  /** @param {number} page */
  function pdfPageEntry(page) {
    if (!readerContext.pdfPageManifest || page < 1 || page > readerContext.pdfPageManifest.pageCount) return null;
    const pageEntry = (
      readerContext.pdfPageManifest.entries?.[page - 1] || {
        page,
        path: `${readerContext.pdfPageManifest.root}/pages/page-${String(page).padStart(6, "0")}.${readerContext.pdfPageManifest.pageCodec?.(page) || readerContext.pdfPageManifest.codec || "webp"}`
      }
    );
    const ocrEntry = readerContext.pdfPageManifest.ocr?.[page - 1];
    return ocrEntry ? { ...pageEntry, ...ocrEntry, page } : pageEntry;
  }

  // Geometry state is shared by direct PDF and ordinary image-page formats.
  let pdfPagesBook = { seedRatio: 0 };

  /** @typedef {import('../../../typings/reader-page-window-strict').PdfOutlineItem} OutlineItem */
  /** @typedef {import('../../../typings/reader-page-window-strict').PdfOutlineDocument} PdfOutlineDocument */
  /** @typedef {import('../../../typings/reader-page-window-strict').DjvuOutlineDocument} DjvuOutlineDocument */

  /** @param {OutlineItem} item @param {PdfOutlineDocument | DjvuOutlineDocument} pdf @param {boolean} isDjvu */
  async function resolveOutlinePage(item, pdf, isDjvu) {
    try {
      const destination = typeof item.dest === "string" ? await pdf.getDestination?.(item.dest) : item.dest;
      readerContext.assertReaderActive();
      const ref = destination?.[0];
      let index = -1;
      if (typeof ref === "number" && Number.isInteger(ref)) {
        // PDF.js numeric destinations are zero-based. DjVu normalizes through its adapter.
        index = isDjvu ? await /** @type {DjvuOutlineDocument} */ (pdf).getPageIndex(ref) : ref;
      } else if (!isDjvu && ref && typeof ref === "object") {
        index = await /** @type {PdfOutlineDocument} */ (pdf).getPageIndex(ref);
      }
      if (Number.isSafeInteger(index) && index >= 0 && index < pdf.numPages) return index + 1;
    } catch (_) { /* A broken destination does not discard the remaining outline. */ }
    return null;
  }

  /** @param {OutlineItem[] | null} outline
   * @returns {Generator<{item: OutlineItem, depth: number}, undefined, unknown>} */
  function* outlineItems(outline) {
    const stack = [(outline || []).values()];
    while (stack.length) {
      const row = stack.at(-1)?.next();
      if (!row || row.done) { stack.pop(); continue; }
      const item = row.value;
      yield { item, depth: stack.length - 1 };
      if (item.items?.length) stack.push(item.items.values());
    }
    return undefined;
  }

  /** @param {PdfOutlineDocument | DjvuOutlineDocument} pdf */
  async function loadPdfOutline(pdf, isDjvu = false) {
    if (typeof pdf?.getOutline !== "function") return undefined;
    try {
      const outline = await readerContext.awaitReader(pdf.getOutline());
      if (!outline?.length) return [];
      /** @type {import('../../../typings/reader-page-window-strict').PdfOutlineEntry[]} */
      const entries = [];
      const items = outlineItems(outline);
      let nextIndex = 0;
      // Lookups can wait for independent PDF ranges. Bound the queue and assign
      // each entry's original slot before any await; leave DjVu serial.
      await readerContext.awaitReader(Promise.all(Array.from({ length: isDjvu ? 1 : 4 }, async () => {
        while (true) {
          readerContext.assertReaderActive();
          const next = items.next().value;
          if (next === undefined) return;
          const { item, depth } = next;
          const slot = nextIndex++;
          const page = await resolveOutlinePage(item, pdf, isDjvu);
          readerContext.assertReaderActive();
          const label = String(item.title || "未命名章节").replace(/[\u2610-\u2612\u25a1]\s*[xX×]?\s*$/u, "").trim() || "未命名章节";
          entries[slot] = {
            label: page === null ? label : `${label} · 第 ${page} 页`,
            depth,
            page,
            activate: (generation) => page === null ? false : readerContext.goToPage(page, generation)
          };
        }
      })));
      readerContext.assertReaderActive();
      return entries;
    } catch (error) {
      if (!readerContext.readerAbortController.signal.aborted)
        console.warn("PDF outline could not be loaded", error);
      return undefined;
    }
  }

  // The first measured page geometry replaces the A4 estimate for unrendered
  // shells and virtual chunk heights. Callers run inside applyPdfShellGeometry,
  // which keeps the reading anchor in place.
  /** @param {number} width @param {number} height */
  function seedPdfPageGeometry(width, height) {
    if (pdfPagesBook.seedRatio || readerContext.pdfV3Map || !(width > 0 && height > 0)) return;
    const ratio = height / width;
    pdfPagesBook.seedRatio = ratio;
    if (Math.abs(ratio / 1.414 - 1) < .001) return;
    for (const shell of /** @type {NodeListOf<HTMLElement>} */ (readerContext.content.querySelectorAll(".reader-page:not([data-page-geometry])")))
      shell.style.aspectRatio = `1 / ${ratio}`;
    readerContext.pdfShellWindow?.setDefaultRatio(ratio);
  }

  /**
   * @param {(page: number) => HTMLElement} createShell
   * @param {number} total
   * @param {number} batchSize
   * @param {(endPage: number) => void} [onBatchMounted]
   */
  async function appendShellsBatched(createShell, total, batchSize, onBatchMounted) {
    for (let start = 2; start <= total; start += batchSize) {
      readerContext.assertReaderActive();
      const fragment = document.createDocumentFragment();
      for (let page = start; page < Math.min(start + batchSize, total + 1); page++) {
        const shell = createShell(page);
        // An already-mounted provisional shell may contain a live selection.
        // Leave it in place and insert only missing predecessors before it.
        if (shell.isConnected) readerContext.content.insertBefore(fragment, shell);
        else fragment.appendChild(shell);
      }
      // Any remaining shells follow the last retained shell in document order.
      readerContext.content.appendChild(fragment);
      onBatchMounted?.(Math.min(start + batchSize - 1, total));
      await readerContext.waitForReader();
    }
  }

  /** @param {Element} element */
  function pdfSelectionIntersects(element) {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return false;
    if (element.contains(selection.anchorNode) || element.contains(selection.focusNode)) return true;
    return !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(element);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {{anchorNode: Node | null, anchorOffset: number} | null} [start]
   */
  function correctPdfCrossPageSelection(x, y, start = null) {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return;
    const anchorNode = start?.anchorNode || selection.anchorNode;
    const anchorOffset = start?.anchorNode ? start.anchorOffset : selection.anchorOffset;
    if (!start?.anchorNode && selection.isCollapsed) return;
    const origin = anchorNode?.parentElement?.closest(".reader-page");
    let target = document.elementFromPoint(x, y)?.closest(".reader-page");
    const caret = start?.anchorNode && readerContext.independentTextCaret(document, x, y);
    if (caret && anchorNode && origin?.contains(anchorNode) && readerContext.content.contains(caret.node)) {
      selection.setBaseAndExtent(anchorNode, anchorOffset, caret.node, caret.offset);
      return;
    }
    if (!target) {
      let distance = Infinity;
      for (const shell of readerContext.content.querySelectorAll(".reader-page")) {
        const rect = shell.getBoundingClientRect();
        const gap = Math.max(rect.top - y, y - rect.bottom, 0);
        if (gap < distance) { distance = gap; target = shell; }
      }
    }
    if (!anchorNode || !origin || !target || origin === target || !readerContext.content.contains(origin) || !readerContext.content.contains(target)) return;
    const runs = target.querySelectorAll(".reader-pdf-text-run");
    let nearest = null, distance = Infinity;
    for (const run of runs) {
      if (!run.textContent) continue;
      const rect = run.getBoundingClientRect();
      const dx = Math.max(rect.left - x, x - rect.right, 0);
      const dy = Math.max(rect.top - y, y - rect.bottom, 0);
      const gap = Math.hypot(dx, dy);
      if (gap < distance) { nearest = run; distance = gap; }
    }
    const endpoint = nearest && pdfTextRunCaret(nearest, x, y);
    if (endpoint) selection.setBaseAndExtent(anchorNode, anchorOffset, endpoint.node, endpoint.offset);
  }

  /**
   * @param {number} total
   * @param {import('../../../typings/reader-page-window-strict').WindowShell} firstShell
   * @param {(page: number) => import('../../../typings/reader-page-window-strict').WindowShell} createShell
   * @param {(shell: import('../../../typings/reader-page-window-strict').WindowShell) => void} unobserve
   * @param {number} defaultRatio
   * @param {Map<number, import('../../../typings/reader-page-window-strict').WindowShell> | null} [retainedShells]
   */
  function createPdfShellWindow(total, firstShell, createShell, unobserve, defaultRatio, retainedShells = null) {
    // `defaultRatio` may be replaced once a real page geometry is known.
    if (total <= 256) return null;
    const chunkSize = 32;
    /** @type {import('../../../typings/reader-page-window-strict').PdfWindowChunk[]} */
    const chunks = [];
    const ratios = new Map();
    let frame = 0, disposed = false;
    const readWidth = () => {
      const style = getComputedStyle(readerContext.content);
      return (readerContext.content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * readerContext.documentState.zoom;
    };
    /** @param {import('../../../typings/reader-page-window-strict').PdfWindowChunk} chunk @param {number} width */
    const chunkHeight = (chunk, width) => {
      let height = 0;
      for (let page = chunk.start; page <= chunk.end; page++)
        height += Math.max(160, width * (ratios.get(page) || defaultRatio)) + 18;
      return height;
    };
    const fragment = document.createDocumentFragment();
    const initialWidth = readWidth();
    for (let start = 1; start <= total; start += chunkSize) {
      const element = document.createElement("div");
      element.className = "reader-pdf-chunk";
      element.setAttribute("aria-hidden", "true");
      const chunk = { element, start, end: Math.min(total, start + chunkSize - 1), mounted: false };
      chunks.push(chunk);
      element.style.height = `${chunkHeight(chunk, initialWidth)}px`;
      fragment.appendChild(element);
    }
    // Keep previously selected text nodes connected to the document while
    // assigning the verified prefix to its virtual chunks. Unvisited chunks
    // remain placeholders and are mounted/retired by the ordinary window.
    if (retainedShells?.size) readerContext.content.insertBefore(fragment, retainedShells.values().next().value || null);
    else readerContext.content.appendChild(fragment);
    const selection = retainedShells ? document.getSelection() : null;
    const savedSelection = selection?.rangeCount && retainedShells && [...retainedShells.values()].some(shell => readerContext.pdfSelectionIntersects(shell))
      ? {anchor:selection.anchorNode, anchorOffset:selection.anchorOffset, focus:selection.focusNode, focusOffset:selection.focusOffset,
        ranges:[...Array(selection.rangeCount)].map((_,index)=>{
          const range=selection.getRangeAt(index);
          return {start:range.startContainer,startOffset:range.startOffset,end:range.endContainer,endOffset:range.endOffset};
        })} : null;
    for (const chunk of chunks) {
      const retained = [];
      if (retainedShells) for (let page = chunk.start; page <= chunk.end; page++) {
        const shell = retainedShells.get(page);
        if (shell?.isConnected) retained.push(shell);
      }
      if (!retained.length) continue;
      chunk.element.style.height = "";
      chunk.element.removeAttribute("aria-hidden");
      chunk.mounted = true;
      for (const shell of retained) {
        chunk.element.appendChild(shell);
        retainedShells?.delete(Number(shell.dataset.page));
      }
      for (let page=chunk.start;page<=chunk.end;page++) {
        const existing=chunk.element.querySelector(`.reader-page[data-page="${page}"]`);
        if (existing) continue;
        const next=[...chunk.element.children].find(node => Number(/** @type {HTMLElement} */ (node).dataset.page) > page);
        chunk.element.insertBefore(createShell(page),next || null);
      }
    }
    if (savedSelection?.anchor?.isConnected && savedSelection.focus?.isConnected && selection) {
      try {
        selection.removeAllRanges();
        if (savedSelection.ranges.length === 1 && selection.setBaseAndExtent)
          selection.setBaseAndExtent(savedSelection.anchor,savedSelection.anchorOffset,savedSelection.focus,savedSelection.focusOffset);
        else for (const saved of savedSelection.ranges) {
          if (!saved.start.isConnected || !saved.end.isConnected) continue;
          const range=document.createRange();range.setStart(saved.start,saved.startOffset);range.setEnd(saved.end,saved.endOffset);
          selection.addRange(range);
        }
      } catch (_) { /* A concurrent selection edit must not break the document. */ }
    }
    /** @param {import('../../../typings/reader-page-window-strict').PdfWindowChunk} chunk */
    function mount(chunk) {
      if (chunk.mounted) return;
      const pages = document.createDocumentFragment();
      for (let page = chunk.start; page <= chunk.end; page++) {
        const shell = page === 1 && firstShell.isConnected ? firstShell : createShell(page);
        if (ratios.has(page)) shell.style.aspectRatio = `1 / ${ratios.get(page)}`;
        pages.appendChild(shell);
      }
      chunk.element.style.height = "";
      chunk.element.removeAttribute("aria-hidden");
      chunk.element.appendChild(pages);
      chunk.mounted = true;
    }
    /** @param {import('../../../typings/reader-page-window-strict').PdfWindowChunk} chunk */
    function canUnmount(chunk) {
      return chunk.mounted && !chunk.element.contains(document.activeElement) &&
        !readerContext.pdfSelectionIntersects(chunk.element);
    }
    /** @param {import('../../../typings/reader-page-window-strict').PdfWindowChunk} chunk */
    function measureChunk(chunk) {
      for (const shell of /** @type {HTMLCollectionOf<import('../../../typings/reader-page-window-strict').WindowShell>} */ (chunk.element.children)) {
        const bounds = shell.getBoundingClientRect();
        if (bounds.width && bounds.height) ratios.set(Number(shell.dataset.page), bounds.height / bounds.width);
      }
    }
    /** @param {import('../../../typings/reader-page-window-strict').PdfWindowChunk} chunk @param {number} width */
    function unmount(chunk, width) {
      if (!chunk.mounted || chunk.element.contains(document.activeElement) ||
          readerContext.pdfSelectionIntersects(chunk.element)) return;
      for (const shell of /** @type {HTMLCollectionOf<import('../../../typings/reader-page-window-strict').WindowShell>} */ (chunk.element.children)) {
        const page = Number(shell.dataset.page);
        shell._textEpoch = (shell._textEpoch || 0) + 1;
        shell._renderCancel?.();
        unobserve(shell);
        readerContext.pdfManifestShells[page] = undefined;
      }
      chunk.element.replaceChildren();
      chunk.element.style.height = `${chunkHeight(chunk, width)}px`;
      chunk.element.setAttribute("aria-hidden", "true");
      chunk.mounted = false;
    }
    /** @param {number} index */
    function show(index) {
      if (disposed) return;
      const anchor = readerContext.pageAtMarker();
      const before = readerContext.isPdfPageVisible(anchor) ? /** @type {Element} */ (anchor).getBoundingClientRect().top : undefined;
      const retiring = chunks.filter((chunk, i) => Math.abs(i - index) > 2 && canUnmount(chunk));
      const width = retiring.length ? readWidth() : 0;
      // Capture all retiring page geometry before mounting or removing any chunks.
      for (const chunk of retiring) measureChunk(chunk);
      for (let i = Math.max(0, index - 2); i <= Math.min(chunks.length - 1, index + 2); i++)
        mount(/** @type {import('../../../typings/reader-page-window-strict').PdfWindowChunk} */ (chunks[i]));
      for (const chunk of retiring) unmount(chunk, width);
      if (anchor?.isConnected && before !== undefined)
        readerContext.viewport.scrollTop += anchor.getBoundingClientRect().top - before;
    }
    function sync() {
      frame = 0;
      if (disposed) return;
      const { viewport } = readerContext;
      const marker = viewport.scrollTop + viewport.clientHeight / 2;
      /** @param {import('../../../typings/reader-page-window-strict').PdfWindowChunk} chunk */
      const endsAfterMarker = ({ element }) => element.offsetTop + element.offsetHeight > marker;
      // The flow-root block stack is ordered until layout coordinates saturate
      // or wrap. Gecko can wrap chunk offsets once the stack exceeds ~35.8M px;
      // the viewport then reports ~8.95M px. Retain the linear rule for large stacks.
      if (viewport.scrollHeight >= 8 * 1024 * 1024) {
        const index = chunks.findIndex(endsAfterMarker);
        show(index < 0 ? chunks.length - 1 : index);
        return;
      }
      let low = 0, high = chunks.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (endsAfterMarker(/** @type {import('../../../typings/reader-page-window-strict').PdfWindowChunk} */ (chunks[mid]))) high = mid;
        else low = mid + 1;
      }
      show(Math.min(low, chunks.length - 1));
    }
    mount(/** @type {import('../../../typings/reader-page-window-strict').PdfWindowChunk} */ (chunks[0]));
    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(readerContext.viewport);
    function resize() {
      if (disposed) return;
      const anchor = readerContext.pageAtMarker();
      const before = readerContext.isPdfPageVisible(anchor) ? /** @type {Element} */ (anchor).getBoundingClientRect().top : undefined;
      const width = readWidth();
      for (const chunk of chunks) if (!chunk.mounted) chunk.element.style.height = `${chunkHeight(chunk, width)}px`;
      if (anchor?.isConnected && before !== undefined)
        readerContext.viewport.scrollTop += anchor.getBoundingClientRect().top - before;
      schedule();
    }
    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(sync);
    }
    const window = {
      /** @param {number} page Integer in [1, total]; outside this range may return null or throw. Throws after disposal. */
      ensure(page) {
        const index = Math.floor((page - 1) / chunkSize);
        show(index);
        return (/** @type {import('../../../typings/reader-page-window-strict').PdfWindowChunk} */ (chunks[index])).element.querySelector(`.reader-page[data-page="${page}"]`);
      },
      /** @param {import('../../../typings/reader-page-window-strict').WindowShell} shell */
      remember(shell) {
        if (!shell.isConnected) return;
        const bounds = shell.getBoundingClientRect();
        if (bounds.width && bounds.height) ratios.set(Number(shell.dataset.page), bounds.height / bounds.width);
      },
      // The caller owns anchor compensation (see seedPdfPageGeometry).
      /** @param {number} ratio */
      setDefaultRatio(ratio) {
        if (disposed || !(ratio > 0)) return;
        defaultRatio = ratio;
        const width = readWidth();
        for (const chunk of chunks) if (!chunk.mounted) chunk.element.style.height = `${chunkHeight(chunk, width)}px`;
      },
      schedule,
      resize,
      dispose() {
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        chunks.length = 0;
        ratios.clear();
        readerContext.pdfShellWindow = null;
      }
    };
    readerContext.trackReaderResource(() => window.dispose());
    return window;
  }

  /** @param {Response | Promise<Response>} prepared */
  async function renderPdfPages(prepared) {
    pdfPagesBook = { seedRatio: 0 };
    const book = pdfPagesBook;
    const response = await prepared;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const decoded = JSON.parse(await VoiceOfMLReaderSecurity.readText(response, VoiceOfMLReaderSecurity.LIMITS.manifestBytes));
    const manifest = decoded?.kind === "pdf-reading"
      ? readerContext.validateReadingManifest(decoded, VoiceOfMLReaderSecurity.LIMITS.pdfPages)
      : VoiceOfMLReaderSecurity.validatePdfPageManifest(decoded);
    if (manifest.kind === "pdf-reading") {
      if (readerContext.pdfManifestSource()?.root.split("/").slice(0, 3).join("/") !==
          `objects/${manifest.source_sha256.slice(0, 2)}/${manifest.source_sha256}`)
        throw new Error("PDF_V3_SOURCE_MISMATCH");
      const repository = readerContext.pdfV3Repository =
        readerContext.createPdfV3Repository(manifest.source_sha256, manifest.page_count);
      readerContext.pdfV3Manifest = manifest;
      readerContext.pdfOcrManifest = manifest.text_layer ? manifest : null;
      readerContext.ocrManifestUrl = manifest.text_layer ? readerContext.sourceUrl : "";
      if (manifest.primary.kind === "pdf") {
        // PDF and PDF-converted documents draw the primary directly. Keep the
        // independent text layer/map, but never request old preview partitions,
        // race a page image, or fall back to a raster stream after failure.
        readerContext.extension = "pdf";
        readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability("pdf"));
        readerContext.readerRuntime.update("source", { extension: "pdf" });
        readerContext.syncCapabilityControls();
        const pending = readerContext.loadPdfDocument(readerContext.v3ResourceUrl(manifest.primary.resource));
        pending.catch(() => {});
        readerContext.pdfV3Map = readerContext.validatePageMap(await repository.read(manifest.page_map), manifest);
        const pdf = await pending;
        readerContext.assertReaderActive();
        if (pdf.numPages !== manifest.page_count) {
          await pdf.destroy?.();
          throw new Error("PDF_PRIMARY_PAGE_COUNT_MISMATCH");
        }
        return readerContext.renderPdf(pdf);
      }
      readerContext.extension = "pdf";
      readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability("pdf"));
      readerContext.readerRuntime.update("source", { extension: "pdf" });
      readerContext.syncCapabilityControls();
      /** @type {string} */
      const djvuLoaderUrl = "/search/static/reader/pdf/reader-djvu-loader.mjs";
      // The checked map is independent of decoder bootstrap. Start it as soon
      // as the manifest is validated, not after the loader module graph arrives.
      const pageMap = repository.read(manifest.page_map).then(map => readerContext.validatePageMap(map, manifest));
      const loading = import(djvuLoaderUrl);
      // Fail on a bad map even if the import is stalled. The loader can still
      // prepare the decoder and read the primary while a valid map is pending.
      const { openDirectDjvu } = /** @type {typeof import('./reader-djvu-loader.mjs')} */ (await readerContext.awaitReader(
        Promise.race([loading, pageMap.then(() => loading)])));
      readerContext.assertReaderActive();
      let pdf;
      try {
        pdf = /** @type {import('../../../typings/reader-page-window-strict').DirectDjvuDocument} */ (await openDirectDjvu(readerContext, manifest, pageMap));
        readerContext.pdfV3Map = await pageMap;
        return await readerContext.renderPdf(pdf);
      } catch (error) {
        pdf?.destroy();
        throw error;
      }
    }
    if (readerContext.capability.mode !== "image-pages") {
      const extension = String(readerContext.resolvedReaderData?.original_extension || "").toLowerCase();
      let originalPath = "";
      try {
        const url = new URL(readerContext.downloadUrl, location.href);
        originalPath = url.searchParams.get("path") || url.pathname;
      } catch (_) {}
      const djvu = manifest.source_format === "djvu" || extension === "djvu" || /\.djvu$/i.test(originalPath);
      if (djvu) throw new Error("DJVU_LEGACY_READING_UNSUPPORTED");
      const primary = readerContext.pdfPrimarySource();
      if (!primary) throw new Error("PDF_PRIMARY_REQUIRED");
      readerContext.extension = "pdf";
      readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability("pdf"));
      readerContext.readerRuntime.update("source", { extension: "pdf" });
      readerContext.syncCapabilityControls();
      return readerContext.renderPdf(readerContext.loadPdfDocument(primary));
    }
    return renderImagePageWindow(manifest.page_count, book, manifest.toc);
  }

  /**
   * @param {number} totalPages
   * @param {{seedRatio: number}} book
   * @param {import('../../../typings/reader-security-strict').ValidatedPdfPageManifest['toc']} [toc]
   * @param {import('../../../typings/reader-page-window-strict').ImagePageIntegrity[]} [avifPages]
   */
  async function renderImagePageWindow(totalPages, book, toc, avifPages) {
    const openingNavigation = readerContext.readerRuntime.currentGeneration("navigation");
    const layout = Promise.withResolvers();
    readerContext.pdfShellLayoutReady = layout.promise;
    try {
      await mountImagePageWindow(totalPages, book, toc,
        () => readerContext.isReaderGenerationCurrent("navigation", openingNavigation),
        () => {
          readerContext.pdfShellLayoutReady = null;
          layout.resolve(true);
        }, avifPages);
    } finally {
      readerContext.pdfShellLayoutReady = null;
      layout.resolve(false);
    }
  }

  /** @param {number} totalPages @param {{seedRatio: number}} book
   * @param {import('../../../typings/reader-security-strict').ValidatedPdfPageManifest['toc']} toc
   * @param {() => boolean} ownsOpeningPosition @param {() => void} publishLayout
   * @param {import('../../../typings/reader-page-window-strict').ImagePageIntegrity[]} [avifPages] */
  async function mountImagePageWindow(totalPages, book, toc, ownsOpeningPosition, publishLayout, avifPages) {
    readerContext.assertReaderActive();
    const source = readerContext.pdfManifestSource();
    if (!source?.pageUrl) throw new Error("PDF_MANIFEST_INVALID");
    const codec = avifPages ? "avif" : "webp";
    const sourcePageUrl = source.pageUrl;
    const pageUrl = (/** @type {number} */ page) => sourcePageUrl(page, codec);
    if (avifPages) pageUrl(1); // Reject unsupported roots before publishing navigation.
    readerContext.pdfPageManifest = { ...source, pageUrl, avifPages, pageCount: totalPages, codec, sourceFormat: "image" };
    readerContext.updateDocumentState({ pageCount: totalPages });
    readerContext.pageInput.max = String(totalPages);
    /** @type {HTMLElement} */ (document.querySelector("#page-total")).textContent = `/ ${totalPages}`;
    readerContext.status.textContent = `${totalPages} 页`;
    await readerContext.getInitialReaderRestoration();
    readerContext.assertReaderActive();
    const initialPage = readerContext.initialReaderPage(totalPages);
    // Start the validated opening WebP early, even on Save-Data. AVIF goes
    // through the bounded renderer so that no unchecked bytes reach an <img>.
    if (codec === "webp" && ownsOpeningPosition()) {
      startOpeningImage(initialPage, pageUrl(initialPage));
      // Let the browser process the src update before synchronous shell work.
      await Promise.resolve();
      readerContext.assertReaderActive();
    }
    if (readerContext.ocrManifestUrl && !navigator.connection?.saveData) {
      readerContext.loadPdfOcrPage(initialPage).catch(() => {});
    }
    let initialRenderGate = true;
    if (Array.isArray(toc) && toc.length)
      readerContext.setToc(
        toc.map((item) => ({
          label: `${item.title} · 第 ${item.page} 页`,
          depth: item.depth,
          page: item.page,
          activate: (generation) => readerContext.goToPage(item.page, generation)
        }))
      );
    const observer = new IntersectionObserver(
      (items) => {
        if (readerContext.readerAbortController.signal.aborted) return;
        for (const entry of items) if (entry.isIntersecting) {
          /** @type {HTMLElement} */ (entry.target).dataset.renderVisible = readerContext.isPdfPageVisible(entry.target) ? "1" : "0";
          readerContext.renderPdfInBackground(entry.target);
        }
      },
      { root: readerContext.viewport, rootMargin: `${readerContext.PDF_PREFETCH_MARGIN}px 0px` }
    );
    const visibleObserver = new IntersectionObserver(
      (items) => {
        if (readerContext.readerAbortController.signal.aborted) return;
        for (const entry of items) {
          /** @type {HTMLElement} */ (entry.target).dataset.renderVisible = entry.isIntersecting ? "1" : "0";
          if (entry.isIntersecting) {
            readerContext.promotePdfRenderWaiter(entry.target);
            readerContext.renderPdfInBackground(entry.target, false, readerContext.pdfPagePriority(entry.target));
            if (/** @type {HTMLElement} */ (entry.target).dataset.renderState === "rendered") readerContext.renderPdfOcrText(entry.target);
          }
        }
      },
      { root: readerContext.viewport, threshold: 0 }
    );
    /** @param {import('../../../typings/reader-page-window-strict').WindowShell} shell */
    const observeShell = (shell) => {
      if (initialRenderGate) {
        shell._pdfObserversPending = true;
        return;
      }
      observer.observe(shell);
      visibleObserver.observe(shell);
    };
    const releaseInitialRenderGate = () => {
      initialRenderGate = false;
      for (const shell of /** @type {NodeListOf<import('../../../typings/reader-page-window-strict').WindowShell>} */ (readerContext.content.querySelectorAll(".reader-page"))) {
        if (!shell._pdfObserversPending) continue;
        delete shell._pdfObserversPending;
        observeShell(shell);
      }
    };
    readerContext.trackReaderResource(() => {
      observer.disconnect();
      visibleObserver.disconnect();
    });
    /** @param {number} page */
    const createShell = (page) => {
      const shell = document.createElement("section");
      shell.className = "reader-page";
      shell.dataset.page = String(page);
      shell.style.aspectRatio = `1 / ${book.seedRatio || 1.414}`;
      if (readerContext.pdfV3Map) {
        const geometry = /** @type {import('../../../typings/reader-v3-strict').PageMap['pages'][number]} */ (readerContext.pdfV3Map.pages[page - 1]);
        shell.style.aspectRatio = `${geometry.width} / ${geometry.height}`;
      }
      readerContext.pdfManifestShells[page] = shell;
      shell.tabIndex = 0;
      shell.setAttribute("role", "region");
      shell.setAttribute("aria-label", `第 ${page} 页`);
      const pageState = document.createElement("div");
      pageState.className = "reader-page-state";
      readerContext.setPdfPageLoadingState(pageState, page);
      pageState.hidden = true;
      const textLayer = document.createElement("div");
      textLayer.className = "reader-pdf-text";
      textLayer.setAttribute("role", "document");
      textLayer.setAttribute("aria-label", `第 ${page} 页正文`);
      shell.append(pageState, textLayer);
      const openingImage = readerContext.pdfFirstPagePreload;
      if (openingImage && page === readerContext.pdfFirstPagePreloadPage) {
        // Hand it off once. A later remount must never move a stale image back
        // into the window, and a new jump can abandon an unmounted opening page.
        readerContext.pdfFirstPagePreload = null;
        if (ownsOpeningPosition() && (!openingImage.complete || openingImage.naturalWidth))
          shell.appendChild(openingImage);
        else
          openingImage.removeAttribute("src");
      }
      shell.addEventListener("focus", () => readerContext.renderPdfInBackground(shell));
      observeShell(shell);
      return shell;
    };
    const firstShell = createShell(1);
    readerContext.content.appendChild(firstShell);
    readerContext.markReaderContentReady();
    readerContext.pdfShellWindow = readerContext.createPdfShellWindow(totalPages, firstShell, createShell, (shell) => {
      observer.unobserve(shell);
      visibleObserver.unobserve(shell);
    }, book.seedRatio || 1.414);
    // The opening image only needs its own shell; history and the background
    // observers still wait for the complete layout.
    const mounted = !readerContext.pdfShellWindow && initialPage > 1 ? Promise.withResolvers() : null;
    const shellsReady = readerContext.pdfShellsReady = readerContext.pdfShellWindow
      ? Promise.resolve() : readerContext.appendShellsBatched(createShell, totalPages, 250, mounted
        ? endPage => { if (endPage >= initialPage) mounted.resolve(undefined); } : undefined);
    shellsReady.catch(() => {});
    publishLayout();
    try {
      if (ownsOpeningPosition()) {
        if (mounted) await Promise.race([mounted.promise, shellsReady]);
        readerContext.assertReaderActive();
        if (ownsOpeningPosition()) {
          const openingShell = readerContext.pdfShellWindow?.ensure(initialPage) || (initialPage === 1
            ? firstShell : readerContext.content.querySelector(`.reader-page[data-page="${initialPage}"]`));
          if (!openingShell) throw new Error("PDF initial page shell missing");
          try {
            await drawOpeningImagePage(openingShell, ownsOpeningPosition);
          } catch (error) {
            // An early error can precede a newer, successful page jump
            // while unrelated shells are still mounting. Don't fail that view.
            await shellsReady.catch(() => {});
            readerContext.assertReaderActive();
            if (ownsOpeningPosition()) {
              // A speculative first image was not the saved page if history
              // missed the short opening window. Try the newly known target.
              const history = readerContext.readerRestorationPromise;
              const saved = history && await readerContext.awaitReader(Promise.race([
                history, readerContext.waitForReader(150).then(() => null)
              ]));
              readerContext.assertReaderActive();
              if (ownsOpeningPosition()) {
                const page = Number(saved?.page);
                if (!Number.isInteger(page) || page < 1 || page > totalPages || page === initialPage) throw error;
                const fallback = readerContext.pdfShellWindow?.ensure(page) ||
                  readerContext.content.querySelector(`.reader-page[data-page="${page}"]`);
                if (!fallback) throw error;
                try { await drawOpeningImagePage(fallback, ownsOpeningPosition); }
                catch (failure) { if (ownsOpeningPosition()) throw failure; }
              }
            }
          }
          if (mounted) {
            await shellsReady;
            // Near the temporary end the scroll can clamp. Align again before
            // releasing observers, but leave any newer navigation untouched.
            if (ownsOpeningPosition() && openingShell.isConnected)
              readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(openingShell);
          }
        }
      }
    } finally {
      // Restore or fall back only after the batch stops mutating the layout.
      // Keep the original image error if the abandoned batch also fails.
      await shellsReady.catch(() => {});
      readerContext.pdfFirstPagePreload?.removeAttribute("src");
      readerContext.pdfFirstPagePreload = null;
      if (!readerContext.readerAbortController.signal.aborted) releaseInitialRenderGate();
    }
    await shellsReady;
  }

  /** @param {Element} target @param {() => boolean} ownsOpeningPosition */
  async function drawOpeningImagePage(target, ownsOpeningPosition) {
    readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(target);
    try {
      await readerContext.renderPdfImageShell(target, false, true);
    } catch (error) {
      readerContext.assertReaderActive();
      // A newer jump can cancel or supersede this image, not the Reader.
      if (ownsOpeningPosition()) throw error;
    }
    readerContext.markReaderContentReady();
    if (ownsOpeningPosition() && target.isConnected)
      readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(target);
  }

  /** @param {Response | Promise<Response>} prepared */
  async function renderImagePages(prepared) {
    const response = await prepared;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    /** @type {{version: number, kind: string, image_format?: unknown, page_count: number,
     *   pages: ({path?: unknown, bytes?: unknown, sha256?: unknown} | null)[]} | null} */
    const manifest = JSON.parse(
      await VoiceOfMLReaderSecurity.readText(response, VoiceOfMLReaderSecurity.LIMITS.manifestBytes)
    );
    if (!manifest || manifest.version !== 1 || manifest.kind !== "image-page-stream" ||
        !Number.isInteger(manifest.page_count) || manifest.page_count < 1 ||
        !Array.isArray(manifest.pages) || manifest.pages.length !== manifest.page_count ||
        manifest.pages.includes(null))
      throw new Error("IMAGE_MANIFEST_INVALID");
    if (manifest.page_count > VoiceOfMLReaderSecurity.LIMITS.pdfPages)
      throw Object.assign(new Error("READER_RESOURCE_LIMIT"), { code: "READER_RESOURCE_LIMIT" });
    if (manifest.image_format !== undefined && manifest.image_format !== "webp" && manifest.image_format !== "avif")
      throw new Error("IMAGE_MANIFEST_INVALID");
    // Legacy WebP entries never supplied the URL. Require exact ordinal paths
    // and integrity pins for AVIF, but still derive the URL from the trusted root.
    const avifPages = manifest.image_format === "avif" ? manifest.pages.map((entry, index) => {
      const path = `pages/page-${String(index + 1).padStart(6, "0")}.avif`;
      if (entry?.path !== path || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 1 || entry.bytes > VoiceOfMLReaderSecurity.LIMITS.imagePageBytes ||
          typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256))
        throw new Error("IMAGE_MANIFEST_INVALID");
      return { bytes: entry.bytes, sha256: entry.sha256 };
    }) : undefined;
    pdfPagesBook = { seedRatio: 0 };
    return renderImagePageWindow(manifest.page_count, pdfPagesBook, undefined, avifPages);
  }

  /** @typedef {import('../../../typings/reader-page-window-strict').PdfPreviewDocument | import('../../../typings/reader-page-window-strict').DirectDjvuDocument} VerifiedPdf */
  /** @typedef {{page: number, top: number | null}} PreviewAnchor */
  /** @param {VerifiedPdf | Promise<VerifiedPdf>} prepared */
  async function renderPdf(prepared) {
    const pdf = await prepared;
    readerContext.assertReaderActive();
    /** @type {import('../../../typings/reader-page-window-strict').WindowShell | null} */
    let previewShell = null;
    /** @type {PreviewAnchor | null} */
    let previewAnchor = null;
    /** @type {HTMLDivElement | null} */
    let previewPadding = null;
    let previewNavigationChanged = false;
    /** @type {Map<number, import('../../../typings/reader-page-window-strict').WindowShell>} */
    const previewPages = new Map();
    const previewDocument = pdf;
    if (previewDocument._pdfInfo?.readerPageCountPending === true) {
      // A pending page count is a PDF.js staged document with a transport.
      const pdf = /** @type {import('../../../typings/reader-page-window-strict').PendingPdfDocument} */ (previewDocument);
      // Until validation succeeds neither navigation nor history receives an
      // untrusted count. The preview uses the original page and renderer.
      const navigation = readerContext.readerRuntime.currentGeneration("navigation");
      const history = readerContext.readerRestorationPromise;
      const known = history ? await readerContext.awaitReader(Promise.race([
        history.then(saved => ({ saved })), readerContext.waitForReader(150).then(() => null)
      ])) : { saved: null };
      const saved = known?.saved, savedPage = Number(saved?.page);
      const canPreview = !!known && (!saved || (savedPage === 1 && Number(saved?.pageOffset || 0) === 0 && !saved?.id));
      const lifetime = new AbortController();
      let preservePreview = false;
      const untrackPreview = readerContext.trackReaderResource(() => {
        lifetime.abort(readerContext.readerAbortError());
        previewPadding?.remove();
        if (preservePreview) return;
        for (const shell of previewPages.values()) { shell._renderCancel?.(); shell.remove(); }
      });
      /** @type {HTMLElement | null} */
      let controls = null;
      let previousDisabled = false;
      let bookmarkDisabled = false;
      let verifiedCount = null;
      let previewWidth = null, previewZoom = null;
      let provisionalDocument = false;
      let previewActive = true, previewCount = 1, previewPage = 1, previewTurnUntil = 0;
      /** @type {Promise<void> | null} */
      let prefixTask = null;
      /** @type {Promise<void> | null} */
      let previewMoreTask = null;
      /** @type {unknown[] | null} */
      let previewRefs = null;
      let previewPendingPage = 0, previewExhausted = false, previewPrefixFailed = false, previewPrefixTimer = 0;
      /** @type {Promise<void> | null} */
      let warmTask = null;
      /** @type {(() => void) | null} */
      let cancelWarm = null;
      /** @type {(() => Promise<{count: number, refs: unknown[]}>) | null} */
      let startValidation = null;
      let validationTimer = 0;
      let removePreviewControls = () => {};
      let disconnectPreviewObserver = () => {};
      let releasePrefixTimeout = () => {};
      const cleanupControls = () => {
        removePreviewControls(); removePreviewControls = () => {};
        disconnectPreviewObserver(); disconnectPreviewObserver = () => {};
      };
      readerContext.status.textContent = "正在检查文档";
      /** @type {HTMLElement} */ (document.querySelector("#page-total")).textContent = "";
      const gateControls = /** @type {HTMLElement} */ (document.querySelector(".page-controls")), gateWasHidden = gateControls.hidden;
      gateControls.hidden = true;
      try {
        if (!readerContext.restorationFailed && canPreview && !readerContext.ocrManifestUrl &&
            !readerContext.pdfV3Map && !pdf.isPureXfa &&
            navigation === readerContext.readerRuntime.currentGeneration("navigation")) {
          // Prefix identities come from the current catalog, even when an old
          // linearized first-page hint exists after an incremental update.
          const refs = await readerContext.awaitReader(
            /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).messageHandler.sendWithPromise("ReaderPrepareFirstPage", null), lifetime.signal);
          if (!Array.isArray(refs) || refs.length !== 1) throw new Error("PDF_PREFIX_INVALID");
          previewRefs = refs;
          const page = await readerContext.awaitReader(pdf.getPage(1), lifetime.signal);
          const base = page.getViewport({scale:1});
          previewShell = document.createElement("section");
          previewShell.className = "reader-page reader-pdf-opening";
          previewShell.dataset.page = "1";
          previewShell.style.aspectRatio = `${base.width} / ${base.height}`;
          previewShell.setAttribute("role", "region");
          previewShell.setAttribute("aria-label", "第 1 页，正在检查文档");
          const text = document.createElement("div");
          text.className = "reader-pdf-text";
          text.setAttribute("role", "document");
          text.setAttribute("aria-label", "第 1 页正文");
          previewShell.append(text);
          readerContext.content.appendChild(previewShell);
          previewPages.set(1, previewShell);
          previousDisabled = readerContext.pageInput.disabled;
          readerContext.pageInput.disabled = true;
          bookmarkDisabled = readerContext.bookmarkRibbon.disabled;
          readerContext.bookmarkRibbon.disabled = true;
          readerContext.status.textContent = "正在检查文档";
          /** @type {HTMLElement} */ (document.querySelector("#page-total")).textContent = "";
          controls = /** @type {HTMLElement} */ (document.querySelector(".page-controls"));
          controls.hidden = true;
          readerContext.pdfDocument = pdf;
          provisionalDocument = true;
          const pdfGeneration = readerContext.readerRuntime.currentGeneration("pdf");
          await readerContext.renderPdfShell(previewShell, false, true);
          readerContext.assertReaderActive();
          previewShell.dataset.previewReady = "1";
          previewShell.dataset.previewPdfGeneration = String(pdfGeneration);
          previewWidth = previewShell.clientWidth;
          previewZoom = readerContext.documentState.zoom;
          readerContext.markReaderContentReady();
          // Let the browser paint before validation competes for network/CPU.
          await Promise.race([readerContext.waitForReader(0, true), readerContext.waitForReader(100)]);
          // The reader stays on the original PDF. Its bounded prefix is ordered
          // by a left-to-right page-tree walk, never by unverified /Count.
          const prefixDeadline = Promise.withResolvers();
          const prefixTimer = setTimeout(() => prefixDeadline.resolve(null), 5000);
          releasePrefixTimeout = () => { clearTimeout(prefixTimer); prefixDeadline.resolve(null); };
          const prefix = Promise.race([
            pdf._transport.messageHandler.sendWithPromise("ReaderGetPagePrefix", {limit:2}), prefixDeadline.promise
          ]).finally(() => clearTimeout(prefixTimer));
          prefixTask = prefix.then(async refs => {
            if (!previewActive || !Array.isArray(refs) || refs.length < 2 || refs.length > 4) { startValidation?.(); return; }
            const installed = await readerContext.awaitReader(
              /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).messageHandler.sendWithPromise("ReaderInstallPagePrefix", null), lifetime.signal);
            if (!previewActive || installed?.refs?.length !== refs.length ||
                installed.refs.some((ref, index) => ref !== refs[index])) { startValidation?.(); return; }
            previewRefs = refs;
            const count = refs.length;
            previewCount = count;
            /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).pagesMapper.pagesNumber = count;
            // Warm only the next page the reader can actually request. The
            // detached canvas is disposable and yields to visible rendering.
            warmTask = pdf.getPage(2).then(async page => {
              if (!previewActive) return;
              const warmController = new AbortController();
              const acquire = readerContext.acquirePdfRenderSlot(true, null, warmController.signal);
              let acquired = false;
              const cancelQueued = () => warmController.abort(readerContext.readerAbortError());
              cancelWarm = cancelQueued;
              try {
                await readerContext.awaitReader(acquire, lifetime.signal);
                acquired = true;
                if (!previewActive) return;
                const base = page.getViewport({scale:1});
                const scale = Math.min(pdf.readerRenderScaleLimit ?? 3, /** @type {import('../../../typings/reader-page-window-strict').WindowShell} */ (previewShell).clientWidth / base.width);
                const viewport = page.getViewport({scale});
                const outputScale = readerContext.pdfOutputScale(viewport);
                const canvas = document.createElement("canvas");
                const width = Math.ceil(viewport.width * outputScale), height = Math.ceil(viewport.height * outputScale);
                if (width * height > readerContext.pdfPixelBudget()) return;
                canvas.width = width; canvas.height = height;
                const task = page.render({canvasContext:/** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d")),viewport,
                  transform:outputScale === 1 ? null : [outputScale,0,0,outputScale,0,0]});
                cancelWarm = () => { cancelQueued(); task.cancel?.(); };
                const untrack = readerContext.trackReaderResource(() => task.cancel?.());
                try { await readerContext.awaitReader(task.promise, lifetime.signal); }
                finally { untrack(); canvas.width = canvas.height = 0; }
              } finally {
                cancelWarm = null;
                if (acquired) readerContext.releasePdfRenderSlot();
              }
            });
            warmTask.catch(() => {});
            /** @type {HTMLElement} */ (controls).hidden = false;
            const total = /** @type {HTMLElement} */ (document.querySelector("#page-total")),
              previous = /** @type {HTMLButtonElement} */ (document.querySelector("#page-prev")),
              next = /** @type {HTMLButtonElement} */ (document.querySelector("#page-next"));
            const inputHidden = readerContext.pageInput.hidden, totalHidden = total.hidden;
            const previousLabel = previous.getAttribute("aria-label"), nextLabel = next.getAttribute("aria-label");
            const previousWasDisabled = previous.disabled, nextWasDisabled = next.disabled;
            readerContext.pageInput.hidden = true;
            total.hidden = true;
            previous.disabled = false; next.disabled = false;
            previous.setAttribute("aria-label", "上一页");
            next.setAttribute("aria-label", "下一页");
            readerContext.status.textContent = "正在检查文档，可顺序阅读";
            /** @param {import('../../../typings/reader-page-window-strict').WindowShell} shell @param {number | boolean} priority */
            const renderPreview = (shell, priority = readerContext.pdfPagePriority(shell)) => {
              const generation = readerContext.readerRuntime.currentGeneration("pdf");
              readerContext.renderPdfInBackground(shell, false, priority)?.then(() => {
                if (!previewActive || shell.dataset.renderState !== "rendered") return;
                shell.dataset.previewPageReady = "1";
                shell.dataset.previewPdfGeneration = String(generation);
                shell.dataset.previewWidth = String(shell.clientWidth);
                shell.dataset.previewZoom = String(readerContext.documentState.zoom);
              }).catch(() => {});
            };
            /** @param {number} delta */
            const turn = delta => {
              cancelWarm?.();
              if (delta < 0) previewPendingPage = 0;
              if (delta > 0 && previewPage >= previewCount) {
                if (!previewExhausted && !previewPrefixFailed) {
                  previewPendingPage = previewPage + 1;
                  readerContext.status.textContent = "正在检查文档，正在加载下一页";
                  clearTimeout(previewPrefixTimer); previewPrefixTimer = 0;
                  requestMore();
                }
                return;
              }
              if (!previewNavigationChanged && saved) readerContext.beginReaderNavigation();
              previewPage = Math.min(previewCount, Math.max(1, previewPage + delta));
              previewNavigationChanged = true;
              previewTurnUntil = performance.now() + 1500;
              previewAnchor = {page:previewPage, top:null};
              let shell = previewPages.get(previewPage);
              if (!shell) {
                shell = document.createElement("section");
                shell.className = "reader-page reader-pdf-opening";
                shell.dataset.page = String(previewPage);
                shell.style.aspectRatio = /** @type {import('../../../typings/reader-page-window-strict').WindowShell} */ (previewShell).style.aspectRatio;
                shell.setAttribute("role", "region");
                shell.setAttribute("aria-label", `第 ${previewPage} 页，正在检查文档`);
                const text = document.createElement("div");
                text.className = "reader-pdf-text"; text.setAttribute("role", "document");
                text.setAttribute("aria-label", `第 ${previewPage} 页正文`); shell.append(text);
                const pageState = document.createElement("div");
                pageState.className = "reader-page-state";
                readerContext.setPdfPageLoadingState(pageState, previewPage); shell.append(pageState);
                const after = [...previewPages.entries()].find(([number]) => number > previewPage)?.[1];
                if (after) readerContext.content.insertBefore(shell, after); else readerContext.content.insertBefore(shell, previewPadding);
                previewPages.set(previewPage, shell);
              }
              // A temporary end spacer prevents button navigation from being
              // clamped when fewer than one viewport of verified prefix pages
              // follows the target. It represents no page or count.
              if (!previewPadding) {
                previewPadding = document.createElement("div");
                previewPadding.setAttribute("aria-hidden", "true");
                previewPadding.style.height = `${readerContext.viewport.clientHeight}px`;
                readerContext.content.appendChild(previewPadding);
              }
              shell.scrollIntoView({block:"start"});
              // Explicit next/previous wins over an incomplete old page even
              // when a sliver of that page remains inside the viewport.
              for (const other of previewPages.values()) {
                if (other === shell || other.dataset.renderState !== "rendering" ||
                    readerContext.pdfSelectionIntersects(other)) continue;
                other._pdfRenderCancelled = true;
                other._pdfRenderNeedsRequeue = true;
                other._renderCancel?.();
              }
              renderPreview(shell, true);
              if (delta > 0 && previewPage === previewCount) requestMore();
              else if (delta > 0 && previewPage === previewCount - 1) scheduleMore();
            };
            /** @param {Event} event */
            const onPrevious = event => { event.stopImmediatePropagation(); turn(-1); };
            /** @param {Event} event */
            const onNext = event => { event.stopImmediatePropagation(); turn(1); };
            const ensureSequentialShells = (start = 2) => {
              for (let number=start; number<=previewCount; number++) {
                if (previewPages.has(number)) continue;
                const shell=document.createElement("section");
                shell.className="reader-page reader-pdf-opening";
                shell.dataset.page=String(number);
                shell.style.aspectRatio=/** @type {import('../../../typings/reader-page-window-strict').WindowShell} */ (previewShell).style.aspectRatio;
                shell.setAttribute("role","region");
                shell.setAttribute("aria-label",`第 ${number} 页，正在检查文档`);
                const text=document.createElement("div");
                text.className="reader-pdf-text";text.setAttribute("role","document");
                text.setAttribute("aria-label",`第 ${number} 页正文`);shell.append(text);
                const pageState=document.createElement("div");pageState.className="reader-page-state";
                readerContext.setPdfPageLoadingState(pageState,number);shell.append(pageState);
                const after=[...previewPages.entries()].filter(([page])=>page>number).sort((a,b)=>a[0]-b[0])[0]?.[1];
                if (after) readerContext.content.insertBefore(shell,after); else readerContext.content.insertBefore(shell,previewPadding);
                previewPages.set(number,shell);
                previewObserver.observe(shell);
              }
            };
            const previewObserver=new IntersectionObserver(entries=>{
              for (const entry of entries) {
                if (!previewActive || !entry.isIntersecting || /** @type {HTMLElement} */ (entry.target).dataset.renderState === "rendered") continue;
                cancelWarm?.();
                const shell=/** @type {HTMLElement} */ (entry.target);
                renderPreview(shell);
                if (Number(shell.dataset.page) === previewCount && readerContext.isPdfPageVisible(shell)) requestMore();
              }
            },{root:readerContext.viewport,rootMargin:"200px 0px"});
            // Resolve at most one page beyond the exposed prefix. Its ref is
            // walked from the current catalog, in tree order, without /Count.
            // This is neither a total nor permission to jump arbitrarily.
            const requestMore = () => {
              if (!previewActive || previewMoreTask || previewExhausted || previewPrefixFailed ||
                  previewCount > previewPage + 1 ||
                  previewCount >= VoiceOfMLReaderSecurity.LIMITS.pdfPages) return previewMoreTask;
              const limit = previewCount + 1;
              const task = (async () => {
                const refs = await readerContext.awaitReader(
                  pdf._transport.messageHandler.sendWithPromise("ReaderGetPagePrefix", {limit}), lifetime.signal);
                if (!previewActive) return;
                if (!Array.isArray(refs) || refs.length > limit || refs.length < previewCount ||
                    (/** @type {unknown[]} */ (previewRefs)).some((ref,index) => refs[index] !== ref)) throw new Error("PDF_PREFIX_INVALID");
                if (refs.length < limit) {
                  previewExhausted = true;
                  previewPendingPage = 0;
                  readerContext.status.textContent = "正在检查文档";
                  return;
                }
                const installed = await readerContext.awaitReader(
                  /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).messageHandler.sendWithPromise("ReaderInstallPagePrefix", null), lifetime.signal);
                if (!previewActive) return;
                if (installed?.refs?.length !== refs.length || installed.refs.some((ref,index) => ref !== refs[index]))
                  throw new Error("PDF_PREFIX_INVALID");
                previewRefs = refs;
                const previousCount = previewCount;
                previewCount = refs.length;
                /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).pagesMapper.pagesNumber = previewCount;
                ensureSequentialShells(previousCount + 1);
                readerContext.status.textContent = "正在检查文档，可顺序阅读";
                if (previewPendingPage === previewCount && previewPage === previewCount - 1) {
                  previewPendingPage = 0;
                  turn(1);
                }
              })().catch(error => {
                if (!previewActive || error?.name === "AbortError") return;
                previewPrefixFailed = true;
                previewPendingPage = 0;
                readerContext.status.textContent = "正在检查文档，下一页暂不可用";
              }).finally(() => {
                if (previewMoreTask === task) previewMoreTask = null;
                if (previewActive && !previewExhausted && !previewPrefixFailed &&
                    (previewPendingPage > previewCount || readerContext.isPdfPageVisible(previewPages.get(previewCount)))) requestMore();
              });
              previewMoreTask = task;
              return task;
            };
            const scheduleMore = () => {
              if (previewPrefixTimer) return;
              previewPrefixTimer = setTimeout(() => {
                previewPrefixTimer = 0;
                requestMore();
              }, 200);
            };
            disconnectPreviewObserver=()=>previewObserver.disconnect();
            ensureSequentialShells();
            const onScroll = () => {
              if (performance.now() < previewTurnUntil) return;
              const shell = readerContext.pageAtMarker();
              const number = Number(shell?.dataset.page);
              if (previewActive && shell && number >= 1 && number <= previewCount) {
                if (number !== 1 && !previewNavigationChanged && saved) readerContext.beginReaderNavigation();
                if (number !== 1) previewNavigationChanged = true;
                previewPage = number;
                previewAnchor = {page:number, top:shell.getBoundingClientRect().top};
                if (number === previewCount) requestMore();
                else if (number === previewCount - 1) scheduleMore();
              }
            };
            const onScrollIntent = () => {
              previewTurnUntil = 0; previewPendingPage = 0;
            };
            /** @param {KeyboardEvent} event */
            const onPageKeyIntent = event => {
              if (!event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey &&
                  !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(/** @type {Element | null} */ (event.target)?.tagName || "") &&
                  ["PageDown", "PageUp", "ArrowDown", "ArrowUp", " "].includes(event.key)) onScrollIntent();
            };
            readerContext.viewport.addEventListener("scroll", onScroll, {passive:true});
            for (const type of ["wheel", "touchstart", "pointerdown"])
              readerContext.viewport.addEventListener(type, onScrollIntent, {passive:true});
            document.addEventListener("keydown", onPageKeyIntent, true);
            previous.addEventListener("click", onPrevious, true);
            next.addEventListener("click", onNext, true);
            removePreviewControls = () => {
              previous.removeEventListener("click", onPrevious, true);
              next.removeEventListener("click", onNext, true);
              readerContext.viewport.removeEventListener("scroll", onScroll);
              for (const type of ["wheel", "touchstart", "pointerdown"])
                readerContext.viewport.removeEventListener(type, onScrollIntent);
              document.removeEventListener("keydown", onPageKeyIntent, true);
              readerContext.pageInput.hidden = inputHidden; total.hidden = totalHidden;
              previous.disabled = previousWasDisabled; next.disabled = nextWasDisabled;
              if (previousLabel === null) previous.removeAttribute("aria-label"); else previous.setAttribute("aria-label", previousLabel);
              if (nextLabel === null) next.removeAttribute("aria-label"); else next.setAttribute("aria-label", nextLabel);
            };
            startValidation?.();
          }).catch(() => { startValidation?.(); });
        }
        const timed = Promise.withResolvers();
        const timer = setTimeout(() => timed.reject(Object.assign(new Error("PDF 检查超时，请重试加载。"),
          {code:"READER_PDF_TRANSPORT"})), readerContext.READER_PROXY_TIMEOUT_MS);
        try {
          /** @type {Promise<{count: number, refs: unknown[]}> | null} */
          let validation = null;
          const validationStarted = Promise.withResolvers();
          startValidation = () => {
            if (!validation) {
              validation = /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).messageHandler.sendWithPromise("ReaderValidatePageCount", null);
              validationStarted.resolve(validation);
            }
            return validation;
          };
          if (prefixTask) validationTimer = setTimeout(() => startValidation?.(),350);
          else startValidation();
          const verified = await readerContext.awaitReader(Promise.race([
            validationStarted.promise, timed.promise
          ]), lifetime.signal);
          const pendingTurn = previewPendingPage;
          previewActive = false;
          // Both prefix tasks observe previewActive immediately after their
          // worker response; they cannot publish beyond this handoff.
          if (!Number.isSafeInteger(verified?.count) || verified.count < 1 ||
              verified.count > VoiceOfMLReaderSecurity.LIMITS.pdfPages) throw new Error("PDF 页数验证失败");
          verifiedCount = verified.count;
          if (previewRefs && (verified.refs?.length < previewRefs.length ||
              previewRefs.some((ref, index) => verified.refs[index] !== ref)))
            throw new Error("PDF_PREFIX_CHANGED");
          // A click at the frontier may still be waiting for the next ref when
          // full validation wins. Carry that request into the normal reader.
          if (pendingTurn > 0 && pendingTurn <= verifiedCount && pendingTurn === previewPage + 1) {
            if (!previewNavigationChanged && saved) readerContext.beginReaderNavigation();
            previewNavigationChanged = true;
            previewAnchor = {page:pendingTurn, top:readerContext.viewport.getBoundingClientRect().top};
          }
        } finally { clearTimeout(timer); }
      } catch (error) {
        (/** @type {(() => void) | null} */ (cancelWarm))?.();
        (/** @type {HTMLDivElement | null} */ (previewPadding))?.remove();
        if (provisionalDocument && readerContext.pdfDocument === pdf) readerContext.pdfDocument = null;
        for (const shell of previewPages.values()) { shell._renderCancel?.(); shell.remove(); }
        throw error;
      } finally {
        previewActive = false;
        clearTimeout(validationTimer);
        clearTimeout(previewPrefixTimer);
        releasePrefixTimeout();
        (/** @type {(() => void) | null} */ (cancelWarm))?.();
        cleanupControls();
        preservePreview = verifiedCount !== null && !readerContext.readerAbortController.signal.aborted;
        untrackPreview();
        if (!readerContext.readerAbortController.signal.aborted) gateControls.hidden = gateWasHidden;
        if (!readerContext.readerAbortController.signal.aborted && controls) {
          controls.hidden = gateWasHidden;
          readerContext.pageInput.disabled = previousDisabled;
          readerContext.bookmarkRibbon.disabled = bookmarkDisabled;
        }
      }
      readerContext.assertReaderActive();
      pdf._pdfInfo.numPages = verifiedCount;
      /** @type {NonNullable<import('../../../typings/reader-page-window-strict').PdfPreviewDocument['_transport']>} */ (pdf._transport).pagesMapper.pagesNumber = verifiedCount;
      delete pdf._pdfInfo.readerPageCountPending;
      if (previewShell) {
        const anchor = previewNavigationChanged && previewAnchor ? previewPages.get(previewAnchor.page) : readerContext.pageAtMarker();
        if (anchor && previewPages.has(Number(anchor.dataset.page)))
          previewAnchor = {page:Number(anchor.dataset.page),top:anchor.getBoundingClientRect().top};
        for (const [number, shell] of [...previewPages]) {
          if (number === 1) continue;
          const incomplete = !shell.querySelector("canvas.ready");
          const requested = previewNavigationChanged && previewAnchor?.page === number;
          if (shell._renderPromise && !requested) {
            if (incomplete) shell._renderCancel?.();
            await shell._renderPromise.catch(() => {});
          }
          if (!requested && (incomplete || !shell.querySelector("canvas.ready"))) {
            shell.remove(); previewPages.delete(number); continue;
          }
          shell.classList.remove("reader-pdf-opening");
          shell.setAttribute("aria-label", `第 ${number} 页`);
          if (!incomplete && (String(readerContext.readerRuntime.currentGeneration("pdf")) !== shell.dataset.previewPdfGeneration ||
              Number(shell.dataset.previewWidth) !== shell.clientWidth || Number(shell.dataset.previewZoom) !== readerContext.documentState.zoom))
            delete shell.dataset.renderState;
          delete shell.dataset.previewPageReady; delete shell.dataset.previewPdfGeneration;
          delete shell.dataset.previewWidth; delete shell.dataset.previewZoom;
          shell.tabIndex = 0;
          shell.addEventListener("focus", () => readerContext.renderPdfInBackground(shell));
        }
        if (String(readerContext.readerRuntime.currentGeneration("pdf")) !== previewShell.dataset.previewPdfGeneration ||
            previewWidth !== previewShell.clientWidth || previewZoom !== readerContext.documentState.zoom)
          delete previewShell.dataset.renderState;
        previewShell.classList.remove("reader-pdf-opening");
        previewShell.setAttribute("aria-label", "第 1 页");
        delete previewShell.dataset.previewReady;
        delete previewShell.dataset.previewPdfGeneration;
        previewShell.tabIndex = 0;
        previewShell.addEventListener("focus", () => readerContext.renderPdfInBackground(/** @type {import('../../../typings/reader-page-window-strict').WindowShell} */ (previewShell)));
      }
      if (previewAnchor && !previewPages.has(previewAnchor.page) && !previewNavigationChanged) previewAnchor = null;
    }
    // Publish a pending layout before the verified count enables page jumps.
    // Navigation can wait for shell lookup without waiting for a canvas draw.
    const layout = Promise.withResolvers();
    readerContext.pdfShellLayoutReady = layout.promise;
    const opening = readerContext.readerRuntime.currentGeneration("navigation");
    const superseded = /** @type {PromiseWithResolvers<null>} */ (Promise.withResolvers());
    const onNavigation = () => {
      if (!readerContext.isReaderGenerationCurrent("navigation", opening)) superseded.resolve(null);
    };
    window.addEventListener("voice-reader-navigation-changed", onNavigation);
    try {
      await renderVerifiedPdf(pdf, previewShell, previewAnchor, previewPages, previewPadding, superseded.promise, () => {
        readerContext.pdfShellLayoutReady = null;
        layout.resolve(true);
      });
    } catch (error) {
      readerContext.assertReaderActive();
      // A live opening failure must not be mistaken for reader disposal.
      if (/** @type {{name?: string} | null} */ (error)?.name === "AbortError")
        throw new Error("PDF 页面加载中断，请重试。", { cause: error });
      throw error;
    } finally {
      window.removeEventListener("voice-reader-navigation-changed", onNavigation);
      readerContext.pdfShellLayoutReady = null;
      layout.resolve(false);
    }
  }

  /** @param {VerifiedPdf} pdf
   * @param {import('../../../typings/reader-page-window-strict').WindowShell | null} previewShell
   * @param {PreviewAnchor | null} previewAnchor
   * @param {Map<number, import('../../../typings/reader-page-window-strict').WindowShell>} previewPages
   * @param {HTMLDivElement | null} previewPadding
   * @param {Promise<null>} superseded
   * @param {() => void} publishLayout */
  async function renderVerifiedPdf(pdf, previewShell, previewAnchor, previewPages, previewPadding, superseded, publishLayout) {
    const openingNavigation = readerContext.readerRuntime.currentGeneration("navigation");
    const ownsOpeningPosition = () => readerContext.isReaderGenerationCurrent("navigation", openingNavigation);
    readerContext.pdfDocument = pdf;
    readerContext.updateDocumentState({ pageCount: pdf.numPages });
    if (pdf.sourceSha256 && readerContext.ocrManifestUrl) {
      // Existing OCR is optional and never allowed to change the source image.
      // Attach it only when its manifest identifies these exact source bytes.
      try {
        const manifest = await readerContext.loadPdfOcrManifest();
        if (manifest?.source_sha256 !== pdf.sourceSha256) throw new Error("DJVU_OCR_SOURCE_MISMATCH");
      } catch (error) {
        if (readerContext.readerAbortController.signal.aborted) throw error;
        console.warn("DjVu OCR text does not match this source; using embedded text", error);
        readerContext.ocrManifestUrl = "";
        readerContext.pdfOcrManifest = null;
        readerContext.pdfOcrManifestPromise = null;
      }
    }
    readerContext.pageInput.max = String(readerContext.documentState.pageCount);
    /** @type {HTMLElement} */ (document.querySelector("#page-total")).textContent = `/ ${readerContext.documentState.pageCount}`;
    readerContext.status.textContent = `${pdf.numPages} 页`;
    await readerContext.getInitialReaderRestoration();
    const initialPage = previewAnchor?.page || readerContext.initialReaderPage(pdf.numPages);
    let initialRenderGate = true;
    const firstPage = ownsOpeningPosition() ? await Promise.race([
      readerContext.measurePdf(readerContext.awaitReader(pdf.getPage(initialPage)), "page", initialPage).catch(error => {
        if (!ownsOpeningPosition()) return null;
        throw error;
      }), superseded
    ]) : null;
    readerContext.assertReaderActive();
    const firstViewport = firstPage?.getViewport({ scale: 1 }) || { width: 612, height: 792 };
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (readerContext.readerAbortController.signal.aborted) return;
          /** @type {HTMLElement} */ (entry.target).dataset.renderVisible = entry.isIntersecting && readerContext.isPdfPageVisible(entry.target) ? "1" : "0";
          if (entry.isIntersecting) readerContext.renderPdfInBackground(entry.target);
        }),
      { root: document.querySelector("#viewport"), rootMargin: `${readerContext.PDF_PREFETCH_MARGIN}px 0px` }
    );
    const visibleObserver = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (readerContext.readerAbortController.signal.aborted) return;
          /** @type {HTMLElement} */ (entry.target).dataset.renderVisible = entry.isIntersecting ? "1" : "0";
          if (entry.isIntersecting) {
            readerContext.promotePdfRenderWaiter(entry.target);
            if (readerContext.pdfUserHasScrolled || /** @type {HTMLElement} */ (entry.target).dataset.renderState !== "rendering")
              readerContext.renderPdfInBackground(entry.target, false, readerContext.pdfPagePriority(entry.target));
          }
        }),
      { root: document.querySelector("#viewport"), threshold: 0 }
    );
    const pageObserver = new IntersectionObserver(() => readerContext.scheduleMarkerSync(), {
      root: document.querySelector("#viewport"),
      threshold: [0, 0.5, 1]
    });
    /** @param {import('../../../typings/reader-page-window-strict').WindowShell} shell */
    const observeShell = (shell) => {
      if (initialRenderGate) {
        shell._pdfObserversPending = true;
        return;
      }
      observer.observe(shell);
      visibleObserver.observe(shell);
      pageObserver.observe(shell);
    };
    const releaseInitialRenderGate = () => {
      initialRenderGate = false;
      for (const shell of /** @type {NodeListOf<import('../../../typings/reader-page-window-strict').WindowShell>} */ (readerContext.content.querySelectorAll(".reader-page"))) {
        if (!shell._pdfObserversPending) continue;
        delete shell._pdfObserversPending;
        observeShell(shell);
      }
    };
    readerContext.trackReaderResource(() => {
      observer.disconnect();
      visibleObserver.disconnect();
      pageObserver.disconnect();
    });
    /** @param {number} page */
    const createShell = (page) => {
      if (previewPages.has(page)) {
        const existing = /** @type {import('../../../typings/reader-page-window-strict').WindowShell} */ (previewPages.get(page));
        // Virtual-window eviction must not resurrect stale canvas/text.
        previewPages.delete(page);
        observeShell(existing);
        return existing;
      }
      const shell = document.createElement("section");
      shell.className = "reader-page";
      shell.dataset.page = String(page);
      shell.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`;
      if (readerContext.pdfV3Map) {
        const geometry = /** @type {import('../../../typings/reader-v3-strict').PageMap['pages'][number]} */ (readerContext.pdfV3Map.pages[page - 1]);
        shell.style.aspectRatio = `${geometry.width} / ${geometry.height}`;
      }
      shell.tabIndex = 0;
      shell.setAttribute("role", "region");
      shell.setAttribute("aria-label", `第 ${page} 页`);
      // The canvas is created by the renderer on first use: a 300x150 default
      // canvas per shell costs ~180 KB, so a 250-page PDF held ~45 MB of blank
      // backing stores before any page was visible.
      const textLayer = document.createElement("div");
      textLayer.className = "reader-pdf-text";
      textLayer.setAttribute("role", "document");
      textLayer.setAttribute("aria-label", `第 ${page} 页正文`);
      shell.append(textLayer);
      const pageState = document.createElement("div");
      pageState.className = "reader-page-state";
      readerContext.setPdfPageLoadingState(pageState, page);
      shell.appendChild(pageState);
      shell.addEventListener("focus", () => readerContext.renderPdfInBackground(shell));
      observeShell(shell);
      return shell;
    };
    const firstShell = previewShell || createShell(1);
    if (!previewShell) readerContext.content.appendChild(firstShell);
    else for (const shell of previewPages.values()) observeShell(shell);
    readerContext.pdfShellWindow = readerContext.createPdfShellWindow(pdf.numPages, firstShell, createShell, (shell) => {
      observer.unobserve(shell);
      visibleObserver.unobserve(shell);
      pageObserver.unobserve(shell);
    }, firstViewport.height / firstViewport.width, previewPages);
    const drawWhileBatching = !readerContext.pdfShellWindow && !previewShell && readerContext.extension === "pdf";
    // The target can paint once its own batch is connected, but restore and
    // adjacent observers still need the full layout (including near the end).
    const mounted = drawWhileBatching && initialPage > 1 ? Promise.withResolvers() : null;
    const shellsReady = readerContext.pdfShellsReady = readerContext.pdfShellWindow
      ? Promise.resolve() : readerContext.appendShellsBatched(createShell, pdf.numPages, 24, mounted
        ? endPage => { if (endPage >= initialPage) mounted.resolve(undefined); } : undefined);
    shellsReady.catch(() => {});
    publishLayout();
    let releaseObservers = !drawWhileBatching;
    try {
      const targetShell = !ownsOpeningPosition() || (drawWhileBatching && initialPage === 1)
        ? firstShell
        : readerContext.pdfShellWindow
          ? readerContext.pdfShellWindow.ensure(initialPage)
          : (await (mounted ? Promise.race([mounted.promise, shellsReady]) : shellsReady),
            readerContext.content.querySelector(`.reader-page[data-page="${initialPage}"]`));
      readerContext.assertReaderActive();
      if (!targetShell) throw new Error("PDF initial page shell missing");
      previewPadding?.remove();
      if (previewAnchor && ownsOpeningPosition()) {
        const anchor = readerContext.content.querySelector(`.reader-page[data-page="${previewAnchor.page}"]`);
        if (anchor) {
          readerContext.viewport.scrollTop += anchor.getBoundingClientRect().top - /** @type {number} */ (previewAnchor.top);
          readerContext.updateDocumentState({page:previewAnchor.page});
          readerContext.pageInput.value = String(previewAnchor.page);
          readerContext.pageNavigationLockUntil = performance.now() + 500;
          // Initial restoration uses this generation; marker sync is locked
          // briefly while the verified shell window takes ownership.
        }
      }
      readerContext.markReaderContentReady();
      const shouldDraw = ownsOpeningPosition();
      if (!previewShell && shouldDraw) readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
      try {
        if (shouldDraw) await Promise.race([readerContext.renderPdfShell(targetShell, false, true), superseded]);
      } catch (error) {
        // New visible demand can preempt the first draw, and a virtual-window
        // jump can evict its shell entirely. Neither is a document failure.
        const shell = /** @type {import('../../../typings/reader-page-window-strict').WindowShell} */ (targetShell);
        const cancelled = shell._pdfRenderCancelled || !shell.isConnected;
        if (readerContext.readerAbortController.signal.aborted || (ownsOpeningPosition() && (!cancelled ||
            /** @type {{name?: string} | null} */ (error)?.name !== "AbortError"))) throw error;
      }
      readerContext.markReaderContentReady();
      if (!previewShell && !drawWhileBatching && targetShell.isConnected && ownsOpeningPosition())
        readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
      await shellsReady;
      readerContext.assertReaderActive();
      // A short last mounted slice can clamp the initial scroll. Correct it
      // once there is enough layout, but never after a newer navigation.
      if (drawWhileBatching && initialPage > 1 && ownsOpeningPosition())
        readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
      releaseObservers = true;
    } finally {
      if (releaseObservers && !readerContext.readerAbortController.signal.aborted) releaseInitialRenderGate();
    }
    const isDjvu = readerContext.extension === "djvu" || readerContext.pdfV3Manifest?.primary.kind === "djvu";
    if (pdf.outlineNeedsFullSource) {
      // An ambiguous range index may hide document-level NAVM after page
      // components. Keep first paint fast; fetch the whole original only when
      // the reader explicitly opens its contents panel.
      let requested=false;
      /** @param {string} label @returns {import('../../../typings/reader-page-window-strict').PdfOutlineEntry} */
      const outlineEntry=(label)=>({label,depth:0,activate:async(generation)=>{
        if (requested) return false;
        requested=true;
        try {
          const entries=await loadPdfOutline(pdf, isDjvu);
          if (!readerContext.isReaderGenerationCurrent("navigation",generation)) return false;
          readerContext.setToc(entries || [outlineEntry("原件目录加载失败，点击重试")]);
        } finally { requested=false; }
        return false;
      }});
      readerContext.setToc([outlineEntry("加载原件目录")]);
    } else {
      const outlineReady = loadPdfOutline(pdf, isDjvu).then((entries) => {
        if (entries?.length) readerContext.setToc(entries);
      });
      outlineReady.catch(() => {});
    }
    readerContext.assertReaderActive();
  }

  return {
    pdfManifestSource,
    pdfPageEntry,
    appendShellsBatched,
    pdfSelectionIntersects,
    correctPdfCrossPageSelection,
    createPdfShellWindow,
    loadPdfOutline,
    seedPdfPageGeometry,
    renderPdfPages,
    renderImagePages,
    renderPdf
  };
}
