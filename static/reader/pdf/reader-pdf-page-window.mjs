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
      for (let page = start; page < Math.min(start + batchSize, total + 1); page++)
        fragment.appendChild(createShell(page));
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

  function createPdfShellWindow(total, firstShell, createShell, unobserve, defaultRatio) {
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
    readerContext.content.appendChild(fragment);
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
          entry.target.dataset.renderVisible = readerContext.isPdfPageVisible(entry.target) ? "1" : "0";
          readerContext.renderPdfInBackground(entry.target);
        }
      },
      { root: readerContext.viewport, rootMargin: `${readerContext.PDF_PREFETCH_MARGIN}px 0px` }
    );
    const visibleObserver = new IntersectionObserver(
      (items) => {
        if (readerContext.readerAbortController.signal.aborted) return;
        for (const entry of items) {
          entry.target.dataset.renderVisible = entry.isIntersecting ? "1" : "0";
          if (entry.isIntersecting) {
            readerContext.promotePdfRenderWaiter(entry.target);
            readerContext.renderPdfInBackground(entry.target, false, readerContext.pdfPagePriority(entry.target));
            if (entry.target.dataset.renderState === "rendered") readerContext.renderPdfOcrText(entry.target);
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
    let previewShell = null;
    if (pdf._pdfInfo?.readerPageCountPending === true) {
      // Until validation succeeds neither navigation nor history receives an
      // untrusted count. The preview uses the original page and renderer.
      const navigation = readerContext.readerRuntime.currentGeneration("navigation");
      const saved = readerContext.readerRestorationPromise
        ? await readerContext.awaitReader(readerContext.readerRestorationPromise) : null;
      const lifetime = new AbortController();
      const untrackPreview = readerContext.trackReaderResource(() => {
        lifetime.abort(readerContext.readerAbortError());
        previewShell?._renderCancel?.();
        previewShell?.remove();
      });
      let controls = null, controlsHidden = false, previousDisabled = false;
      let bookmarkDisabled = false;
      let verifiedCount = null;
      let previewWidth = null, previewZoom = null;
      let provisionalDocument = false;
      try {
        if (!readerContext.restorationFailed && !saved && !readerContext.ocrManifestUrl &&
            !readerContext.pdfV3Map && !pdf.isPureXfa &&
            navigation === readerContext.readerRuntime.currentGeneration("navigation")) {
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
          previousDisabled = readerContext.pageInput.disabled;
          readerContext.pageInput.disabled = true;
          bookmarkDisabled = readerContext.bookmarkRibbon.disabled;
          readerContext.bookmarkRibbon.disabled = true;
          readerContext.status.textContent = "正在检查文档";
          document.querySelector("#page-total").textContent = "";
          controls = document.querySelector(".page-controls");
          controlsHidden = controls.hidden;
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
        }
        const timed = Promise.withResolvers();
        const timer = setTimeout(() => timed.reject(Object.assign(new Error("PDF 检查超时，请重试加载。"),
          {code:"READER_PDF_TRANSPORT"})), readerContext.READER_PROXY_TIMEOUT_MS);
        try {
          const verified = await readerContext.awaitReader(Promise.race([
            pdf._transport.messageHandler.sendWithPromise("ReaderValidatePageCount", null), timed.promise
          ]), lifetime.signal);
          if (!Number.isSafeInteger(verified?.count) || verified.count < 1 ||
              verified.count > VoiceOfMLReaderSecurity.LIMITS.pdfPages) throw new Error("PDF 页数验证失败");
          verifiedCount = verified.count;
        } finally { clearTimeout(timer); }
      } catch (error) {
        if (provisionalDocument && readerContext.pdfDocument === pdf) readerContext.pdfDocument = null;
        previewShell?.remove();
        throw error;
      } finally {
        untrackPreview();
        if (!lifetime.signal.aborted && controls) {
          controls.hidden = controlsHidden;
          readerContext.pageInput.disabled = previousDisabled;
          readerContext.bookmarkRibbon.disabled = bookmarkDisabled;
        }
      }
      readerContext.assertReaderActive();
      pdf._pdfInfo.numPages = verifiedCount;
      pdf._transport.pagesMapper.pagesNumber = verifiedCount;
      delete pdf._pdfInfo.readerPageCountPending;
      if (previewShell) {
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
    const initialPage = readerContext.initialReaderPage(pdf.numPages);
    let initialRenderGate = true;
    const firstPage = await readerContext.measurePdf(readerContext.awaitReader(pdf.getPage(initialPage)), "page", initialPage);
    readerContext.assertReaderActive();
    const firstViewport = firstPage.getViewport({ scale: 1 });
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (readerContext.readerAbortController.signal.aborted) return;
          entry.target.dataset.renderVisible = entry.isIntersecting && readerContext.isPdfPageVisible(entry.target) ? "1" : "0";
          if (entry.isIntersecting) readerContext.renderPdfInBackground(entry.target);
        }),
      { root: document.querySelector("#viewport"), rootMargin: `${readerContext.PDF_PREFETCH_MARGIN}px 0px` }
    );
    const visibleObserver = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (readerContext.readerAbortController.signal.aborted) return;
          entry.target.dataset.renderVisible = entry.isIntersecting ? "1" : "0";
          if (entry.isIntersecting) {
            readerContext.promotePdfRenderWaiter(entry.target);
            if (readerContext.pdfUserHasScrolled || entry.target.dataset.renderState !== "rendering")
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
    else observeShell(firstShell);
    readerContext.pdfShellWindow = readerContext.createPdfShellWindow(pdf.numPages, firstShell, createShell, (shell) => {
      observer.unobserve(shell);
      visibleObserver.unobserve(shell);
      pageObserver.unobserve(shell);
    }, firstViewport.height / firstViewport.width);
    readerContext.pdfShellsReady = readerContext.pdfShellWindow ? Promise.resolve() : readerContext.appendShellsBatched(createShell, pdf.numPages, 24);
    try {
      const targetShell = readerContext.pdfShellWindow
        ? readerContext.pdfShellWindow.ensure(initialPage)
        : (await readerContext.pdfShellsReady, readerContext.content.querySelector(`.reader-page[data-page="${initialPage}"]`));
      if (!targetShell) throw new Error("PDF initial page shell missing");
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
