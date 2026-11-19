import { EBOOK_LAYOUT_STYLE, wrapEbookTables } from "../ui/reader-document-styles.mjs";

/** @param {import('../../../typings/reader-foliate-format-strict').FoliateFormatContext} readerContext */
export function createReaderFoliateFormat(readerContext) {
  /** @param {Element} article */
  function foliateSectionRoot(article) {
    return article?.shadowRoot || article;
  }

  /** @param {Element} article @param {string} selector */
  function foliateSectionQuery(article, selector) {
    return readerContext.foliateSectionRoot(article)?.querySelector(selector) || null;
  }

  function foliateSectionCandidates() {
    return [
      ...readerContext.content.querySelectorAll(
        ".foliate-continuous > article[data-section]:not(.foliate-section-placeholder), .reader-epub-chapter"
      )
    ].flatMap((article) => [
      article,
      ...readerContext.foliateSectionRoot(article).querySelectorAll(
        ":is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,img,table)"
      )
    ]);
  }

  /** @typedef {{sectionIndex: number, anchor?: import('../../../typings/reader-foliate-format-strict').FoliateAnchor | null, fragment?: string, target?: {getBoundingClientRect(): {top: number}} | null}} LocationEntry */
  /** @param {unknown} entry @returns {entry is LocationEntry} */
  function isFoliateLocationEntry(entry) {
    if (typeof entry !== "object" || entry === null || !("sectionIndex" in entry) || typeof entry.sectionIndex !== "number") return false;
    if ("anchor" in entry && entry.anchor != null && typeof entry.anchor !== "function") return false;
    if ("fragment" in entry && entry.fragment !== undefined && typeof entry.fragment !== "string") return false;
    if ("target" in entry && entry.target != null && (typeof entry.target !== "object" || !("getBoundingClientRect" in entry.target) || typeof entry.target.getBoundingClientRect !== "function")) return false;
    return true;
  }

  /** @type {unknown[] | undefined} */
  let indexedToc;
  /** @type {Map<number, [number, LocationEntry][]>} */
  const locations = new Map();

  /** @param {unknown[]} entries @param {number} section */
  function sectionLocations(entries, section) {
    // Foliate resolves sectionIndex before publishing a new TOC array.
    if (indexedToc !== entries) {
      indexedToc = entries;
      locations.clear();
      for (const [index, entry] of entries.entries()) {
        if (!isFoliateLocationEntry(entry)) continue;
        const key = entry.sectionIndex;
        if (Number.isNaN(key)) continue;
        const bucket = locations.get(key);
        if (bucket) bucket.push([index, entry]);
        else locations.set(key, [[index, entry]]);
      }
    }
    return locations.get(section) || [];
  }

  function syncFoliateScrollLocation() {
    const toc = readerContext.navigationState.tocEntries;
    if (!readerContext.foliateContinuous || !toc.length) return;
    const rows = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".foliate-continuous article[data-section]")),
      top = readerContext.viewport.getBoundingClientRect().top + 80;
    let sectionTop = 0, sectionNode = null;
    for (const row of rows) {
      if (row.hidden) continue;
      const rowTop = row.getBoundingClientRect().top;
      if (rowTop <= top) { sectionTop = rowTop; sectionNode = row; }
    }
    if (!sectionNode) return;
    const entries = sectionLocations(toc, Number(sectionNode.dataset.section));
    let best = -1;
    let bestPosition = -Infinity;
    for (const [index, entry] of entries) {
      let position = sectionTop;
      try {
        if (entry.anchor) {
          const root = readerContext.foliateSectionRoot(sectionNode);
          const anchor = entry.anchor({
            getElementById: (id) => root.querySelector(`[id="${CSS.escape(id)}"]`),
            querySelector: (selector) => root.querySelector(selector)
          });
          if (anchor) position = anchor.getBoundingClientRect().top;
        }
        if (entry.fragment) {
          const anchor = readerContext.foliateSectionQuery(
            sectionNode,
            `[id="${CSS.escape(entry.fragment)}"], [name="${CSS.escape(entry.fragment)}"]`
          );
          if (anchor) position = anchor.getBoundingClientRect().top;
        }
      } catch (_) { continue; }
      if (position <= top && (position > bestPosition || (position === bestPosition && index > best))) {
        best = index;
        bestPosition = position;
      }
    }
    if (best < 0) {
      let firstPosition = Infinity;
      for (const [index, entry] of entries) {
        let position;
        try { position = entry.target?.getBoundingClientRect?.().top; } catch (_) { continue; }
        if (position !== undefined && Number.isFinite(position) && position < firstPosition) {
          best = index;
          firstPosition = position;
        }
      }
    }
    if (best >= 0 && best !== readerContext.navigationState.currentChapterIndex) {
      readerContext.updateNavigationState({ currentChapterIndex: best });
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
    }
  }

  function refreshFoliateWindow() {
    readerContext.foliateWindowFrame = 0;
    readerContext.foliateSectionLoader?.refresh?.();
  }

  function scheduleFoliateWindowRefresh() {
    if (!readerContext.foliateWindowFrame) readerContext.foliateWindowFrame = requestAnimationFrame(readerContext.refreshFoliateWindow);
  }

  function trimFoliateSections() {
    if (!readerContext.foliateContinuous || !readerContext.foliateSectionVirtualizer ||
        readerContext.content.querySelector(".foliate-supplement-active")) return;
    const marker = readerContext.viewport.getBoundingClientRect().top + 80,
      rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")].map(row => /** @type {HTMLElement} */ (row)),
      current =
        rows.find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top <= marker && rect.bottom > marker;
        }) || rows.find((row) => row.getBoundingClientRect().top > marker);
    if (current) readerContext.foliateSectionVirtualizer.trim(Number(current.dataset.section));
  }

  function scheduleFoliateScrollSync() {
    if (readerContext.foliateScrollFrame) return;
    readerContext.foliateScrollFrame = requestAnimationFrame(() => {
      readerContext.foliateScrollFrame = 0;
      readerContext.syncFoliateScrollLocation();
      readerContext.foliateScrollAnchors.whenIdle(readerContext.trimFoliateSections);
    });
  }

  /** @param {import('../../../typings/reader-foliate-format-strict').FoliateTocEntry} entry @param {number} [generation] @param {{closePanel?: boolean}} [options] */
  async function activateFoliateTocEntry(entry, generation = readerContext.beginReaderNavigation(), { closePanel = true } = {}) {
    const book = readerContext.epubRendition?.book,
      href = String(entry.href || ""),
      target = await readerContext.epubRendition?.book?.resolveHref(href);
    if (!book || !target || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const section = target && book.sections[target.index],
      sections = book.sections.filter((item) => item.linear !== "no"),
      visibleIndex = section ? sections.indexOf(section) : -1,
      destinationIndex = visibleIndex >= 0 ? visibleIndex : -target.index - 1;
    if (!section || !readerContext.foliateSectionLoader) return false;
    let node = await readerContext.foliateSectionLoader(destinationIndex);
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    // Background neighbors are not part of a demanded TOC destination.
    await readerContext.waitForReader(0, true);
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    if (!node?.isConnected) node = await readerContext.foliateSectionLoader(destinationIndex);
    if (!node?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const root = readerContext.foliateSectionRoot(node),
      /** @type {import('../../../typings/reader-foliate-format-strict').FoliateAnchorDocument} */
      anchorDocument = {
        getElementById: (id) => root.querySelector(`[id="${CSS.escape(id)}"]`),
        querySelector: (selector) => root.querySelector(selector)
      };
    let anchor = null;
    try {
      anchor = typeof target.anchor === "function" ? target.anchor(anchorDocument) : null;
    } catch (_) {}
    if (!anchor) {
      try {
        const fragment = href.split("#")[1] || "",
          id = fragment ? decodeURIComponent(fragment) : "";
        anchor = id ? root.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`) : null;
      } catch (_) {}
    }
    const destination = anchor || node;
    readerContext.foliateScrollAnchors.invalidate();
    const landing = readerContext.alignReaderDestination(destination, 8);
    readerContext.foliateScrollAnchors.remember();
    // Section heights and images keep settling after the jump; hold the destination on
    // the landing line until the layout stops moving.
    readerContext.holdReaderDestination(destination, 8);
    readerContext.syncFoliateScrollLocation();
    readerContext.updateTocCurrentMark();
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
    if (closePanel) readerContext.setReaderPanelOpen(false, true);
    readerContext.foliateScrollAnchors.remember();
    return true;
  }

  /** @param {Document} source */
  function cloneFoliateDocument(source) {
    const doc = /** @type {Document} */ (source.cloneNode(true)),
      original = source.createTreeWalker(source, NodeFilter.SHOW_TEXT),
      cloned = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    /** @type {WeakMap<Node, Node>} */
    const sourceNodes = new WeakMap();
    while (original.nextNode() && cloned.nextNode())
      sourceNodes.set(cloned.currentNode, original.currentNode);
    return { doc: readerContext.sanitizeEpubDocument(doc, { keepBlobImports: true }), sourceNodes };
  }

  /** @param {Document} source @param {WeakMap<Node, Node>} sourceNodes @param {Element} body @param {Element} renderedBody */
  function foliateSearchAnchor(source, sourceNodes, body, renderedBody) {
    const sourceWalker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    /** @type {{original: Text; offset: number}[]} */
    const pairs = [];
    let offset = 0;
    while (sourceWalker.nextNode()) {
      const node = /** @type {Text} */ (sourceWalker.currentNode);
      const original = sourceNodes.get(node);
      if (original) pairs.push({ original: /** @type {Text} */ (original), offset });
      offset += node.length;
    }
    return (/** @type {import('../../../typings/reader-foliate-format-strict').SearchAnchor} */ anchor) => {
      const range = anchor(source);
      if (!range || typeof range.intersectsNode !== "function") return null;
      const intervals = [];
      for (const { original, offset } of pairs) {
        if (!range.intersectsNode(original)) continue;
        const start = range.startContainer === original ? range.startOffset : 0;
        const end = range.endContainer === original ? range.endOffset : original.length;
        if (end > start) intervals.push({ start: offset + start, end: offset + end });
      }
      const walker = document.createTreeWalker(renderedBody, NodeFilter.SHOW_TEXT),
        selected = [];
      let offset = 0;
      while (walker.nextNode()) {
        const node = /** @type {Text} */ (walker.currentNode),
          end = offset + node.length;
        for (const interval of intervals)
          if (interval.start < end && interval.end > offset)
            selected.push({
              node,
              start: Math.max(0, interval.start - offset),
              end: Math.min(node.length, interval.end - offset)
            });
        offset = end;
      }
      return selected;
    };
  }

  /** @param {ParentNode} root @param {number} [timeoutMs] */
  async function settleReaderImages(root, timeoutMs = 2500) {
    readerContext.assertReaderActive();
    const images = [...root.querySelectorAll(/** @type {'img'} */ ("img[src],img[srcset]"))];
    if (!images.length) return;
    let timeout = 0, active = true;
    /** @type {Set<() => void>} */
    const cleanups = new Set();
    const decoded = Promise.allSettled(
      images.map(async (image) => {
        // Sections are prepared off-DOM; lazy images cannot enter a viewport yet.
        image.loading = "eager";
        image.decoding = "async";
        if (!image.complete) await /** @type {Promise<void>} */ (new Promise((resolve) => {
          const finish = () => {
            image.removeEventListener("load", finish);
            image.removeEventListener("error", finish);
            cleanups.delete(finish);
            resolve();
          };
          cleanups.add(finish);
          image.addEventListener("load", finish, { once: true });
          image.addEventListener("error", finish, { once: true });
          if (image.complete) finish();
        }));
        if (active) {
          try { await image.decode?.(); } catch (_) {}
        }
      })
    );
    try {
      await readerContext.awaitReader(
        Promise.race([
          decoded,
          new Promise((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
          })
        ])
      );
    } finally {
      active = false;
      clearTimeout(timeout);
      for (const cleanup of cleanups) cleanup();
    }
  }

  /** @param {Document} doc @param {import('../../../typings/reader-foliate-format-strict').FoliateSection} section */
  function rewriteFoliateResources(doc, section) {
    /** @param {string | null | undefined} value */
    const safeEmbeddedValue = (value) =>
      /^(?:blob:|data:image\/(?:gif|png|jpe?g|webp);)/i.test(String(value || "").trim());
    /** @param {string | null | undefined} value */
    const archiveResourceUrl = (value) => {
      const valueText = String(value || "").trim();
      if (!valueText || valueText.startsWith("#") || safeEmbeddedValue(valueText))
        return safeEmbeddedValue(valueText) ? valueText : null;
      const hash = valueText.indexOf("#"),
        raw = hash < 0 ? valueText : valueText.slice(0, hash);
      let fragment = "";
      try {
        if (hash >= 0) fragment = `#${encodeURIComponent(decodeURIComponent(valueText.slice(hash + 1)))}`;
      } catch (_) { return null; }
      if (!raw || /[?#\\\x00-\x1f\x7f]/.test(raw)) return null;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(raw)) return null;
      try {
        const resolved = String(
          (section.resolveResourceHref
            ? section.resolveResourceHref(raw)
            : section.resolveHref?.(raw)) || ""
        );
        if (
          !resolved ||
          /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(resolved) ||
          /[\\\x00]/.test(resolved) ||
          resolved.split("/").some((part) => !part || part === "." || part === "..")
        )
          return null;
        return `https://voiceofml-search.hf.space/api/reader-resource?book=${encodeURIComponent(readerContext.sourceUrl)}&path=${encodeURIComponent(resolved)}${fragment}`;
      } catch (_) {
        return null;
      }
    };
    // Every src-bearing element (including input[type=image] and track) uses
    // the archive-only resource policy, not just images and media.
    for (const element of doc.querySelectorAll("[src],video[poster]")) {
      for (const name of ["src", "poster"])
        if (element.hasAttribute(name)) {
          const safe = archiveResourceUrl(element.getAttribute(name));
          if (safe) element.setAttribute(name, safe);
          else element.removeAttribute(name);
        }
    }
    for (const element of doc.querySelectorAll("[srcset]")) {
      const value = element.getAttribute("srcset") || "";
      const candidates = value
        .split(",")
        .map((part) => {
          const [raw, ...descriptor] = part.trim().split(/\s+/);
          const safe = archiveResourceUrl(raw);
          return safe ? [safe, ...descriptor].join(" ") : null;
        })
        .filter(Boolean);
      if (candidates.length) element.setAttribute("srcset", candidates.join(", "));
      else element.removeAttribute("srcset");
    }
    for (const image of doc.querySelectorAll("image")) {
      const value =
        image.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
        image.getAttribute("xlink:href") ||
        image.getAttribute("href");
      const safe = archiveResourceUrl(value);
      if (safe) {
        image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", safe);
        image.setAttribute("href", safe);
      } else {
        image.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
        image.removeAttribute("xlink:href");
        image.removeAttribute("href");
      }
    }
    // Other SVG references (feImage, use, textPath...) may only point inside the
    // chapter; feImage may also use a packaged image like <image>.
    for (const element of doc.querySelectorAll("*")) {
      if (element.namespaceURI !== "http://www.w3.org/2000/svg" || ["a", "image"].includes(element.localName)) continue;
      for (const attribute of [...element.attributes]) {
        if (attribute.localName !== "href" ||
            (attribute.namespaceURI && attribute.namespaceURI !== "http://www.w3.org/1999/xlink")) continue;
        const value = attribute.value.trim();
        if (value.startsWith("#")) continue;
        const safe = element.localName === "feImage" ? archiveResourceUrl(value) : null;
        if (safe) attribute.value = safe;
        else element.removeAttributeNode(attribute);
      }
    }
    for (const link of doc.querySelectorAll(/** @type {'a'} */ ("a[href]"))) {
      const href = link.getAttribute("href") || "";
      // An in-book link to a packaged image opens the image itself, not a dead chapter URL.
      if (/\.(?:gif|png|jpe?g|webp)(?:#.*)?$/i.test(href)) {
        const resource = archiveResourceUrl(href);
        if (resource) {
          link.setAttribute("href", resource);
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
      }
      if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
  }

  /** @param {import('../../../typings/reader-foliate-format-strict').FoliateSection} section @param {number} index @param {AbortSignal} [signal] @param {'high' | 'low'} [priority] */
  async function createFoliateSection(section, index, signal, priority) {
    signal = signal || readerContext.readerAbortController.signal;
    priority = priority || "high";
    const source = await readerContext.awaitReader(section.createDocument(), signal);
    const { doc, sourceNodes } = readerContext.cloneFoliateDocument(source);
    readerContext.assertReaderActive();
    readerContext.rewriteFoliateResources(doc, section);
    // Packaged CSS is loaded from Foliate blob: URLs; inline it sanitized so
    // remote url()/@import references cannot bypass the archive-only policy.
    const styles = await readerContext.sanitizeFoliateStyles([...doc.querySelectorAll("style,link")]);
    signal.throwIfAborted();
    readerContext.assertReaderActive();
    for (const node of doc.querySelectorAll("style,link")) node.remove();
    const article = /** @type {import('../../../typings/reader-foliate-format-strict').FoliateArticle} */ (document.createElement("article"));
    article.dataset.section = String(index);
    const shadow = article.attachShadow({ mode: "open" }),
      baseStyle = document.createElement("style"),
      layoutStyle = document.createElement("style"),
      sectionBody = document.createElement("div");
    // Chapter styles live in a shadow root, so document-level preferences cannot reach them.
    baseStyle.textContent = `
    :host { display: block; color: inherit; }
    * { box-sizing: border-box; }
    .reader-section-body { display: block; color: inherit; line-height: inherit; }
    .reader-section-body > :first-child { margin-top: 0 !important; }
    :host(.reader-document-dark) .reader-section-body,
    :host(.reader-document-dark) .reader-section-body :where(:not(svg, svg *, img, canvas, video, audio, math, math *)) {
      color: inherit !important;
      background-color: transparent !important;
      border-color: #4a5056 !important;
      text-shadow: none !important;
    }
    a { color: var(--reader-book-link) !important; }
    :host(.reader-document-dark) .reader-section-body a { color: var(--reader-book-link) !important; }
    img, svg, video { max-width: 100%; height: auto; }
    mark.full-search-highlight { background: #ffd54f; color: #111; }
    :host(.reader-document-dark) .reader-section-body mark.full-search-highlight { background: #ffd54f !important; color: #111 !important; }
    @media (prefers-contrast: more) {
      .reader-section-body a[href] { text-decoration: underline !important; }
      .reader-section-body mark.full-search-highlight { outline: 2px solid currentColor; }
    }
  `;
    sectionBody.className = "reader-section-body";
    const body = readerContext.epubContentBody(doc);
    // Import the sanitized nodes directly. Serializing and reparsing legacy
    // nested anchors lets HTML's adoption rules reorder footnotes and citations.
    if (body)
      sectionBody.append(...[...body.childNodes].map((node) => document.importNode(node, true)));
    wrapEbookTables(sectionBody);
    article._resolveSearchAnchor = readerContext.foliateSearchAnchor(source, sourceNodes, body, sectionBody);
    layoutStyle.textContent = EBOOK_LAYOUT_STYLE;
    shadow.append(baseStyle, ...styles, layoutStyle, sectionBody);
    for (const image of sectionBody.querySelectorAll("img")) {
      image.loading = priority === "high" ? "eager" : "lazy";
      image.fetchPriority = priority;
      image.decoding = "async";
    }
    signal.throwIfAborted();
    readerContext.assertReaderActive();
    article.classList.toggle("reader-document-dark", readerContext.readerTheme === "dark");
    return article;
  }

  /** @param {HTMLElement} stream @param {import('../../../typings/reader-foliate-format-strict').FoliateSection[]} sections */
  function setupFoliateWindow(stream, sections) {
    let focus = readerContext.initialReaderTargetSection ?? 0, targetPending = false;
    stream.style.overflowAnchor = "none";
    /** @param {number} index */
    const existing = index => /** @type {import('../../../typings/reader-foliate-format-strict').FoliateArticle | null} */ (stream.querySelector(`article[data-section="${index}"]:not(.foliate-section-placeholder)`));
    /** @param {number} index */
    const ensurePlaceholder = index => {
      if (!sections[index] || stream.querySelector(`article[data-section="${index}"]`)) return;
      const placeholder = document.createElement("article");
      placeholder.className = "foliate-section-placeholder";
      placeholder.dataset.section = String(index);
      placeholder.hidden = stream.classList.contains("foliate-supplement-active");
      placeholder.style.setProperty("--foliate-placeholder-height", `${Math.max(400, readerContext.viewport.clientHeight)}px`);
      placeholder.setAttribute("aria-label", `加载第 ${index + 1} 节`);
      const next = [...stream.children].find(node => Number(/** @type {HTMLElement} */ (node).dataset.section) > index);
      readerContext.foliateScrollAnchors.preserve(() => stream.insertBefore(placeholder, next || null));
      observer.observe(placeholder);
    };
    const warm = () => {
      const indices = [];
      for (const offset of [-1, 1, -2, 2, 3, 4, 5, 6]) {
        const index = focus + offset;
        if (sections[index] && !existing(index)) indices.push(index);
      }
      scheduler.prefetch(document.hidden ? [] : indices);
    };
    const refresh = () => {
      if (readerContext.readerAbortController.signal.aborted || stream.classList.contains("foliate-supplement-active")) return;
      const marker = readerContext.viewport.getBoundingClientRect().top + 80;
      const rows = [...stream.children];
      const current = rows.find(node => {
        const rect = node.getBoundingClientRect();
        return rect.top <= marker && rect.bottom > marker;
      }) || rows.find(node => node.getBoundingClientRect().top > marker);
      const index = current ? Number(/** @type {HTMLElement} */ (current).dataset.section) : focus;
      if (targetPending && index !== focus && !readerContext.foliateScrollAnchors.scrolling) return;
      targetPending = false;
      focus = index;
      if (current?.classList.contains("foliate-section-placeholder")) scheduler.load(index).catch(() => {});
      warm();
      readerContext.foliateScrollAnchors.whenIdle(readerContext.trimFoliateSections);
    };
    const observer = new IntersectionObserver(readerContext.scheduleFoliateWindowRefresh,
      { root: readerContext.viewport, rootMargin: `${readerContext.FOLIATE_PREFETCH_MARGIN}px` });
    readerContext.foliateSectionObserver = observer;
    /** @param {number} index @param {import('../../../typings/reader-foliate-format-strict').FoliateArticle} article */
    const commitSection = (index, article) =>
        readerContext.foliateScrollAnchors.preserve(() => {
          const placeholder = stream.querySelector(
              `article.foliate-section-placeholder[data-section="${index}"]`
            ),
            next = [...stream.querySelectorAll("article[data-section]")].find(
              (item) => Number(/** @type {HTMLElement} */ (item).dataset.section) > index
            );
          if (stream.classList.contains("foliate-supplement-active")) article.hidden = true;
          if (placeholder) {
            observer.unobserve(placeholder);
            placeholder.replaceWith(article);
          } else stream.insertBefore(article, next || null);
          observer.observe(article);
          readerContext.foliateScrollAnchors.observe(article);
          ensurePlaceholder(index - 1);
          ensurePlaceholder(index + 1);
          return article;
        });
    const scheduler = readerContext.readerRuntime.track(VoiceOfMLReaderChapters.createChapterScheduler({
      create: async (index, signal, priority) => {
        const section = sections[index];
        if (!section) throw new RangeError("Foliate section is unavailable");
        const article = await readerContext.createFoliateSection(section, index, signal, priority);
        signal.throwIfAborted();
          if (existing(index)) return existing(index);
          return commitSection(index, article);
      }
    }));
    readerContext.foliateChapterRepository = VoiceOfMLReaderChapters.createChapterRepository({
      count: sections.length, find: existing, create: index => scheduler.load(index)
    });
    readerContext.foliateSectionVirtualizer = VoiceOfMLReaderVirtual.createSectionVirtualizer({
      limit: readerContext.FOLIATE_LOADED_SECTION_LIMIT,
      getLoaded: () => [
        .../** @type {NodeListOf<import('../../../typings/reader-foliate-format-strict').FoliateArticle>} */ (stream.querySelectorAll("article[data-section]:not(.foliate-section-placeholder)"))
      ],
      getIndex: (article) => Number(article.dataset.section),
      getHeight: (article) => article.getBoundingClientRect().height,
      canVirtualize: (article) => {
        const rect = article.getBoundingClientRect(),
          viewportRect = readerContext.viewport.getBoundingClientRect();
        return (
          rect.bottom < viewportRect.top - readerContext.FOLIATE_PREFETCH_MARGIN ||
          rect.top > viewportRect.bottom + readerContext.FOLIATE_PREFETCH_MARGIN
        ) && !article.contains(document.activeElement) && !article.shadowRoot?.activeElement &&
          !readerContext.foliateSectionRoot(article).querySelector("mark.full-search-highlight") &&
          ![window.getSelection(), /** @type {(ShadowRoot & {getSelection?: () => Selection | null}) | null} */ (article.shadowRoot)?.getSelection?.()].some(selection =>
            selection && !selection.isCollapsed && (selection.containsNode(article, true) ||
              selection.anchorNode?.getRootNode() === article.shadowRoot));
      },
      virtualize: (article, index, height) => {
        const placeholder = document.createElement("article");
        placeholder.className = "foliate-section-placeholder";
        placeholder.dataset.section = String(index);
        placeholder.style.setProperty("--foliate-placeholder-height", `${height}px`);
        placeholder.setAttribute("aria-hidden", "true");
        observer.unobserve(article);
        readerContext.foliateScrollAnchors.unobserve(article);
        for (const image of readerContext.foliateSectionRoot(article).querySelectorAll("img")) {
          image.removeAttribute("src");
          image.removeAttribute("srcset");
        }
        article._resolveSearchAnchor = null;
        article.replaceWith(placeholder);
        observer.observe(placeholder);
        return placeholder;
      },
      release: (index) => readerContext.foliateChapterRepository?.release(index) ?? false,
      preserve: (change) => readerContext.foliateScrollAnchors.preserve(change)
    });
    // Negative indices encode the original spine index, preserving existing linear
    // bookmark indices while keeping supplemental sections out of progression.
    let supplementGeneration = 0;
    readerContext.foliateSectionLoader = /** @type {import('../../../typings/reader-foliate-format-strict').FoliateLoader} */ (index => {
      if (index < 0) {
        const source = readerContext.epubBook?.sections[-index - 1];
        if (!Number.isInteger(index) || !source || source.linear !== "no") return Promise.resolve(null);
        const generation = ++supplementGeneration;
        const present = existing(index);
        const task = present ? Promise.resolve(present) : readerContext.createFoliateSection(source, index);
        return task.then(article => {
          if (generation !== supplementGeneration || readerContext.readerAbortController.signal.aborted) return null;
          for (const old of stream.querySelectorAll("article[data-supplement]")) if (old !== article) old.remove();
          article.dataset.supplement = "true";
          if (!article.isConnected) stream.append(article);
          for (const row of stream.children) if (row !== article) /** @type {HTMLElement} */ (row).hidden = true;
          stream.classList.add("foliate-supplement-active");
          return article;
        });
      }
      ++supplementGeneration;
      if (stream.classList.contains("foliate-supplement-active")) {
        for (const row of stream.children) /** @type {HTMLElement} */ (row).hidden = false;
        for (const old of stream.querySelectorAll("article[data-supplement]")) old.remove();
        stream.classList.remove("foliate-supplement-active");
      }
      focus = index;
      targetPending = true;
      const task = existing(index) ? Promise.resolve(existing(index)) : scheduler.load(index, true, true);
      warm();
      return task;
    });
    readerContext.foliateSectionLoader.refresh = refresh;
    readerContext.foliateSectionSettler = () => readerContext.waitForReader(0, true);
    const scroll = readerContext.scheduleFoliateWindowRefresh;
    readerContext.viewport.addEventListener("scroll", scroll, { passive: true });
    document.addEventListener("visibilitychange", scroll);
    readerContext.trackReaderResource(() => {
      readerContext.viewport.removeEventListener("scroll", scroll);
      document.removeEventListener("visibilitychange", scroll);
    });
  }

  /** @param {import('../../../typings/reader-foliate-format-strict').FoliateView} view @param {import('../../../typings/reader-foliate-format-strict').FoliateSection[]} sections */
  async function foliateTocEntries(view, sections) {
    readerContext.assertReaderActive();
    /** @type {import('../../../typings/reader-foliate-format-strict').FoliateTocEntry[]} */
    const entries = [];
    /** @param {import('../../../typings/reader-foliate-format-strict').FoliateTocItem[] | undefined} items @param {number} [depth] */
    const append = (items, depth = 0) => {
      for (const item of items || []) {
        const href = item?.href ? String(item.href) : "";
        if (href || item?.label)
          entries.push({
            label: item.label || "未命名章节",
            href,
            depth,
            group: !href,
            activate: () => view.goTo(href)
          });
        append(item.subitems, depth + 1);
      }
    };
    append(view.book.toc);
    /** @type {Map<import('../../../typings/reader-foliate-format-strict').FoliateSection, number>} */
    const sectionIndices = new Map();
    for (const [index, section] of sections.entries())
      if (!sectionIndices.has(section)) sectionIndices.set(section, index);
    let next = 0, yieldDeadline = performance.now() + 8;
    /** @type {Promise<void> | null} */
    let yieldTask = null;
    const resolveEntries = async () => {
      while (next < entries.length) {
        readerContext.assertReaderActive();
        if (yieldTask || performance.now() >= yieldDeadline) {
          yieldTask ||= readerContext.waitForReader().finally(() => {
            yieldTask = null;
            yieldDeadline = performance.now() + 8;
          });
          await yieldTask;
          continue;
        }
        const entry = entries[next++];
        if (!entry) continue;
        if (entry.group) {
          entry.sectionIndex = -1;
          entry.fragment = "";
          continue;
        }
        try {
          const target = await view.book.resolveHref(entry.href),
            section = target && view.book.sections[target.index];
          readerContext.assertReaderActive();
          entry.sectionIndex = section ? sectionIndices.get(section) ?? -target.index - 1 : -1;
          entry.anchor = typeof target?.anchor === "function" ? target.anchor : null;
          const fragment = entry.href.split("#")[1] || "";
          try { entry.fragment = fragment ? decodeURIComponent(fragment) : ""; }
          catch (_) { entry.fragment = ""; }
        } catch (_) {
          readerContext.assertReaderActive();
          entry.sectionIndex = -1;
          entry.fragment = "";
        }
      }
    };
    await readerContext.awaitReader(Promise.all(Array.from({ length: Math.min(8, entries.length) }, resolveEntries)));
    readerContext.assertReaderActive();
    return entries;
  }

  async function renderFoliate() {
    const foliateModuleUrl = "/search/static/foliate-reader/view.js?reader-v1";
    const prepared = readerContext.prepareReaderDocument([import(foliateModuleUrl)]);
    const [response, bytes] = await Promise.all([prepared.response,readerContext.readPreparedBytes(
      prepared.response,prepared.engines,VoiceOfMLReaderSecurity.LIMITS.archiveCompressedBytes)]);
    readerContext.assertReaderActive();
    if (VoiceOfMLReaderSecurity.isZipContainer(readerContext.extension, bytes))
      VoiceOfMLReaderSecurity.inspectZip(bytes);
    const view = /** @type {import('../../../typings/reader-foliate-format-strict').FoliateView} */ (/** @type {unknown} */ (document.createElement("foliate-view"))),
      stream = document.createElement("div");
    view.className = "foliate-reader-view";
    stream.className = "foliate-continuous";
    readerContext.content.replaceChildren(readerContext.loadingIndicator, view, stream);
    readerContext.epubRendition = view;
    await view.open(
      new File([bytes], new URL(readerContext.sourceUrl).pathname.split("/").pop() || "book.epub", {
        type: response.headers.get("content-type") || "application/epub+zip"
      })
    );
    readerContext.assertReaderActive();
    readerContext.epubBook = view.book;
    view.style.display = "none";
    const sections = view.book.sections.filter((section) => section.linear !== "no");
    await readerContext.getInitialReaderRestoration();
    const savedSection = Number(readerContext.readerRestorationEntry?.foliateSection);
    const initialSection = Number.isInteger(savedSection) && savedSection < 0 && view.book.sections[-savedSection - 1]?.linear === "no"
      ? 0 : Number.isInteger(savedSection)
      ? Math.max(0, Math.min(sections.length - 1, savedSection))
      : 0;
    readerContext.initialReaderTargetSection = readerContext.readerRestorationEntry?.foliateSection == null ? null : initialSection;
    readerContext.setupFoliateWindow(stream, sections);
    const repository = readerContext.foliateChapterRepository;
    if (!repository) throw new Error("Foliate chapter repository not initialized");
    if (sections[initialSection]) await repository.load(initialSection);
    if (savedSection < 0 && view.book.sections[-savedSection - 1]?.linear === "no")
      await readerContext.foliateSectionLoader?.(savedSection);
    readerContext.assertReaderActive();
    readerContext.markReaderContentReady();
    // Restoration targets the selected section; an unrelated slow previous
    // section is loaded in the background and remains retryable.
    if (initialSection > 0) repository.load(initialSection - 1).catch(error => {
      if (!readerContext.readerAbortController.signal.aborted)
        console.warn("Previous EPUB chapter could not be loaded", error);
    });
    // Resolving every TOC href can be expensive for large books. The first
    // chapter is already visible, so finish the opening path before enriching
    // the navigation panel in the background.
    readerContext.foliateTocEntries(view, sections)
      .then((entries) => {
        if (entries.length && !readerContext.readerAbortController.signal.aborted) readerContext.setToc(entries);
      })
      .catch(() => {});
    readerContext.scheduleFoliateScrollSync();
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "EPUB";
  }

  return {
    foliateSectionRoot,
    foliateSectionQuery,
    foliateSectionCandidates,
    syncFoliateScrollLocation,
    refreshFoliateWindow,
    scheduleFoliateWindowRefresh,
    trimFoliateSections,
    scheduleFoliateScrollSync,
    activateFoliateTocEntry,
    cloneFoliateDocument,
    foliateSearchAnchor,
    settleReaderImages,
    rewriteFoliateResources,
    createFoliateSection,
    setupFoliateWindow,
    foliateTocEntries,
    renderFoliate
  };
}
