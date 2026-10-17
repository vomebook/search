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
    link.tabIndex = 0;
    link.setAttribute("role", "link");
    link.textContent = entry.label;
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
  let tocHintInteractionCleanup = null;
  const cancelTocHint = () => {
    clearTimeout(tocHintTimer);
    tocHintTimer = 0;
    tocHintPending = false;
    tocHintInteractionCleanup?.();
    tocHintInteractionCleanup = null;
  };
  const finishTocHint = () => {
    tocHintTimer = 0;
    if (readerContext.readerLifecycle.disposed || !tocHintPending) return;
    if (readerContext.readerRuntime.state.lifecycle.phase !== "ready") return;
    tocHintPending = false;
    if (!readerContext.navigationState.tocEntries.length ||
        readerContext.panelState.open || readerContext.readerPanelInteractionSerial > 0 ||
        readerContext.readerUiHistoryState !== "base") {
      tocHintShown = true;
      return;
    }
    const panel = document.querySelector("#history-panel");
    if (!panel) return;
    tocHintShown = true;
    const autoSerial = readerContext.readerPanelInteractionSerial;
    // This is a visual hint, not a user-opened panel state. Keep the toolbar's
    // aria-expanded/state closed so the next history-button click converts the
    // hint into a normal persistent panel instead of immediately closing it.
    panel.hidden = false;
    void panel.offsetWidth;
    panel.classList.add("is-open");
    readerContext.selectPanel("toc");
    readerContext.updateTocCurrentMark();
    const markInteraction = () => { readerContext.readerPanelInteractionSerial++; };
    const events = ["pointerdown", "keydown", "focusin"];
    events.forEach(type => panel.addEventListener(type, markInteraction, true));
    tocHintInteractionCleanup = () => {
      events.forEach(type => panel.removeEventListener(type, markInteraction, true));
      tocHintInteractionCleanup = null;
    };
    tocHintTimer = setTimeout(() => {
      tocHintInteractionCleanup?.();
      tocHintTimer = 0;
      if (!readerContext.readerLifecycle.disposed && !readerContext.panelState.open &&
          panel.classList.contains("is-open") &&
          readerContext.readerPanelInteractionSerial === autoSerial)
        panel.classList.remove("is-open");
      if (!panel.classList.contains("is-open"))
        setTimeout(() => { if (!panel.classList.contains("is-open")) panel.hidden = true; }, 250);
    }, 1600);
  };
  let phaseCleanup = null;
  function ensureTocHintPhaseListener() {
    if (phaseCleanup) return;
    phaseCleanup = readerContext.readerRuntime.events.on("phase", ({ phase }) => {
      if (phase === "ready" && tocHintPending && !tocHintTimer)
        tocHintTimer = setTimeout(finishTocHint, 80);
      else if (phase === "failed" || phase === "disposed") {
        cancelTocHint();
        phaseCleanup?.();
        phaseCleanup = null;
      }
    });
    readerContext.readerRuntime.track(() => { cancelTocHint(); phaseCleanup?.(); phaseCleanup = null; });
  }
  function hintReaderToc() {
    if (tocHintShown || tocHintPending || !readerContext.navigationState.tocEntries.length) return;
    ensureTocHintPhaseListener();
    tocHintPending = true;
    if (readerContext.readerRuntime.state.lifecycle.phase === "ready")
      tocHintTimer = setTimeout(finishTocHint, 80);
  }

  function setToc(entries) {
    const normalizedEntries = (entries || []).map((entry) => ({
      ...entry,
      href: String(entry.href || ""),
      label: readerContext.cleanTocLabel(entry.label)
    }));
    readerContext.updateNavigationState({
      tocEntries: normalizedEntries,
      currentChapterIndex: normalizedEntries.length ? 0 : -1
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
        mark.textContent = "✓";
        row.appendChild(mark);
      }
      mark.hidden = index !== readerContext.navigationState.currentChapterIndex;
      row.classList.toggle("is-current", index === readerContext.navigationState.currentChapterIndex);
    }
  }

  function syncTocTab() {
    const tab = document.querySelector("#toc-tab");
    if (!tab) return;
    tab.hidden = !readerContext.navigationState.tocEntries.length;
    if (readerContext.navigationState.tocEntries.length && readerContext.navigationState.currentChapterIndex < 0)
      readerContext.updateNavigationState({ currentChapterIndex: 0 });
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
