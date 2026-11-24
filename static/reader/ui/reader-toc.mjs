/** @param {import('../../../typings/reader-toc-strict').TocContext} readerContext */
export function createReaderToc(readerContext) {
  // setToc owns normalized entries. Index explicit page numbers only for those
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
        activate: () => {
          target.closest("details.reader-clean-web-reply")?.setAttribute("open", "");
          target.scrollIntoView({ block: "start" });
        }
      }));
  }

  /** @param {HTMLElement} root
   * @param {import('../../../typings/reader-toc-strict').TocEntry[]} entries */
  function createHeadingLocationCache(root, entries) {
    /** @type {{index: number, top: number}[] | null} */
    let positions = null;
    /** @type {{entry: import('../../../typings/reader-toc-strict').TocEntry, index: number, target: Element | null | undefined, connected: boolean}[]} */
    let targets = [];
    let width = -1, extent = -1, zoom = -1, live = false;
    /** @type {boolean | undefined} */
    let wasAnimating = false;
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
        const animating = root.getAnimations?.({subtree:true}).some(animation => animation.playState === "running" || animation.pending);
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
          const connectedTargets = /** @type {{target: Element, index: number}[]} */ (targets.filter(row => row.connected));
          live = connectedTargets.some(({target}) => scrollDependent(target));
          positions = connectedTargets.map(({target, index}) => ({index,
            top:target.getBoundingClientRect().top + scroll})).sort((a,b) => a.top-b.top || a.index-b.index);
          width = root.clientWidth; extent = root.scrollHeight; zoom = nextZoom;
        }
        let low = 0, high = positions.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if ((positions[middle]?.top ?? Infinity) <= scroll + marker) low = middle + 1;
          else high = middle;
        }
        return positions[low - 1]?.index ?? -1;
      },
      dispose() {
        mutations.disconnect(); resize.disconnect();
        root.removeEventListener("load", invalidate, true);
        root.ownerDocument.fonts?.removeEventListener("loadingdone", invalidate);
        positions = null; targets = [];
      }
    };
  }

  /** @type {ReadonlySet<string | null | undefined>} */
  const pageLocationModes = new Set(["pdf", "pdf-pages", "image-pages"]);

  function syncHeadingLocation() {
    const entries = tocEntries();
    if (!entries.length) {
      readerContext.headingLocationCache?.dispose();
      readerContext.headingLocationCache = null;
      return;
    }
    const mode = readerContext.capability.mode;
    if (pageLocationModes.has(mode)) return;
    const viewport = readerContext.viewport;
    const frame = readerContext.htmlFrame;
    const viewTop = frame ? 0 : viewport.getBoundingClientRect().top;
    const marker = viewTop + 8;
    let current;
    if (mode === "epub-chapters") {
      current = virtualHeadingIndex(marker, entries);
      if (current === undefined) return;
    } else {
      const doc = frame?.contentDocument;
      const root = doc?.body || readerContext.content;
      let cache = readerContext.headingLocationCache;
      if (!cache || cache.root !== root || cache.entries !== entries) {
        cache?.dispose();
        cache = readerContext.headingLocationCache = createHeadingLocationCache(root, entries);
      }
      const scroller = doc?.scrollingElement || viewport;
      const { scrollTop: scroll, clientHeight: height, scrollHeight } = scroller;
      const end = scrollHeight - height;
      // At the scroll limit, a short final section cannot reach the normal
      // top marker. Include headings visible through the bottom of the viewport.
      const atEnd = scroll > 0 && end > 1 && end - scroll <= 1;
      const bottom = viewTop + (scroller === viewport ? viewport.clientTop : 0) + height;
      current = cache.at(atEnd ? bottom - 1 : marker, scroll);
    }
    if (current !== readerContext.navigationState.currentChapterIndex) {
      readerContext.updateNavigationState({ currentChapterIndex: current });
      readerContext.updateTocCurrentMark();
    }
  }

  /** @param {number} marker @param {ReturnType<typeof tocEntries>} entries */
  function virtualHeadingIndex(marker, entries) {
    let current = -1,
      currentPosition = -Infinity,
      first = -1,
      firstPosition = Infinity;
    // CHM fallbacks and fragment aliases can share a target. Reuse its top
    // only in this read pass: layout and scroll can move it before the next.
    /** @type {Map<Element, number>} */
    const targetTops = new Map();
    for (const [index, entry] of entries.entries()) {
      const target = entry.target;
      if (!target?.isConnected) continue;
      let position = targetTops.get(target);
      if (position === undefined) {
        position = target.getBoundingClientRect().top;
        targetTops.set(target, position);
      }
      // Entries are visited in index order; the later index wins a tie.
      if (position <= marker && position >= currentPosition) {
        current = index;
        currentPosition = position;
      }
      if (position > marker && position < firstPosition) {
        first = index;
        firstPosition = position;
      }
    }
    // Only the start of the directory is a preface. At a virtual window's
    // leading edge the closest mounted target can be a later chapter.
    if (current >= 0) return current;
    if (first < 0) return undefined;
    return first === entries.findIndex((entry) => !entry.group) ? -1 : first;
  }

  /** @param {number} index @param {{closePanel?: boolean}} [options] */
  async function navigateTocEntry(index, { closePanel = true } = {}) {
    if (index < 0 || index >= readerContext.navigationState.tocEntries.length) return;
    const entry = tocEntries()[index];
    if (!entry || entry.group) return;
    const panelSerial = readerContext.readerPanelInteractionSerial;
    const generation = readerContext.beginReaderNavigation();
    try {
      const activated = await entry.activate(generation);
      if (activated === false || !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      readerContext.updateNavigationState({ currentChapterIndex: index });
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
      // Landing still belongs to this navigation, but closing belongs to the
      // drawer as it was when the row was activated.
      if (closePanel && readerContext.panelState.open && panelSerial === readerContext.readerPanelInteractionSerial)
        readerContext.setReaderPanelOpen(false, true);
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
    }
  }

  /** @param {import('../../../typings/reader-toc-strict').TocEntry} entry @param {number} index */
  function createTocRow(entry, index) {
    const row = document.createElement("div");
    row.className = "panel-item toc-item";
    row.dataset.tocIndex = String(index);
    const depth = entry.depth || 0;
    row.style.setProperty("--toc-depth", String(depth));
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
      link.setAttribute("aria-level", String(Math.min(6, depth + 1)));
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
      if (index === undefined) continue;
      const entry = state.entries[index];
      if (!entry) continue;
      let row = cache.rows.get(index);
      if (!row) {
        row = createTocRow(entry, index);
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
  const TOC_HINT_HISTORY_WAIT_MS = 150; // Same budget as startup's restoration grace period.
  // A one- or two-entry directory (a cover, a preface) is not worth opening the
  // panel for; the reader opens on the content and the panel stays one tap away.
  const tocHintHasEnoughEntries = () =>
    tocEntries().filter((entry) => !entry.group).length > TOC_HINT_MIN_ENTRIES;
  const cancelTocHint = () => {
    clearTimeout(tocHintTimer);
    tocHintTimer = 0;
    tocHintPending = false;
  };
  /** @param {boolean} unread */
  const finishTocHint = (unread) => {
    if (!tocHintPending) return;
    cancelTocHint();
    if (readerContext.readerLifecycle.disposed || readerContext.readerAbortController.signal.aborted) return;
    tocHintShown = true;
    if (!unread || !tocHintHasEnoughEntries() ||
        readerContext.panelState.open || readerContext.readerPanelInteractionSerial > 0 ||
        readerContext.readerUiHistoryState !== "base") return;
    let key = "";
    try {
      const { downloadUrl, sourceUrl, chapterManifestUrl } = readerContext;
      // Resolved links can point at converted assets. Use the original catalog
      // URL, when known, so old/current IDs and direct links share a reminder.
      const source = downloadUrl.startsWith("https://huggingface.co/datasets/VoiceOfML/")
        ? downloadUrl : sourceUrl || chapterManifestUrl;
      if (source) key = `reader-toc-hint:v1:${VoiceOfMLReader.shortSourceId(source)}`;
      if (key && localStorage.getItem(key) === "1") return;
    } catch (_) { /* Storage unavailable: keep the in-page reminder. */ }
    // Keep the directory open using the normal panel owner: toolbar, Escape,
    // system Back and aria-expanded must all agree with the visible drawer.
    readerContext.setReaderPanelOpen(true);
    readerContext.selectPanel("toc");
    // An interaction that preempted the hint above does not count as showing it.
    try { if (key) localStorage.setItem(key, "1"); } catch (_) { /* Best effort. */ }
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
    // Reuse the startup read, not restoration completion or the Reader phase.
    // If history is still unknown at the deadline, leave the drawer closed
    // without consuming the hint; never pop it later when the read settles.
    const restoration = readerContext.readerRestorationPromise;
    tocHintTimer = setTimeout(() => finishTocHint(!restoration), restoration ? TOC_HINT_HISTORY_WAIT_MS : 0);
    void restoration?.then(entry => {
      if (!tocHintPending) return;
      clearTimeout(tocHintTimer);
      const unread = !entry && !readerContext.readerHasHistory && !readerContext.restorationFailed;
      tocHintTimer = setTimeout(() => finishTocHint(unread), 0);
    }, () => finishTocHint(false));
  }

  /** @param {import('../../../typings/reader-toc-strict').TocEntry[] | null | undefined} entries */
  function setToc(entries) {
    const normalizedEntries = (entries || []).map((entry) => ({
      ...entry,
      href: String(entry.href || ""),
      label: cleanTocLabel(entry.label)
    }));
    // Invalidate before publishing; event listeners may replace the entries.
    ownedTocEntries = normalizedEntries;
    pageLookupEntries = null;
    pageLookup = [];
    readerContext.updateNavigationState({ tocEntries: normalizedEntries, currentChapterIndex: -1 });
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
          renderVirtualToc();
        });
      };
      panelView.addEventListener("scroll", onScroll, { passive: true });
      readerContext.tocVirtualState = {
        entries: normalizedEntries,
        matches: normalizedEntries.map((_, index) => index),
        query: "",
        list,
        panelView,
        render: renderVirtualToc,
        destroy: () => {
          panelView.removeEventListener("scroll", onScroll);
          if (frame) cancelAnimationFrame(frame);
        }
      };
      renderVirtualToc();
    } else {
      for (const [index, entry] of normalizedEntries.entries())
        list.appendChild(createTocRow(entry, index));
    }
    readerContext.filterPanel(document.querySelector('#toc-panel'), {resetScroll:false});
    readerContext.updateTocCurrentMark();
    // PDF outlines can arrive after the reader is already ready and the
    // no-TOC progress summary has been placed inside this panel.
    readerContext.updateReadingProgressSummary();
    readerContext.placeReadingProgress();
    readerContext.updateProgressTools();
    hintReaderToc();
    return normalizedEntries;
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
    return entry.page ?? null;
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
    const mode = readerContext.capability.mode;
    if (readerContext.documentState.page > 0 && (readerContext.documentState.pageCount > 1 || pageLocationModes.has(mode))) {
      const entries = tocEntries();
      let pageIndex = -1;
      if (entries.length > PAGE_LOOKUP_MIN_ENTRIES && entries === ownedTocEntries && ownedTocEntries !== pageLookupEntries)
        indexTocPages(ownedTocEntries);
      if (entries === pageLookupEntries) {
        let low = 0, high = pageLookup.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if ((pageLookup[middle]?.page ?? Infinity) <= readerContext.documentState.page) low = middle + 1;
          else high = middle;
        }
        if (low) pageIndex = pageLookup[low - 1]?.index ?? -1;
      } else {
        for (const [index, entry] of entries.entries()) {
          const page = tocPage(entry);
          if (page !== null && page <= readerContext.documentState.page) pageIndex = index;
        }
      }
      if (pageIndex !== readerContext.navigationState.currentChapterIndex)
        readerContext.updateNavigationState({ currentChapterIndex: pageIndex });
    }
    syncMarkedTocRow();
  }

  function syncTocTab() {
    const tab = /** @type {HTMLElement | null} */ (document.querySelector("#toc-tab"));
    if (!tab) return;
    tab.hidden = !readerContext.navigationState.tocEntries.length;
  }

  return {
    updateNavigationState,
    headingTocEntries,
    syncHeadingLocation,
    navigateTocEntry,
    setToc,
    updateTocCurrentMark,
    syncTocTab
  };
}
