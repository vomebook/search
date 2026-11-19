// Native reading for every Reader format that has native text or a text layer.
// The shared static/tts-client.js player is given an adapter whose text only
// grows at its end, assembled from units (the whole document, an EPUB section,
// a chapter or a PDF page) in reading order from the unit the reader starts at.
// DOM text is never modified: highlights use the CSS Custom Highlight API in
// the realm (frame document / shadow tree) that owns the range.
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
// A standalone Reader left while reading aloud (← or browser back) records
// where it was; search/reader-host/application/navigation.js resumes it in a background Reader
// and passes the position through the frame name. Keep both keys in sync.
const HANDOFF_KEY = "reader-speech-handoff";
const RESUME_PREFIX = "reader-speech-resume:";
const HIGHLIGHT_STYLE = "::highlight(ccrd-speech){background:rgba(138,180,248,.38);color:inherit;text-decoration:underline}";

/** @param {Node | null | undefined} root @returns {Text[]} */
function textNodes(root) {
  /** @type {Text[]} */
  const nodes = [];
  if (!root) return nodes;
  const doc = root.ownerDocument || /** @type {Document} */ (root);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let parent = node.parentNode; parent && parent !== root; parent = parent.parentNode) {
        if (SKIP.has(parent.nodeName)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node; (node = walker.nextNode());) nodes.push(/** @type {Text} */ (node));
  return nodes;
}

/** @param {() => unknown} check @param {number} timeout */
function until(check, timeout) {
  const deadline = performance.now() + timeout;
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    const poll = () => (check() || performance.now() > deadline ? resolve() : setTimeout(poll, 100));
    poll();
  }));
}

/** @param {Node | null | undefined} root */
function rootText(root) { return textNodes(root).map((node) => node.data).join(""); }

// PDF/OCR line breaks are layout, not sentences. Keep the length (and thus
// every offset) identical: a break not after sentence punctuation becomes a space.
/** @param {string} text */
function spokenPageText(text) {
  return text.replace(/\n(?!\n)/g, (/** @type {string} */ match, /** @type {number} */ offset) => /[。！？!?；;：:…”」』）)\n]\s*$/u.test(text.slice(Math.max(0, offset - 2), offset)) ? "\n" : " ");
}

/** @param {Document} doc @param {number} x @param {number} y @param {ShadowRoot[]} roots */
function caretIn(doc, x, y, roots) {
  try {
    const point = doc.caretPositionFromPoint?.(x, y, roots?.length ? { shadowRoots: roots } : undefined);
    if (point?.offsetNode) return { node: point.offsetNode, offset: point.offset };
  } catch (_) { /* Older signature without options. */ }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** @param {Document | ShadowRoot | Element} root */
function ensureStyle(root) {
  const target = root?.nodeType === 11 ? root : root?.ownerDocument?.head || /** @type {Document} */ (root)?.head;
  if (!target || target.querySelector?.("style[data-speech-highlight]")) return;
  const doc = root.ownerDocument || /** @type {Document} */ (root);
  const style = doc.createElement("style");
  style.dataset.speechHighlight = ""; style.textContent = HIGHLIGHT_STYLE;
  target.append(style);
}

/** @param {import('../../../typings/reader-speech-strict').SpeechContext} readerContext
 * @param {() => Promise<void>} loadPlayer */
export function createReaderSpeech(readerContext, loadPlayer) {
  /** @type {import('../../../typings/reader-speech-strict').SpeechAdapter | null} */
  let adapter = null;
  let installed = false, disposed = false, loadingPlayer = false;
  /** @type {Array<() => void>} */
  const cleanup = [];

  const speech = () => (/** @type {typeof globalThis & {CCRDSpeech?: import('../../../typings/reader-speech-strict').SpeechPlayer}} */ (globalThis)).CCRDSpeech;
  const mode = () => readerContext.capability?.mode || "";
  const documentId = () => "reader:" + (readerContext.sourceUrl || readerContext.contentUrl || location.search);
  const readerSpeechTitle = () => document.querySelector("#title")?.textContent?.trim() || document.title || "朗读";

  // ---- Per-format unit sources -------------------------------------------
  function foliateSections() {
    return (readerContext.epubBook?.sections || []).filter((section) => section.linear !== "no");
  }
  function chapterCount() { return readerContext.chapterManifestLoader?.count || 0; }
  function pageCount() { return Number(readerContext.documentState?.pageCount) || 0; }

  function hasText() {
    const current = mode();
    if (["text", "markdown", "html", "foliate", "epub-chapters", "pdf"].includes(current)) return true;
    if (current === "pdf-pages") return !!(readerContext.ocrManifestUrl || readerContext.pdfOcrManifest || readerContext.pdfDocument);
    return false;
  }

  /** @returns {import('../../../typings/reader-speech-strict').SpeechSource | null} */
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
      /** @param {number} index */
      const article = (index) => readerContext.content.querySelector(`.foliate-continuous article[data-section="${index}"]:not(.foliate-section-placeholder)`);
      /** @param {number} index */
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
      // Valid chapter manifests have consecutive 1-based indices. Reading
      // their text doesn't require the optional full-text search index.
      const loader = readerContext.chapterManifestLoader;
      /** @param {number} index */
      const root = (index) => readerContext.content.querySelector(`.reader-epub-chapter[data-chapter="${index + 1}"]`);
      return {
        units: chapterCount(), first: 0, root,
        load: async (index) => rootText(root(index) || await loader?.(index + 1)),
        locate: (index) => loader?.(index + 1)
      };
    }
    if (current === "pdf" || current === "pdf-pages") {
      /** @param {number} page */
      const shell = (page) => /** @type {HTMLElement | null} */ (readerContext.content.querySelector(`.reader-page[data-page="${page}"]`));
      const ocr = current === "pdf-pages" && (readerContext.ocrManifestUrl || readerContext.pdfOcrManifest);
      return {
        units: pageCount() + 1, first: 1,
        root: (page) => { const node = shell(page); return node?.dataset.textReady === "1" ? node.querySelector(".reader-pdf-text") : null; },
        // Text the renderer has extracted or is extracting. Only these pages are
        // probed: extracting another page loads all its resources first, which
        // for a scanned page means downloading its full page image.
        ready: (page) => shell(page)?.dataset.textReady === "1" || !!readerContext.pdfTextContentCache?.has(page) ||
          !!readerContext.pdfTextContentPromises?.get(page)?.request?.demanded,
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
          return spokenPageText(readerContext.pdfTextContent(Array.isArray(items) ? items : items?.items || []));
        },
        locate: (page) => readerContext.goToPage(page),
        page: true
      };
    }
    return null;
  }

  // Scroll the sentence itself (not its parent block: a TXT block holds 32 KiB)
  // to a third of the way down its nearest scroller, crossing shadow roots and frames.
  /** @param {Range} range @param {ScrollBehavior} behavior */
  function scrollToRange(range, behavior) {
    const rect = range.getBoundingClientRect();
    if (!rect.height) return;
    const doc = /** @type {Document} */ (range.startContainer.ownerDocument);
    for (let el = /** @type {Element | null} */ (range.startContainer.parentElement); el; el = el.parentElement || /** @type {ShadowRoot | undefined} */ (el.getRootNode?.())?.host || null) {
      const overflow = /** @type {Window} */ (el.ownerDocument.defaultView).getComputedStyle(el).overflowY;
      if (/auto|scroll/.test(overflow) && el.scrollHeight > el.clientHeight + 1) {
        const box = el.getBoundingClientRect();
        el.scrollBy({ top: rect.top - box.top - box.height / 3, behavior });
        return;
      }
    }
    const scroller = doc.scrollingElement;
    if (doc !== document && scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
      /** @type {Window} */ (doc.defaultView).scrollBy({ top: rect.top - /** @type {Window} */ (doc.defaultView).innerHeight / 3, behavior });
      return;
    }
    const frame = doc.defaultView?.frameElement;
    const box = readerContext.viewport.getBoundingClientRect();
    readerContext.viewport.scrollBy({ top: rect.top + (frame ? frame.getBoundingClientRect().top : 0) - box.top - box.height / 3, behavior });
  }

  // ---- Adapter ---------------------------------------------------------------
  /** @param {import('../../../typings/reader-speech-strict').SpeechSource} sourceInfo @param {number} base */
  function createAdapter(sourceInfo, base) {
    /** @type {import('../../../typings/reader-speech-strict').Part[]} */
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
    /** @type {import('../../../typings/reader-speech-strict').SpeechAdapter} */
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
          if (begun && limit <= offset + node.length) { range.setEnd(node, limit - offset); ensureStyle(/** @type {Document | ShadowRoot | Element} */ (root.getRootNode?.() || root)); return range; }
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
        if (!part) return undefined;
        self.current = start;
        // Parked in the background (Reader closed while reading): no layout to follow.
        if (!self.following || !readerContext.viewport.getClientRects().length) return undefined;
        const range = self.range(start, start + 1);
        if (!range) {
          // An unrendered page/section: navigate there and wait for its text.
          if (sourceInfo.root(part.unit) || !sourceInfo.locate) return undefined;
          self.autoUntil = performance.now() + 8000;
          return Promise.resolve(sourceInfo.locate(part.unit)).then(() => until(() => sourceInfo.root(part.unit), 8000))
            .finally(() => { self.autoUntil = performance.now() + 600; });
        }
        const position = self.visible(start, range);
        if (position && !position.inside) {
          self.autoUntil = performance.now() + 1200;
          scrollToRange(range, "smooth");
        }
        return undefined;
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
      const article = [...readerContext.content.querySelectorAll(/** @type {string} */ (".foliate-continuous article[data-section]"))]
        .find((node) => node.getBoundingClientRect().bottom > box.top + 8);
      unit = article ? Number(/** @type {HTMLElement} */ (article).dataset.section) : 0;
    } else if (current === "epub-chapters") {
      const article = [...readerContext.content.querySelectorAll(".reader-epub-chapter[data-chapter]")]
        .find((node) => node.getBoundingClientRect().bottom > box.top + 8);
      const chapter = Number(/** @type {HTMLElement | undefined} */ (article)?.dataset.chapter);
      unit = Number.isInteger(chapter) && chapter >= 1 && chapter <= info.units ? chapter - 1 : 0;
    } else if (info.page) {
      // The marker returns a page element; the saved page can lag behind it.
      const marker = Number(readerContext.pageAtMarker?.()?.dataset.page);
      const page = Number.isInteger(marker) && marker >= info.first && marker < info.units
        ? marker : Number(readerContext.documentState?.page) || info.first;
      unit = Math.max(info.first, Math.min(info.units - 1, page));
    }
    const root = info.root(unit);
    if (!root) return { unit, offset: 0 };
    // First character whose line reaches below the viewport top. Rendered
    // characters are in reading order, so a binary search over each text node
    // is exact even for one 32 KiB TXT text node (no hit-testing guesswork).
    const shift = info.frame ? info.frame.getBoundingClientRect().top : 0;
    const limit = box.top + 4 - shift;
    const doc = root.ownerDocument || document, range = doc.createRange();
    /** @param {Text} node @param {number} index */
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
      target = /** @type {import('../../../typings/reader-speech-strict').SpeechAdapter} */ (rebase(position.unit));
    }
    await target.ensureUnit(position.unit);
    target.following = true; // Reading starts where the reader looks: follow it.
    return target.offsetOf(position);
  }

  // ---- Publication to the shared player --------------------------------------
  /** @param {import('../../../typings/reader-speech-strict').SpeechAdapter} next */
  function publish(next) {
    adapter = next;
    speech()?.previewLoaded({
      id: documentId(), title: readerSpeechTitle(), adapter: next, host: document.body,
      tools: document.querySelector(".reader-actions"), buttonClass: "icon-button preview-speech-btn"
    });
    if (resume) { const target = resume; resume = null; resumeAt(target); }
  }

  // ---- Leaving a standalone Reader while reading aloud -----------------------
  // Unit-local position: adapter offsets depend on the unit the window started at.
  /** @type {{pending: true} | import('../../../typings/reader-speech-strict').Position | null} */
  let resume = (() => {
    try {
      if (!String(window.name).startsWith(RESUME_PREFIX)) return null;
      const value = /** @type {{pending?: boolean; unit?: number; offset?: number} | null} */ (JSON.parse(window.name.slice(RESUME_PREFIX.length)));
      window.name = "";
      if (value?.pending === true) return { pending: true };
      return Number.isInteger(value?.unit) && Number.isInteger(value?.offset) ? /** @type {import('../../../typings/reader-speech-strict').Position} */ (value) : null;
    } catch (_) { return null; }
  })();

  function handoff() {
    try {
      if (readerContext.isReaderOverlayFrame?.()) return; // The search page keeps that one alive.
      const state = speech()?.state?.();
      const owner = state?.adapter;
      // The Reader's disposal may stop the player first; `interrupted` keeps that case.
      if (!(state?.playing || state?.interrupted) || typeof owner?.partAt !== "function" || !Number.isInteger(state.position)) return;
      const part = owner.partAt(/** @type {number} */ (state.position));
      if (!part) return;
      const value = JSON.stringify({ readerUrl: location.href, unit: part.unit,
        offset: Math.max(0, Math.min(part.raw.length, /** @type {number} */ (state.position) - part.start)), at: Date.now() });
      sessionStorage.setItem(HANDOFF_KEY, value);
      // A Reader opened as the first page later reaches a search document that
      // was never loaded in this tab; sessionStorage is still shared there, but
      // localStorage also covers a search page opened in a fresh tab.
      try { localStorage.setItem(HANDOFF_KEY, value); } catch (_) {}
    } catch (_) { /* Optional: without storage, leaving stops reading as before. */ }
  }

  /** @param {{pending: true} | import('../../../typings/reader-speech-strict').Position} target */
  async function resumeAt(target) {
    const info = adapter?.source;
    if (!adapter || !info) return;
    if ('pending' in target && target.pending) {
      let offset = 0;
      try { offset = await adapter.locateTop(); } catch (_) {}
      if (adapter?.source !== info) return;
      adapter.following = true;
      speech()?.readFrom(offset);
      return;
    }
    if ('pending' in target) return;
    if (target.unit < info.first || target.unit >= info.units) return;
    let owner = adapter;
    if (info.units > 1 && (target.unit < owner.base || !owner.covers(target.unit) && target.unit - owner.base > 2)) owner = /** @type {import('../../../typings/reader-speech-strict').SpeechAdapter} */ (rebase(target.unit));
    await owner.ensureUnit(target.unit);
    if (owner !== adapter) return;
    owner.following = true;
    speech()?.readFrom(owner.offsetOf(target));
  }

  /** @param {number} unit */
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

  /** @param {Node} node @param {number} offset */
  async function readAt(node, offset) {
    let global = adapter?.offsetFromNode(node, offset);
    if (global === null || global === undefined) {
      // A unit outside the loaded window: start a window there.
      const info = /** @type {import('../../../typings/reader-speech-strict').SpeechSource} */ (adapter?.source || source());
      let unit = null;
      for (let index = info.first; index < info.units && unit === null; index++) {
        const root = info.root(index);
        if (root && (root.contains(node) || root.getRootNode?.()?.contains?.(node))) unit = index;
      }
      if (unit === null) return;
      const next = /** @type {import('../../../typings/reader-speech-strict').SpeechAdapter} */ (rebase(unit));
      await next.ensure(1);
      global = next.offsetFromNode(node, offset);
      if (global === null || global === undefined) return;
    }
    if (adapter) adapter.following = true;
    speech()?.readFrom(global);
  }

  /** @param {MouseEvent} event */
  function onDoubleClick(event) {
    if (!adapter || !speech()) return;
    const doc = /** @type {Node | null} */ (event.target)?.ownerDocument || document;
    const path = event.composedPath?.() || [];
    const shadow = /** @type {ShadowRoot | undefined} */ (path.map((node) => /** @type {Node} */ (node)?.getRootNode?.()).find((root) => root?.nodeType === 11));
    const caret = caretIn(doc, event.clientX, event.clientY, shadow ? [shadow] : []);
    if (caret?.node?.nodeType === Node.TEXT_NODE) readAt(caret.node, caret.offset);
  }

  // ---- Lifecycle ---------------------------------------------------------------
  // Formats whose text may be absent (scanned PDF, comic books, empty files)
  // only get the button once text is found at/near the reading position.
  /** @type {Map<number, Promise<string>>} */
  const probeText = new Map();
  /** @type {Map<number, Promise<boolean>>} */
  const probeSeen = new Map();
  let generation = 0, reprobe = false;
  /** @type {Promise<void> | null} */
  let probing = null;
  /** @type {import('../../../typings/reader-speech-strict').SpeechSource | null} */
  let offerSource = null;

  /** @param {import('../../../typings/reader-speech-strict').SpeechSource} info @returns {import('../../../typings/reader-speech-strict').SpeechSource} */
  function withProbeCache(info) {
    const load = info.load;
    return { ...info, load: (unit) => {
      const hit = probeText.get(unit);
      if (hit) { probeText.delete(unit); return hit; }
      return load(unit);
    } };
  }

  /** @param {import('../../../typings/reader-speech-strict').SpeechSource} info */
  function needsProbe(info) {
    const current = mode();
    if (current === "epub-chapters") return false;
    if (current === "pdf-pages" && (readerContext.ocrManifestUrl || readerContext.pdfOcrManifest)) return false;
    return true;
  }

  /** @param {import('../../../typings/reader-speech-strict').SpeechSource} info @param {number} owner */
  async function probe(info, owner) {
    const from = info.units > 1 ? (topPosition()?.unit ?? info.first) : info.first;
    for (let unit = Math.max(info.first, from - 1); unit < Math.min(info.units, from + 12); unit++) {
      // A page the renderer has not reached is skipped, not recorded: it is
      // probed once its text is extracted (see attach).
      if (!probeSeen.has(unit) && info.ready && !info.ready(unit)) continue;
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

  /** @param {import('../../../typings/reader-speech-strict').SpeechSource} info */
  function offer(info) {
    if (adapter) return;
    // A page's text (or the position) changed during a probe: probe once more.
    if (probing) { reprobe = true; return; }
    reprobe = false;
    const owner = generation;
    probing = probe(info, owner).then((from) => {
      if (owner !== generation) return;
      probing = null;
      if (from === null || adapter) {
        if (!adapter && reprobe) offer(info);
        return;
      }
      publish(createAdapter(info, info.units > 1 ? Math.max(info.first, from - 1) : info.first));
    }, () => { if (owner === generation) probing = null; });
  }

  function detach() {
    generation++;
    probing = null; reprobe = false; offerSource = null; probeText.clear(); probeSeen.clear();
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
    /** @param {EventTarget | null | undefined} target @param {string} type @param {EventListener} handler @param {AddEventListenerOptions} [options] */
    const listen = (target, type, handler, options) => {
      if (!target) return;
      target.addEventListener(type, handler, options);
      cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    listen(readerContext.viewport, "dblclick", /** @type {EventListener} */ (onDoubleClick));
    if (info.frame?.contentDocument) { listen(info.frame.contentDocument, "dblclick", /** @type {EventListener} */ (onDoubleClick)); ensureStyle(info.frame.contentDocument); }
    if (info.ready && offerSource && typeof MutationObserver === "function") {
      // Pages are probed as the renderer extracts their text, never ahead of it.
      const observer = new MutationObserver(() => {
        if (adapter) observer.disconnect();
        else if (offerSource) offer(offerSource);
      });
      observer.observe(readerContext.content, { subtree: true, attributes: true, attributeFilter: ["data-text-ready"] });
      cleanup.push(() => observer.disconnect());
    }
    let timer = 0, settle = 0;
    const onScroll = () => {
      clearTimeout(timer); timer = setTimeout(syncToView, 250);
      clearTimeout(settle); settle = setTimeout(() => speech()?.viewChanged?.(), 150);
    };
    // Reader-initiated movement stops auto-follow at once, including during one
    // of our own smooth scrolls. Scroll events alone (layout shifts, lazy pages,
    // our own follow) never do. The player panel's buttons are excluded.
    const keys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " ", "Spacebar"]);
    /** @param {Event} event */
    const onIntent = (event) => {
      if (!adapter || /** @type {Element | null} */ (event.target)?.closest?.("#speech-panel, .reader-actions")) return;
      if (event.type === "keydown" && !keys.has(/** @type {KeyboardEvent} */ (event).key)) return;
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

  function attachWhenReady() {
    if (disposed || loadingPlayer || !hasText()) return;
    if (speech()) return attach();
    loadingPlayer = true;
    // Reading is already ready; an optional player must not delay or fail it.
    void Promise.resolve().then(() => disposed ? undefined : loadPlayer()).then(() => {
      if (!disposed) attach();
    }).catch(() => {}).finally(() => { loadingPlayer = false; });
  }

  function install() {
    if (installed) return;
    installed = true;
    try {
      if (!readerContext.isReaderOverlayFrame?.()) {
        sessionStorage.removeItem(HANDOFF_KEY);
        localStorage.removeItem(HANDOFF_KEY);
      }
    } catch (_) {}
    // Starting speech in a newly opened book takes over from the Reader that
    // was left reading in the background.
    document.addEventListener("click", (event) => {
      if (!(/** @type {Element | null} */ (event.target))?.closest?.("[data-speech-toggle]")) return;
      if (readerContext.isReaderOverlayFrame?.())
        window.parent.postMessage({ type: "voice-reader-speech-start" }, location.origin);
    }, { capture: true });
    // ← records it before navigating; pagehide covers browser back and other exits.
    window.addEventListener("pagehide", handoff, { capture: true });
    document.querySelector("#back")?.addEventListener("click", handoff, { capture: true });
    readerContext.readerRuntime.events.on("phase", (detail) => {
      if (!detail || typeof detail !== "object" || !("phase" in detail)) return;
      if (detail.phase === "ready") attachWhenReady();
      else if (detail.phase === "disposed") { disposed = true; speech()?.stop?.(); detach(); }
    });
  }

  return { installReaderSpeech: install, readerSpeechAdapter: () => adapter };
}
