/** @import * as DomSearch from "../../../typings/reader-dom-search-strict" */
// DOM matching, text snapshots and marks share one Reader-owned lifecycle.
// Use semantic HTML boundaries, not computed styles (which can force layout).
const SEARCH_BLOCKS = new Set(("address article aside blockquote br caption center dd details dialog div dl dt fieldset " +
  "figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre search " +
  "section summary table tbody td tfoot th thead tr ul").split(" "));
const BLOCK_SEPARATOR = "\n";

/** @param {Element} element */
function isSearchBlock(element) {
  // TXT blocks are storage/rendering chunks, not paragraph boundaries.
  return SEARCH_BLOCKS.has(element.localName) && !(element.localName === "pre" &&
    element.classList.contains("reader-text-block") && element.parentElement?.classList.contains("reader-text"));
}

/** @param {string} value */
export function fullSearchEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} text @param {number} index @param {number} length */
export function fullSearchSnippet(text, index, length) {
  const start = Math.max(0, index - 72),
    end = Math.min(text.length, index + length + 88);
  return {
    text: text.slice(start, end),
    matchStart: index - start,
    matchLength: length,
    prefix: start ? "…" : "",
    suffix: end < text.length ? "…" : ""
  };
}

/** @param {number} total @param {number} requestedOffset @param {number} [pageSize] */
export function fullSearchPageOffset(total, requestedOffset, pageSize = 50) {
  return Math.max(0, Math.min(
    Math.floor(Math.max(0, total - 1) / pageSize),
    Math.floor(requestedOffset / pageSize)
  )) * pageSize;
}

/** @param {HTMLElement} mark */
function visibleTextMark(mark) {
  return !mark.closest(".reader-text-padding");
}

// Both caches suspend observation while Reader-owned marks rewrite the DOM.
/** @param {Element} root @param {string[]} attributeFilter @param {() => void} clear */
function observeSearchCache(root, attributeFilter, clear) {
  let valid = true, disposed = false;
  const invalidate = () => { valid = false; clear(); };
  const observer = new MutationObserver(invalidate);
  const current = () => {
    if (observer.takeRecords().length) invalidate();
    return valid && !disposed;
  };
  return {
    current, invalidate,
    pause() { current(); observer.disconnect(); },
    resume() {
      if (!disposed) observer.observe(root, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter
      });
    },
    dispose() { disposed = true; invalidate(); observer.disconnect(); }
  };
}

/** @param {DomSearch.Options} options */
export function createReaderDomSearch({
  content, runtime, isCurrent, yieldTask, getTocEntries, publishPage
}) {
  /** @type {HTMLElement[]} */
  let fullSearchActiveMarks = [];
  /** @type {DomSearch.Locator | null} */
  let fullSearchDomLocator = null;
  /** @type {DomSearch.Snapshot | null} */
  let fullSearchDomSnapshot = null;
  const DOM_SEARCH_SNAPSHOT_BYTES = 8 * 1024 * 1024;
  /** @param {Element} root */
  function createDomSearchSnapshot(root) {
    fullSearchDomSnapshot?.dispose();
    /** @type {DomSearch.SnapshotData | null} */
    let value = null;
    const { current, pause, resume, dispose } = observeSearchCache(root, ["class", "data-page"], () => { value = null; });
    /** @type {DomSearch.Snapshot} */
    const snapshot = {
      root, current, pause, resume, dispose,
      get value() { return current() ? value : null; },
      set(data) {
        if (!current()) return;
        if (data.offsets.length > 32768 ||
            data.text.length * 2 + data.offsets.length * 64 + data.breaks.length * 8 > DOM_SEARCH_SNAPSHOT_BYTES) {
          snapshot.dispose();
          return;
        }
        // Owned highlights replace text nodes but leave these parent boundaries intact.
        value = { ...data, offsets: data.offsets.map(({ parent, start, end }) => ({ parent, start, end })) };
      }
    };
    resume();
    fullSearchDomSnapshot = snapshot;
    return snapshot;
  }
  const stopGeneration = runtime.events.on("generation", (event) => {
    if ((/** @type {{ name: string }} */ (event)).name === "search") {
      fullSearchDomLocator?.dispose();
      fullSearchDomLocator = null;
    }
  });
  function dispose() {
    stopGeneration();
    fullSearchDomLocator?.dispose();
    fullSearchDomLocator = null;
    fullSearchDomSnapshot?.dispose();
    fullSearchDomSnapshot = null;
    fullSearchActiveMarks = [];
  }
  /** @param {Element} root @param {number} generation */
  function createFullSearchDomLocator(root, generation) {
    fullSearchDomLocator?.dispose();
    /** @type {DomSearch.Checkpoint[]} */
    const checkpoints = [];
    const cache = observeSearchCache(root, ["class"], () => { checkpoints.length = 0; });
    const current = () => cache.current() && isCurrent("search", generation);
    /** @type {DomSearch.Locator} */
    const locator = {
      current, pause: cache.pause, resume: cache.resume, dispose: cache.dispose,
      boundaries() { return current() ? checkpoints.slice() : []; },
      seed(boundaries) { if (current()) checkpoints.push(...boundaries); },
      build(offsets) {
        if (!current()) return;
        const stride = Math.max(128, Math.ceil(offsets.length / 2048));
        for (let index = 0; index < offsets.length && checkpoints.length < 2048;) {
          const entry = offsets[index];
          if (!entry) break;
          const { node, parent: target, start } = entry;
          // Element boundaries survive text splitting and normalization by our marks.
          if (target && target.firstChild === node) {
            checkpoints.push({ target, start });
            index += stride;
          } else index++;
        }
      },
      checkpoint(offset) {
        if (!current()) return null;
        let low = 0, high = checkpoints.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if ((checkpoints[middle]?.start ?? Infinity) <= offset) low = middle + 1;
          else high = middle;
        }
        const checkpoint = checkpoints[low - 1];
        if (checkpoint && (!checkpoint.target.isConnected || !root.contains(checkpoint.target))) {
          cache.invalidate();
          return null;
        }
        return checkpoint || null;
      }
    };
    cache.resume();
    fullSearchDomLocator = locator;
    return locator;
  }
  function clearFullSearchMarks() {
    fullSearchDomLocator?.pause();
    fullSearchDomSnapshot?.pause();
    try {
      content.querySelectorAll(".reader-text-hit-box").forEach(node => node.remove());
      /** @type {Set<Node>} */
      const changedParents = new Set();
      for (const mark of fullSearchActiveMarks) {
        if (mark.parentNode) changedParents.add(mark.parentNode);
        mark.replaceWith(mark.textContent);
      }
      fullSearchActiveMarks = [];
      for (const parent of changedParents) parent.normalize();
      content.querySelectorAll(".reader-chapter-search-heading").forEach(node => node.remove());
    } finally {
      fullSearchDomLocator?.resume();
      fullSearchDomSnapshot?.resume();
    }
  }
  /** @param {Element} root @param {number} generation @param {number} endOffset @param {DomSearch.Checkpoint | null} checkpoint @param {(node: Text, start: number, end: number) => void} collect */
  async function fullSearchTextNodes(root, generation, endOffset, checkpoint, collect) {
    /** @param {Element | null} element */
    function enclosingBlock(element) {
      for (; element && element !== root; element = element.parentElement)
        if (isSearchBlock(element)) return element;
      return null;
    }
    let block = checkpoint ? enclosingBlock(checkpoint.target) : null;
    let boundary = false, seenText = false;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const element = /** @type {Element} */ (node);
      if (element.localName === "script" || element.localName === "style" ||
          element.classList.contains("reader-pdf-text") ||
          (element.localName === "mark" && element.classList.contains("full-search-highlight")))
        return NodeFilter.FILTER_REJECT;
      if (isSearchBlock(element)) {
        block = element;
        boundary = true;
      }
      return NodeFilter.FILTER_SKIP;
    });
    if (checkpoint) walker.currentNode = checkpoint.target;
    let visited = 0, length = checkpoint?.start || 0, deadline = performance.now() + 8;
    while (walker.nextNode()) {
      if (!isCurrent("search", generation)) return false;
      const node = /** @type {Text} */ (walker.currentNode);
      if (node.data) {
        if (block && !block.contains(node)) {
          block = enclosingBlock(node.parentElement);
          boundary = true;
        }
        // A checkpoint starts at its text, after any preceding separator.
        if (boundary && seenText) length++;
        boundary = false;
        seenText = true;
        const start = length;
        length += node.data.length;
        collect(node, start, length);
        if (length >= endOffset) break;
      }
      if (++visited % 256 === 0 && performance.now() >= deadline) {
        await yieldTask();
        deadline = performance.now() + 8;
      }
    }
    return true;
  }
  /** @param {DomSearch.TextPart[]} parts */
  function highlightTextParts(parts) {
    fullSearchDomLocator?.pause();
    fullSearchDomSnapshot?.pause();
    const marks = [];
    try {
      for (const { node, start, end } of [...parts].reverse()) {
        node.splitText(end);
        const selected = node.splitText(start),
          mark = node.ownerDocument.createElement("mark");
        mark.className = "full-search-highlight";
        mark.textContent = selected.data;
        selected.replaceWith(mark);
        fullSearchActiveMarks.push(mark);
        marks.unshift(mark);
      }
    } finally {
      fullSearchDomLocator?.resume();
      fullSearchDomSnapshot?.resume();
    }
    return marks;
  }

  /** @param {unknown} entry @returns {entry is DomSearch.TocEntry} */
  function isTocEntry(entry) {
    if (typeof entry !== "object" || entry === null || !("label" in entry) || typeof entry.label !== "string") return false;
    if (!("target" in entry) || entry.target == null) return true;
    const target = entry.target;
    return typeof target === "object" && "nodeType" in target && target.nodeType === 1 &&
      "compareDocumentPosition" in target && typeof target.compareDocumentPosition === "function";
  }
  /** @param {Element} root @param {DomSearch.LiveOffset[]} offsets @returns {DomSearch.HeadingLookup | null} */
  function createFullSearchHeadingLookup(root, offsets) {
    const entries = getTocEntries();
    /** @type {{start: number, label: string}[]} */
    const boundaries = [];
    const headings = entries.filter(isTocEntry).filter(/** @returns {entry is typeof entry & { target: Element }} */ (entry) => !!entry.target);
    // For a large in-root TOC, walk the same DOM order once. Repeated
    // compareDocumentPosition on distant siblings can otherwise dominate search.
    if (headings.length >= 256 && headings.every(entry => entry.target.isConnected &&
        (entry.target === root || root.contains(entry.target)))) {
      const targets = new Set(headings.map(entry => entry.target));
      /** @type {Map<Element, {index: number, order: number}>} */
      const positions = new Map();
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let cursor = 0, order = 0;
      if (targets.has(root)) positions.set(root, { index: 0, order: order++ });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === Node.ELEMENT_NODE && targets.has(/** @type {Element} */ (node)))
          positions.set(/** @type {Element} */ (node), { index: cursor, order: order++ });
        else if (offsets[cursor]?.node === node) cursor++;
      }
      let previous = -1;
      for (const entry of headings) {
        const position = positions.get(entry.target);
        if (position === undefined || position.order < previous) return null;
        previous = position.order;
        boundaries.push({ start: offsets[position.index]?.start ?? Infinity, label: entry.label });
      }
      return (offset) => {
        if (getTocEntries() !== entries) return null;
        let low = 0, high = boundaries.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if ((boundaries[middle]?.start ?? Infinity) <= offset) low = middle + 1;
          else high = middle;
        }
        return { label: boundaries[low - 1]?.label };
      };
    }
    let previous = null;
    for (const entry of headings) {
      const target = entry.target;
      if (!target.isConnected || target.getRootNode() !== root.getRootNode() ||
          (previous && previous !== target &&
           !(previous.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING))) return null;
      previous = target;
    }
    const linear = headings.length * Math.ceil(Math.log2(offsets.length + 1)) > offsets.length;
    let cursor = 0;
    for (const entry of headings) {
      const target = entry.target;
      let low = 0, high = offsets.length;
      if (linear) {
        for (let entry; (entry = offsets[cursor]); cursor++) {
          if (target.compareDocumentPosition(entry.node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
        }
        low = cursor;
      } else {
        while (low < high) {
          const middle = (low + high) >> 1;
          const entry = offsets[middle];
          if (!entry || target.compareDocumentPosition(entry.node) & Node.DOCUMENT_POSITION_FOLLOWING) high = middle;
          else low = middle + 1;
        }
      }
      boundaries.push({ start: offsets[low]?.start ?? Infinity, label: entry.label });
    }
    return (offset) => {
      if (getTocEntries() !== entries) return null;
      let low = 0, high = boundaries.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((boundaries[middle]?.start ?? Infinity) <= offset) low = middle + 1;
        else high = middle;
      }
      return { label: boundaries[low - 1]?.label };
    };
  }
  /** @param {Node} node @param {number} offset @param {number} total @param {DomSearch.HeadingLookup | null} [headingLookup] @param {HTMLElement | null} [parent] */
  function fullSearchLocation(node, offset, total, headingLookup = null, parent = node.parentElement) {
    const page = parent && parent.closest("[data-page]");
    if (page) return `第 ${/** @type {HTMLElement} */ (page).dataset.page} 页`;
    const indexed = headingLookup?.(offset);
    if (indexed?.label !== undefined) return indexed.label;
    if (indexed) return `正文 ${Math.min(100, Math.floor(offset / Math.max(1, total) * 100))}%`;
    if (getTocEntries().length) {
      const heading = getTocEntries().filter(isTocEntry).reverse().find(entry => entry.target &&
        (entry.target === node.parentElement || !!(entry.target.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
      if (heading) return heading.label;
    }
    return `正文 ${Math.min(100, Math.floor(offset / Math.max(1, total) * 100))}%`;
  }
  /** @param {Element} root @param {string} fallback @param {string} query @param {number} generation
   * @param {number} [navigationGeneration] @returns {Promise<DomSearch.Result[]>} */
  async function fullSearchDomMatches(root, fallback, query, generation,
                                      navigationGeneration = runtime.currentGeneration("navigation")) {
    const previousSnapshot = fullSearchDomSnapshot;
    const previousData = previousSnapshot?.root === root ? previousSnapshot.value : null;
    const cached = previousData?.toc === getTocEntries() ? previousData : null;
    const snapshot = cached && previousSnapshot ? previousSnapshot : createDomSearchSnapshot(root);
    const locator = createFullSearchDomLocator(root, generation);
    /** @type {DomSearch.Offset[]} */
    const offsets = cached ? cached.offsets : [];
    /** @type {string[]} */
    const chunks = [];
    const breaks = cached ? cached.breaks : [];
    const findLineBreaks = query.includes(BLOCK_SEPARATOR);
    let length = 0;
    /** @type {(node: Text, start: number, end: number) => void} */
    const collect = (node, start, end) => {
      if (start > length) {
        breaks.push(length);
        chunks.push(BLOCK_SEPARATOR);
      }
      offsets.push({ node, parent: /** @type {HTMLElement} */ (node.parentElement), start, end });
      chunks.push(node.data);
      length = end;
    };
    const collected = cached || await fullSearchTextNodes(root, generation, Infinity, null, collect);
    if (!collected || !isCurrent("search", generation)) return [];
    if (cached) locator.seed(cached.checkpoints);
    else locator.build(offsets);
    const headingLookup = cached ? cached.headingLookup : createFullSearchHeadingLookup(root, /** @type {DomSearch.LiveOffset[]} */ (offsets));
    const text = cached ? cached.text : chunks.join("");
    /** @type {DomSearch.Group[]} */
    const groups = [];
    /** @type {DomSearch.Match[]} */
    const firstHits = [];
    if (!cached && (headingLookup || !getTocEntries().some(entry => isTocEntry(entry) && entry.target)))
      snapshot.set({ text, offsets, breaks, headingLookup, checkpoints: locator.boundaries(), toc: getTocEntries() });
    /** @type {DomSearch.HighlightOffset[]} */
    let highlightOffsets = /** @type {DomSearch.LiveOffset[]} */ (offsets);
    const patternText = fullSearchEscape(query);
    const matchableBreaks = findLineBreaks ? breaks : [];
    let nextStart = 0, total = 0;
    /** @param {number} index @param {{start: number, end: number}[]} [parts] */
    const locateIndex = (index, parts = offsets) => {
      let low = 0, high = parts.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((parts[middle]?.end ?? Infinity) <= index) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    /** @param {number} start @param {number} end */
    const partsFor = (start, end) => {
      const parts = [];
      for (let index = locateIndex(start, highlightOffsets); index < highlightOffsets.length; index++) {
        const entry = highlightOffsets[index];
        if (!entry || entry.start >= end) break;
        parts.push(entry);
      }
      return parts;
    };
    /** @param {DomSearch.Group} group */
    const matchesIn = function* (group) {
      const re = new RegExp(patternText, "giu");
      const source = text.slice(group.start, group.end);
      re.lastIndex = group.skip;
      if (!matchableBreaks.length) {
        for (const match of source.matchAll(re)) {
          if (match.index >= 65536) break;
          yield { index: group.start + match.index, value: match[0] };
        }
        return;
      }
      let low = 0, high = matchableBreaks.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((matchableBreaks[middle] ?? Infinity) < group.start + group.skip) low = middle + 1;
        else high = middle;
      }
      let boundary = matchableBreaks[low] ?? Infinity;
      for (let match; (match = re.exec(source)) && match.index < 65536;) {
        const index = group.start + match.index;
        while (boundary < index) boundary = matchableBreaks[++low] ?? Infinity;
        if (boundary < index + match[0].length) {
          // Only literal source newlines are searchable. Resume after the
          // synthetic separator, not after the rejected match.
          re.lastIndex = boundary - group.start + 1;
          continue;
        }
        yield { index, value: match[0] };
      }
    };
    /** @param {DomSearch.Match} match @returns {DomSearch.Result} */
    const resultFor = (match) => {
      const part = offsets[locateIndex(match.index)];
      return {
        location: part ? fullSearchLocation(part.node || part.parent, match.index, text.length, headingLookup, part.parent) : fallback,
        snippet: fullSearchSnippet(text, match.index, match.value.length),
        async activate(navigationGeneration = runtime.currentGeneration("navigation")) {
          if (!isCurrent("navigation", navigationGeneration)) return false;
          const searchGeneration = runtime.currentGeneration("search");
          const end = match.index + match.value.length;
          clearFullSearchMarks();
          const checkpoint = locator.checkpoint(match.index);
          /** @type {DomSearch.TextPart[]} */
          const parts = [];
          /** @type {(node: Text, start: number, nodeEnd: number) => void} */
          const collectMatch = (node, start, nodeEnd) => {
            if (nodeEnd > match.index && start < end)
              parts.push({ node, start: Math.max(0, match.index - start), end: Math.min(node.data.length, end - start) });
          };
          let collected = await fullSearchTextNodes(root, searchGeneration, end, checkpoint, collectMatch);
          if (checkpoint && !locator.current()) {
            parts.length = 0;
            collected = await fullSearchTextNodes(root, searchGeneration, end, null, collectMatch);
          }
          if (!collected || !isCurrent("search", searchGeneration) ||
              !isCurrent("navigation", navigationGeneration)) return false;
          if (parts.map(part => part.node.data.slice(part.start, part.end)).join("") !== match.value) return false;
          const marks = highlightTextParts(parts);
          marks.find(visibleTextMark)?.scrollIntoView({ block: "center" });
          return marks.length > 0;
        }
      };
    };
    const pageSize = 50;
    /** @type {DomSearch.Result[]} */
    const firstPage = [];
    /** @param {number} requestedOffset @returns {DomSearch.Page} */
    const page = (requestedOffset) => {
      const offset = fullSearchPageOffset(total, requestedOffset, pageSize);
      if (offset === 0) return { total, offset, pageSize, results: firstPage.slice() };
      const results = [];
      let passed = 0;
      for (const group of groups) {
        if (passed + group.count <= offset) { passed += group.count; continue; }
        for (const match of matchesIn(group)) {
          if (passed++ < offset) continue;
          results.push(resultFor(match));
          if (results.length === pageSize) break;
        }
        if (results.length === pageSize) break;
      }
      return { total, offset, pageSize, results };
    };
    let scanDeadline = performance.now() + 8;
    for (let start = 0; start < text.length; start += 65536) {
      const group = { start, end: start + 65536 + query.length - 1,
        skip: Math.max(0, nextStart - start), count: 0 };
      for (const match of matchesIn(group)) {
        group.count++;
        nextStart = match.index + match.value.length;
        if (firstHits.length < 100) firstHits.push(match);
        // Keep rows already published on the first page activatable as the
        // scan grows, without rebuilding their snippets or activation closures.
        if (firstPage.length < pageSize) firstPage.push(resultFor(match));
      }
      groups.push(group);
      total += group.count;
      if (start === 0 || (group.count && total <= pageSize) || groups.length % 8 === 0) {
        publishPage(page(0), page, true);
      }
      // Keep bounded scan groups and exact progress, but avoid a clamped timer
      // for every small group when scanning itself is much faster than a frame.
      if (start === 0 || performance.now() >= scanDeadline) {
        await yieldTask();
        scanDeadline = performance.now() + 8;
      }
      if (!isCurrent("search", generation)) return [];
    }
    publishPage(page(0), page, false);
    if (cached && !snapshot.current())
      return fullSearchDomMatches(root, fallback, query, generation, navigationGeneration);
    const firstHit = firstHits[0], lastHit = firstHits.at(-1);
    if (cached && firstHit && lastHit && navigationGeneration === runtime.currentGeneration("navigation")) {
      const checkpoint = locator.checkpoint(firstHit.index);
      const end = lastHit.index + lastHit.value.length;
      highlightOffsets = [];
      const collected = await fullSearchTextNodes(root, generation, end, checkpoint,
        (node, start, end) => highlightOffsets.push({ node, start, end }));
      if (!collected || !isCurrent("search", generation)) return [];
      if (!snapshot.current())
        return fullSearchDomMatches(root, fallback, query, generation, navigationGeneration);
    }
    if (navigationGeneration === runtime.currentGeneration("navigation")) {
      for (let i = firstHits.length - 1; i >= 0; i--) {
        const match = firstHits[i];
        if (!match) continue;
        const end = match.index + match.value.length;
        const parts = partsFor(match.index, end);
        if (!parts.length) continue;
        highlightTextParts(parts.map(part => ({ node: part.node,
          start: Math.max(match.index, part.start) - part.start,
          end: Math.min(end, part.end) - part.start })));
      }
    }
    return page(0).results;
  }
  function pruneMarks() {
    fullSearchActiveMarks = fullSearchActiveMarks.filter(mark => mark.isConnected);
  }
  return Object.freeze({
    search: fullSearchDomMatches, clearMarks: clearFullSearchMarks,
    highlight: highlightTextParts, pruneMarks, dispose
  });
}
