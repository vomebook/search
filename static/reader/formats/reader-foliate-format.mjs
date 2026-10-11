export function createReaderFoliateFormat(readerContext) {
  function foliateSectionRoot(article) {
    return article?.shadowRoot || article;
  }

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

  function syncFoliateScrollLocation() {
    if (!readerContext.foliateContinuous || !readerContext.navigationState.tocEntries.length) return;
    const rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")],
      top = readerContext.viewport.getBoundingClientRect().top + 80;
    let sectionIndex = -1,
      sectionNode = null;
    for (const row of rows)
      if (row.getBoundingClientRect().top <= top) {
        sectionIndex = Number(row.dataset.section);
        sectionNode = row;
      }
    if (!sectionNode) return;
    let best = -1;
    let bestPosition = -Infinity;
    for (const [index, entry] of readerContext.navigationState.tocEntries.entries()) {
      if (entry.sectionIndex !== sectionIndex) continue;
      let position = sectionNode.getBoundingClientRect().top;
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
      if (position <= top && (position > bestPosition || (position === bestPosition && index > best))) {
        best = index;
        bestPosition = position;
      }
    }
    if (best < 0) {
      let firstPosition = Infinity;
      for (const [index, entry] of readerContext.navigationState.tocEntries.entries()) {
        if (entry.sectionIndex !== sectionIndex) continue;
        const position = entry.target?.getBoundingClientRect?.().top;
        if (Number.isFinite(position) && position < firstPosition) {
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
    if (!readerContext.foliateContinuous || !readerContext.foliateSectionVirtualizer) return;
    const marker = readerContext.viewport.getBoundingClientRect().top + 80,
      rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")],
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

  async function activateFoliateTocEntry(entry, generation = readerContext.beginReaderNavigation()) {
    const book = readerContext.epubRendition?.book,
      href = String(entry.href || ""),
      target = await readerContext.epubRendition?.book?.resolveHref(href);
    if (!book || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const section = target && book.sections[target.index],
      sections = book.sections.filter((item) => item.linear !== "no"),
      visibleIndex = section ? sections.indexOf(section) : -1;
    if (!section || visibleIndex < 0 || !readerContext.foliateSectionLoader) return false;
    let node = await readerContext.foliateSectionLoader(visibleIndex);
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    // Background neighbors are not part of a demanded TOC destination.
    await readerContext.waitForReader(0, true);
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    if (!node?.isConnected) node = await readerContext.foliateSectionLoader(visibleIndex);
    if (!node?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const root = readerContext.foliateSectionRoot(node),
      anchorDocument = {
        getElementById: (id) => root.querySelector(`[id="${CSS.escape(id)}"]`),
        querySelector: (selector) => root.querySelector(selector)
      };
    let anchor = null;
    try {
      anchor = typeof target.anchor === "function" ? target.anchor(anchorDocument) : null;
    } catch (_) {}
    if (!anchor) {
      const fragment = href.split("#")[1] || "",
        id = fragment ? decodeURIComponent(fragment) : "";
      anchor = id ? root.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`) : null;
    }
    const destination = anchor || node;
    readerContext.foliateScrollAnchors.invalidate();
    readerContext.viewport.scrollTop = Math.max(
      0,
      readerContext.viewport.scrollTop +
        destination.getBoundingClientRect().top -
        readerContext.viewport.getBoundingClientRect().top -
        8
    );
    readerContext.syncFoliateScrollLocation();
    readerContext.updateTocCurrentMark();
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
    readerContext.setReaderPanelOpen(false, true);
    readerContext.foliateScrollAnchors.remember();
    return true;
  }

  function cloneFoliateDocument(source) {
    const doc = source.cloneNode(true),
      original = source.createTreeWalker(source, NodeFilter.SHOW_TEXT),
      cloned = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    const sourceNodes = new WeakMap();
    while (original.nextNode() && cloned.nextNode())
      sourceNodes.set(cloned.currentNode, original.currentNode);
    return { doc: readerContext.sanitizeEpubDocument(doc), sourceNodes };
  }

  function foliateSearchAnchor(source, sourceNodes, body, renderedBody) {
    const sourceWalker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const pairs = [];
    let offset = 0;
    while (sourceWalker.nextNode()) {
      const node = sourceWalker.currentNode;
      const original = sourceNodes.get(node);
      if (original) pairs.push({ original, offset });
      offset += node.length;
    }
    return (anchor) => {
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
        const node = walker.currentNode,
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

  async function settleReaderImages(root, timeoutMs = 2500) {
    readerContext.assertReaderActive();
    const images = [...root.querySelectorAll("img[src],img[srcset]")];
    if (!images.length) return;
    let timeout = 0, active = true;
    const cleanups = new Set();
    const decoded = Promise.allSettled(
      images.map(async (image) => {
        // Sections are prepared off-DOM; lazy images cannot enter a viewport yet.
        image.loading = "eager";
        image.decoding = "async";
        if (!image.complete) await new Promise((resolve) => {
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
        });
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

  function rewriteFoliateResources(doc, section) {
    const safeEmbeddedValue = (value) =>
      /^(?:blob:|data:image\/(?:gif|png|jpe?g|webp);)/i.test(String(value || "").trim());
    const archiveResourceUrl = (value) => {
      const raw = String(value || "").trim();
      if (!raw || raw.startsWith("#") || raw.includes("#") || safeEmbeddedValue(raw))
        return safeEmbeddedValue(raw) ? raw : null;
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
        return `https://voiceofml-search.hf.space/api/reader-resource?book=${encodeURIComponent(readerContext.sourceUrl)}&path=${encodeURIComponent(resolved)}`;
      } catch (_) {
        return null;
      }
    };
    for (const element of doc.querySelectorAll(
      "img[src],source[src],audio[src],video[src],video[poster]"
    )) {
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
    for (const link of doc.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
  }

  async function createFoliateSection(section, index) {
    const signal = arguments[2] || readerContext.readerAbortController.signal;
    const priority = arguments[3] || "high";
    const source = await readerContext.awaitReader(section.createDocument(), signal);
    const { doc, sourceNodes } = readerContext.cloneFoliateDocument(source);
    readerContext.assertReaderActive();
    readerContext.rewriteFoliateResources(doc, section);
    const styles = [...doc.querySelectorAll("style,link")].map((node) => node.cloneNode(true));
    for (const node of doc.querySelectorAll("style,link")) node.remove();
    const article = document.createElement("article");
    article.dataset.section = String(index);
    const shadow = article.attachShadow({ mode: "open" }),
      baseStyle = document.createElement("style"),
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
    article._resolveSearchAnchor = readerContext.foliateSearchAnchor(source, sourceNodes, body, sectionBody);
    shadow.append(baseStyle, ...styles, sectionBody);
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

  function setupFoliateWindow(stream, sections) {
    let focus = readerContext.initialReaderTargetSection ?? 0, targetPending = false;
    stream.style.overflowAnchor = "none";
    const existing = index => stream.querySelector(`article[data-section="${index}"]:not(.foliate-section-placeholder)`);
    const ensurePlaceholder = index => {
      if (!sections[index] || stream.querySelector(`article[data-section="${index}"]`)) return;
      const placeholder = document.createElement("article");
      placeholder.className = "foliate-section-placeholder";
      placeholder.dataset.section = String(index);
      placeholder.style.setProperty("--foliate-placeholder-height", `${Math.max(400, readerContext.viewport.clientHeight)}px`);
      placeholder.setAttribute("aria-label", `加载第 ${index + 1} 节`);
      const next = [...stream.children].find(node => Number(node.dataset.section) > index);
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
      if (readerContext.readerAbortController.signal.aborted) return;
      const marker = readerContext.viewport.getBoundingClientRect().top + 80;
      const rows = [...stream.children];
      const current = rows.find(node => {
        const rect = node.getBoundingClientRect();
        return rect.top <= marker && rect.bottom > marker;
      }) || rows.find(node => node.getBoundingClientRect().top > marker);
      const index = current ? Number(current.dataset.section) : focus;
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
    const commitSection = (index, article) =>
        readerContext.foliateScrollAnchors.preserve(() => {
          const placeholder = stream.querySelector(
              `article.foliate-section-placeholder[data-section="${index}"]`
            ),
            next = [...stream.querySelectorAll("article[data-section]")].find(
              (item) => Number(item.dataset.section) > index
            );
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
        const article = await readerContext.createFoliateSection(sections[index], index, signal, priority);
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
        ...stream.querySelectorAll("article[data-section]:not(.foliate-section-placeholder)")
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
          ![window.getSelection(), article.shadowRoot?.getSelection?.()].some(selection =>
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
      release: (index) => readerContext.foliateChapterRepository.release(index),
      preserve: (change) => readerContext.foliateScrollAnchors.preserve(change)
    });
    readerContext.foliateSectionLoader = index => {
      focus = index;
      targetPending = true;
      const task = existing(index) ? Promise.resolve(existing(index)) : scheduler.load(index, true, true);
      warm();
      return task;
    };
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

  async function foliateTocEntries(view, sections) {
    readerContext.assertReaderActive();
    const entries = [];
    const append = (items, depth = 0) => {
      for (const item of items || []) {
        const href = item?.href ? String(item.href) : "";
        if (href)
          entries.push({
            label: item.label || "未命名章节",
            href,
            depth,
            activate: () => view.goTo(href)
          });
        append(item.subitems, depth + 1);
      }
    };
    append(view.book.toc);
    const sectionIndices = new Map();
    for (const [index, section] of sections.entries())
      if (!sectionIndices.has(section)) sectionIndices.set(section, index);
    let next = 0, yieldDeadline = performance.now() + 8, yieldTask = null;
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
        try {
          const target = await view.book.resolveHref(entry.href),
            section = target && view.book.sections[target.index];
          readerContext.assertReaderActive();
          entry.sectionIndex = section ? sectionIndices.get(section) ?? -1 : -1;
          entry.anchor = typeof target?.anchor === "function" ? target.anchor : null;
          const fragment = entry.href.split("#")[1] || "";
          entry.fragment = fragment ? decodeURIComponent(fragment) : "";
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
    const prepared = readerContext.prepareReaderDocument([import("/search/static/foliate-reader/view.js?reader-v1")]);
    const [response, bytes] = await Promise.all([prepared.response,readerContext.readPreparedBytes(
      prepared.response,prepared.engines,VoiceOfMLReaderSecurity.LIMITS.archiveCompressedBytes)]);
    readerContext.assertReaderActive();
    if (VoiceOfMLReaderSecurity.isZipContainer(readerContext.extension, bytes))
      VoiceOfMLReaderSecurity.inspectZip(bytes);
    const view = document.createElement("foliate-view"),
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
    const initialSection = Number.isInteger(savedSection)
      ? Math.max(0, Math.min(sections.length - 1, savedSection))
      : 0;
    readerContext.initialReaderTargetSection = readerContext.readerRestorationEntry?.foliateSection == null ? null : initialSection;
    readerContext.setupFoliateWindow(stream, sections);
    if (sections[initialSection]) await readerContext.foliateChapterRepository.load(initialSection);
    if (initialSection > 0) await readerContext.foliateChapterRepository.load(initialSection - 1);
    readerContext.assertReaderActive();
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
