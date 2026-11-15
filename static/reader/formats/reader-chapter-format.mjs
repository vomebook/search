// The current MOBI chapter manifest for this five-volume edition contains
// cross-volume sidebar targets that point back into volume 1. Its own verified
// "总目录" links and each volume's adjacent "书名页" independently identify
// these destinations. Never apply this correction to another manifest version.
/** @type {Map<string, [number, string, number, string, number, string, number][]>} */
const REVIEWED_TOC_CORRECTIONS = new Map([
  ["7b150f1ba768d3bf4380b805676a32b8b2c18d7a8b4efb75be49a38da1dbf3a8", [
    [1, "费曼物理学讲义：新千年版．第1卷", 4, "", 4, "chapter", 3],
    [2, "封面", 4, "", 4, "chapter", 3],
    [355, "费曼物理学讲义：新千年版．第2卷", 50, "2NI-3c4a5b77066c4db48850b1e309e1eb0b", 306, "chapter", 357],
    [356, "封面", 50, "2NI-3c4a5b77066c4db48850b1e309e1eb0b", 306, "chapter", 357],
    [684, "费曼物理学讲义：新千年版．第3卷", 84, "68C-3c4a5b77066c4db48850b1e309e1eb0b", 595, "chapter", 686],
    [685, "封面", 84, "68C-3c4a5b77066c4db48850b1e309e1eb0b", 595, "chapter", 686],
    [855, "费曼物理学讲义补编", 109, "88V-3c4a5b77066c4db48850b1e309e1eb0b", 744, "chapter", 857],
    [856, "封面", 109, "88V-3c4a5b77066c4db48850b1e309e1eb0b", 744, "chapter", 857],
    [875, "费曼物理学讲义习题集：新千年版", 118, "9LP-3c4a5b77066c4db48850b1e309e1eb0b", 763, "chapter", 877],
    [876, "封面", 118, "9LP-3c4a5b77066c4db48850b1e309e1eb0b", 763, "chapter", 877]
  ]]
]);
const REVIEWED_MOBI_SOURCE = "chapters/ebook/mobi/046c991cc6fb1b05e4c95e24fea7dd34112a9ba239ff4e2f22d68221bb8fd6aa/6df0c142735b1a1a/chapter-manifest.json";

/** @param {import("../../../typings/reader-chapter-format-strict").ChapterManifest} manifest
 * @param {Uint8Array<ArrayBuffer>} bytes @param {string} manifestUrl */
export function applyReviewedTocCorrections(manifest, bytes, manifestUrl) {
  const url = new URL(manifestUrl, location.href);
  const path = url.searchParams.get("path") || decodeURIComponent(url.pathname);
  if (!path.endsWith(REVIEWED_MOBI_SOURCE) || !globalThis.crypto?.subtle || !Array.isArray(manifest.toc)) return manifest;
  const tocEntries = manifest.toc;
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
    const hex = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
    const corrections = REVIEWED_TOC_CORRECTIONS.get(hex);
    if (!corrections) return manifest;
    for (const [index, title, chapter, fragment, target, , titleIndex] of corrections) {
      const entry = tocEntries[index], titlePage = tocEntries[titleIndex];
      if (!entry || entry.title !== title || entry.chapter !== chapter || entry.fragment !== fragment ||
          !titlePage || titlePage.title !== "书名页" || titlePage.chapter !== target ||
          !manifest.chapters[target - 1]) return manifest;
    }
    const toc = tocEntries.map(entry => ({ ...entry }));
    for (const [index, , , , chapter, fragment] of corrections) Object.assign(/** @type {import("../../../typings/reader-chapter-format-strict").TocItem} */ (toc[index]), { chapter, fragment });
    return { ...manifest, toc };
  }).catch(() => manifest);
}

/** @param {unknown} value @returns {value is {path: string, bytes: number, sha256: string, [key: string]: unknown}} */
export function isChapterSearchIndex(value) {
  if (!value || typeof value !== "object") return false;
  return "path" in value && value.path === "epub-search-index.json.gz" &&
    "bytes" in value && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
    "sha256" in value && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

/** @param {unknown} value */
export function chapterOptionalText(value) {
  return typeof value === "string" ? value : "";
}

/** Match the validator's bytes/size precedence without poisoning the prefetch sum.
 * @param {unknown} chapter */
export function chapterPrefetchSize(chapter) {
  try {
    const raw = chapter && typeof chapter === "object"
      ? (("bytes" in chapter ? chapter.bytes : undefined) ?? ("size" in chapter ? chapter.size : undefined) ?? 0)
      : (typeof chapter === "number" || typeof chapter === "string" ? chapter : 0);
    const size = Number(raw);
    return Number.isFinite(size) && size >= 0 ? size : 0;
  } catch (_) { return 0; }
}

/** @param {unknown} entry @returns {entry is import("../../../typings/reader-chapter-format-strict").TocEntry} */
function isChapterTocEntry(entry) {
  return typeof entry === "object" && entry !== null &&
    "label" in entry && typeof entry.label === "string" &&
    "chapterIndex" in entry && typeof entry.chapterIndex === "number" &&
    "fragment" in entry && typeof entry.fragment === "string" &&
    "depth" in entry && typeof entry.depth === "number" &&
    "activate" in entry && typeof entry.activate === "function";
}

/** @param {import("../../../typings/reader-chapter-format-strict").ChapterFormatContext} readerContext */
export function createReaderChapterFormat(readerContext) {
  /** @param {Response | Promise<Response>} prepared */
  async function renderChapterManifest(prepared) {
    const response = await prepared;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifestBytes = await VoiceOfMLReaderSecurity.readBytes(response, VoiceOfMLReaderSecurity.LIMITS.manifestBytes);
    let manifest = VoiceOfMLReaderSecurity.validateChapterManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    manifest = await applyReviewedTocCorrections(manifest, manifestBytes,
      readerContext.chapterManifestUrl || readerContext.sourceUrl);
    readerContext.assertReaderActive();
    const frame = document.createElement("div");
    frame.className = "epub-frame";
    frame.style.overflowAnchor = "none";
    const openingGeneration = readerContext.readerRuntime.currentGeneration("navigation");
    readerContext.content.appendChild(frame);
    const loaded = new Set(), retainedBytes = new Map(),
      manifestBase = readerContext.trustedReaderAssetManifestUrl(readerContext.chapterManifestUrl || readerContext.sourceUrl);
    const chapterByIndex = new Map(manifest.chapters.map((chapter) => [chapter.index, chapter]));
    const chapterPrefetchCount = 6;
    const chapterPrefetchMaxCount = 10, chapterPrefetchBytes = 128 * 1024;
    let chapterFocusIndex = 1, chapterWindowFrame = 0, chapterWindowReady = false;
    let navigationTargetChapter = 0;
    /** @type {(() => void) | null} */
    let navigationProtectionCleanup = null;
    let chapterNavigating = 0;
    /** @type {IntersectionObserver | null} */
    let chapterPreviousObserver = null;
    const chapterBudget = VoiceOfMLReaderSecurity.createByteBudget();
    if (!manifestBase) throw new Error("EPUB_INVALID_MANIFEST_PATH");
    const searchIndex = manifest.search_index;
    readerContext.chapterSearchConfiguration =
      isChapterSearchIndex(searchIndex)
        ? {
          chapters: manifest.chapters,
          index: {
            ...searchIndex,
            url: (() => {
              const resolved = readerContext.trustedChapterUrl(searchIndex.path, manifestBase);
              if (!resolved) return "";
              const target = new URL(resolved, location.href);
              const bucketUrl = target.origin === "https://voiceofml-search.hf.space" &&
                target.pathname === "/api/reader-bucket-resource"
                ? target.pathname + target.search : resolved;
              return readerContext.readerContentUrl(bucketUrl);
            })()
          }
          }
        : null;
    /** @param {import("../../../typings/reader-chapter-format-strict").Chapter} chapter */
    const chapterUrl = (chapter) => readerContext.trustedChapterUrl(chapter.path, manifestBase);
    /** @param {number} index */
    const chapterAt = (index) => chapterByIndex.get(index) || null;
    /** @param {number} index @param {string} selector */
    const nextChapterNode = (index, selector) => {
      for (const node of frame.querySelectorAll(/** @type {string} */ (selector)))
        if (Number(/** @type {HTMLElement} */ (node).dataset.chapter) > index) return node;
      return null;
    };
    /** @param {string} raw @param {string} base @param {string} attribute */
    const resourceUrl = (raw, base, attribute) => {
      const value = String(raw || "").trim();
      if (!value || value.startsWith("#")) return null;
      return readerContext.trustedChapterResourceUrl(value, base, attribute, manifestBase);
    };
    /** @param {HTMLElement} article */
    const insertChapter = (article) => {
      const existing = frame.querySelector(
        `.reader-epub-chapter[data-chapter="${article.dataset.chapter}"]`
      );
      if (existing) return existing;
      const next = nextChapterNode(Number(article.dataset.chapter), ".reader-epub-chapter, .reader-chapter-sentinel");
      const marker = frame.querySelector(`.reader-chapter-sentinel[data-chapter="${article.dataset.chapter}"]`);
      const insert = () => {
        if (marker) {
          /** @type {IntersectionObserver} */ (readerContext.chapterManifestObserver).unobserve(marker);
          /** @type {IntersectionObserver} */ (chapterPreviousObserver).unobserve(marker);
          marker.replaceWith(article);
        } else frame.insertBefore(article, next || null);
      };
      const preservePosition = chapterWindowReady || !readerContext.isReaderGenerationCurrent("navigation", openingGeneration);
      if (preservePosition) readerContext.foliateScrollAnchors.preserve(insert);
      else insert();
      /** @type {IntersectionObserver} */ (readerContext.chapterManifestObserver).observe(article);
      if (preservePosition) readerContext.foliateScrollAnchors.observe(article);
      return article;
    };
    /** @param {import("../../../typings/reader-chapter-format-strict").Chapter} chapter @param {boolean} [previous] */
    const ensureSentinel = (chapter, previous = false) => {
      if (readerContext.readerAbortController.signal.aborted || loaded.has(chapter.index)) return null;
      const selector = `.reader-chapter-sentinel[data-chapter="${chapter.index}"]`;
      const existing = frame.querySelector(selector);
      if (existing) return existing;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "reader-chapter-sentinel";
      marker.dataset.chapter = String(chapter.index);
      marker.textContent = `加载第 ${chapter.index} 章`;
      marker.setAttribute("aria-label", `重试加载第 ${chapter.index} 章`);
      marker.addEventListener("click", () => {
        marker.disabled = true;
        fetchChapter(chapter).catch((error) => {
          marker.disabled = false;
          console.warn("EPUB chapter could not be loaded", error);
        });
      });
      const next = nextChapterNode(chapter.index,
        ".reader-epub-chapter[data-chapter], .reader-chapter-sentinel[data-chapter]");
      const insert = () => frame.insertBefore(marker, next || null);
      if (chapterWindowReady || !readerContext.isReaderGenerationCurrent("navigation", openingGeneration))
        readerContext.foliateScrollAnchors.preserve(insert);
      else insert();
      /** @type {IntersectionObserver} */ (previous ? chapterPreviousObserver : readerContext.chapterManifestObserver).observe(marker);
      return marker;
    };
    /** @param {Element} article @param {string} fragment */
    const chapterTarget = (article, fragment) =>
      !fragment || article.id === fragment ? article :
        article.querySelector(`[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`);
    /** @param {string | null} value */
    const normalizeTocLabel = value => String(value || "").replace(/\s+/gu, "").toLowerCase();
    // Old merged CHM bundles can lose the TOC fragment while retaining the
    // original, functioning book-internal link. Accept only a unique exact
    // label that points to an existing generated page in the same chapter.
    /** @param {HTMLElement} article @param {import("../../../typings/reader-chapter-format-strict").Chapter} chapter */
    const repairMergedChmToc = (article, chapter) => {
      const missing = readerContext.navigationState.tocEntries.filter(isChapterTocEntry).filter(entry =>
        entry.chapterIndex === chapter.index && !entry.fragment && normalizeTocLabel(entry.label));
      if (!missing.length) return;
      const wanted = new Set(missing.map(entry => normalizeTocLabel(entry.label)));
      const idCounts = new Map();
      for (const node of article.querySelectorAll("[id], [name]"))
        for (const id of new Set([node.id, node.getAttribute("name")]))
          if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
      const targets = new Map();
      for (const link of article.querySelectorAll('a[href^="#chm-page-"]')) {
        const label = normalizeTocLabel(link.textContent);
        if (!wanted.has(label)) continue;
        const fragment = /** @type {string} */ (link.getAttribute("href")).slice(1);
        if (!/^chm-page-\d+$/.test(fragment)) continue;
        if (!targets.has(label)) targets.set(label, new Set());
        targets.get(label).add(fragment);
      }
      for (const entry of missing) {
        const candidates = targets.get(normalizeTocLabel(entry.label));
        if (candidates?.size !== 1) continue;
        const fragment = candidates.values().next().value;
        if (idCounts.get(fragment) === 1 && chapterTarget(article, fragment)) entry.fragment = fragment;
      }
    };
    const mergedChmToc = manifest.chapters.some(chapter =>
      "source_path" in chapter && chapter.source_path === "chm-fallback.html");
    const setChapterToc = () => {
      const entries = (manifest.toc ?? manifest.chapters.map((item) => ({
          title: ("title" in item && chapterOptionalText(item.title)) || `章节 ${item.index}`, chapter: item.index, depth: 0, fragment: ""
        }))).map((item) => ({
          label: item.title,
          chapterIndex: item.chapter,
          fragment: item.fragment,
          depth: item.depth,
          activate: (/** @type {number} */ generation) => activateChapter(/** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (manifest.chapters[item.chapter - 1]), generation, item.fragment)
        }));
      readerContext.setToc(entries);
      for (const entry of readerContext.navigationState.tocEntries.filter(isChapterTocEntry))
        entry.activate = generation => activateChapter(/** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (chapterAt(entry.chapterIndex)), generation, entry);
    };
    const chapterScheduler = VoiceOfMLReaderChapters.createChapterScheduler({
      create: async (index, signal, priority) => {
        const chapter = /** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (chapterAt(index));
        readerContext.assertReaderActive();
        const url = chapterUrl(chapter);
        if (!url) throw new Error("EPUB_INVALID_PATH");
        const result = await readerContext.fetchReaderUrl(url, { signal, priority });
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
        const bytes = await VoiceOfMLReaderSecurity.readBytes(
          result,
          VoiceOfMLReaderSecurity.LIMITS.chapterBytes,
          chapterBudget
        );
        let inserted = false;
        try {
          readerContext.assertReaderActive();
          signal.throwIfAborted();
          const doc = readerContext.parseChapterDocument(new TextDecoder().decode(bytes));
          const elements = doc.querySelectorAll("*");
          let rewritten = 0, deadline = performance.now() + 8;
          /** @param {number} count @param {number} total */
          const yieldIfNeeded = async (count, total) => {
            if (count % 256 || count >= total || performance.now() < deadline) return;
            signal.throwIfAborted();
            readerContext.assertReaderActive();
            await new Promise(resolve => setTimeout(resolve, 0));
            signal.throwIfAborted();
            readerContext.assertReaderActive();
            deadline = performance.now() + 8;
          };
          for (const element of elements) {
            for (const name of ["src", "href", "poster", "xlink:href"])
              if (element.hasAttribute(name)) {
                const value = element.getAttribute(name) || "";
                if (name === "href" && element.localName === "a" &&
                    readerContext.trustedChapterReferenceUrl(value, url, manifestBase)) continue;
                const resolved = resourceUrl(value, url, name === "href" ? "href" : "resource");
                if (resolved) element.setAttribute(name, resolved);
                else if (!(name === "href" && value.startsWith("#"))) element.removeAttribute(name);
              }
            if (element.hasAttribute("srcset")) element.removeAttribute("srcset");
            if (++rewritten % 256 === 0 && rewritten < elements.length && performance.now() >= deadline)
              await yieldIfNeeded(rewritten, elements.length);
          }
          signal.throwIfAborted();
          readerContext.assertReaderActive();
          const article = /** @type {HTMLElement & {_chapterSearchHead?: Node | null}} */ (document.createElement("article"));
          article.className = "reader-markdown reader-epub-chapter";
          article.dataset.chapter = String(chapter.index);
          if (doc.body?.id) article.id = doc.body.id;
          // The parser has already normalized and sanitized this HTML document.
          // Import nodes directly rather than serializing and parsing the body again.
          const children = doc.body?.childNodes;
          let imported = 0;
          if (children) for (const child of children) {
            article.appendChild(document.importNode(child, true));
            if (++imported % 256 === 0 && imported < children.length && performance.now() >= deadline)
              await yieldIfNeeded(imported, children.length);
          }
          const images = article.querySelectorAll("img");
          let prepared = 0;
          for (const image of images) {
            image.loading = priority === "high" ? "eager" : "lazy";
            image.fetchPriority = priority;
            image.decoding = "async";
            if (++prepared % 256 === 0 && prepared < images.length && performance.now() >= deadline)
              await yieldIfNeeded(prepared, images.length);
          }
          // The generated text index includes head text (e.g. the chapter title).
          article._chapterSearchHead = doc.head ? document.importNode(doc.head, true) : null;
          signal.throwIfAborted();
          readerContext.assertReaderActive();
          insertChapter(article);
          loaded.add(chapter.index);
          retainedBytes.set(chapter.index, bytes.byteLength);
          inserted = true;
          if (mergedChmToc) repairMergedChmToc(article, chapter);
          for (const entry of readerContext.navigationState.tocEntries.filter(isChapterTocEntry))
            if (entry.chapterIndex === chapter.index)
              entry.target = chapterTarget(article, entry.fragment);
          const next = chapterAt(chapter.index + 1);
          if (next) ensureSentinel(next);
          const previous = chapterAt(chapter.index - 1);
          if (previous) ensureSentinel(previous, true);
          scheduleChapterWindow();
        } catch (error) {
          if (!inserted) chapterBudget.release(bytes.byteLength);
          throw error;
        }
      }
    });
    /** @param {import("../../../typings/reader-chapter-format-strict").Chapter} chapter @param {boolean} [demand] @param {boolean} [exclusive] */
    const fetchChapter = (chapter, demand = true, exclusive = false) => {
      readerContext.assertReaderActive();
      if (loaded.has(chapter.index)) return Promise.resolve();
      return chapterScheduler.load(chapter.index, demand, exclusive).then(() => {
        readerContext.foliateScrollAnchors.whenIdle(trimChapterWindow);
      }).catch(error => {
        if (error.name !== "AbortError" && !readerContext.readerAbortController.signal.aborted) {
          const marker = ensureSentinel(chapter);
          marker?.classList.add("reader-chapter-load-error");
          marker?.removeAttribute("aria-hidden");
        }
        throw error;
      });
    };
    /** @param {import("../../../typings/reader-chapter-format-strict").Chapter} chapter @param {number} generation @param {string | {fragment?: string}} destination */
    const activateChapter = async (chapter, generation, destination = "") => {
      chapterFocusIndex = chapter.index;
      navigationProtectionCleanup?.();
      navigationTargetChapter = chapter.index;
      chapterNavigating++;
      let landingProtected = false;
      try {
        await fetchChapter(chapter, true, chapterWindowReady);
        if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
        const node = frame.querySelector(`.reader-epub-chapter[data-chapter="${chapter.index}"]`);
        let id = (typeof destination === "string" ? destination : destination.fragment || "").replace(/^#/, "");
        try {
          id = decodeURIComponent(id);
        } catch (_) {}
        const anchor = chapterTarget(/** @type {Element} */ (node), id);
        if (!anchor) throw new Error("EPUB_MISSING_ANCHOR");
        readerContext.foliateScrollAnchors.invalidate();
        // Measure the anchor instead of using scrollIntoView: the demanded landing line is
        // this viewport's top edge, and scrollIntoView can also move ancestor scrollers.
        readerContext.alignReaderDestination(anchor);
        readerContext.foliateScrollAnchors.remember();
        // Chapter images and lazy placeholders keep changing height after the jump; hold
        // the anchor on the landing line until the layout settles.
        readerContext.holdReaderDestination(anchor);
        // Keep the demanded chapter out of the trim queue while its landing
        // stabilizes. Scroll-anchoring and delayed images can otherwise mark a
        // previous chapter as current and remove the destination mid-jump.
        let timer = 0;
        const unlock = () => {
          clearTimeout(timer);
          for (const name of ["wheel", "touchstart", "pointerdown", "keydown"])
            readerContext.viewport.removeEventListener(name, unlock);
          if (navigationTargetChapter === chapter.index) navigationTargetChapter = 0;
          if (navigationProtectionCleanup === unlock) navigationProtectionCleanup = null;
        };
        navigationProtectionCleanup = unlock;
        landingProtected = true;
        for (const name of ["wheel", "touchstart", "pointerdown", "keydown"])
          readerContext.viewport.addEventListener(name, unlock, { once: true, passive: true });
        timer = setTimeout(unlock, 16000);
        readerContext.syncHeadingLocation();
        readerContext.updateProgressTools();
        readerContext.scheduleSave();
        return true;
      } finally {
        chapterNavigating--;
        if (!landingProtected && navigationTargetChapter === chapter.index && !navigationProtectionCleanup)
          navigationTargetChapter = 0;
        scheduleChapterWindow();
      }
    };
    frame.addEventListener("click", async (event) => {
      const link = /** @type {Element} */ (event.target).closest?.("a[href]");
      const article = /** @type {HTMLElement | null | undefined} */ (link?.closest(".reader-epub-chapter"));
      if (
        !link || !article ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const current = chapterAt(Number(article.dataset.chapter));
      const destination = readerContext.trustedChapterReferenceUrl(link.getAttribute("href"), chapterUrl(/** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (current)), manifestBase);
      const target = destination ? new URL(destination.url) : null;
      const fragment = destination?.fragment || "";
      const chapter = target && manifest.chapters.find((item) => chapterUrl(item) === target.href);
      if (!chapter) {
        // A stale or missing book document must not navigate out to an asset 404.
        if (/\.(?:xhtml?|html?)(?:$|#)/i.test(link.getAttribute("href") || "")) {
          event.preventDefault();
          let message = link.nextElementSibling;
          if (!message?.classList.contains("reader-chapter-link-error")) {
            message = document.createElement("span");
            message.className = "reader-chapter-link-error";
            message.setAttribute("role", "status");
            message.textContent = "（无法定位此书内链接）";
            link.after(message);
          }
        }
        return;
      }
      event.preventDefault();
      const generation = readerContext.beginReaderNavigation();
      try {
        await activateChapter(chapter, generation, fragment);
      } catch (error) {
        readerContext.reportNavigationError(error, generation);
      }
    });
    const chapterVirtualizer = VoiceOfMLReaderVirtual.createSectionVirtualizer({
      limit: 12,
      getLoaded: () => [.../** @type {NodeListOf<HTMLElement & {_chapterSearchHead?: Node | null}>} */ (frame.querySelectorAll(":scope > .reader-epub-chapter"))],
      getIndex: article => Number(article.dataset.chapter),
      getHeight: article => article.getBoundingClientRect().height,
      canVirtualize: article => {
        if (Number(article.dataset.chapter) === navigationTargetChapter) return false;
        const rect = article.getBoundingClientRect(), view = readerContext.viewport.getBoundingClientRect();
        const selection = window.getSelection();
        return (rect.bottom < view.top - 800 || rect.top > view.bottom + 800) &&
          !article.contains(document.activeElement) &&
          !article.querySelector("mark.full-search-highlight") &&
          !(selection && !selection.isCollapsed &&
            selection.containsNode(article, true));
      },
      virtualize: (article, index, height) => {
        loaded.delete(index);
        const marker = /** @type {HTMLButtonElement} */ (ensureSentinel(/** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (chapterAt(index))));
        const style = getComputedStyle(article);
        marker.classList.add("reader-chapter-placeholder");
        marker.style.height = `${height}px`;
        marker.style.marginTop = style.marginTop;
        marker.style.marginBottom = style.marginBottom;
        marker.setAttribute("aria-hidden", "true");
        /** @type {IntersectionObserver} */ (readerContext.chapterManifestObserver).unobserve(article);
        readerContext.foliateScrollAnchors.unobserve(article);
        for (const entry of readerContext.navigationState.tocEntries.filter(isChapterTocEntry))
          if (entry.chapterIndex === index) entry.target = null;
        for (const image of article.querySelectorAll("img")) image.removeAttribute("src");
        article.replaceWith(marker);
        article._chapterSearchHead = null;
      },
      release: index => {
        chapterBudget.release(retainedBytes.get(index));
        retainedBytes.delete(index);
      },
      preserve: change => readerContext.foliateScrollAnchors.preserve(change)
    });
    function trimChapterWindow() {
      if (chapterWindowReady && !chapterNavigating) chapterVirtualizer.trim(navigationTargetChapter || chapterFocusIndex);
    }
    function chapterPrefetchIndices() {
      if (document.hidden) return [];
      // A fixed opening prefix keeps extra front matter within the DOM retention target.
      const forwardCount = Math.max(chapterPrefetchCount, chapterPrefetchMaxCount + 1 - chapterFocusIndex);
      const nearby = manifest.chapters.slice(Math.max(0, chapterFocusIndex - 2),
        chapterFocusIndex + forwardCount);
      const indices = [];
      let bytes = 0;
      for (const chapter of nearby) {
        bytes += chapterPrefetchSize(chapter);
        if (chapter.index > chapterFocusIndex + chapterPrefetchCount && bytes > chapterPrefetchBytes) break;
        if (!loaded.has(chapter.index)) indices.push(chapter.index);
      }
      return indices;
    }
    function refreshChapterWindow() {
      chapterWindowFrame = 0;
      if (!chapterWindowReady || readerContext.readerAbortController.signal.aborted) return;
      const view = readerContext.viewport.getBoundingClientRect();
      const rows = [...frame.querySelectorAll(":scope > [data-chapter]")].map(row => /** @type {HTMLElement} */ (row));
      const current = rows.find(row => {
        const rect = row.getBoundingClientRect();
        return rect.top <= view.top + 80 && rect.bottom > view.top + 80;
      }) || rows.find(row => row.getBoundingClientRect().top > view.top);
      if (current && !chapterNavigating) chapterFocusIndex = Number(current.dataset.chapter);
      if (!chapterNavigating && current?.classList.contains("reader-chapter-sentinel") &&
          current.getBoundingClientRect().top < view.bottom)
        fetchChapter(/** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (chapterAt(chapterFocusIndex))).catch(() => {});
      if (!chapterNavigating) chapterScheduler.prefetch(chapterPrefetchIndices());
      readerContext.foliateScrollAnchors.whenIdle(trimChapterWindow);
    }
    function scheduleChapterWindow() {
      if (!chapterWindowFrame) chapterWindowFrame = requestAnimationFrame(refreshChapterWindow);
    }
    function handleChapterVisibility() {
      if (document.hidden) chapterScheduler.prefetch([]);
      else scheduleChapterWindow();
    }
    readerContext.chapterManifestObserver = new IntersectionObserver(
      scheduleChapterWindow,
      { root: readerContext.viewport, rootMargin: "800px 0px" }
    );
    chapterPreviousObserver = new IntersectionObserver((entries) => {
      if (!chapterWindowReady || chapterNavigating || readerContext.readerAbortController.signal.aborted) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const chapter = chapterAt(Number(/** @type {HTMLElement} */ (entry.target).dataset.chapter));
        if (chapter) fetchChapter(chapter).catch(() => {});
      }
    }, { root: readerContext.viewport });
    readerContext.viewport.addEventListener("scroll", scheduleChapterWindow, { passive: true });
    window.addEventListener("resize", scheduleChapterWindow);
    document.addEventListener("visibilitychange", handleChapterVisibility);
    let chapterCleaned = false;
    readerContext.chapterManifestCleanup = () => {
      if (chapterCleaned) return;
      chapterCleaned = true;
      navigationProtectionCleanup?.();
      chapterWindowReady = false;
      cancelAnimationFrame(chapterWindowFrame);
      readerContext.viewport.removeEventListener("scroll", scheduleChapterWindow);
      window.removeEventListener("resize", scheduleChapterWindow);
      document.removeEventListener("visibilitychange", handleChapterVisibility);
      chapterScheduler.dispose();
      chapterVirtualizer.dispose();
      readerContext.chapterManifestObserver?.disconnect();
      chapterPreviousObserver?.disconnect();
      readerContext.chapterManifestObserver = null;
      readerContext.chapterManifestLoader = null;
      for (const bytes of retainedBytes.values()) chapterBudget.release(bytes);
      retainedBytes.clear();
      loaded.clear();
    };
    readerContext.trackReaderResource(readerContext.chapterManifestCleanup);
    const chapterManifestLoader = async (/** @type {number} */ index) => {
      const chapter = chapterAt(index);
      if (!chapter) return null;
      chapterFocusIndex = index;
      chapterNavigating++;
      try { await fetchChapter(chapter, true, chapterWindowReady); }
      finally { chapterNavigating--; }
      return frame.querySelector(`.reader-epub-chapter[data-chapter="${index}"]`);
    };
    chapterManifestLoader.count = manifest.chapters.length;
    readerContext.chapterManifestLoader = chapterManifestLoader;
    setChapterToc();
    await readerContext.getInitialReaderRestoration();
    const savedChapter = Number(readerContext.readerRestorationEntry?.chapterIndex) - 1;
    const initialChapter = Number.isInteger(savedChapter)
      ? Math.max(0, Math.min(manifest.chapters.length - 1, savedChapter))
      : 0;
    const initial = /** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (manifest.chapters[initialChapter]);
    chapterFocusIndex = initial.index;
    if (initialChapter > 0) ensureSentinel(/** @type {import("../../../typings/reader-chapter-format-strict").Chapter} */ (manifest.chapters[initialChapter - 1]), true);
    try {
      const firstChapter = fetchChapter(initial);
      chapterScheduler.prefetch(chapterPrefetchIndices());
      await firstChapter;
    } catch (error) {
      if (readerContext.readerRestorationEntry?.chapterIndex == null) throw error;
      throw Object.assign(new Error("阅读位置恢复失败，原进度已保留，请重试加载。", { cause: error }), {
        code: "READER_RESTORE"
      });
    }
    chapterWindowReady = true;
    if (readerContext.isReaderGenerationCurrent("navigation", openingGeneration)) readerContext.foliateScrollAnchors.invalidate();
    for (const article of frame.querySelectorAll(".reader-epub-chapter")) readerContext.foliateScrollAnchors.observe(article);
      frame.style.overflowAnchor = "none";
    scheduleChapterWindow();
    readerContext.assertReaderActive();
    readerContext.markReaderContentReady();
    readerContext.status.textContent = `EPUB · ${manifest.chapters.length} 章`;
  }

  function captureChapterPosition() {
    if (readerContext.capability.mode !== "epub-chapters") return null;
    const marker = readerContext.viewport.getBoundingClientRect().top + 8;
    const chapters = [...readerContext.content.querySelectorAll(".reader-epub-chapter")];
    const chapter =
      chapters.find((node) => node.getBoundingClientRect().bottom > marker) ||
      chapters[chapters.length - 1];
    return chapter
      ? {
          chapterIndex: Number(/** @type {HTMLElement} */ (chapter).dataset.chapter),
          chapterManifest: readerContext.chapterManifestUrl || readerContext.sourceUrl,
          chapterOffset: marker - chapter.getBoundingClientRect().top
        }
      : null;
  }

  /** @param {import("../../../typings/reader-chapter-format-strict").ChapterPosition} entry @param {number} generation */
  async function restoreChapterPosition(entry, generation) {
    if (
      /-epub-chapters-v5\//.test(readerContext.chapterManifestUrl || readerContext.sourceUrl) &&
      entry.chapterManifest !== (readerContext.chapterManifestUrl || readerContext.sourceUrl)
    ) return false;
    if (!readerContext.chapterManifestLoader || !Number.isInteger(entry.chapterIndex)) return false;
    const chapter = await readerContext.chapterManifestLoader(entry.chapterIndex);
    if (!chapter?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    readerContext.viewport.scrollTop +=
      chapter.getBoundingClientRect().top -
      readerContext.viewport.getBoundingClientRect().top -
      8 +
      (Number(entry.chapterOffset) || 0);
    readerContext.foliateScrollAnchors.remember();
    readerContext.syncHeadingLocation();
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
    return true;
  }

  return {
    renderChapterManifest,
    captureChapterPosition,
    restoreChapterPosition
  };
}
