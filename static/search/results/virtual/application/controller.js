// Own the virtual render/measurement lifecycle and logical scroll segment.
(function () {
const segmentHeight = 1000000;
/** @param {SearchVirtualState} VSCROLL @param {SearchVirtualDependencies} deps */
function create(VSCROLL, deps) {
const { elements: DOM, updateCurrentResultPosition, maybeLoadNextPage, updateScrollThumb,
  updateScrollTrack, ensureResultWindowPages, updateVisibleSelection, animateVisibleResultRows,
  rememberDisplayedSearchView, cancelQuickScroll, activateSearchView, clearResultTemplateCache,
  getHeightMeasurementKey, getResultStableId } = deps;
/** @type {SearchVirtualScroll} */
const scroll = { origin: 0, target: null };
/** @type {number | null} */
let releasedDragTop = null;
const heights = VoiceOfMLVirtualHeights.create(VSCROLL, deps);
const { getVirtualTotalHeight, getVirtualOffset, findVirtualIndex, ensureVirtualHeights } = heights;
const { getResultScrollOrigin, layoutResultScrollSegment, reconcileVirtualRows } = VoiceOfMLVirtualRows.create(VSCROLL, scroll, {
  elements: DOM, total: deps.total, recordForRow: deps.recordForRow,
  resetKeyboardIndex: deps.resetKeyboardIndex, ensureResultTemplateCache: deps.ensureResultTemplateCache,
  createResultRow: deps.createResultRow, getResultScrollTop, getVirtualOffset, findVirtualIndex
});
function getResultScrollTop() {
  return scroll.target ?? (scroll.origin + DOM.resultsContainer.scrollTop);
}

/** @param {number} value @param {boolean} [restoreWindow] */
function setResultScrollTop(value, restoreWindow = false) {
  const total = getVirtualTotalHeight(), viewport = DOM.resultsContainer.clientHeight;
  const target = Math.max(0, Math.min(value, Math.max(0, total - viewport)));
  const physical = target - scroll.origin;
  if (!restoreWindow && physical >= 0 && physical <= DOM.resultsContainer.scrollHeight - viewport) {
    // Native scrolling rounds subpixels. Round toward the requested row so
    // an exact boundary cannot land on the previous record after restoration.
    DOM.resultsContainer.scrollTop = Math.ceil(physical);
    updateCurrentResultPosition();
    return;
  }
  if (restoreWindow) {
    // Seed restored windows without velocity overscan from the position jump.
    VSCROLL.lastScrollTop = target;
    VSCROLL.lastScrollTime = 0;
    VSCROLL.scrollVelocity = 0;
    releasedDragTop = null;
  }
  scroll.target = target;
  VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
  try { renderVisible(); } finally { scroll.target = null; }
  if (restoreWindow && VSCROLL.dragMetrics && !VSCROLL.isDraggingThumb) releasedDragTop = getResultScrollTop();
  updateCurrentResultPosition();
}

function scheduleVirtualRender(scrollIntent = false) {
  const afterScroll = scrollIntent === true;
  if (afterScroll && !VSCROLL.renderAfterScroll) {
    VSCROLL.renderAfterScroll = true;
    if (!VSCROLL.isDraggingThumb) maybeLoadNextPage();
  }
  if (VSCROLL.renderFrame) return;
  VSCROLL.renderFrame = requestAnimationFrame(() => {
    VSCROLL.renderFrame = 0;
    const scrollTrackUpdated = renderVisible();
    if (VSCROLL.renderAfterScroll) {
      VSCROLL.renderAfterScroll = false;
      if (!scrollTrackUpdated) {
        if (VSCROLL.isDraggingThumb) updateScrollThumb();
        else updateScrollTrack();
      }
    }
  });
}

function renderVisible() {
  const items = deps.results();
  const len = deps.hasWindow() ? deps.windowTotal() : items.length;
  ensureVirtualHeights(len);
  if (len === 0) {
    if (VSCROLL.renderStart !== 0 || VSCROLL.renderEnd !== 0) {
      // Validation can replace a nonempty preview in place. Reconcile the
      // old rows and spacers rather than leaving clickable stale records.
      reconcileVirtualRows(items, 0, 0, 0, 0, DOM.resultsContainer.clientHeight);
      VSCROLL.renderStart = VSCROLL.renderEnd = 0;
    }
    updateScrollTrack();
    return true;
  }
  const container = DOM.resultsContainer;
  const scrollTop = getResultScrollTop();
  const viewH = container.clientHeight;
  const est = VSCROLL.estimatedHeight;
  const overscanItems = Math.max(10, Math.floor(viewH / (est || 60)));
  const now = performance.now();
  const previousScrollTop = VSCROLL.lastScrollTop;
  const elapsed = VSCROLL.lastScrollTime ? Math.max(1, now - VSCROLL.lastScrollTime) : 16;
  const instantVelocity = Math.abs(scrollTop - previousScrollTop) / elapsed;
  VSCROLL.scrollVelocity = VSCROLL.scrollVelocity * 0.7 + instantVelocity * 0.3;
  VSCROLL.lastScrollTime = now;
  const tightWindow = VSCROLL.isDraggingThumb || !!VSCROLL.dragMetrics;
  const extraScreens = tightWindow ? 0 : Math.min(3, Math.floor(VSCROLL.scrollVelocity / 1.5));
  const baseOverscanPx = overscanItems * (est || 60);
  const velocityOverscanPx = extraScreens * viewH;
  const scrollingDown = scrollTop >= previousScrollTop;
  VSCROLL.scrollDirection = scrollingDown ? 1 : -1;
  VSCROLL.lastScrollTop = scrollTop;
  const totalH = getVirtualOffset(len);
  const segmentNeedsRecenter = getResultScrollOrigin(totalH, scrollTop, viewH) !== scroll.origin;
  const needsLayout = segmentNeedsRecenter || scroll.target !== null;
  // A scroll event from drag compensation must not widen the released
  // window. Normal overscan resumes as soon as the viewport actually moves.
  if (releasedDragTop !== null && Math.abs(scrollTop - releasedDragTop) > 1) releasedDragTop = null;
  const safePadding = releasedDragTop !== null ? 0 : tightWindow ? viewH * 0.35 : baseOverscanPx * 0.35;
  const safeStart = findVirtualIndex(Math.max(0, scrollTop - safePadding));
  const safeEnd = Math.min(len, findVirtualIndex(scrollTop + viewH + safePadding) + 1);
  ensureResultWindowPages(safeStart, safeEnd);
  updateCurrentResultPosition();
  if (!deps.pendingEntrance() && !needsLayout
      && VSCROLL.renderStart <= safeStart && VSCROLL.renderEnd >= safeEnd) return false;
  let beforePx, afterPx;
  if (tightWindow) {
    beforePx = afterPx = viewH * 0.35;
  } else if (scrollingDown) {
    beforePx = baseOverscanPx;
    afterPx = baseOverscanPx * 2 + velocityOverscanPx;
  } else {
    beforePx = baseOverscanPx * 2 + velocityOverscanPx;
    afterPx = baseOverscanPx;
  }
  let start = findVirtualIndex(Math.max(0, scrollTop - beforePx));
  let end = Math.min(len, findVirtualIndex(scrollTop + viewH + afterPx) + 1);
  if (end - start < 10 && len > 10) end = Math.min(start + 30, len);
  if (deps.pendingEntrance() && start === 0) end = Math.min(len, Math.max(end, 30));
  ensureResultWindowPages(start, end);
  if (start === VSCROLL.renderStart && end === VSCROLL.renderEnd && !needsLayout) return false;
  VSCROLL.renderStart = start;
  VSCROLL.renderEnd = end;
  const topH = getVirtualOffset(start);
  const endH = getVirtualOffset(end);
  const bottomH = Math.max(0, totalH - endH);
  const anchorIndex = findVirtualIndex(scrollTop);
  const anchor = { index: anchorIndex, offset: scrollTop - getVirtualOffset(anchorIndex) };
  reconcileVirtualRows(items, start, end, topH, bottomH, viewH);
  if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateVisibleSelection();
  if (VSCROLL.isDraggingThumb) {
    // A provisional bottom made of estimated rows can shrink by multiple
    // viewports. Settle it during the drag, keeping the last row reachable.
    const atBottom = scrollTop >= totalH - viewH - 1;
    if (measureRenderedHeights(start, end, anchor, atBottom)) {
      // If the first batch shrank, fill the tight overscan again before
      // displaying it under the thumb, so release doesn't discover new rows.
      const correctedTop = getResultScrollTop();
      if ((start > 0 && correctedTop - viewH * 0.35 < getVirtualOffset(start) - 1)
          || (end < len && correctedTop + viewH * 1.35 > getVirtualOffset(end) + 1)) {
        VSCROLL.renderStart = -1;
        VSCROLL.renderEnd = -1;
        if (renderVisible()) return true;
      }
    }
  }
  // Correct the rendered window before paint, using one content anchor.
  // A deferred measurement can otherwise run against another window/query.
  if (!VSCROLL.isDraggingThumb && measureHeights(start, end, anchor)) {
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    scheduleVirtualRender();
  }
  updateScrollTrack();
  if (deps.pendingEntrance()) {
    deps.consumeEntrance();
    animateVisibleResultRows();
  }
  return true;
}

function resetVirtualScrollState() {
  scroll.origin = 0;
  scroll.target = null;
  releasedDragTop = null;
  rememberDisplayedSearchView();
  cancelQuickScroll();
  if (VSCROLL.renderFrame) cancelAnimationFrame(VSCROLL.renderFrame);
  VSCROLL.renderFrame = 0;
  VSCROLL.renderAfterScroll = false;
  activateSearchView();
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  VSCROLL.heights = [];
  VSCROLL.sparseHeights = !!deps.hasWindow() || !!deps.cloning();
  VSCROLL.heightBase = VSCROLL.estimatedHeight || 60;
  VSCROLL.heightTree = [];
  VSCROLL.heightsDirty = true;
  VSCROLL.lastScrollTop = 0;
  VSCROLL.lastScrollTime = 0;
  VSCROLL.scrollVelocity = 0;
  VSCROLL.scrollDirection = 1;
  VSCROLL.estimateMeasurementKey = "";
  clearResultTemplateCache();
  updateScrollTrack();
}

function refreshVirtualAfterAppend(updateView = true) {
  if (updateView && !deps.restoring() && deps.loadedPage() >= 1) rememberDisplayedSearchView();
  const previousLength = VSCROLL.heights.length;
  ensureVirtualHeights(deps.results().length);
  const topSpacer = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector(".virtual-spacer-top"));
  const bottomSpacer = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector(".virtual-spacer-bottom"));
  if (!topSpacer || !bottomSpacer || VSCROLL.renderStart < 0 || VSCROLL.renderEnd <= VSCROLL.renderStart) {
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    if (updateView) scheduleVirtualRender();
    return;
  }
  const topH = getVirtualOffset(VSCROLL.renderStart);
  const endH = getVirtualOffset(VSCROLL.renderEnd);
  const totalH = getVirtualTotalHeight();
  const logicalTop = getResultScrollTop(), previousOrigin = scroll.origin;
  layoutResultScrollSegment(topSpacer, bottomSpacer, topH, endH, totalH, logicalTop);
  if (previousOrigin !== scroll.origin) DOM.resultsContainer.scrollTop = logicalTop - scroll.origin;
  if (updateView) {
    const viewH = DOM.resultsContainer.clientHeight, estimate = VSCROLL.estimatedHeight || 60;
    const buffer = 2 * Math.max(10, Math.floor(viewH / estimate)) * estimate + 3 * viewH;
    if (!deps.hasWindow() && previousLength < deps.results().length && VSCROLL.renderEnd < previousLength
        && topH <= logicalTop && endH >= logicalTop + viewH
        && getVirtualOffset(previousLength) > logicalTop + viewH + buffer) {
      updateScrollTrack();
      return;
    }
    // Coalesce page arrival with a pending scroll render when possible.
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    scheduleVirtualRender();
  }
}

function ensureVirtualViewportCovered() {
  if (VSCROLL.renderStart < 0 || VSCROLL.renderEnd <= VSCROLL.renderStart) return;
  const viewTop = getResultScrollTop();
  const viewBottom = viewTop + DOM.resultsContainer.clientHeight;
  if ((VSCROLL.renderStart > 0 && viewTop < getVirtualOffset(VSCROLL.renderStart) - 1)
      || (VSCROLL.renderEnd < VSCROLL.heights.length && viewBottom > getVirtualOffset(VSCROLL.renderEnd) + 1)) {
    // Let the scroll RAF perform the single DOM update for this frame. A
    // synchronous render here would duplicate layout and height measurement.
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
  }
}

/** @param {number} [start] @param {number} [end] @param {{index: number, offset: number} | null} [anchor] */
function measureHeights(start = VSCROLL.renderStart, end = VSCROLL.renderEnd, anchor = null) {
  if (VSCROLL.isDraggingThumb || start !== VSCROLL.renderStart || end !== VSCROLL.renderEnd) return false;
  const top = getResultScrollTop();
  const index = anchor ? anchor.index : findVirtualIndex(top);
  return measureRenderedHeights(start, end, anchor || { index, offset: top - getVirtualOffset(index) });
}

/** @param {number} start @param {number} end @param {{index: number, offset: number}} anchor */
function measureRenderedHeights(start, end, anchor, pinBottom = false) {
  const rowMeasureKey = getHeightMeasurementKey();
  const measureKey = [rowMeasureKey, start, end].join(":");
  if (VSCROLL.measuredWindowKey === measureKey) return false;
  const els = /** @type {NodeListOf<HTMLElement>} */ (DOM.resultsList.querySelectorAll(".result-item"));
  /** @type {[number, number][]} */
  const measurements = [];
  let measuredSum = 0;
  let measuredCount = 0;
  let changed = false;
  for (let i = 0; i < els.length; i++) {
    const idx = parseInt(/** @type {string} */ (/** @type {HTMLElement} */ (els[i]).dataset.index));
    if (!deps.results()[idx]) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= VSCROLL.heights.length) continue;
    if (VSCROLL.measuredRowKeys[idx] === rowMeasureKey && /** @type {number} */ (VSCROLL.heights[idx]) > 0) {
      measuredSum += /** @type {number} */ (VSCROLL.heights[idx]);
      measuredCount++;
      continue;
    }
    const height = /** @type {HTMLElement} */ (els[i]).getBoundingClientRect().height;
    if (height <= 0) continue;
    measurements.push([idx, height]);
    measuredSum += height;
    measuredCount++;
    VSCROLL.measuredRowKeys[idx] = rowMeasureKey;
    deps.recordMeasurement();
    VSCROLL.heightCache.set(getResultStableId(deps.results()[idx]), { height, measurementKey: rowMeasureKey });
  }
  for (let i = 0; i < measurements.length; i++) {
    const idx = /** @type {[number, number]} */ (measurements[i])[0];
    const height = /** @type {[number, number]} */ (measurements[i])[1];
    if (VSCROLL.heights[idx] !== height) {
      const prev = VSCROLL.heights[idx] || VSCROLL.estimatedHeight || 60;
      VSCROLL.heights[idx] = height;
      if (!VSCROLL.heightsDirty && VSCROLL.heightTree.length === VSCROLL.heights.length + 1) {
        VoiceOfMLSearchHeightIndex.fenwickAdd(VSCROLL.heightTree, idx + 1, height - prev);
      } else {
        VSCROLL.heightsDirty = true;
      }
      changed = true;
    }
  }
  if (!VSCROLL.isDraggingThumb && !VSCROLL.sparseHeights && measuredCount > 10 && VSCROLL.estimateMeasurementKey !== rowMeasureKey) {
    VSCROLL.estimateMeasurementKey = rowMeasureKey;
    const nextEstimate = measuredSum / measuredCount;
    if (Math.abs(nextEstimate - VSCROLL.estimatedHeight) > 1) {
      VSCROLL.estimatedHeight = nextEstimate;
      // Seed estimates at the top only. Rescaling the entire unseen list
      // from each new window moves the thumb and can clamp scrollTop to bottom.
      if (getResultScrollTop() === 0 && start === 0) {
        for (let index = 0; index < VSCROLL.heights.length; index++) {
          if (!VSCROLL.measuredRowKeys[index]) VSCROLL.heights[index] = nextEstimate;
        }
        VSCROLL.heightsDirty = true;
        changed = true;
      }
    }
  }
  VSCROLL.measuredWindowKey = measureKey;
  if (changed) {
    refreshVirtualAfterAppend(false);
    const height = VSCROLL.heights[anchor.index] || VSCROLL.heightBase;
    const viewport = DOM.resultsContainer.clientHeight;
    const maxTop = Math.max(0, getVirtualTotalHeight() - viewport);
    const target = pinBottom ? maxTop
      : Math.max(0, Math.min(maxTop, getVirtualOffset(anchor.index) + Math.min(anchor.offset, height - 1)));
    if (Math.abs(getResultScrollTop() - target) > 0.5) setResultScrollTop(target);
    VSCROLL.lastScrollTop = getResultScrollTop();
  }
  return changed;
}
return { ...heights, getResultScrollTop, setResultScrollTop, scheduleVirtualRender, renderVisible, resetVirtualScrollState, refreshVirtualAfterAppend, ensureVirtualViewportCovered, measureHeights };
}
globalThis.VoiceOfMLVirtualResults = { create, segmentHeight };
})();
