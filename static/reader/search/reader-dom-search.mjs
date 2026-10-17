// DOM matching, text snapshots and marks share one Reader-owned lifecycle.
export function fullSearchEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export function fullSearchPageOffset(total, requestedOffset, pageSize = 50) {
  return Math.max(0, Math.min(
    Math.floor(Math.max(0, total - 1) / pageSize),
    Math.floor(requestedOffset / pageSize)
  )) * pageSize;
}

export function createReaderDomSearch({
  content, runtime, isCurrent, yieldTask, getTocEntries, unwrapRoot, publishPage
}) {
  let fullSearchActiveMarks = [];
  let fullSearchDomLocator = null;
  let fullSearchDomSnapshot = null;
  const DOM_SEARCH_SNAPSHOT_BYTES = 8 * 1024 * 1024;
  function createDomSearchSnapshot(root) {
    fullSearchDomSnapshot?.dispose();
    let valid = true, disposed = false, value = null;
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
    const snapshot = {
      root, current, resume,
      get value() { return current() ? value : null; },
      set(data) {
        if (!current()) return;
        if (data.offsets.length > 32768 || data.text.length * 2 + data.offsets.length * 64 > DOM_SEARCH_SNAPSHOT_BYTES) {
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
  const stopGeneration = runtime.events.on("generation", ({ name }) => {
    if (name === "search") {
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
  function createFullSearchDomLocator(root, generation) {
    fullSearchDomLocator?.dispose();
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
          if (target?.firstChild === node) {
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
  async function fullSearchTextNodes(root, generation, endOffset = Infinity, checkpoint = null, collect = null) {
    const nodes = [],
      walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    if (checkpoint) walker.currentNode = checkpoint.target;
    let visited = 0, length = checkpoint?.start || 0, deadline = performance.now() + 8;
    while (walker.nextNode()) {
      if (!isCurrent("search", generation)) return null;
      const node = walker.currentNode;
      if (
        node.data &&
        !node.parentElement.closest("script,style,mark.full-search-highlight,.reader-pdf-text")
      ) {
        if (collect) collect(node);
        else nodes.push(node);
        length += node.data.length;
        if (length >= endOffset) break;
      }
      if (++visited % 256 === 0 && performance.now() >= deadline) {
        await yieldTask();
        deadline = performance.now() + 8;
      }
    }
    return nodes;
  }
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

  function createFullSearchHeadingLookup(root, offsets) {
    const entries = getTocEntries(), boundaries = [];
    const headings = entries.filter(entry => entry.target);
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
  function fullSearchLocation(node, fallback, offset, total, headingLookup = null, parent = node.parentElement) {
    const page = parent && parent.closest("[data-page]");
    if (page) return `第 ${page.dataset.page} 页`;
    const indexed = headingLookup?.(offset);
    if (indexed?.label !== undefined) return indexed.label;
    if (indexed) return `正文 ${Math.min(100, Math.floor(offset / Math.max(1, total) * 100))}%`;
    if (getTocEntries().length) {
      const heading = [...getTocEntries()].reverse().find(entry => entry.target &&
        (entry.target === node.parentElement || !!(entry.target.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
      if (heading) return heading.label;
    }
    return `正文 ${Math.min(100, Math.floor(offset / Math.max(1, total) * 100))}%`;
  }
  async function fullSearchDomMatches(root, fallback, query, generation, progressive = false,
                                      occurrence = null, navigationGeneration = runtime.currentGeneration("navigation")) {
    root = unwrapRoot(root);
    const cached = progressive && fullSearchDomSnapshot?.root === root &&
      fullSearchDomSnapshot.value?.toc === getTocEntries() ? fullSearchDomSnapshot.value : null;
    const snapshot = progressive ? (cached ? fullSearchDomSnapshot : createDomSearchSnapshot(root)) : null;
    const locator = progressive ? createFullSearchDomLocator(root, generation) : null;
    const offsets = cached ? cached.offsets : [],
      chunks = [];
    let length = 0;
    const collect = node => {
      offsets.push({ node, parent: node.parentElement, start: length, end: length + node.data.length });
      chunks.push(node.data);
      length += node.data.length;
    };
    const nodes = cached ? [] : await fullSearchTextNodes(root, generation, Infinity, null, collect);
    if (!nodes || !isCurrent("search", generation)) return [];
    if (cached) locator?.seed(cached.checkpoints);
    else locator?.build(offsets);
    const headingLookup = cached ? cached.headingLookup : createFullSearchHeadingLookup(root, offsets);
    const text = cached ? cached.text : chunks.join(""), groups = [], firstHits = [];
    if (!cached && snapshot && (headingLookup || !getTocEntries().some(entry => entry.target)))
      snapshot.set({ text, offsets, headingLookup, checkpoints: locator.boundaries(), toc: getTocEntries() });
    let highlightOffsets = offsets;
    const patternText = fullSearchEscape(query);
    let nextStart = 0, total = 0;
    const locateIndex = (index, parts = offsets) => {
      let low = 0, high = parts.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (parts[middle].end <= index) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const partsFor = (start, end) => {
      const parts = [];
      for (let index = locateIndex(start, highlightOffsets); index < highlightOffsets.length && highlightOffsets[index].start < end; index++)
        parts.push(highlightOffsets[index]);
      return parts;
    };
    const matchesIn = function* (group) {
      const re = new RegExp(patternText, "giu");
      re.lastIndex = group.skip;
      for (const match of text.slice(group.start, group.end).matchAll(re)) {
        if (match.index >= 65536) break;
        yield { index: group.start + match.index, value: match[0] };
      }
    };
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
          let checkpoint = locator?.checkpoint(match.index);
          let currentNodes = await fullSearchTextNodes(root, searchGeneration, end, checkpoint);
          if (checkpoint && !locator.current()) {
            checkpoint = null;
            currentNodes = await fullSearchTextNodes(root, searchGeneration, end);
          }
          if (!currentNodes || !isCurrent("search", searchGeneration) ||
              !isCurrent("navigation", navigationGeneration)) return false;
          let position = checkpoint?.start || 0, parts = [];
          for (const node of currentNodes) {
            const nodeEnd = position + node.data.length;
            if (nodeEnd > match.index && position < end)
              parts.push({ node, start: Math.max(0, match.index - position), end: Math.min(node.data.length, end - position) });
            position = nodeEnd;
            if (position >= end) break;
          }
          if (parts.map(part => part.node.data.slice(part.start, part.end)).join("") !== match.value) return false;
          const [target] = highlightTextParts(parts);
          target?.scrollIntoView({ block: "center" });
          return !!target;
        }
      };
    };
    const page = (requestedOffset) => {
      const pageSize = 50, results = [];
      const offset = fullSearchPageOffset(total, requestedOffset, pageSize);
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
    if (cached && !snapshot.current())
      return fullSearchDomMatches(root, fallback, query, generation, progressive, occurrence, navigationGeneration);
    if (cached && firstHits.length && navigationGeneration === runtime.currentGeneration("navigation")) {
      const checkpoint = locator.checkpoint(firstHits[0].index);
      const end = firstHits[firstHits.length - 1].index + firstHits[firstHits.length - 1].value.length;
      const markNodes = await fullSearchTextNodes(root, generation, end, checkpoint);
      if (!markNodes || !isCurrent("search", generation)) return [];
      if (!snapshot.current())
        return fullSearchDomMatches(root, fallback, query, generation, progressive, occurrence, navigationGeneration);
      let position = checkpoint?.start || 0;
      highlightOffsets = markNodes.map(node => {
        const part = { node, start: position, end: position + node.data.length };
        position = part.end;
        return part;
      });
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
