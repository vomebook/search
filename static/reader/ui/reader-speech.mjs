// Native reading for every Reader format that has native text or a text layer.
// The shared static/tts-client.js player is given an adapter whose text only
// grows at its end, assembled from units (the whole document, an EPUB section,
// a chapter or a PDF page) in reading order from the unit the reader starts at.
// DOM text is never modified: highlights use the CSS Custom Highlight API in
// the realm (frame document / shadow tree) that owns the range.
/** @typedef {import('../../../typings/reader-speech-strict').Position} SpeechPosition
 * @typedef {import('../../../typings/tts-client-strict').PlaybackSettings} PlaybackSettings */
import { isReaderVCard } from "../formats/reader-text-format.mjs";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
// A standalone Reader left while reading aloud (← or browser back) records
// where it was; search/reader-host/application/navigation.js resumes it in a background Reader
// and passes the position through the frame name. Keep both keys in sync.
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

/** Map a DOM boundary (which may be between elements) to the spoken UTF-16 text.
 * @param {Node} root @param {Node} node @param {number} offset */
function textOffset(root, node, offset) {
  if (!root.contains(node)) return null;
  const point = (root.ownerDocument || document).createRange();
  point.setStart(node, offset); point.collapse(true);
  let total = 0;
  for (const item of textNodes(root)) {
    if (item === node) return total + offset;
    if (point.comparePoint(item, 0) >= 0) return total;
    total += item.length;
  }
  return total;
}

// PDF/OCR line breaks are layout, not sentences. Keep the length (and thus
// every offset) identical: a break not after sentence punctuation becomes a space.
/** @param {string} text */
function spokenPageText(text) {
  return text.replace(/\n(?!\n)/g, (/** @type {string} */ _match, /** @type {number} */ offset) => /[。！？!?；;：:…”」』）)\n]\s*$/u.test(text.slice(Math.max(0, offset - 2), offset)) ? "\n" : " ");
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
 * @param {() => Promise<void>} loadPlayer
 * @param {string} [handoffPayload] Captured before Reader startup; omitted by isolated callers. */
export function createReaderSpeech(readerContext, loadPlayer, handoffPayload) {
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
  function chapterCount() { return readerContext.chapterManifestLoader?.count || 0; }
  function pageCount() { return Number(readerContext.documentState?.pageCount) || 0; }

  function hasText() {
    // Neither a formatted contact nor its plain-text fallback may reach TTS.
    if (isReaderVCard(readerContext)) return false;
    const current = mode();
    if (["text", "markdown", "html", "epub-chapters", "pdf"].includes(current)) return true;
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
    if (current === "epub-chapters") {
      // Valid chapter manifests have consecutive 1-based indices. Reading
      // their text doesn't require the optional full-text search index.
      const loader = readerContext.chapterManifestLoader;
      /** @param {number} index */
      const root = (index) => readerContext.content.querySelector(`.reader-epub-chapter[data-chapter="${index + 1}"]`);
      return {
        units: chapterCount(), first: 0, root,
        load: async (index) => {
          const chapter = root(index) || await loader?.(index + 1);
          if (!chapter) throw new Error("Chapter unavailable");
          return rootText(chapter);
        },
        locate: (index) => loader?.(index + 1)
      };
    }
    if (current === "pdf" || current === "pdf-pages") {
      /** @param {number} page */
      const shell = (page) => /** @type {HTMLElement | null} */ (readerContext.content.querySelector(`.reader-page[data-page="${page}"]`));
      const ocr = !!(readerContext.ocrManifestUrl || readerContext.pdfOcrManifest);
      /** @param {number} page */
      const root = (page) => {
        const node = shell(page);
        return node?.dataset.textReady === "1" ? node.querySelector(".reader-pdf-text") : null;
      };
      return {
        units: pageCount() + 1, first: 1, root,
        // Passive probes wait for the renderer. Only playback requests OCR
        // ahead of it; native extraction may also pull the full page image.
        ready: (page) => !!root(page) || !!readerContext.pdfTextContentCache?.has(page) ||
          !!readerContext.pdfTextContentPromises?.get(page)?.request?.demanded,
        load: async (page, probing = false) => {
          // The displayed layer owns selection and range offsets, including
          // when it is already showing the native fallback.
          const layer = root(page), renderedText = rootText(layer);
          if (renderedText.trim() || (layer && !ocr)) return spokenPageText(renderedText);
          if (ocr && !probing) {
            try {
              const payload = await readerContext.loadPdfOcrPage(page, "low");
              const text = payload?.kind === "pdf-text-layer" ? payload.text :
                (payload?.blocks || []).map(block => block.t).filter(Boolean).join("\n");
              const rendered = rootText(root(page));
              if (rendered.trim()) return spokenPageText(rendered);
              if (text?.trim()) return spokenPageText(text);
            } catch (error) {
              if (!readerContext.pdfDocument || /** @type {{name?: string} | null} */ (error)?.name === "AbortError") throw error;
              const rendered = rootText(root(page));
              if (rendered.trim()) return spokenPageText(rendered);
            }
          }
          const pdf = readerContext.pdfDocument;
          if (!pdf) return "";
          const items = await readerContext.loadPdfTextContent(page, await pdf.getPage(page), null);
          const rendered = rootText(root(page));
          return spokenPageText(rendered.trim() ? rendered : readerContext.pdfTextContent(Array.isArray(items) ? items : items?.items || []));
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
      const unit = next;
      const attempt = async () => {
        for (let tries = 0; ; tries++) {
          try { return await sourceInfo.load(unit); }
          catch (error) { if (tries >= 1) throw error; }
        }
      };
      return attempt().then((raw) => {
        next++;
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
    /** @param {number} offset */
    function positionRange(offset) {
      const range = self.range(offset, offset + 1);
      const padding = range?.startContainer.parentElement?.closest(".reader-text-padding");
      if (!range || !padding) return range;
      // Keep saved/spoken offsets exact. Only the scrolling rectangle needs a
      // painted character; follow the next text after any hidden padding.
      const root = self.root;
      if (!root) return range;
      const walker = padding.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      walker.currentNode = range.startContainer;
      for (let node; (node = walker.nextNode());) {
        if (node.parentElement?.closest(".reader-text-padding") || !node.textContent?.trim()) continue;
        const target = padding.ownerDocument.createRange();
        const start = node.textContent.search(/\S/u);
        target.setStart(node, start);
        target.setEnd(node, start + 1);
        return target;
      }
      return range;
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
        chain = chain.catch(() => {}).then(async () => {
          for (let guard = 0; !done && text.length < length && guard < 400; guard++) await loadNext();
        });
        return chain;
      },
      // Load through `unit` (the unit the reader is looking at).
      ensureUnit(unit) {
        chain = chain.catch(() => {}).then(async () => {
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
      locateTop: () => {
        const position = topPosition();
        return position ? locatePosition(position) : Promise.resolve(null);
      },
      selectionStart: () => selectionStart(),
      onStart() {
        if (readerContext.isReaderOverlayFrame?.())
          window.parent.postMessage({ type: "voice-reader-speech-start" }, location.origin);
      },
      partAt(offset) {
        let low = 0, high = parts.length - 1;
        while (low <= high) {
          const middle = (low + high) >> 1, part = parts[middle];
          if (!part) return null;
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
        const range = positionRange(start);
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
      visible(start, range = positionRange(start)) {
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
          const range = positionRange(offset);
          if (range) scrollToRange(range, "auto");
          self.following = true;
        } finally { self.autoUntil = performance.now() + 600; }
      },
      offsetAtTop() {
        const position = topPosition();
        if (!position) return 0;
        const part = parts.find((item) => item.unit === position.unit);
        return part ? part.start + Math.min(position.offset, part.raw.length) : text.length;
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
    if (current === "epub-chapters") {
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

  // Rebase before loading a distant unit; never walk all the intervening pages.
  /** @param {SpeechPosition} position */
  async function locatePosition(position) {
    let target = adapter;
    if (!target || position.unit < target.source.first || position.unit >= target.source.units) return null;
    if (position.unit < target.base || !target.covers(position.unit) && position.unit - target.base > 2) {
      target = rebase(position.unit);
      if (!target) return null;
    }
    await target.ensureUnit(position.unit);
    if (adapter !== target) return null;
    target.following = true;
    return target.offsetOf(position);
  }

  /** @param {Node} node @param {number} offset */
  function nodePosition(node, offset) {
    const info = adapter?.source;
    if (!info) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
    const unit = info.dom ? info.first : info.page
      ? Number(element?.closest(".reader-page[data-page]")?.getAttribute("data-page"))
      : Number(element?.closest(".reader-epub-chapter[data-chapter]")?.getAttribute("data-chapter")) - 1;
    if (!Number.isInteger(unit) || unit < info.first || unit >= info.units) return null;
    const root = info.root(unit), local = root && textOffset(root, node, offset);
    return local === null ? null : { unit, offset: local };
  }

  function selectionStart() {
    const info = adapter?.source;
    if (!info) return null;
    const doc = info.frame?.contentDocument || document;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return null;
    const range = selection.getRangeAt(0);
    const position = nodePosition(range.startContainer, range.startOffset);
    // Require both ends to belong to reader text, not to the surrounding UI.
    if (!position || !nodePosition(range.endContainer, range.endOffset)) return null;
    return () => locatePosition(position);
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
  /** @type {(({pending: true} | SpeechPosition) & {settings?: PlaybackSettings}) | null} */
  let resume = (() => {
    try {
      // An explicitly captured empty payload must not read window.name again.
      const raw = handoffPayload === undefined ? VoiceOfMLReader.speechHandoff.takeFramePayload(window) : handoffPayload;
      if (!raw) return null;
      const value = /** @type {{pending?: boolean; unit?: number; offset?: number; settings?: PlaybackSettings} | null} */ (JSON.parse(raw));
      const settings = value?.settings;
      if (settings && (!Number.isFinite(settings.rate) || settings.rate < 0.5 || settings.rate > 2 ||
          !["off", "clip", "5", "15", "30", "60"].includes(settings.timer) ||
          !Number.isFinite(settings.deadline) || settings.deadline < 0 ||
          (settings.timer === "off" || settings.timer === "clip" ? settings.deadline !== 0 : settings.deadline <= Date.now()))) return null;
      if (value?.pending === true) return settings ? { pending: true, settings } : { pending: true };
      return Number.isInteger(value?.unit) && Number.isInteger(value?.offset) ? /** @type {SpeechPosition & {settings?: PlaybackSettings}} */ (value) : null;
    } catch (_) { return null; }
  })();

  function handoff() {
    try {
      if (readerContext.isReaderOverlayFrame?.()) return; // The search page keeps that one alive.
      const state = speech()?.state?.();
      const readerUrl = readerContext.currentReaderUrl?.() || new URL(location.href);
      const owner = state?.adapter;
      if (!state || (state.settings?.deadline && state.settings.deadline <= Date.now())) return;
      let target;
      if (state.pending) target = { pending: true };
      else {
        // Disposal may stop the player first; `interrupted` keeps that case.
        if (!(state.playing || state.interrupted) || typeof owner?.partAt !== "function" || !Number.isInteger(state.position)) return;
        const part = owner.partAt(/** @type {number} */ (state.position));
        if (!part) return;
        target = { unit: part.unit,
          offset: Math.max(0, Math.min(part.raw.length, /** @type {number} */ (state.position) - part.start)) };
      }
      const value = JSON.stringify({ readerUrl: readerUrl.href, ...target, settings: state.settings, at: Date.now() });
      const key = VoiceOfMLReader.speechHandoff.storageKey;
      sessionStorage.setItem(key, value);
      // A Reader opened as the first page later reaches a search document that
      // was never loaded in this tab; sessionStorage is still shared there, but
      // localStorage also covers a search page opened in a fresh tab.
      try { localStorage.setItem(key, value); } catch (_) {}
    } catch (_) { /* Optional: without storage, leaving stops reading as before. */ }
  }

  /** @param {({pending: true} | SpeechPosition) & {settings?: PlaybackSettings}} target */
  function resumeAt(target) {
    const position = "pending" in target ? topPosition() : target;
    if (position) speech()?.readFrom(() => locatePosition(position), { exact: !("pending" in target), settings: target.settings });
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

  /** @param {MouseEvent} event */
  function onDoubleClick(event) {
    if (!adapter || !speech()) return;
    const doc = /** @type {Node | null} */ (event.target)?.ownerDocument || document;
    const path = event.composedPath?.() || [];
    const shadow = /** @type {ShadowRoot | undefined} */ (path.map((node) => /** @type {Node} */ (node)?.getRootNode?.()).find((root) => root?.nodeType === 11));
    const caret = caretIn(doc, event.clientX, event.clientY, shadow ? [shadow] : []);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return;
    const position = nodePosition(caret.node, caret.offset);
    if (position) speech()?.readFrom(() => locatePosition(position));
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
    const load = info.load, owner = generation;
    return { ...info, load: (unit) => {
      const hit = owner === generation ? probeText.get(unit) : undefined;
      if (hit) { probeText.delete(unit); return hit; }
      return load(unit);
    } };
  }

  function needsProbe() {
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
        const text = Promise.resolve().then(() => owner === generation ? info.load(unit, true) : "").then((value) => String(value || ""));
        probeText.set(unit, text);
        probeSeen.set(unit, text.then((value) => {
          if (value.trim()) return true;
          // A native probe can finish before the OCR renderer. Do not cache
          // the blank result for playback or for the next text-ready mutation.
          if (info.page && (readerContext.ocrManifestUrl || readerContext.pdfOcrManifest) && probeText.get(unit) === text) {
            probeText.delete(unit);
            probeSeen.delete(unit);
          }
          return false;
        }));
      }
      let found;
      try { found = await probeSeen.get(unit); }
      catch (_) {
        if (owner !== generation) return null;
        probeSeen.delete(unit); probeText.delete(unit); continue;
      }
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
      // Only the adapter consumes probe results; the probe always uses the raw loader.
      publish(createAdapter(withProbeCache(info), info.units > 1 ? Math.max(info.first, from - 1) : info.first));
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
    const info = source();
    if (!info || info.units <= info.first) return;
    if (resume && !("pending" in resume) && resume.unit >= info.first && resume.unit < info.units && resume.offset >= 0) {
      // Unlike an ordinary passive probe, an explicit handoff already owns a
      // text position. It may be far away from the currently visible page.
      publish(createAdapter(info, resume.unit));
    } else {
      if (resume && !("pending" in resume)) resume = null;
      if (needsProbe()) { offerSource = info; offer(info); }
      else publish(createAdapter(info, info.units > 1 ? Math.max(info.first, (topPosition()?.unit ?? info.first) - 1) : info.first));
    }
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

  function install(alreadyReady = false) {
    if (installed) return;
    installed = true;
    try {
      if (handoffPayload === undefined && !readerContext.isReaderOverlayFrame?.()) {
        const key = VoiceOfMLReader.speechHandoff.storageKey;
        sessionStorage.removeItem(key);
        localStorage.removeItem(key);
      }
    } catch (_) {}
    // ← records it before navigating; pagehide covers browser back and other exits.
    window.addEventListener("pagehide", handoff, { capture: true });
    document.querySelector("#back")?.addEventListener("click", handoff, { capture: true });
    readerContext.readerRuntime.events.on("phase", (detail) => {
      if (!detail || typeof detail !== "object" || !("phase" in detail)) return;
      if (detail.phase === "ready") attachWhenReady();
      else if (detail.phase === "disposed") { disposed = true; speech()?.stop?.(); detach(); }
    });
    if (alreadyReady) attachWhenReady();
  }

  return { installReaderSpeech: install, readerSpeechAdapter: () => adapter };
}
