export function createReaderPdfPageWindow(readerContext) {
  async function preloadPdfFirstPage(total) {
    if (readerContext.pdfV3Manifest) return;
    await readerContext.getInitialReaderRestoration();
    try {
      const source = readerContext.pdfManifestSource();
      if (!source) return;
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
        path: `${readerContext.pdfPageManifest.root}/pages/page-${String(page).padStart(6, "0")}.webp`
      }
    );
    const ocrEntry = readerContext.pdfPageManifest.ocr?.[page - 1];
    return ocrEntry ? { ...pageEntry, ...ocrEntry, page } : pageEntry;
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
        unobserve(shell);
        shell._hybridCancel?.(); shell._v3PreviewRelease?.();
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
      readerContext.pdfV3Repository = readerContext.createPdfV3Repository(manifest.source_sha256, manifest.page_count);
      readerContext.pdfV3Map = readerContext.validatePageMap(await readerContext.pdfV3Repository.read(manifest.page_map), manifest);
      readerContext.pdfV3Manifest = manifest;
      readerContext.pdfOcrManifest = manifest.text_layer ? manifest : null;
      readerContext.ocrManifestUrl = manifest.text_layer ? readerContext.sourceUrl : "";
    }
    readerContext.assertReaderActive();
    const source = readerContext.pdfManifestSource();
    const totalPages = manifest.page_count;
    if (!source) throw new Error("PDF_MANIFEST_INVALID");
    readerContext.pdfPageManifest = { ...source, pageCount: totalPages };
    if (readerContext.pdfV3Manifest) {
      readerContext.pdfPageManifest.pageUrl = () => "";
      readerContext.pdfHybridUrl = readerContext.v3ResourceUrl(manifest.primary.resource);
      readerContext.pdfHybridDocumentPromise = readerContext.loadPdfDocument(readerContext.pdfHybridUrl).then(pdf => {
        readerContext.assertReaderActive();
        if (pdf.numPages !== totalPages) throw new Error("PDF_PRIMARY_PAGE_COUNT_MISMATCH");
        readerContext.pdfDocument = pdf; return pdf;
      });
      readerContext.pdfHybridDocumentPromise.catch(() => {});
    }
    readerContext.updateDocumentState({ pageCount: totalPages });
    readerContext.pageInput.max = String(totalPages);
    document.querySelector("#page-total").textContent = `/ ${totalPages}`;
    readerContext.status.textContent = `${totalPages} 页`;
    await readerContext.getInitialReaderRestoration();
    const initialPage = readerContext.initialReaderPage(totalPages);
    // Start the manifest and first OCR page while the first image is loading.
    // The page renderer reuses these promises, so visible text does not wait for
    // a second sequential request after the image has painted.
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
      shell.style.aspectRatio = "1 / 1.414";
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
    }, 1.414);
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
    readerContext.pdfDocument = pdf;
    readerContext.updateDocumentState({ pageCount: pdf.numPages });
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
      shell.tabIndex = 0;
      shell.setAttribute("role", "region");
      shell.setAttribute("aria-label", `第 ${page} 页`);
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      const textLayer = document.createElement("div");
      textLayer.className = "reader-pdf-text";
      textLayer.setAttribute("role", "document");
      textLayer.setAttribute("aria-label", `第 ${page} 页正文`);
      shell.append(canvas, textLayer);
      const pageState = document.createElement("div");
      pageState.className = "reader-page-state";
      readerContext.setPdfPageLoadingState(pageState, page);
      shell.appendChild(pageState);
      shell.addEventListener("focus", () => readerContext.renderPdfInBackground(shell));
      observeShell(shell);
      return shell;
    };
    const firstShell = createShell(1);
    readerContext.content.appendChild(firstShell);
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
      readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
      await readerContext.renderPdfShell(targetShell, false, true);
      readerContext.markReaderContentReady();
      readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(targetShell);
    } finally {
      releaseInitialRenderGate();
    }
    const outlineReady = (async () => {
      if (typeof pdf.getOutline !== "function") return;
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
        if (entries.length) readerContext.setToc(entries);
      } catch (error) {
        if (!readerContext.readerAbortController.signal.aborted)
          console.warn("PDF outline could not be loaded", error);
      }
    })();
    outlineReady.catch(() => {});
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
    renderPdfPages,
    renderImagePages,
    renderPdf
  };
}
