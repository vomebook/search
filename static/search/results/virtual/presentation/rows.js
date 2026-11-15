// Reconcile reusable rows, segmented spacers and focus in one DOM transaction.
(function () {
/** @param {SearchVirtualState} VSCROLL @param {SearchVirtualScroll} scroll @param {SearchVirtualRowsDependencies} deps */
function create(VSCROLL, scroll, deps) {
const { elements: DOM, getResultScrollTop, getVirtualOffset, findVirtualIndex,
  ensureResultTemplateCache, createResultRow } = deps;
const RESULT_SCROLL_SEGMENT_HEIGHT = VoiceOfMLVirtualResults.segmentHeight;
/** @param {number} totalH @param {number} logicalTop @param {number} viewport */
function getResultScrollOrigin(totalH, logicalTop, viewport) {
  const limit = RESULT_SCROLL_SEGMENT_HEIGHT;
  const maxOrigin = Math.max(0, totalH - limit);
  const physical = logicalTop - scroll.origin;
  if (scroll.origin > maxOrigin || physical < limit / 4 || physical + viewport > limit * 3 / 4) {
    return Math.max(0, Math.min(maxOrigin, logicalTop - limit / 2));
  }
  return scroll.origin;
}
/** @param {number} topH @param {number} endH @param {number} totalH @param {number} logicalTop @param {number} [viewport] */
function layoutResultScrollSegment(topH, endH, totalH, logicalTop, viewport = DOM.resultsContainer.clientHeight) {
  const limit = RESULT_SCROLL_SEGMENT_HEIGHT;
  scroll.origin = getResultScrollOrigin(totalH, logicalTop, viewport);
  const top = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector('.virtual-spacer-top'));
  const bottom = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector('.virtual-spacer-bottom'));
  if (top) top.style.height = Math.max(0, topH - scroll.origin) + 'px';
  if (bottom) bottom.style.height = Math.max(0, Math.min(totalH, scroll.origin + limit) - endH) + 'px';
}

/** @param {(VoiceOfMLResultRecord | null | undefined)[]} items @param {number} start @param {number} end @param {number} topH @param {number} bottomH @param {number} [viewport] */
function reconcileVirtualRows(items, start, end, topH, bottomH, viewport = DOM.resultsContainer.clientHeight) {
  const focused = /** @type {HTMLElement} */ (document.activeElement);
  const focusedRow = DOM.resultsList.contains(focused) ? /** @type {HTMLElement} */ (focused.closest('.result-item')) : null;
  const focusedRecord = focusedRow && deps.recordForRow(focusedRow);
  // Validate once before reusing rows, not once for every new row.
  ensureResultTemplateCache();
  const logicalTop = getResultScrollTop();
  const previousOrigin = scroll.origin;
  let topSpacer = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector(".virtual-spacer-top"));
  let bottomSpacer = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector(".virtual-spacer-bottom"));
  if (!topSpacer) {
    topSpacer = document.createElement("div");
    topSpacer.className = "virtual-spacer virtual-spacer-top";
    topSpacer.setAttribute('aria-hidden', 'true');
    DOM.resultsList.prepend(topSpacer);
  }
  if (!bottomSpacer) {
    bottomSpacer = document.createElement("div");
    bottomSpacer.className = "virtual-spacer virtual-spacer-bottom";
    bottomSpacer.setAttribute('aria-hidden', 'true');
    DOM.resultsList.append(bottomSpacer);
  }
  const endH = getVirtualOffset(end);
  layoutResultScrollSegment(topH, endH, endH + bottomH, logicalTop, viewport);

  /** @type {Map<number, HTMLElement>} */
  const existing = new Map();
  /** @type {NodeListOf<HTMLElement>} */ (DOM.resultsList.querySelectorAll(".result-item[data-index]")).forEach((row) => {
    const idx = Number(row.dataset.index);
    if (idx < start || idx >= end || Number(row.dataset.contentVersion) !== VSCROLL.contentVersion || deps.recordForRow(row) !== items[idx]) row.remove();
    else existing.set(idx, row);
  });
  /** @type {ChildNode | null} */
  let cursor = topSpacer.nextSibling;
  for (let idx = start; idx < end; idx++) {
    const row = existing.get(idx) || createResultRow(items[idx], idx);
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-posinset', String(idx + 1));
    row.setAttribute('aria-setsize', String(deps.total()));
    if (row !== cursor) DOM.resultsList.insertBefore(row, cursor || bottomSpacer);
    cursor = row.nextSibling;
  }
  if (DOM.resultsList.lastElementChild !== bottomSpacer) DOM.resultsList.append(bottomSpacer);
  if (focusedRow && !focused.isConnected) {
    const replacement = /** @type {HTMLElement | null} */ (DOM.resultsList.querySelector('.result-item[data-index="' + focusedRow.dataset.index + '"]'));
    const sameRecord = replacement && focusedRecord && deps.recordForRow(replacement) === focusedRecord;
    const control = sameRecord && (focused === focusedRow ? replacement :
      Array.from(/** @type {NodeListOf<HTMLElement>} */ (replacement.querySelectorAll('button,a,input,[role="button"]'))).find(node =>
        node.className === focused.className && node.dataset.action === /** @type {HTMLElement} */ (focused).dataset.action &&
        node.getAttribute('aria-label') === focused.getAttribute('aria-label')));
    if (!control) deps.resetKeyboardIndex(findVirtualIndex(logicalTop) - 1);
    (control || DOM.resultsContainer).focus({ preventScroll: true });
  }
  if (previousOrigin !== scroll.origin || scroll.target !== null) {
    DOM.resultsContainer.scrollTop = Math.ceil(logicalTop - scroll.origin);
    scroll.target = null;
  }
}
return { getResultScrollOrigin, layoutResultScrollSegment, reconcileVirtualRows };
}
globalThis.VoiceOfMLVirtualRows = { create };
})();
