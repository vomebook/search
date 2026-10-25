export function createReaderToc(readerContext) {
  function updateNavigationState(patch) {
    return readerContext.readerRuntime.update("navigation", patch);
  }

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

  function createHeadingLocationCache(root, entries) {
    let positions = null, targets = [], width = -1, extent = -1, zoom = -1, wasAnimating = false, live = false;
    const invalidate = () => { positions = null; };
    const mutations = new MutationObserver(invalidate), resize = new ResizeObserver(invalidate);
    mutations.observe(root, {subtree:true, childList:true, characterData:true,
      attributes:true, attributeFilter:["style", "class", "hidden", "width", "height"]});
    resize.observe(root);
    root.addEventListener("load", invalidate, true);
    root.ownerDocument.fonts?.addEventListener("loadingdone", invalidate);
    return { root, entries,
      at(marker, scroll) {
        if (mutations.takeRecords().length) invalidate();
        const nextWidth = root.clientWidth, nextExtent = root.scrollHeight, nextZoom = readerContext.documentState.zoom;
        const animating = root.getAnimations?.({subtree:true}).some(animation => animation.playState === "running" || animation.pending) || false;
        if (live || animating || wasAnimating || nextWidth !== width || nextExtent !== extent || nextZoom !== zoom ||
            targets.some(row => row.target !== row.entry.target || row.connected !== !!row.target?.isConnected)) invalidate();
        wasAnimating = animating;
        if (!positions) {
          targets = entries.map((entry, index) => ({entry, index, target:entry.target, connected:!!entry.target?.isConnected}));
          const fixed = new WeakMap();
          const scrollDependent = target => {
            const ancestors = [];
            let value = false;
            for (let node = target; node; node = node.parentElement) {
              if (fixed.has(node)) { value = fixed.get(node); break; }
              ancestors.push(node);
              const position = root.ownerDocument.defaultView?.getComputedStyle(node).position;
              if (position === "fixed" || position === "sticky") { value = true; break; }
              if (node === root) break;
            }
            for (const node of ancestors) fixed.set(node, value);
            return value;
          };
          // Source CSS may pin headings while scrolling; keep their live geometry.
          live = targets.some(row => row.connected && scrollDependent(row.target));
          positions = targets.filter(row => row.connected).map(row => ({index:row.index,
            top:row.target.getBoundingClientRect().top + scroll - marker})).sort((a,b) => a.top-b.top || a.index-b.index);
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
    if (!["foliate", "epub-chapters"].includes(readerContext.capability.mode)) {
      if (readerContext.headingLocationCache?.root !== root || readerContext.headingLocationCache?.entries !== readerContext.navigationState.tocEntries) {
        readerContext.headingLocationCache?.dispose();
        readerContext.headingLocationCache = readerContext.createHeadingLocationCache(root, readerContext.navigationState.tocEntries);
      }
      const current = readerContext.headingLocationCache.at(marker, readerContext.htmlFrame ? readerContext.htmlFrame.contentWindow.scrollY : readerContext.viewport.scrollTop);
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
    for (const [index, entry] of readerContext.navigationState.tocEntries.entries()) {
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

  async function navigateTocEntry(index) {
    if (index < 0 || index >= readerContext.navigationState.tocEntries.length) return;
    if (readerContext.navigationState.tocEntries[index].group) return;
    const generation = readerContext.beginReaderNavigation(),
      entry = readerContext.navigationState.tocEntries[index];
    try {
      const activated = readerContext.foliateContinuous
        ? await readerContext.activateFoliateTocEntry(entry, generation)
        : await entry.activate(generation);
      if (activated === false || !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      readerContext.updateNavigationState({ currentChapterIndex: index });
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
      readerContext.setReaderPanelOpen(false, true);
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
    }
  }

  function createTocRow(entry, index) {
    const row = document.createElement("div");
    row.className = "panel-item toc-item";
    row.dataset.tocIndex = String(index);
    row.style.setProperty("--toc-depth", String(entry.depth || 0));
    const link = document.createElement("div");
    link.className = "panel-item-main";
    link.textContent = entry.label;
    link.title = entry.label;
    if (entry.group) {
      row.classList.add("toc-group");
      link.setAttribute("role", "heading");
      link.setAttribute("aria-level", String(Math.min(6, (entry.depth || 0) + 1)));
      row.appendChild(link);
      return row;
    }
    link.tabIndex = 0;
    link.setAttribute("role", "link");
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
    row.appendChild(link);
    return row;
  }

  function renderVirtualToc() {
    const state = readerContext.tocVirtualState;
    if (!state) return;
    const height = Math.max(320, state.panelView.clientHeight),
      start = Math.max(0, Math.floor(state.panelView.scrollTop / readerContext.TOC_VIRTUAL_ROW_HEIGHT) - 12),
      end = Math.min(state.entries.length, start + Math.ceil(height / readerContext.TOC_VIRTUAL_ROW_HEIGHT) + 24),
      fragment = document.createDocumentFragment();
    state.list.replaceChildren();
    for (let index = start; index < end; index++) {
      const row = readerContext.createTocRow(state.entries[index], index);
      row.classList.add("toc-virtual-row");
      row.style.top = `${index * readerContext.TOC_VIRTUAL_ROW_HEIGHT}px`;
      fragment.appendChild(row);
    }
    state.list.appendChild(fragment);
    readerContext.updateTocCurrentMark();
  }

  let tocHintShown = false, tocHintPending = false, tocHintTimer = 0;
  // Opening the Reader must not pop the directory for a trivial one (a cover, a
  // preface, a single chapter); the panel stays one tap away in the toolbar.
  const TOC_HINT_MIN_ENTRIES = 3;
  // A one- or two-entry directory (a cover, a preface) is not worth opening the
  // panel for; the reader opens on the content and the panel stays one tap away.
  const tocHintHasEnoughEntries = () =>
    readerContext.navigationState.tocEntries.filter((entry) => !entry.group).length > TOC_HINT_MIN_ENTRIES;
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
  let phaseCleanup = null;
  function ensureTocHintPhaseListener() {
    if (phaseCleanup) return;
    phaseCleanup = readerContext.readerRuntime.events.on("phase", ({ phase }) => {
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

  function setToc(entries) {
    const normalizedEntries = (entries || []).map((entry) => ({
      ...entry,
      href: String(entry.href || ""),
      label: readerContext.cleanTocLabel(entry.label)
    }));
    readerContext.updateNavigationState({
      tocEntries: normalizedEntries,
      currentChapterIndex: normalizedEntries.findIndex((entry) => !entry.group)
    });
    const tocTab = document.querySelector("#toc-tab");
    tocTab.hidden = false;
    tocTab.textContent = normalizedEntries.length ? "目录" : "阅读";
    const previousList = document.querySelector("#toc-list"),
      list = previousList.cloneNode(false);
    readerContext.tocVirtualState?.destroy();
    readerContext.tocVirtualState = null;
    previousList.replaceWith(list);
    const virtualizationThreshold = readerContext.chapterManifestUrl ? 2000 : readerContext.TOC_VIRTUALIZATION_THRESHOLD;
    if (normalizedEntries.length > virtualizationThreshold) {
      const panelView = list.parentElement;
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
    readerContext.updateTocCurrentMark();
    hintReaderToc();
  }

  function cleanTocLabel(value) {
    return (
      String(value || "未命名章节")
        .replace(/[\uFFFD\u2610-\u2612\u25a1\u0000-\u001F\u007F]/gu, "")
        .replace(/\s{2,}/gu, " ")
        .trim() || "未命名章节"
    );
  }

  function updateTocCurrentMark() {
    const rows = [...document.querySelectorAll("#toc-list .toc-item")];
    if (readerContext.documentState.pageCount > 1 && readerContext.documentState.page > 0) {
      let pageIndex = -1;
      for (const [index, entry] of readerContext.navigationState.tocEntries.entries()) {
        const match = entry.label.match(/第\s*(\d+)\s*页/u);
        if (match && Number(match[1]) <= readerContext.documentState.page) pageIndex = index;
      }
      if (pageIndex >= 0) readerContext.updateNavigationState({ currentChapterIndex: pageIndex });
    }
    for (const row of rows) {
      const index = Number(row.dataset.tocIndex);
      let mark = row.querySelector(".toc-current-mark");
      if (!mark) {
        mark = document.createElement("span");
        mark.className = "toc-current-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "✓";
        row.appendChild(mark);
      }
      mark.hidden = index !== readerContext.navigationState.currentChapterIndex;
      row.classList.toggle("is-current", index === readerContext.navigationState.currentChapterIndex);
      const link = row.querySelector('[role="link"]');
      if (index === readerContext.navigationState.currentChapterIndex) link?.setAttribute("aria-current", "location");
      else link?.removeAttribute("aria-current");
    }
  }

  function syncTocTab() {
    const tab = document.querySelector("#toc-tab");
    if (!tab) return;
    tab.hidden = !readerContext.navigationState.tocEntries.length;
    if (readerContext.navigationState.tocEntries.length && readerContext.navigationState.currentChapterIndex < 0)
      readerContext.updateNavigationState({ currentChapterIndex: readerContext.navigationState.tocEntries.findIndex((entry) => !entry.group) });
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
