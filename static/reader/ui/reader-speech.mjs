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
  const title = () => document.querySelector("#title")?.textContent?.trim() || document.title || "朗读";

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
      follow(start) {
        const part = self.partAt(start);
        if (!part) return;
        const range = self.range(start, start + 1), rect = range?.getBoundingClientRect();
        const box = readerContext.viewport.getBoundingClientRect();
        if (rect && rect.height && (rect.bottom > box.bottom - 24 || rect.top < box.top)) {
          // Follow only when the previous clip was on screen, i.e. the reader is listening along.
          if (self.following) range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
        } else if (!rect && sourceInfo.page && self.following) sourceInfo.locate?.(part.unit);
        self.following = !!rect && rect.bottom > box.top && rect.top < box.bottom;
      },
      following: true,
      async reveal(offset) {
        const part = self.partAt(offset);
        if (!part) return;
        await sourceInfo.locate?.(part.unit);
        if (adapter !== self) publish(self);
        const range = self.range(offset, offset + 1);
        range?.startContainer.parentElement?.scrollIntoView({ block: "center" });
        self.following = true;
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
    const doc = root.ownerDocument || document;
    let x = box.left + 24, y = box.top + 12;
    if (info.frame) { const frameBox = info.frame.getBoundingClientRect(); x = 24; y = Math.max(12, box.top - frameBox.top + 12); }
    const shadow = root.getRootNode?.();
    const caret = caretIn(doc, x, y, shadow?.nodeType === 11 ? [shadow] : []);
    if (!caret || !root.contains(caret.node)) return { unit, offset: 0 };
    let total = 0;
    for (const node of textNodes(root)) {
      if (node === caret.node) return { unit, offset: total + caret.offset };
      total += node.length;
    }
    return { unit, offset: 0 };
  }

  // ---- Publication to the shared player --------------------------------------
  function publish(next) {
    adapter = next;
    speech()?.previewLoaded({
      id: documentId(), title: title(), adapter: next, host: document.body,
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
  function detach() {
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
    const start = info.units > 1 ? Math.max(info.first, (topPosition()?.unit ?? info.first) - 1) : info.first;
    publish(createAdapter(info, start));
    const listen = (target, type, handler, options) => {
      if (!target) return;
      target.addEventListener(type, handler, options);
      cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    listen(readerContext.viewport, "dblclick", onDoubleClick);
    if (info.frame?.contentDocument) { listen(info.frame.contentDocument, "dblclick", onDoubleClick); ensureStyle(info.frame.contentDocument); }
    let timer = 0;
    const onScroll = () => { clearTimeout(timer); timer = setTimeout(syncToView, 250); };
    listen(readerContext.viewport, "scroll", onScroll, { passive: true });
    if (info.frame?.contentWindow) listen(info.frame.contentWindow, "scroll", onScroll, { passive: true });
    cleanup.push(() => clearTimeout(timer));
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
