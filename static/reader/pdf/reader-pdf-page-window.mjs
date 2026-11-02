export function createReaderPdfPageWindow(readerContext) {
  async function preloadPdfFirstPage(total) {
    // Hybrid PDFs use the primary-document race below. A standalone preload
    // would guarantee preview traffic before a warm PDF can win.
    if (readerContext.pdfV3Manifest || readerContext.pdfHybridUrl) return;
    await readerContext.getInitialReaderRestoration();
    try {
      const source = readerContext.pdfPageManifest || readerContext.pdfManifestSource();
      if (!source) return;
      if (["jxl", "png", "mixed"].includes(source.codec)) return;
      const page = readerContext.initialReaderPage(total);
      readerContext.pdfFirstPagePreloadPage = page;
      const pageUrl = new URL(source.pageUrl(page));
      const early = window.__VOICE_PDF_PRELOAD__;
      if (early?.image && early.pageUrl === pageUrl.href) {
        readerContext.pdfFirstPagePreload = early.image;
        // Reuse an existing request at demand priority when available.
        readerContext.pdfFirstPagePreload.fetchPriority = "high";
      }
      else if (!navigator.connection?.saveData) {
        readerContext.pdfFirstPagePreload = new Image();
        readerContext.pdfFirstPagePreload.decoding = "async";
        readerContext.pdfFirstPagePreload.fetchPriority = "high";
        readerContext.pdfFirstPagePreload.src = pageUrl.href;
      }
    } catch (_) {}
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

  // Per-book PDF-pages state; renderPdfPages resets it.
  let pdfPagesBook = { hybridFailed: false, manifestToc: false, initialShown: false, outlineStarted: false, seedRatio: 0 };

  function startPdfHybridDocument(totalPages = readerContext.documentState.pageCount) {
    if (readerContext.pdfV3Manifest?.primary.kind === "djvu" || readerContext.pdfPageManifest?.sourceFormat === "djvu") return;
    // A failed primary leaves hybrid mode for the rest of this book.
    if (pdfPagesBook.hybridFailed || readerContext.pdfHybridDocumentPromise) return;
    readerContext.pdfHybridUrl = readerContext.pdfPrimarySource();
    if (!readerContext.pdfHybridUrl) return;
    const book = pdfPagesBook;
    const documentPromise = readerContext.loadPdfDocument(readerContext.pdfHybridUrl).then((pdf) => {
      readerContext.assertReaderActive();
      if (book.hybridFailed) throw new Error("PDF_PRIMARY_TRANSPORT");
      if (pdf.numPages !== totalPages) {
        pdf.destroy?.()?.catch?.(() => {});
        throw new Error("PDF_PRIMARY_PAGE_COUNT_MISMATCH");
      }
      readerContext.pdfDocument = pdf;
      readerContext.drainPdfRangeWaiters?.();
      readerContext.clearPdfManifestPrefetches();
      readerContext.cancelSpeculativePdfRenders(readerContext.pageAtMarker?.());
      readerContext.syncCapabilityControls();
      maybeLoadHybridOutline(book);
      return pdf;
    });
    readerContext.pdfHybridDocumentPromise = documentPromise;
    documentPromise.catch((error) => {
      if (error?.name === "AbortError" || readerContext.readerLifecycle.disposed ||
          readerContext.pdfHybridDocumentPromise !== documentPromise) return;
      console.warn("Primary PDF unavailable; page stream retained", error);
      leavePdfHybridMode(book);
    });
  }

  // The image stream becomes the only surface: ordinary prioritized image
  // admission and manifest prefetch replace the PDF-preview race.
  function leavePdfHybridMode(book = pdfPagesBook, error = null) {
    if (book !== pdfPagesBook || book.hybridFailed || readerContext.readerLifecycle.disposed) return;
    if (error) console.warn("Primary PDF failed after opening; page stream retained", error);
    book.hybridFailed = true;
    const pdf = readerContext.pdfDocument;
    readerContext.pdfDocument = null;
    readerContext.pdfHybridUrl = "";
    readerContext.drainPdfRangeWaiters?.();
    // The page stream stays readable, but without OCR it has no text layer.
    readerContext.pdfHybridSearchUnavailable = true;
    if (pdf && error) pdf.destroy?.()?.catch?.(() => {});
    for (const shell of readerContext.content.querySelectorAll(".reader-page[data-pdf-hybrid]")) {
      delete shell.dataset.pdfHybrid;
      if (shell.dataset.renderState !== "rendered") shell._pdfRenderNeedsRequeue = true;
    }
    readerContext.syncCapabilityControls();
    readerContext.scheduleVisiblePdfRenderReconciliation(true);
    const page = readerContext.documentState.page;
    if (page) readerContext.schedulePdfManifestPrefetch(page);
  }

  async function loadPdfOutline(pdf) {
    if (typeof pdf?.getOutline !== "function") return;
    try {
      const outline = await readerContext.awaitReader(pdf.getOutline()),
        entries = [];
      const cleanLabel = (value) =>
        String(value || "未命名章节")
          .replace(/[\u2610-\u2612\u25a1]\s*[xX×]?\s*$/u, "")
          .trim() || "未命名章节";
      const append = async (items, depth = 0) => {
        for (const item of items || []) {
          readerContext.assertReaderActive();
          let destination = item.dest,
            page = 0;
          if (typeof destination === "string") destination = await pdf.getDestination(destination);
          if (destination && destination[0]) {
            try {
              page = (await pdf.getPageIndex(destination[0])) + 1;
            } catch (_) {}
          }
          entries.push({
            label: page ? `${cleanLabel(item.title)} · 第 ${page} 页` : cleanLabel(item.title),
            depth,
            activate: (generation) => (page ? readerContext.goToPage(page, generation) : false)
          });
          await append(item.items, depth + 1);
        }
      };
      await append(outline);
      readerContext.assertReaderActive();
      return entries;
    } catch (error) {
      if (!readerContext.readerAbortController.signal.aborted)
        console.warn("PDF outline could not be loaded", error);
    }
  }

  // A page manifest without its own TOC takes the primary PDF outline, after
  // the opening page is shown so outline reads never delay the first screen.
  function maybeLoadHybridOutline(book = pdfPagesBook) {
    if (book !== pdfPagesBook || book.manifestToc || book.outlineStarted || !book.initialShown) return;
    const pdf = readerContext.pdfDocument;
    if (!pdf || !readerContext.pdfHybridUrl) return;
    book.outlineStarted = true;
    loadPdfOutline(pdf).then((entries) => {
      if (book !== pdfPagesBook || book.manifestToc || !entries?.length || readerContext.readerLifecycle.disposed) return;
      readerContext.setToc(entries);
    }).catch(() => {});
  }

  // The first measured page geometry replaces the A4 estimate for unrendered
  // shells and virtual chunk heights. Callers run inside applyPdfShellGeometry,
  // which keeps the reading anchor in place.
  function seedPdfPageGeometry(width, height) {
    if (pdfPagesBook.seedRatio || readerContext.pdfV3Map || !(width > 0 && height > 0)) return;
    const ratio = height / width;
    pdfPagesBook.seedRatio = ratio;
    if (Math.abs(ratio / 1.414 - 1) < .001) return;
    for (const shell of readerContext.content.querySelectorAll(".reader-page:not([data-page-geometry])"))
      shell.style.aspectRatio = `1 / ${ratio}`;
    readerContext.pdfShellWindow?.setDefaultRatio(ratio);
  }

  async function appendShellsBatched(createShell, total, batchSize) {
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
      await readerContext.waitForReader();
    }
  }

  function pdfSelectionIntersects(element) {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return false;
    if (element.contains(selection.anchorNode) || element.contains(selection.focusNode)) return true;
    return !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(element);
  }

  function correctPdfCrossPageSelection(x, y, start = null) {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return;
    const anchorNode = start?.anchorNode || selection.anchorNode;
    const anchorOffset = start?.anchorNode ? start.anchorOffset : selection.anchorOffset;
    if (!start?.anchorNode && selection.isCollapsed) return;
    const origin = anchorNode?.parentElement?.closest(".reader-page");
    let target = document.elementFromPoint(x, y)?.closest(".reader-page");
    const caret = start?.anchorNode && readerContext.independentTextCaret(document, x, y);
    if (caret && origin?.contains(anchorNode) && readerContext.content.contains(caret.node)) {
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
    if (!origin || !target || origin === target || !readerContext.content.contains(origin) || !readerContext.content.contains(target)) return;
    const runs = [...target.querySelectorAll(".reader-pdf-text-run")].filter((run) => run.firstChild?.nodeType === Node.TEXT_NODE);
    if (!runs.length) return;
    let nearest = null, distance = Infinity;
    for (const run of runs) {
      const rect = run.getBoundingClientRect();
      const dx = Math.max(rect.left - x, x - rect.right, 0);
      const dy = Math.max(rect.top - y, y - rect.bottom, 0);
      const gap = Math.hypot(dx, dy);
      if (gap < distance) { nearest = run; distance = gap; }
    }
    const node = nearest.firstChild, rect = nearest.getBoundingClientRect();
    let offset;
    if (y < rect.top || y > rect.bottom) {
      offset = y < rect.top ? 0 : node.length;
    } else {
      const range = document.createRange();
      const vertical = getComputedStyle(nearest).writingMode.startsWith("vertical");
      const position = vertical ? y : x;
      let low = 0, high = node.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        range.setStart(node, mid);
        range.setEnd(node, mid + 1);
        const glyph = range.getBoundingClientRect();
        const center = vertical ? (glyph.top + glyph.bottom) / 2 : (glyph.left + glyph.right) / 2;
        if (center < position) low = mid + 1;
        else high = mid;
      }
      offset = low;
    }
    selection.setBaseAndExtent(anchorNode, anchorOffset, node, offset);
  }

  function createPdfShellWindow(total, firstShell, createShell, unobserve, defaultRatio, retainedShells = null) {
    // `defaultRatio` may be replaced once a real page geometry is known.
    if (total <= 256) return null;
    const chunkSize = 32, chunks = [], ratios = new Map();
    let frame = 0, disposed = false;
    const readWidth = () => {
      const style = getComputedStyle(readerContext.content);
      return (readerContext.content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * readerContext.documentState.zoom;
    };
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
    if (retainedShells?.size) readerContext.content.insertBefore(fragment, retainedShells.values().next().value);
    else readerContext.content.appendChild(fragment);
    const selection = retainedShells ? document.getSelection() : null;
    const savedSelection = selection?.rangeCount && [...retainedShells.values()].some(shell => readerContext.pdfSelectionIntersects(shell))
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
        retainedShells.delete(Number(shell.dataset.page));
      }
      for (let page=chunk.start;page<=chunk.end;page++) {
        const existing=chunk.element.querySelector(`.reader-page[data-page="${page}"]`);
        if (existing) continue;
        const next=[...chunk.element.children].find(node => Number(node.dataset.page) > page);
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
    function canUnmount(chunk) {
      return chunk.mounted && !chunk.element.contains(document.activeElement) &&
        !readerContext.pdfSelectionIntersects(chunk.element);
    }
    function measureChunk(chunk) {
      for (const shell of chunk.element.children) {
        const bounds = shell.getBoundingClientRect();
        if (bounds.width && bounds.height) ratios.set(Number(shell.dataset.page), bounds.height / bounds.width);
      }
    }
    function unmount(chunk, width) {
      if (!chunk.mounted || chunk.element.contains(document.activeElement) ||
          readerContext.pdfSelectionIntersects(chunk.element)) return;
      for (const shell of chunk.element.children) {
        const page = Number(shell.dataset.page);
        shell._textEpoch = (shell._textEpoch || 0) + 1;
        shell._renderCancel?.();
        shell._hybridCancel?.();
        shell._v3PreviewRelease?.();
        unobserve(shell);
        readerContext.pdfManifestShells[page] = undefined;
      }
      chunk.element.replaceChildren();
      chunk.element.style.height = `${chunkHeight(chunk, width)}px`;
      chunk.element.setAttribute("aria-hidden", "true");
      chunk.mounted = false;
    }
    function show(index) {
      if (disposed) return;
      const anchor = readerContext.pageAtMarker();
      const before = readerContext.isPdfPageVisible(anchor) ? anchor.getBoundingClientRect().top : undefined;
      const retiring = chunks.filter((chunk, i) => Math.abs(i - index) > 2 && canUnmount(chunk));
      const width = retiring.length ? readWidth() : 0;
      // Capture all retiring page geometry before mounting or removing any chunks.
      for (const chunk of retiring) measureChunk(chunk);
      for (let i = Math.max(0, index - 2); i <= Math.min(chunks.length - 1, index + 2); i++)
        mount(chunks[i]);
      for (const chunk of retiring) unmount(chunk, width);
      if (anchor?.isConnected && before !== undefined)
        readerContext.viewport.scrollTop += anchor.getBoundingClientRect().top - before;
    }
    function sync() {
      frame = 0;
      if (disposed) return;
      const marker = readerContext.viewport.scrollTop + readerContext.viewport.clientHeight / 2;
      const index = chunks.findIndex((chunk) => chunk.element.offsetTop + chunk.element.offsetHeight > marker);
      show(index < 0 ? chunks.length - 1 : index);
    }
    mount(chunks[0]);
    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(readerContext.viewport);
    function resize() {
      if (disposed) return;
      const anchor = readerContext.pageAtMarker();
      const before = readerContext.isPdfPageVisible(anchor) ? anchor.getBoundingClientRect().top : undefined;
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
      ensure(page) {
        const index = Math.floor((page - 1) / chunkSize);
        show(index);
        return chunks[index].element.querySelector(`.reader-page[data-page="${page}"]`);
      },
      remember(shell) {
        if (!shell.isConnected) return;
        const bounds = shell.getBoundingClientRect();
        if (bounds.width && bounds.height) ratios.set(Number(shell.dataset.page), bounds.height / bounds.width);
      },
      // The caller owns anchor compensation (see seedPdfPageGeometry).
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

  async function renderPdfPages(prepared) {
    pdfPagesBook = { hybridFailed: false, manifestToc: false, initialShown: false, outlineStarted: false, seedRatio: 0 };
    const book = pdfPagesBook;
    readerContext.resetPdfLatencySamples();
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
      const { openDirectDjvu } = await import("/search/static/reader/pdf/reader-djvu-loader.mjs");
      let pdf;
      try {
        const pageMap = repository.read(manifest.page_map).then(map => readerContext.validatePageMap(map, manifest));
        pdf = await openDirectDjvu(readerContext, manifest, pageMap);
        readerContext.pdfV3Map = await pageMap;
        return await readerContext.renderPdf(pdf);
      } catch (error) {
        pdf?.destroy();
        throw error;
      }
    }
    if (manifest.kind !== "pdf-reading" && readerContext.capability.mode !== "image-pages") {
      const extension = String(readerContext.resolvedReaderData?.original_extension || "").toLowerCase();
      let originalPath = "";
      try {
        const url = new URL(readerContext.downloadUrl, location.href);
        originalPath = url.searchParams.get("path") || url.pathname;
      } catch (_) {}
      const djvu = manifest.source_format === "djvu" || extension === "djvu" || /\.djvu$/i.test(originalPath);
      if (djvu) throw new Error("DJVU_LEGACY_READING_UNSUPPORTED");
      if (!djvu) {
        const primary = readerContext.pdfPrimarySource();
        if (!primary) throw new Error("PDF_PRIMARY_REQUIRED");
        readerContext.extension = "pdf";
        readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability("pdf"));
        readerContext.readerRuntime.update("source", { extension: "pdf" });
        readerContext.syncCapabilityControls();
        return readerContext.renderPdf(readerContext.loadPdfDocument(primary));
      }
    }
    readerContext.assertReaderActive();
    const source = readerContext.pdfManifestSource();
    const totalPages = manifest.page_count;
    if (!source) throw new Error("PDF_MANIFEST_INVALID");
    book.manifestToc = Array.isArray(manifest.toc) && manifest.toc.length > 0;
    readerContext.pdfPageManifest = { ...source, pageCount: totalPages, codec: manifest.codec || "webp",
      sourceFormat: readerContext.capability.mode === "pdf-pages" ? "djvu" : "image" };
    if (["jxl", "png", "mixed"].includes(manifest.codec)) {
      readerContext.pdfPageManifest.pageUrl = page => {
        const ref = manifest.images[page - 1];
        const codec = manifest.codec === "mixed" ? ref.codec : manifest.codec;
        const path = `${source.root}/pages/page-${String(page).padStart(6, "0")}.${codec}`;
        const url = new URL(source.assetUrl(path));
        url.searchParams.set("sha256", ref.sha256);
        url.searchParams.set("bytes", String(ref.bytes));
        return url.href;
      };
      readerContext.pdfPageManifest.pageCodec = page => manifest.codec === "mixed" ? manifest.images[page - 1].codec : manifest.codec;
    }
    if (readerContext.pdfV3Manifest) readerContext.pdfPageManifest.pageUrl = () => "";
    startPdfHybridDocument(totalPages);
    readerContext.updateDocumentState({ pageCount: totalPages });
    readerContext.pageInput.max = String(totalPages);
    document.querySelector("#page-total").textContent = `/ ${totalPages}`;
    readerContext.status.textContent = `${totalPages} 页`;
    await readerContext.getInitialReaderRestoration();
    const initialPage = readerContext.initialReaderPage(totalPages);
    if (readerContext.ocrManifestUrl && !navigator.connection?.saveData) {
      readerContext.loadPdfOcrPage(initialPage).catch(() => {});
    }
    await readerContext.preloadPdfFirstPage(totalPages);
    let initialRenderGate = true;
    if (Array.isArray(manifest.toc) && manifest.toc.length)
      readerContext.setToc(
        manifest.toc.map((item) => ({
          label: `${item.title} · 第 ${item.page} 页`,
          depth: item.depth,
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
      for (const shell of readerContext.content.querySelectorAll(".reader-page")) {
        if (!shell._pdfObserversPending) continue;
        delete shell._pdfObserversPending;
        observeShell(shell);
      }
    };
    readerContext.trackReaderResource(() => {
      observer.disconnect();
      visibleObserver.disconnect();
    });
    const createShell = (page) => {
      const shell = document.createElement("section");
      shell.className = "reader-page";
      shell.dataset.page = String(page);
      if (readerContext.pdfHybridUrl) shell.dataset.pdfHybrid = "1";
      shell.style.aspectRatio = `1 / ${book.seedRatio || 1.414}`;
      if (readerContext.pdfV3Map) {
        const geometry = readerContext.pdfV3Map.pages[page - 1];
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
      if (
        page === readerContext.pdfFirstPagePreloadPage &&
        readerContext.pdfFirstPagePreload &&
        (!readerContext.pdfFirstPagePreload.complete || readerContext.pdfFirstPagePreload.naturalWidth)
      )
        shell.appendChild(readerContext.pdfFirstPagePreload);
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
    readerContext.pdfShellsReady = readerContext.pdfShellWindow ? Promise.resolve() : readerContext.appendShellsBatched(createShell, totalPages, 250);
    readerContext.pdfShellsReady.catch(() => {});
    try {
      const targetShell = readerContext.pdfShellWindow
        ? readerContext.pdfShellWindow.ensure(initialPage)
        : (await readerContext.pdfShellsReady, readerContext.content.querySelector(`.reader-page[data-page="${initialPage}"]`));
      if (!targetShell) throw new Error("PDF initial page shell missing");
      readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
      await readerContext.renderPdfManifestShell(targetShell, false, true);
      readerContext.markReaderContentReady();
      readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
    } finally {
      releaseInitialRenderGate();
    }
    book.initialShown = true;
    maybeLoadHybridOutline(book);
  }

  async function renderImagePages(prepared) {
    const response = await prepared;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = JSON.parse(
      await VoiceOfMLReaderSecurity.readText(response, VoiceOfMLReaderSecurity.LIMITS.manifestBytes)
    );
    if (!manifest || manifest.version !== 1 || manifest.kind !== "image-page-stream" ||
        !Number.isInteger(manifest.page_count) || manifest.page_count < 1 ||
        !Array.isArray(manifest.pages) || manifest.pages.length !== manifest.page_count)
      throw new Error("IMAGE_MANIFEST_INVALID");
    const normalized = {
      version: 2,
      kind: "pdf-pages",
      page_count: manifest.page_count,
      entries: manifest.pages.map((entry, index) => ({
        page: index + 1,
        path: entry.path,
        bytes: entry.bytes,
        sha256: entry.sha256
      }))
    };
    return readerContext.renderPdfPages(Promise.resolve(new Response(JSON.stringify(normalized), {
      headers: { "Content-Type": "application/json" }
    })));
  }

  async function renderPdf(prepared) {
    const pdf = await prepared;
    readerContext.assertReaderActive();
    let previewShell = null, previewAnchor = null, previewPadding = null;
    let previewNavigationChanged = false;
    const previewPages = new Map();
    if (pdf._pdfInfo?.readerPageCountPending === true) {
      // Until validation succeeds neither navigation nor history receives an
      // untrusted count. The preview uses the original page and renderer.
      const navigation = readerContext.readerRuntime.currentGeneration("navigation");
      const saved = readerContext.readerRestorationPromise
        ? await readerContext.awaitReader(readerContext.readerRestorationPromise) : null;
      const savedPage = Number(saved?.page);
      const canPreview = !saved || (savedPage === 1 && Number(saved?.pageOffset || 0) === 0 && !saved?.id);
      const lifetime = new AbortController();
      let preservePreview = false;
      const untrackPreview = readerContext.trackReaderResource(() => {
        lifetime.abort(readerContext.readerAbortError());
        previewPadding?.remove();
        if (preservePreview) return;
        for (const shell of previewPages.values()) { shell._renderCancel?.(); shell.remove(); }
      });
      let controls = null, previousDisabled = false;
      let bookmarkDisabled = false;
      let verifiedCount = null;
      let previewWidth = null, previewZoom = null;
      let provisionalDocument = false;
      let previewActive = true, previewCount = 1, previewPage = 1, previewTurnUntil = 0;
      let prefixTask = null, previewMoreTask = null, previewRefs = null;
      let previewPendingPage = 0, previewExhausted = false, previewPrefixFailed = false, previewPrefixTimer = 0;
      let warmTask = null, cancelWarm = null;
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
      document.querySelector("#page-total").textContent = "";
      const gateControls = /** @type {HTMLElement} */ (document.querySelector(".page-controls")), gateWasHidden = gateControls.hidden;
      gateControls.hidden = true;
      try {
        if (!readerContext.restorationFailed && canPreview && !readerContext.ocrManifestUrl &&
            !readerContext.pdfV3Map && !pdf.isPureXfa &&
            navigation === readerContext.readerRuntime.currentGeneration("navigation")) {
          // Prefix identities come from the current catalog, even when an old
          // linearized first-page hint exists after an incremental update.
          const refs = await readerContext.awaitReader(
            pdf._transport.messageHandler.sendWithPromise("ReaderGetPagePrefix", {limit:1}), lifetime.signal);
          const installed = await readerContext.awaitReader(
            pdf._transport.messageHandler.sendWithPromise("ReaderInstallPagePrefix", null), lifetime.signal);
          if (!Array.isArray(refs) || refs.length !== 1 || installed?.refs?.[0] !== refs[0]) throw new Error("PDF_PREFIX_INVALID");
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
          document.querySelector("#page-total").textContent = "";
          controls = document.querySelector(".page-controls");
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
              pdf._transport.messageHandler.sendWithPromise("ReaderInstallPagePrefix", null), lifetime.signal);
            if (!previewActive || installed?.refs?.length !== refs.length ||
                installed.refs.some((ref, index) => ref !== refs[index])) { startValidation?.(); return; }
            previewRefs = refs;
            const count = refs.length;
            previewCount = count;
            pdf._transport.pagesMapper.pagesNumber = count;
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
                const scale = Math.min(pdf.readerRenderScaleLimit ?? 3, previewShell.clientWidth / base.width);
                const viewport = page.getViewport({scale});
                const outputScale = readerContext.pdfOutputScale(viewport);
                const canvas = document.createElement("canvas");
                const width = Math.ceil(viewport.width * outputScale), height = Math.ceil(viewport.height * outputScale);
                if (width * height > readerContext.pdfPixelBudget()) return;
                canvas.width = width; canvas.height = height;
                const task = page.render({canvasContext:canvas.getContext("2d"),viewport,
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
            controls.hidden = false;
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
                shell.style.aspectRatio = previewShell.style.aspectRatio;
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
            const onPrevious = event => { event.stopImmediatePropagation(); turn(-1); };
            const onNext = event => { event.stopImmediatePropagation(); turn(1); };
            const ensureSequentialShells = (start = 2) => {
              for (let number=start; number<=previewCount; number++) {
                if (previewPages.has(number)) continue;
                const shell=document.createElement("section");
                shell.className="reader-page reader-pdf-opening";
                shell.dataset.page=String(number);
                shell.style.aspectRatio=previewShell.style.aspectRatio;
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
                    previewRefs.some((ref,index) => refs[index] !== ref)) throw new Error("PDF_PREFIX_INVALID");
                if (refs.length < limit) {
                  previewExhausted = true;
                  previewPendingPage = 0;
                  readerContext.status.textContent = "正在检查文档";
                  return;
                }
                const installed = await readerContext.awaitReader(
                  pdf._transport.messageHandler.sendWithPromise("ReaderInstallPagePrefix", null), lifetime.signal);
                if (!previewActive) return;
                if (installed?.refs?.length !== refs.length || installed.refs.some((ref,index) => ref !== refs[index]))
                  throw new Error("PDF_PREFIX_INVALID");
                previewRefs = refs;
                const previousCount = previewCount;
                previewCount = refs.length;
                pdf._transport.pagesMapper.pagesNumber = previewCount;
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
              if (previewActive && number >= 1 && number <= previewCount) {
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
            const onPageKeyIntent = event => {
              if (!event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey &&
                  !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(event.target?.tagName) &&
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
          let validation = null;
          const validationStarted = Promise.withResolvers();
          startValidation = () => {
            if (!validation) {
              validation = pdf._transport.messageHandler.sendWithPromise("ReaderValidatePageCount", null);
              validationStarted.resolve(validation);
            }
            return validation;
          };
          if (prefixTask) validationTimer = setTimeout(() => startValidation(),350);
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
        cancelWarm?.();
        previewPadding?.remove();
        if (provisionalDocument && readerContext.pdfDocument === pdf) readerContext.pdfDocument = null;
        for (const shell of previewPages.values()) { shell._renderCancel?.(); shell.remove(); }
        throw error;
      } finally {
        previewActive = false;
        clearTimeout(validationTimer);
        clearTimeout(previewPrefixTimer);
        releasePrefixTimeout();
        cancelWarm?.();
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
      pdf._transport.pagesMapper.pagesNumber = verifiedCount;
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
        previewShell.addEventListener("focus", () => readerContext.renderPdfInBackground(previewShell));
      }
      if (previewAnchor && !previewPages.has(previewAnchor.page) && !previewNavigationChanged) previewAnchor = null;
    }
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
    document.querySelector("#page-total").textContent = `/ ${readerContext.documentState.pageCount}`;
    readerContext.status.textContent = `${pdf.numPages} 页`;
    await readerContext.getInitialReaderRestoration();
    const initialPage = previewAnchor?.page || readerContext.initialReaderPage(pdf.numPages);
    let initialRenderGate = true;
    const firstPage = await readerContext.measurePdf(readerContext.awaitReader(pdf.getPage(initialPage)), "page", initialPage);
    readerContext.assertReaderActive();
    const firstViewport = firstPage.getViewport({ scale: 1 });
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
      for (const shell of readerContext.content.querySelectorAll(".reader-page")) {
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
    const createShell = (page) => {
      if (previewPages.has(page)) {
        const existing = previewPages.get(page);
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
        const geometry = readerContext.pdfV3Map.pages[page - 1];
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
    readerContext.pdfShellsReady = readerContext.pdfShellWindow ? Promise.resolve() : readerContext.appendShellsBatched(createShell, pdf.numPages, 24);
    try {
      const targetShell = readerContext.pdfShellWindow
        ? readerContext.pdfShellWindow.ensure(initialPage)
        : (await readerContext.pdfShellsReady, readerContext.content.querySelector(`.reader-page[data-page="${initialPage}"]`));
      if (!targetShell) throw new Error("PDF initial page shell missing");
      previewPadding?.remove();
      if (previewAnchor) {
        const anchor = readerContext.content.querySelector(`.reader-page[data-page="${previewAnchor.page}"]`);
        if (anchor) {
          readerContext.viewport.scrollTop += anchor.getBoundingClientRect().top - previewAnchor.top;
          readerContext.updateDocumentState({page:previewAnchor.page});
          readerContext.pageInput.value = String(previewAnchor.page);
          readerContext.pageNavigationLockUntil = performance.now() + 500;
          // Initial restoration uses this generation; marker sync is locked
          // briefly while the verified shell window takes ownership.
        }
      }
      readerContext.markReaderContentReady();
      if (!previewShell) readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
      await readerContext.renderPdfShell(targetShell, false, true);
      readerContext.markReaderContentReady();
      if (!previewShell) readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
    } finally {
      releaseInitialRenderGate();
    }
    if (pdf.outlineNeedsFullSource) {
      // An ambiguous range index may hide document-level NAVM after page
      // components. Keep first paint fast; fetch the whole original only when
      // the reader explicitly opens its contents panel.
      let requested=false;
      const outlineEntry=(label)=>({label,depth:0,activate:async(generation)=>{
        if (requested) return false;
        requested=true;
        try {
          const entries=await loadPdfOutline(pdf);
          if (!readerContext.isReaderGenerationCurrent("navigation",generation)) return false;
          readerContext.setToc(entries || [outlineEntry("原件目录加载失败，点击重试")]);
        } finally { requested=false; }
        return false;
      }});
      readerContext.setToc([outlineEntry("加载原件目录")]);
    } else {
      const outlineReady = loadPdfOutline(pdf).then((entries) => {
        if (entries?.length) readerContext.setToc(entries);
      });
      outlineReady.catch(() => {});
    }
    await readerContext.pdfShellsReady;
    readerContext.assertReaderActive();
  }

  return {
    preloadPdfFirstPage,
    pdfManifestSource,
    pdfPageEntry,
    appendShellsBatched,
    pdfSelectionIntersects,
    correctPdfCrossPageSelection,
    createPdfShellWindow,
    startPdfHybridDocument,
    leavePdfHybridMode,
    loadPdfOutline,
    seedPdfPageGeometry,
    renderPdfPages,
    renderImagePages,
    renderPdf
  };
}
