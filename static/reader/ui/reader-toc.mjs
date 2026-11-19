/** @param {import('../../../typings/reader-toc-strict').TocContext} readerContext */
export function createReaderToc(readerContext) {
  // setToc owns normalized entries. Cache parsed page numbers only for those
  // entries; externally replaced arrays retain the original scan path.
  /** @type {import('../../../typings/reader-toc-strict').TocEntry[] | null} */
  let ownedTocEntries = null;
  /** @type {import('../../../typings/reader-toc-strict').TocEntry[] | null} */
  let pageLookupEntries = null;
  /** @type {{page: number, index: number}[]} */
  let pageLookup = [];
  const PAGE_LOOKUP_MIN_ENTRIES = 256;

  // The shared navigation state publishes TOC-owned entries as unknown[].
  const tocEntries = () => /** @type {import('../../../typings/reader-toc-strict').TocEntry[]} */ (readerContext.navigationState.tocEntries);

  /** @param {Partial<{tocEntries: import('../../../typings/reader-toc-strict').TocEntry[], currentChapterIndex: number}>} patch */
  function updateNavigationState(patch) {
    return readerContext.readerRuntime.update("navigation", patch);
  }

  /** @param {ParentNode} root */
  function headingTocEntries(root) {
    return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter((heading) => heading.textContent.trim())
      .map((target) => ({
        label: target.textContent.trim(),
        depth: Number(target.tagName.slice(1)) - 1,
        target,
        activate: () => target.scrollIntoView({ block: "start" })
      }));
  }

  /** @param {HTMLElement} root
   * @param {import('../../../typings/reader-toc-strict').TocEntry[]} entries */
  function createHeadingLocationCache(root, entries) {
    /** @type {{index: number, top: number}[] | null} */
    let positions = null;
    /** @type {{entry: import('../../../typings/reader-toc-strict').TocEntry, index: number, target: Element | null | undefined, connected: boolean}[]} */
    let targets = [];
    let width = -1, extent = -1, zoom = -1, wasAnimating = false, live = false;
    const invalidate = () => { positions = null; };
    const mutations = new MutationObserver(invalidate), resize = new ResizeObserver(invalidate);
    mutations.observe(root, {subtree:true, childList:true, characterData:true,
      attributes:true, attributeFilter:["style", "class", "hidden", "width", "height"]});
    resize.observe(root);
    root.addEventListener("load", invalidate, true);
    root.ownerDocument.fonts?.addEventListener("loadingdone", invalidate);
    return { root, entries,
      /** @param {number} marker @param {number} scroll */
      at(marker, scroll) {
        if (mutations.takeRecords().length) invalidate();
        const nextWidth = root.clientWidth, nextExtent = root.scrollHeight, nextZoom = readerContext.documentState.zoom;
        const animating = root.getAnimations?.({subtree:true}).some(animation => animation.playState === "running" || animation.pending) || false;
        if (live || animating || wasAnimating || nextWidth !== width || nextExtent !== extent || nextZoom !== zoom ||
            targets.some(row => row.target !== row.entry.target || row.connected !== !!row.target?.isConnected)) invalidate();
        wasAnimating = animating;
        if (!positions) {
          targets = entries.map((entry, index) => ({entry, index, target:entry.target, connected:!!entry.target?.isConnected}));
          /** @type {WeakMap<Element, boolean>} */
          const fixed = new WeakMap();
          /** @param {Element} target */
          const scrollDependent = target => {
            const ancestors = [];
            let value = false;
            for (let node = /** @type {Element | null} */ (target); node; node = node.parentElement) {
              const cached = fixed.get(node);
              if (cached !== undefined) { value = cached; break; }
              ancestors.push(node);
              const position = root.ownerDocument.defaultView?.getComputedStyle(node).position;
              if (position === "fixed" || position === "sticky") { value = true; break; }
              if (node === root) break;
            }
            for (const node of ancestors) fixed.set(node, value);
            return value;
          };
          // Source CSS may pin headings while scrolling; keep their live geometry.
          live = targets.some(row => row.connected && row.target && scrollDependent(row.target));
          positions = targets.flatMap(row => row.connected && row.target ? [{index:row.index,
            top:row.target.getBoundingClientRect().top + scroll - marker}] : []).sort((a,b) => a.top-b.top || a.index-b.index);
          width = root.clientWidth; extent = root.scrollHeight; zoom = nextZoom;
        }
        let low = 0, high = positions.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (positions[middle].top <= scroll) low = middle + 1;
          else high = middle;
        }
        return positions[low ? low - 1 : 0]?.index ?? -1;
      },
      dispose() {
        mutations.disconnect(); resize.disconnect();
        root.removeEventListener("load", invalidate, true);
        root.ownerDocument.fonts?.removeEventListener("loadingdone", invalidate);
        positions = null; targets = [];
      }
    };
  }

  function syncHeadingLocation() {
    const marker = readerContext.htmlFrame ? 8 : readerContext.viewport.getBoundingClientRect().top + 8;
    const root = readerContext.htmlFrame?.contentDocument?.body || readerContext.content;
    if (!["foliate", "epub-chapters"].some(mode => mode === readerContext.capability.mode)) {
      if (readerContext.headingLocationCache?.root !== root || readerContext.headingLocationCache?.entries !== readerContext.navigationState.tocEntries) {
        readerContext.headingLocationCache?.dispose();
        readerContext.headingLocationCache = readerContext.createHeadingLocationCache(root, tocEntries());
      }
      const current = readerContext.headingLocationCache.at(marker, readerContext.htmlFrame ? /** @type {Window} */ (readerContext.htmlFrame.contentWindow).scrollY : readerContext.viewport.scrollTop);
      if (current >= 0 && current !== readerContext.navigationState.currentChapterIndex) {
        readerContext.updateNavigationState({currentChapterIndex:current});
        readerContext.updateTocCurrentMark();
      }
      return;
    }
    let current = -1,
      currentPosition = -Infinity,
      first = -1,
      firstPosition = Infinity;
    for (const [index, entry] of tocEntries().entries()) {
      if (!entry.target?.isConnected) continue;
      const position = entry.target.getBoundingClientRect().top;
      if (position <= marker && (position > currentPosition || (position === currentPosition && index > current))) {
        current = index;
        currentPosition = position;
      }
      if (position > marker && position < firstPosition) {
        first = index;
        firstPosition = position;
      }
    }
    if (current < 0) current = first;
    if (current >= 0 && current !== readerContext.navigationState.currentChapterIndex) {
      readerContext.updateNavigationState({ currentChapterIndex: current });
      readerContext.updateTocCurrentMark();
    }
  }

  /** @param {number} index @param {{closePanel?: boolean}} [options] */
  async function navigateTocEntry(index, { closePanel = true } = {}) {
    if (index < 0 || index >= readerContext.navigationState.tocEntries.length) return;
    if (tocEntries()[index].group) return;
    const generation = readerContext.beginReaderNavigation(),
      entry = tocEntries()[index];
    try {
      const activated = readerContext.foliateContinuous
        ? await readerContext.activateFoliateTocEntry(entry, generation, { closePanel: false })
        : await entry.activate(generation);
      if (activated === false || !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      readerContext.updateNavigationState({ currentChapterIndex: index });
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
      if (closePanel) readerContext.setReaderPanelOpen(false, true);
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
    }
  }

  /** @param {import('../../../typings/reader-toc-strict').TocEntry} entry @param {number} index */
  function createTocRow(entry, index) {
    const row = document.createElement("div");
    row.className = "panel-item toc-item";
    row.dataset.tocIndex = String(index);
    row.style.setProperty("--toc-depth", String(entry.depth || 0));
    const link = document.createElement("div");
    link.className = "panel-item-main";
    link.textContent = entry.label;
    link.title = entry.label;
    const mark = document.createElement("span");
    mark.className = "toc-current-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "✓";
    mark.hidden = true;
    row.append(link, mark);
    if (entry.group) {
      row.classList.add("toc-group");
      link.setAttribute("role", "heading");
      link.setAttribute("aria-level", String(Math.min(6, (entry.depth || 0) + 1)));
      return row;
    }
    link.tabIndex = 0;
    link.setAttribute("role", "link");
    /** @param {Event} [event] */
    const activate = (event) => {
      const selection = getSelection();
      if (event?.type === "click" && selection?.toString() && selection.containsNode(link, true)) return;
      readerContext.navigateTocEntry(index);
    };
    link.addEventListener("click", activate);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    return row;
  }

  // State identity follows setToc's lifecycle without retaining old lists.
  const virtualTocRows = new WeakMap();

  function renderVirtualToc() {
    const state = readerContext.tocVirtualState;
    if (!state) return;
    const height = Math.max(320, state.panelView.clientHeight),
      listTop = state.list.getBoundingClientRect().top - state.panelView.getBoundingClientRect().top + state.panelView.scrollTop,
      visibleTop = Math.max(0, state.panelView.scrollTop - listTop),
      visibleHeight = Math.max(0, height - Math.max(0, listTop - state.panelView.scrollTop)),
      indices = state.matches,
      first = Math.floor(visibleTop / readerContext.TOC_VIRTUAL_ROW_HEIGHT),
      start = Math.max(0, first - 12),
      end = Math.min(indices.length, first + Math.ceil(visibleHeight / readerContext.TOC_VIRTUAL_ROW_HEIGHT) + 13);
    let cache = virtualTocRows.get(state);
    if (!cache || cache.query !== state.query || cache.entries !== state.entries) {
      cache = { query: state.query, entries: state.entries, rows: new Map() };
      virtualTocRows.set(state, cache);
      state.list.replaceChildren();
    }
    const wanted = new Set(indices.slice(start, end));
    for (const [index, row] of cache.rows) {
      if (wanted.has(index)) continue;
      row.remove();
      cache.rows.delete(index);
    }
    // Insert around retained rows: detaching a focused row would lose focus.
    let next = state.list.firstElementChild;
    for (let position = start; position < end; position++) {
      const index = indices[position];
      let row = cache.rows.get(index);
      if (!row) {
        row = readerContext.createTocRow(state.entries[index], index);
        row.classList.add("toc-virtual-row");
        if (state.query) readerContext.highlightPanelItem(/** @type {HTMLElement} */ (row.firstElementChild), state.query);
        cache.rows.set(index, row);
      }
      const top = `${position * readerContext.TOC_VIRTUAL_ROW_HEIGHT}px`;
      if (row.style.top !== top) row.style.top = top;
      if (row !== next) state.list.insertBefore(row, next);
      next = row.nextElementSibling;
    }
    readerContext.updateTocCurrentMark();
  }

  let tocHintShown = false, tocHintPending = false;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let tocHintTimer = 0;
  // Opening the Reader must not pop the directory for a trivial one (a cover, a
  // preface, a single chapter); the panel stays one tap away in the toolbar.
  const TOC_HINT_MIN_ENTRIES = 3;
  // A one- or two-entry directory (a cover, a preface) is not worth opening the
  // panel for; the reader opens on the content and the panel stays one tap away.
  const tocHintHasEnoughEntries = () =>
    tocEntries().filter((entry) => !entry.group).length > TOC_HINT_MIN_ENTRIES;
  const cancelTocHint = () => {
    clearTimeout(tocHintTimer);
    tocHintTimer = 0;
    tocHintPending = false;
  };
  const finishTocHint = () => {
    tocHintTimer = 0;
    if (readerContext.readerLifecycle.disposed || readerContext.readerAbortController.signal.aborted || !tocHintPending) return;
    tocHintPending = false;
    if (!tocHintHasEnoughEntries() ||
        readerContext.panelState.open || readerContext.readerPanelInteractionSerial > 0 ||
        readerContext.readerUiHistoryState !== "base") {
      tocHintShown = true;
      return;
    }
    tocHintShown = true;
    // Keep the directory open using the normal panel owner: toolbar, Escape,
    // system Back and aria-expanded must all agree with the visible drawer.
    readerContext.setReaderPanelOpen(true);
    readerContext.selectPanel("toc");
  };
  /** @type {(() => void) | null} */
  let phaseCleanup = null;
  function ensureTocHintPhaseListener() {
    if (phaseCleanup) return;
    phaseCleanup = readerContext.readerRuntime.events.on("phase", (detail) => {
      const { phase } = /** @type {{phase: string}} */ (detail);
      if (phase === "failed" || phase === "disposed") {
        cancelTocHint();
        phaseCleanup?.();
        phaseCleanup = null;
      }
    });
    readerContext.readerRuntime.track(() => { cancelTocHint(); phaseCleanup?.(); phaseCleanup = null; });
  }
  function hintReaderToc() {
    if (tocHintShown || tocHintPending || !tocHintHasEnoughEntries()) return;
    ensureTocHintPhaseListener();
    tocHintPending = true;
    // Do not wait for the overall Reader phase: TOC availability itself is the
    // useful signal, and the hint should be visible near the opening moment.
    tocHintTimer = setTimeout(finishTocHint, 0);
  }

  /** @param {import('../../../typings/reader-toc-strict').TocEntry[] | null | undefined} entries */
  function setToc(entries) {
    const normalizedEntries = (entries || []).map((entry) => ({
      ...entry,
      href: String(entry.href || ""),
      label: readerContext.cleanTocLabel(entry.label)
    }));
    // Invalidate before publishing; event listeners may replace the entries.
    ownedTocEntries = normalizedEntries;
    pageLookupEntries = null;
    pageLookup = [];
    readerContext.updateNavigationState({
      tocEntries: normalizedEntries,
      currentChapterIndex: normalizedEntries.findIndex((entry) => !entry.group && entry.page !== null)
    });
    const tocTab = /** @type {HTMLElement} */ (document.querySelector("#toc-tab"));
    tocTab.hidden = false;
    tocTab.textContent = normalizedEntries.length ? "目录" : "阅读";
    const previousList = /** @type {HTMLElement} */ (document.querySelector("#toc-list")),
      list = /** @type {HTMLElement} */ (previousList.cloneNode(false));
    readerContext.tocVirtualState?.destroy();
    readerContext.tocVirtualState = null;
    list.classList.remove("toc-list-virtualized");
    list.style.removeProperty("height");
    previousList.replaceWith(list);
    const virtualizationThreshold = readerContext.chapterManifestUrl ? 2000 : readerContext.TOC_VIRTUALIZATION_THRESHOLD;
    if (normalizedEntries.length > virtualizationThreshold) {
      const panelView = /** @type {HTMLElement} */ (list.parentElement);
      list.classList.add("toc-list-virtualized");
      list.style.height = `${normalizedEntries.length * readerContext.TOC_VIRTUAL_ROW_HEIGHT}px`;
      let frame = 0;
      const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          readerContext.renderVirtualToc();
        });
      };
      panelView.addEventListener("scroll", onScroll, { passive: true });
      readerContext.tocVirtualState = {
        entries: normalizedEntries,
        matches: normalizedEntries.map((_, index) => index),
        query: "",
        list,
        panelView,
        render: readerContext.renderVirtualToc,
        destroy: () => {
          panelView.removeEventListener("scroll", onScroll);
          if (frame) cancelAnimationFrame(frame);
        }
      };
      readerContext.renderVirtualToc();
    } else {
      for (const [index, entry] of normalizedEntries.entries())
        list.appendChild(readerContext.createTocRow(entry, index));
    }
    readerContext.filterPanel(document.querySelector('#toc-panel'), {resetScroll:false});
    readerContext.updateTocCurrentMark();
    // PDF outlines can arrive after the reader is already ready and the
    // no-TOC progress summary has been placed inside this panel.
    readerContext.updateReadingProgressSummary();
    readerContext.placeReadingProgress();
    readerContext.updateProgressTools();
    hintReaderToc();
  }

  /** @param {unknown} value */
  function cleanTocLabel(value) {
    return (
      String(value || "未命名章节")
        .replace(/[\uFFFD\u2610-\u2612\u25a1\u0000-\u001F\u007F]/gu, "")
        .replace(/\s{2,}/gu, " ")
        .trim() || "未命名章节"
    );
  }

  /** @param {import('../../../typings/reader-toc-strict').TocEntry} entry */
  function tocPage(entry) {
    // Explicit null means there is no destination. Only legacy producers
    // without page metadata use the label for page lookup.
    if (entry.page !== undefined) return entry.page;
    const match = entry.label.match(/第\s*(\d+)\s*页/u);
    return match ? Number(match[1]) : null;
  }

  // The legacy scan selects the *last directory entry* whose page is at or
  // before the current page, even when the outline itself is not page-sorted.
  /** @param {import('../../../typings/reader-toc-strict').TocEntry[]} entries */
  function indexTocPages(entries) {
    pageLookup = entries.flatMap((entry, index) => {
      const page = tocPage(entry);
      return page === null ? [] : [{page,index}];
    }).sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : a.index - b.index));
    let last = -1;
    for (const row of pageLookup) { last = Math.max(last, row.index); row.index = last; }
    pageLookupEntries = entries;
  }

  /** @param {Element} row @param {boolean} current */
  function markTocRow(row, current) {
    const mark = /** @type {HTMLElement} */ (row.querySelector(".toc-current-mark"));
    mark.hidden = !current;
    row.classList.toggle("is-current", current);
    const link = row.querySelector('[role="link"]');
    if (current) link?.setAttribute("aria-current", "location");
    else link?.removeAttribute("aria-current");
  }

  // Track the node, not just the index: filtering can replace it at the same index.
  /** @type {Element | null | undefined} */
  let markedRow;
  function syncMarkedTocRow() {
    const index = readerContext.navigationState.currentChapterIndex, state = readerContext.tocVirtualState;
    const row = state ? virtualTocRows.get(state)?.rows.get(index) : document.getElementById("toc-list")?.children.item(index);
    if (markedRow === row) return;
    if (markedRow?.isConnected) markTocRow(markedRow, false);
    markedRow = row;
    if (row) markTocRow(row, true);
  }

  function updateTocCurrentMark() {
    if (readerContext.documentState.pageCount > 1 && readerContext.documentState.page > 0) {
      const entries = tocEntries();
      let pageIndex = -1;
      if (entries.length > PAGE_LOOKUP_MIN_ENTRIES && entries === ownedTocEntries && ownedTocEntries !== pageLookupEntries)
        indexTocPages(ownedTocEntries);
      if (entries === pageLookupEntries) {
        let low = 0, high = pageLookup.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (pageLookup[middle].page <= readerContext.documentState.page) low = middle + 1;
          else high = middle;
        }
        if (low) pageIndex = pageLookup[low - 1].index;
      } else {
        for (const [index, entry] of entries.entries()) {
          const page = tocPage(entry);
          if (page !== null && page <= readerContext.documentState.page) pageIndex = index;
        }
      }
      if (pageIndex >= 0) readerContext.updateNavigationState({ currentChapterIndex: pageIndex });
    }
    syncMarkedTocRow();
  }

  function syncTocTab() {
    const tab = /** @type {HTMLElement | null} */ (document.querySelector("#toc-tab"));
    if (!tab) return;
    tab.hidden = !readerContext.navigationState.tocEntries.length;
    if (readerContext.navigationState.tocEntries.length && readerContext.navigationState.currentChapterIndex < 0)
      readerContext.updateNavigationState({ currentChapterIndex: tocEntries().findIndex((entry) => !entry.group) });
  }

  return {
    updateNavigationState,
    headingTocEntries,
    createHeadingLocationCache,
    syncHeadingLocation,
    navigateTocEntry,
    createTocRow,
    renderVirtualToc,
    setToc,
    cleanTocLabel,
    updateTocCurrentMark,
    syncTocTab
  };
}
