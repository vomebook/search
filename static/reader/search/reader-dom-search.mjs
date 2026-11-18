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

/** @param {DomSearch.Options} options */
export function createReaderDomSearch({
  content, runtime, isCurrent, yieldTask, getTocEntries, unwrapRoot, publishPage
}) {
  /** @type {HTMLElement[]} */
  let fullSearchActiveMarks = [];
  /** @type {DomSearch.Locator | null} */
  let fullSearchDomLocator = null;
  /** @type {DomSearch.Snapshot | null} */
  let fullSearchDomSnapshot = null;
  const DOM_SEARCH_SNAPSHOT_BYTES = 8 * 1024 * 1024;
  /** @param {Element | ShadowRoot} root */
  function createDomSearchSnapshot(root) {
    fullSearchDomSnapshot?.dispose();
    let valid = true, disposed = false;
    /** @type {DomSearch.SnapshotData | null} */
    let value = null;
    const invalidate = () => { valid = false; value = null; };
    const observer = new MutationObserver(invalidate);
    const current = () => {
      if (observer.takeRecords().length) invalidate();
      return valid && !disposed;
    };
    const resume = () => {
      if (!disposed) observer.observe(root, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["class", "data-page"]
      });
    };
    /** @type {DomSearch.Snapshot} */
    const snapshot = {
      root, current, resume,
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
      },
      pause() { current(); observer.disconnect(); },
      dispose() { disposed = true; invalidate(); observer.disconnect(); }
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
  /** @param {Element | ShadowRoot} root @param {number} generation */
  function createFullSearchDomLocator(root, generation) {
    fullSearchDomLocator?.dispose();
    /** @type {DomSearch.Checkpoint[]} */
    const checkpoints = [];
    let valid = true, disposed = false;
    const invalidate = () => { valid = false; checkpoints.length = 0; };
    const observer = new MutationObserver(invalidate);
    const current = () => {
      if (observer.takeRecords().length) invalidate();
      return valid && !disposed && isCurrent("search", generation);
    };
    const resume = () => {
      if (!disposed) observer.observe(root, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"]
      });
    };
    /** @type {DomSearch.Locator} */
    const locator = {
      current,
      boundaries() { return current() ? checkpoints.slice() : []; },
      seed(boundaries) { if (current()) checkpoints.push(...boundaries); },
      build(offsets) {
        if (!current()) return;
        const stride = Math.max(128, Math.ceil(offsets.length / 2048));
        for (let index = 0; index < offsets.length && checkpoints.length < 2048;) {
          const { node, parent: target, start } = offsets[index];
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
          if (checkpoints[middle].start <= offset) low = middle + 1;
          else high = middle;
        }
        const checkpoint = checkpoints[low - 1];
        if (checkpoint && (!checkpoint.target.isConnected || !root.contains(checkpoint.target))) {
          invalidate();
          return null;
        }
        return checkpoint || null;
      },
      pause() { current(); observer.disconnect(); },
      resume,
      dispose() { disposed = true; invalidate(); observer.disconnect(); }
    };
    resume();
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
        if (mark.tagName === "MARK") {
          if (mark.parentNode) changedParents.add(mark.parentNode);
          mark.replaceWith(mark.textContent);
        }
        else mark.classList.remove("full-search-highlight");
      }
      fullSearchActiveMarks = [];
      for (const parent of changedParents) parent.normalize();
      content.querySelectorAll(".reader-chapter-search-heading").forEach(node => node.remove());
    } finally {
      fullSearchDomLocator?.resume();
      fullSearchDomSnapshot?.resume();
    }
  }
  /** @param {Element | ShadowRoot} root @param {number} generation @param {number} [endOffset] @param {DomSearch.Checkpoint | null} [checkpoint] @param {((node: Text, start: number, end: number) => void) | null} [collect] @param {boolean} [respectBlocks] */
  async function fullSearchTextNodes(root, generation, endOffset = Infinity, checkpoint = null, collect = null, respectBlocks = true) {
    const nodes = [];
    /** @param {Element | null} element */
    function enclosingBlock(element) {
      for (; element && element !== root; element = element.parentElement)
        if (isSearchBlock(element)) return element;
      return null;
    }
    let block = respectBlocks && checkpoint ? enclosingBlock(checkpoint.target) : null;
    let boundary = false, seenText = false;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const element = /** @type {Element} */ (node);
      if (element.localName === "script" || element.localName === "style" ||
          element.classList.contains("reader-pdf-text") ||
          (element.localName === "mark" && element.classList.contains("full-search-highlight")))
        return NodeFilter.FILTER_REJECT;
      if (respectBlocks && isSearchBlock(element)) {
        block = element;
        boundary = true;
      }
      return NodeFilter.FILTER_SKIP;
    });
    if (checkpoint) walker.currentNode = checkpoint.target;
    let visited = 0, length = checkpoint?.start || 0, deadline = performance.now() + 8;
    while (walker.nextNode()) {
      if (!isCurrent("search", generation)) return null;
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
        if (collect) collect(node, start, length);
        else nodes.push(node);
        if (length >= endOffset) break;
      }
      if (++visited % 256 === 0 && performance.now() >= deadline) {
        await yieldTask();
        deadline = performance.now() + 8;
      }
    }
    return nodes;
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
  /** @param {Element | ShadowRoot} root @param {DomSearch.LiveOffset[]} offsets @returns {DomSearch.HeadingLookup | null} */
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
      if (root.nodeType === Node.ELEMENT_NODE && targets.has(/** @type {Element} */ (root)))
        positions.set(/** @type {Element} */ (root), { index: 0, order: order++ });
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
          if (boundaries[middle].start <= offset) low = middle + 1;
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
        while (cursor < offsets.length &&
               !(target.compareDocumentPosition(offsets[cursor].node) & Node.DOCUMENT_POSITION_FOLLOWING)) cursor++;
        low = cursor;
      } else {
        while (low < high) {
          const middle = (low + high) >> 1;
          if (target.compareDocumentPosition(offsets[middle].node) & Node.DOCUMENT_POSITION_FOLLOWING) high = middle;
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
        if (boundaries[middle].start <= offset) low = middle + 1;
        else high = middle;
      }
      return { label: boundaries[low - 1]?.label };
    };
  }
  /** @param {Node} node @param {string} fallback @param {number} offset @param {number} total @param {DomSearch.HeadingLookup | null} [headingLookup] @param {HTMLElement | null} [parent] */
  function fullSearchLocation(node, fallback, offset, total, headingLookup = null, parent = node.parentElement) {
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
  /** @overload @param {Element} root @param {string} fallback @param {string} query @param {number} generation @param {boolean} progressive @param {number} occurrence @param {number} [navigationGeneration] @returns {Promise<{target: HTMLElement | undefined}[]>} */
  /** @overload @param {Element} root @param {string} fallback @param {string} query @param {number} generation @param {boolean} [progressive] @param {null} [occurrence] @param {number} [navigationGeneration] @returns {Promise<DomSearch.Result[]>} */
  /** @param {Element} inputRoot @param {string} fallback @param {string} query @param {number} generation @param {boolean} [progressive] @param {number | null} [occurrence] @param {number} [navigationGeneration] */
  async function fullSearchDomMatches(inputRoot, fallback, query, generation, progressive = false,
                                      occurrence = null, navigationGeneration = runtime.currentGeneration("navigation")) {
    const root = unwrapRoot(inputRoot);
    const cached = progressive && fullSearchDomSnapshot?.root === root &&
      fullSearchDomSnapshot.value?.toc === getTocEntries() ? fullSearchDomSnapshot.value : null;
    const snapshot = progressive ? (cached ? fullSearchDomSnapshot : createDomSearchSnapshot(root)) : null;
    const locator = progressive ? createFullSearchDomLocator(root, generation) : null;
    /** @type {DomSearch.Offset[]} */
    const offsets = cached ? cached.offsets : [];
    /** @type {string[]} */
    const chunks = [];
    const breaks = cached ? cached.breaks : [];
    const findLineBreaks = query.includes(BLOCK_SEPARATOR);
    // Foliate's section-ordinal fallback must count the same concatenated text
    // matches as the Foliate engine which produced the ordinal.
    const respectBlocks = progressive || occurrence === null;
    let length = 0;
    /** @type {(node: Text, start: number, end: number) => void} */
    const collect = (node, start, end) => {
      if (start > length) {
        if (findLineBreaks || snapshot) breaks.push(length);
        chunks.push(BLOCK_SEPARATOR);
      }
      offsets.push({ node, parent: /** @type {HTMLElement} */ (node.parentElement), start, end });
      chunks.push(node.data);
      length = end;
    };
    const nodes = cached ? [] : await fullSearchTextNodes(root, generation, Infinity, null, collect, respectBlocks);
    if (!nodes || !isCurrent("search", generation)) return [];
    if (cached) locator?.seed(cached.checkpoints);
    else locator?.build(offsets);
    const headingLookup = cached ? cached.headingLookup : createFullSearchHeadingLookup(root, /** @type {DomSearch.LiveOffset[]} */ (offsets));
    const text = cached ? cached.text : chunks.join("");
    /** @type {DomSearch.Group[]} */
    const groups = [];
    /** @type {DomSearch.Match[]} */
    const firstHits = [];
    if (!cached && snapshot && (headingLookup || !getTocEntries().some(entry => isTocEntry(entry) && entry.target)))
      snapshot.set({ text, offsets, breaks, headingLookup, checkpoints: /** @type {DomSearch.Locator} */ (locator).boundaries(), toc: getTocEntries() });
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
        if (parts[middle].end <= index) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    /** @param {number} start @param {number} end */
    const partsFor = (start, end) => {
      const parts = [];
      for (let index = locateIndex(start, highlightOffsets); index < highlightOffsets.length && highlightOffsets[index].start < end; index++)
        parts.push(highlightOffsets[index]);
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
        if (matchableBreaks[middle] < group.start + group.skip) low = middle + 1;
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
        location: fullSearchLocation(part.node || part.parent, fallback, match.index, text.length, headingLookup, part.parent),
        snippet: fullSearchSnippet(text, match.index, match.value.length),
        async activate(navigationGeneration = runtime.currentGeneration("navigation")) {
          if (!isCurrent("navigation", navigationGeneration)) return false;
          const searchGeneration = runtime.currentGeneration("search");
          const end = match.index + match.value.length;
          clearFullSearchMarks();
          const checkpoint = locator?.checkpoint(match.index);
          /** @type {DomSearch.TextPart[]} */
          const parts = [];
          /** @type {(node: Text, start: number, nodeEnd: number) => void} */
          const collectMatch = (node, start, nodeEnd) => {
            if (nodeEnd > match.index && start < end)
              parts.push({ node, start: Math.max(0, match.index - start), end: Math.min(node.data.length, end - start) });
          };
          let currentNodes = await fullSearchTextNodes(root, searchGeneration, end, checkpoint, collectMatch, respectBlocks);
          if (checkpoint && !/** @type {DomSearch.Locator} */ (locator).current()) {
            parts.length = 0;
            currentNodes = await fullSearchTextNodes(root, searchGeneration, end, null, collectMatch, respectBlocks);
          }
          if (!currentNodes || !isCurrent("search", searchGeneration) ||
              !isCurrent("navigation", navigationGeneration)) return false;
          if (parts.map(part => part.node.data.slice(part.start, part.end)).join("") !== match.value) return false;
          const [target] = highlightTextParts(parts);
          target?.scrollIntoView({ block: "center" });
          return !!target;
        }
      };
    };
    const pageSize = 50;
    /** @type {DomSearch.Result[]} */
    const firstPage = [];
    /** @param {number} requestedOffset @returns {DomSearch.Page} */
    const page = (requestedOffset) => {
      const offset = fullSearchPageOffset(total, requestedOffset, pageSize);
      if (progressive && offset === 0) return { total, offset, pageSize, results: firstPage.slice() };
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
        if (progressive && firstPage.length < pageSize) firstPage.push(resultFor(match));
      }
      groups.push(group);
      total += group.count;
      if (progressive && (start === 0 || (group.count && total <= 50) || groups.length % 8 === 0)) {
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
    if (progressive) {
      publishPage(page(0), page, false);
    }
    if (occurrence !== null) {
      if (!isCurrent("navigation", navigationGeneration)) return [];
      const matchedPage = page(occurrence);
      const result = matchedPage.results[occurrence - matchedPage.offset];
      if (!result || !await result.activate(navigationGeneration)) return [];
      return [{ target: fullSearchActiveMarks[0] }];
    }
    const fallbackResults = progressive ? null : firstHits.map(resultFor);
    if (cached && !/** @type {DomSearch.Snapshot} */ (snapshot).current())
      return fullSearchDomMatches(inputRoot, fallback, query, generation, progressive, occurrence, navigationGeneration);
    if (cached && firstHits.length && navigationGeneration === runtime.currentGeneration("navigation")) {
      const checkpoint = /** @type {DomSearch.Locator} */ (locator).checkpoint(firstHits[0].index);
      const end = firstHits[firstHits.length - 1].index + firstHits[firstHits.length - 1].value.length;
      highlightOffsets = [];
      const markNodes = await fullSearchTextNodes(root, generation, end, checkpoint,
        (node, start, end) => highlightOffsets.push({ node, start, end }));
      if (!markNodes || !isCurrent("search", generation)) return [];
      if (!/** @type {DomSearch.Snapshot} */ (snapshot).current())
        return fullSearchDomMatches(inputRoot, fallback, query, generation, progressive, occurrence, navigationGeneration);
    }
    if (navigationGeneration === runtime.currentGeneration("navigation")) {
      for (let i = firstHits.length - 1; i >= 0; i--) {
        const match = firstHits[i], end = match.index + match.value.length;
        const parts = partsFor(match.index, end);
        if (!parts.length) continue;
        const [target] = highlightTextParts(parts.map(part => ({ node: part.node,
          start: Math.max(match.index, part.start) - part.start,
          end: Math.min(end, part.end) - part.start })));
        if (fallbackResults) fallbackResults[i].target = target;
      }
    }
    return fallbackResults || page(0).results;
  }
  function pruneMarks() {
    fullSearchActiveMarks = fullSearchActiveMarks.filter(mark => mark.isConnected);
  }
  return Object.freeze({
    search: fullSearchDomMatches, clearMarks: clearFullSearchMarks,
    highlight: highlightTextParts, pruneMarks, dispose
  });
}
