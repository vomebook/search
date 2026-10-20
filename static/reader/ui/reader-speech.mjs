// Native reading for every Reader format that has native text or a text layer.
// The shared static/tts-client.js player is given an adapter whose text only
// grows at its end, assembled from units (the whole document, an EPUB section,
// a chapter or a PDF page) in reading order from the unit the reader starts at.
// DOM text is never modified: highlights use the CSS Custom Highlight API in
// the realm (frame document / shadow tree) that owns the range.
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const HIGHLIGHT_STYLE = "::highlight(ccrd-speech){background:rgba(138,180,248,.38);color:inherit;text-decoration:underline}";

function textNodes(root) {
  const nodes = [];
  if (!root) return nodes;
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let parent = node.parentNode; parent && parent !== root; parent = parent.parentNode) {
        if (SKIP.has(parent.nodeName)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node; (node = walker.nextNode());) nodes.push(node);
  return nodes;
}

function until(check, timeout) {
  const deadline = performance.now() + timeout;
  return new Promise((resolve) => {
    const poll = () => (check() || performance.now() > deadline ? resolve() : setTimeout(poll, 100));
    poll();
  });
}

function rootText(root) { return textNodes(root).map((node) => node.data).join(""); }

// PDF/OCR line breaks are layout, not sentences. Keep the length (and thus
// every offset) identical: a break not after sentence punctuation becomes a space.
function spokenPageText(text) {
  return text.replace(/\n(?!\n)/g, (match, offset) => /[。！？!?；;：:…”」』）)\n]\s*$/u.test(text.slice(Math.max(0, offset - 2), offset)) ? "\n" : " ");
}

function caretIn(doc, x, y, roots) {
  try {
    const point = doc.caretPositionFromPoint?.(x, y, roots?.length ? { shadowRoots: roots } : undefined);
    if (point?.offsetNode) return { node: point.offsetNode, offset: point.offset };
  } catch (_) { /* Older signature without options. */ }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function ensureStyle(root) {
  const target = root?.nodeType === 11 ? root : root?.ownerDocument?.head || root?.head;
  if (!target || target.querySelector?.("style[data-speech-highlight]")) return;
  const style = (root.ownerDocument || root).createElement("style");
  style.dataset.speechHighlight = ""; style.textContent = HIGHLIGHT_STYLE;
  target.append(style);
}

export function createReaderSpeech(readerContext) {
  let adapter = null, installed = false, cleanup = [];

  const speech = () => globalThis.CCRDSpeech;
  const mode = () => readerContext.capability?.mode || "";
  const documentId = () => "reader:" + (readerContext.sourceUrl || readerContext.contentUrl || location.search);
  const readerSpeechTitle = () => document.querySelector("#title")?.textContent?.trim() || document.title || "朗读";

  // ---- Per-format unit sources -------------------------------------------
  function foliateSections() {
    return (readerContext.epubBook?.sections || []).filter((section) => section.linear !== "no");
  }
  function chapterList() { return readerContext.chapterSearchConfiguration?.chapters || []; }
  function pageCount() { return Number(readerContext.documentState?.pageCount) || 0; }

  function hasText() {
    const current = mode();
    if (["text", "markdown", "html", "foliate", "epub-chapters", "pdf"].includes(current)) return true;
    if (current === "pdf-pages") return !!(readerContext.ocrManifestUrl || readerContext.pdfOcrManifest || readerContext.pdfDocument);
    return false;
  }

  function source() {
    const current = mode();
    if (current === "text" || current === "markdown") {
      const root = readerContext.content.querySelector(".reader-text, .reader-markdown") || readerContext.content;
      return { units: 1, first: 0, root: () => root, load: async () => rootText(root), dom: true };
    }
    if (current === "html") {
      const frame = readerContext.htmlFrame;
      const root = () => frame?.contentDocument?.body || null;
      return { units: 1, first: 0, root, load: async () => rootText(root()), dom: true, frame };
    }
    if (current === "foliate") {
      const sections = foliateSections();
      const article = (index) => readerContext.content.querySelector(`.foliate-continuous article[data-section="${index}"]:not(.foliate-section-placeholder)`);
      const body = (index) => { const node = article(index); const root = node && readerContext.foliateSectionRoot(node); return root?.querySelector(".reader-section-body") || root || null; };
      return {
        units: sections.length, first: 0, root: body,
        load: async (index) => {
          const loaded = body(index);
          if (loaded) return rootText(loaded);
          const doc = await sections[index].createDocument();
          return rootText(doc.body || doc.documentElement);
        },
        locate: (index) => readerContext.foliateSectionLoader?.(index)
      };
    }
    if (current === "epub-chapters") {
      const chapters = chapterList();
      const root = (index) => readerContext.content.querySelector(`.reader-epub-chapter[data-chapter="${chapters[index]?.index}"]`);
      return {
        units: chapters.length, first: 0, root,
        load: async (index) => rootText(root(index) || await readerContext.chapterManifestLoader?.(chapters[index].index)),
        locate: (index) => readerContext.chapterManifestLoader?.(chapters[index].index)
      };
    }
    if (current === "pdf" || current === "pdf-pages") {
      const shell = (page) => readerContext.content.querySelector(`.reader-page[data-page="${page}"]`);
      const ocr = current === "pdf-pages" && (readerContext.ocrManifestUrl || readerContext.pdfOcrManifest);
      return {
        units: pageCount() + 1, first: 1,
        root: (page) => { const node = shell(page); return node?.dataset.textReady === "1" ? node.querySelector(".reader-pdf-text") : null; },
        load: async (page) => {
          const rendered = shell(page);
          if (rendered?.dataset.textReady === "1" && rendered.querySelector(".reader-pdf-text")) return spokenPageText(rootText(rendered.querySelector(".reader-pdf-text")));
          if (ocr) {
            const payload = await readerContext.loadPdfOcrPage(page, "low");
            if (payload?.kind === "pdf-text-layer") return spokenPageText(String(payload.text || ""));
            return spokenPageText((payload?.blocks || []).map((block) => String(block?.t || "")).filter(Boolean).join("\n"));
          }
          if (!readerContext.pdfDocument) return "";
          const items = await readerContext.loadPdfTextContent(page, await readerContext.pdfDocument.getPage(page), null);
          return spokenPageText(readerContext.pdfTextContent(items?.items || items || []));
        },
        locate: (page) => readerContext.goToPage(page),
        page: true
      };
    }
    return null;
  }

  // Scroll the sentence itself (not its parent block: a TXT block holds 32 KiB)
  // to a third of the way down its nearest scroller, crossing shadow roots and frames.
  function scrollToRange(range, behavior) {
    const rect = range.getBoundingClientRect();
    if (!rect.height) return;
    const doc = range.startContainer.ownerDocument;
    for (let el = range.startContainer.parentElement; el; el = el.parentElement || el.getRootNode?.().host || null) {
      const overflow = el.ownerDocument.defaultView.getComputedStyle(el).overflowY;
      if (/auto|scroll/.test(overflow) && el.scrollHeight > el.clientHeight + 1) {
        const box = el.getBoundingClientRect();
        el.scrollBy({ top: rect.top - box.top - box.height / 3, behavior });
        return;
      }
    }
    const scroller = doc.scrollingElement;
    if (doc !== document && scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
      doc.defaultView.scrollBy({ top: rect.top - doc.defaultView.innerHeight / 3, behavior });
      return;
    }
    const frame = doc.defaultView?.frameElement;
    const box = readerContext.viewport.getBoundingClientRect();
    readerContext.viewport.scrollBy({ top: rect.top + (frame ? frame.getBoundingClientRect().top : 0) - box.top - box.height / 3, behavior });
  }

  // ---- Adapter ---------------------------------------------------------------
  function createAdapter(sourceInfo, base) {
    const parts = [];
    let text = "", next = base, done = base >= sourceInfo.units, chain = Promise.resolve();
    function loadNext() {
      const unit = next++;
      return Promise.resolve(sourceInfo.load(unit)).catch(() => "").then((raw) => {
        raw = String(raw || "");
        if (raw.trim()) {
          // One separator character joins units so offsets never shift.
          const join = text && !/\s$/u.test(text) ? (/[。！？!?；;.…”」』）)]\s*$/u.test(text) ? "\n" : " ") : "";
          text += join;
          parts.push({ unit, start: text.length, end: text.length + raw.length, raw });
          text += raw;
        }
        if (next >= sourceInfo.units) done = true;
      });
    }
    const self = {
      base, source: sourceInfo,
      get text() { return text; },
      get done() { return done; },
      // Shown while a slow search (e.g. scanned pages without text) continues.
      progress() {
        if (!sourceInfo.page || next - base < 3) return "";
        return `正在查找可朗读的文字（第 ${Math.min(next, sourceInfo.units - 1)} / ${sourceInfo.units - 1} 页）…`;
      },
      root: null,
      ensure(length) {
        chain = chain.then(async () => {
          for (let guard = 0; !done && text.length < length && guard < 400; guard++) await loadNext();
        });
        return chain;
      },
      // Load through `unit` (the unit the reader is looking at).
      ensureUnit(unit) {
        chain = chain.then(async () => {
          for (let guard = 0; !done && next <= unit && guard < 400; guard++) await loadNext();
        });
        return chain;
      },
      // Offset of a unit-local position; past an empty unit, the next text.
      offsetOf(position) {
        const part = parts.find((item) => item.unit === position.unit);
        if (part) return part.start + Math.min(position.offset, part.raw.length);
        return parts.find((item) => item.unit > position.unit)?.start ?? text.length;
      },
      locateTop: () => locateTop(),
      partAt(offset) {
        let low = 0, high = parts.length - 1;
        while (low <= high) {
          const middle = (low + high) >> 1, part = parts[middle];
          if (offset < part.start) high = middle - 1; else if (offset >= part.end) low = middle + 1; else return part;
        }
        return parts.find((part) => part.start >= offset) || parts[parts.length - 1] || null;
      },
      covers(unit) { return unit >= base && (unit < next || done); },
      // Map a global range to the rendered DOM of one unit (clipped to it).
      range(start, end) {
        const part = self.partAt(start);
        const root = part && sourceInfo.root(part.unit);
        if (!root) return null;
        const nodes = textNodes(root);
        const rendered = nodes.map((node) => node.data).join("");
        // Only highlight when the rendered text is exactly what was read
        // (PDF line breaks are compared with their spoken spaces).
        if (rendered.length !== part.raw.length || (sourceInfo.page ? spokenPageText(rendered) : rendered) !== part.raw) return null;
        const local = Math.max(0, start - part.start), limit = Math.min(part.raw.length, end - part.start);
        if (limit <= local) return null;
        const range = (root.ownerDocument || document).createRange();
        let offset = 0, begun = false;
        for (const node of nodes) {
          if (!begun && local < offset + node.length) { range.setStart(node, local - offset); begun = true; }
          if (begun && limit <= offset + node.length) { range.setEnd(node, limit - offset); ensureStyle(root.getRootNode?.() || root); return range; }
          offset += node.length;
        }
        return null;
      },
      // Follow only while the listener is reading along (the previous clip was
      // on screen or was brought there by us); a reader who scrolled away is left alone.
      // Whether `following` holds is decided by the reader's own scrolling (see
      // userScrolled), not by the clip boundary: scrolling the current clip out
      // of view stops following until "回到播放位置" or scrolling back to it.
      follow(start) {
        const part = self.partAt(start);
        if (!part) return;
        self.current = start;
        // Parked in the background (Reader closed while reading): no layout to follow.
        if (!self.following || !readerContext.viewport.getClientRects().length) return;
        const range = self.range(start, start + 1);
        if (!range) {
          // An unrendered page/section: navigate there and wait for its text.
          if (sourceInfo.root(part.unit) || !sourceInfo.locate) return;
          self.autoUntil = performance.now() + 8000;
          return Promise.resolve(sourceInfo.locate(part.unit)).then(() => until(() => sourceInfo.root(part.unit), 8000))
            .finally(() => { self.autoUntil = performance.now() + 600; });
        }
        const position = self.visible(start, range);
        if (position && position.inside) return;
        if (position) {
          self.autoUntil = performance.now() + 1200;
          scrollToRange(range, "smooth");
        }
      },
      following: true, current: null, autoUntil: 0,
      // null when the clip has no rendered range; otherwise whether it is in view.
      visible(start, range = self.range(start, start + 1)) {
        const rect = range?.getBoundingClientRect();
        if (!rect || !rect.height) return null;
        const box = readerContext.viewport.getBoundingClientRect();
        const shift = sourceInfo.frame ? sourceInfo.frame.getBoundingClientRect().top : 0;
        const top = rect.top + shift, bottom = rect.bottom + shift;
        return { inside: top >= box.top && bottom <= box.bottom - 24, overlaps: bottom > box.top && top < box.bottom };
      },
      // Any scroll the reader starts (wheel, touch, scroll keys, scrollbar,
      // TOC/progress navigation) stops following; only "回到播放位置" or a new
      // start resumes it (Readwise Reader / Spotify "Sync" model, no timeout).
      userScrolled() {
        if (performance.now() < self.autoUntil) return;
        self.following = false;
      },
      inView(offset) { return !!self.visible(offset)?.overlaps; },
      saveView() {
        const win = sourceInfo.frame?.contentWindow;
        return { top: readerContext.viewport.scrollTop, frame: win ? win.scrollY : null };
      },
      restoreView(view) {
        self.following = false;
        self.autoUntil = performance.now() + 600;
        readerContext.viewport.scrollTop = view.top;
        if (view.frame !== null) sourceInfo.frame?.contentWindow?.scrollTo(0, view.frame);
      },
      async reveal(offset) {
        const part = self.partAt(offset);
        if (!part) return;
        self.autoUntil = performance.now() + 8000;
        try {
          await sourceInfo.locate?.(part.unit);
          if (adapter !== self) publish(self);
          const range = self.range(offset, offset + 1);
          if (range) scrollToRange(range, "auto");
          self.following = true;
        } finally { self.autoUntil = performance.now() + 600; }
      },
      offsetAtTop() {
        const position = topPosition();
        if (!position) return 0;
        const part = parts.find((item) => item.unit === position.unit);
        return part ? part.start + Math.min(position.offset, part.raw.length) : text.length;
      },
      offsetFromNode(node, offset) {
        for (const part of parts) {
          const root = sourceInfo.root(part.unit);
          if (!root || !(root === node || root.contains(node) || root.getRootNode?.() === node.getRootNode?.() && root.contains?.(node))) continue;
          let total = 0;
          for (const item of textNodes(root)) {
            if (item === node) return part.start + Math.min(part.raw.length, total + offset);
            total += item.length;
          }
        }
        return null;
      }
    };
    self.root = sourceInfo.root(base) || readerContext.content;
    return self;
  }

  // ---- Positions -------------------------------------------------------------
  function topPosition() {
    const info = adapter?.source || source();
    if (!info) return null;
    const box = readerContext.viewport.getBoundingClientRect();
    const current = mode();
    let unit = info.first;
    if (current === "foliate") {
      const article = [...readerContext.content.querySelectorAll(".foliate-continuous article[data-section]")]
        .find((node) => node.getBoundingClientRect().bottom > box.top + 8);
      unit = article ? Number(article.dataset.section) : 0;
    } else if (current === "epub-chapters") {
      const chapters = chapterList();
      const article = [...readerContext.content.querySelectorAll(".reader-epub-chapter[data-chapter]")]
        .find((node) => node.getBoundingClientRect().bottom > box.top + 8);
      unit = article ? Math.max(0, chapters.findIndex((chapter) => String(chapter.index) === article.dataset.chapter)) : 0;
    } else if (info.page) {
      unit = Math.max(1, Number(readerContext.pageAtMarker?.()) || Number(readerContext.documentState?.page) || 1);
    }
    const root = info.root(unit);
    if (!root) return { unit, offset: 0 };
    // First character whose line reaches below the viewport top. Rendered
    // characters are in reading order, so a binary search over each text node
    // is exact even for one 32 KiB TXT text node (no hit-testing guesswork).
    const shift = info.frame ? info.frame.getBoundingClientRect().top : 0;
    const limit = box.top + 4 - shift;
    const doc = root.ownerDocument || document, range = doc.createRange();
    const bottom = (node, index) => {
      range.setStart(node, index); range.setEnd(node, Math.min(node.length, index + 1));
      const rect = [...range.getClientRects()].find((item) => item.height) || range.getBoundingClientRect();
      return rect.height ? rect.bottom : null;
    };
    let total = 0;
    for (const node of textNodes(root)) {
      const last = bottom(node, Math.max(0, node.length - 1));
      if (last !== null && last > limit) {
        let low = 0, high = node.length - 1;
        while (low < high) {
          const middle = (low + high) >> 1, value = bottom(node, middle);
          if (value !== null && value > limit) high = middle; else low = middle + 1;
        }
        return { unit, offset: total + low };
      }
      total += node.length;
    }
    return { unit, offset: 0 };
  }

  // Exact start for "听书"/"从当前阅读位置开始": the window is re-based to the
  // unit in view when it is not loaded (or would need many earlier units).
  async function locateTop() {
    const position = topPosition();
    if (!adapter || !position) return 0;
    let target = adapter;
    if (target.source.units > 1 && (position.unit < target.base || !target.covers(position.unit) && position.unit - target.base > 2)) {
      target = rebase(position.unit);
    }
    await target.ensureUnit(position.unit);
    target.following = true; // Reading starts where the reader looks: follow it.
    return target.offsetOf(position);
  }

  // ---- Publication to the shared player --------------------------------------
  function publish(next) {
    adapter = next;
    speech()?.previewLoaded({
      id: documentId(), title: readerSpeechTitle(), adapter: next, host: document.body,
      tools: document.querySelector(".reader-actions"), buttonClass: "icon-button preview-speech-btn"
    });
  }

  function rebase(unit) {
    const info = source();
    if (!info) return null;
    const next = createAdapter(info, Math.max(info.first, Math.min(info.units - 1, unit)));
    publish(next);
    return next;
  }

  function syncToView() {
    if (!adapter && offerSource) { offer(offerSource); return; }
    if (!adapter || adapter.source.units <= 1) return;
    const state = speech()?.state?.();
    if (state?.active) return; // Never re-base under active playback.
    const position = topPosition();
    if (position && !adapter.covers(position.unit)) rebase(Math.max(adapter.source.first, position.unit - 1));
  }

  async function readAt(node, offset) {
    let global = adapter?.offsetFromNode(node, offset);
    if (global === null || global === undefined) {
      // A unit outside the loaded window: start a window there.
      const info = adapter?.source || source();
      let unit = null;
      for (let index = info.first; index < info.units && unit === null; index++) {
        const root = info.root(index);
        if (root && (root.contains(node) || root.getRootNode?.()?.contains?.(node))) unit = index;
      }
      if (unit === null) return;
      const next = rebase(unit);
      await next.ensure(1);
      global = next.offsetFromNode(node, offset);
      if (global === null || global === undefined) return;
    }
    if (adapter) adapter.following = true;
    speech()?.readFrom(global);
  }

  function onDoubleClick(event) {
    if (!adapter || !speech()) return;
    const doc = event.target?.ownerDocument || document;
    const path = event.composedPath?.() || [];
    const shadow = path.map((node) => node?.getRootNode?.()).find((root) => root?.nodeType === 11);
    const caret = caretIn(doc, event.clientX, event.clientY, shadow ? [shadow] : []);
    if (caret?.node?.nodeType === Node.TEXT_NODE) readAt(caret.node, caret.offset);
  }

  // ---- Lifecycle ---------------------------------------------------------------
  // Formats whose text may be absent (scanned PDF, comic books, empty files)
  // only get the button once text is found at/near the reading position.
  const probeText = new Map(), probeSeen = new Map();
  let generation = 0, probing = null, offerSource = null;

  function withProbeCache(info) {
    const load = info.load;
    return { ...info, load: (unit) => {
      const hit = probeText.get(unit);
      if (hit) { probeText.delete(unit); return hit; }
      return load(unit);
    } };
  }

  function needsProbe(info) {
    const current = mode();
    if (current === "epub-chapters") return false;
    if (current === "pdf-pages" && (readerContext.ocrManifestUrl || readerContext.pdfOcrManifest)) return false;
    return true;
  }

  async function probe(info, owner) {
    const from = info.units > 1 ? (topPosition()?.unit ?? info.first) : info.first;
    for (let unit = Math.max(info.first, from - 1); unit < Math.min(info.units, from + 12); unit++) {
      if (!probeSeen.has(unit)) {
        const text = Promise.resolve(info.load(unit)).then((value) => String(value || ""), () => "");
        probeText.set(unit, text);
        probeSeen.set(unit, text.then((value) => !!value.trim()));
      }
      const found = await probeSeen.get(unit);
      if (owner !== generation) return null;
      if (found) return from;
    }
    return null;
  }

  function offer(info) {
    if (adapter || probing) return;
    const owner = generation;
    probing = probe(info, owner).then((from) => {
      if (owner !== generation) return;
      probing = null;
      if (from === null || adapter) return;
      publish(createAdapter(info, info.units > 1 ? Math.max(info.first, from - 1) : info.first));
    }, () => { if (owner === generation) probing = null; });
  }

  function detach() {
    generation++;
    probing = null; offerSource = null; probeText.clear(); probeSeen.clear();
    for (const off of cleanup.splice(0)) off();
    adapter = null;
    speech()?.previewClosed();
  }

  function attach() {
    detach();
    const player = speech();
    if (!player) return;
    document.querySelector("[data-speech-toggle]")?.remove();
    if (!hasText()) return;
    const raw = source();
    if (!raw || raw.units <= raw.first) return;
    const info = withProbeCache(raw);
    if (needsProbe(info)) { offerSource = info; offer(info); }
    else publish(createAdapter(info, info.units > 1 ? Math.max(info.first, (topPosition()?.unit ?? info.first) - 1) : info.first));
    const listen = (target, type, handler, options) => {
      if (!target) return;
      target.addEventListener(type, handler, options);
      cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    listen(readerContext.viewport, "dblclick", onDoubleClick);
    if (info.frame?.contentDocument) { listen(info.frame.contentDocument, "dblclick", onDoubleClick); ensureStyle(info.frame.contentDocument); }
    let timer = 0, settle = 0;
    const onScroll = () => {
      clearTimeout(timer); timer = setTimeout(syncToView, 250);
      clearTimeout(settle); settle = setTimeout(() => speech()?.viewChanged?.(), 150);
    };
    // Reader-initiated movement stops auto-follow at once, including during one
    // of our own smooth scrolls. Scroll events alone (layout shifts, lazy pages,
    // our own follow) never do. The player panel's buttons are excluded.
    const keys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " ", "Spacebar"]);
    const onIntent = (event) => {
      if (!adapter || event.target?.closest?.("#speech-panel, .reader-actions")) return;
      if (event.type === "keydown" && !keys.has(event.key)) return;
      adapter.autoUntil = 0;
      adapter.userScrolled();
    };
    const intentTargets = [document, info.frame?.contentDocument];
    for (const target of intentTargets) {
      for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) listen(target, type, onIntent, { passive: true, capture: true });
    }
    listen(readerContext.viewport, "scroll", onScroll, { passive: true, capture: true });
    if (info.frame?.contentWindow) listen(info.frame.contentWindow, "scroll", onScroll, { passive: true });
    cleanup.push(() => { clearTimeout(timer); clearTimeout(settle); });
    ensureStyle(document);
  }

  function install() {
    if (installed) return;
    installed = true;
    readerContext.readerRuntime.events.on("phase", ({ phase }) => {
      if (phase === "ready") attach();
      else if (phase === "disposed") { speech()?.stop?.(); detach(); }
    });
  }

  return { installReaderSpeech: install, readerSpeechAdapter: () => adapter };
}
