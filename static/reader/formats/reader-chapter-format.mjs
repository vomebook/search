// The current MOBI chapter manifest for this five-volume edition contains
// cross-volume sidebar targets that point back into volume 1. Its own verified
// "总目录" links and each volume's adjacent "书名页" independently identify
// these destinations. Never apply this correction to another manifest version.
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

export function applyReviewedTocCorrections(manifest, bytes, manifestUrl) {
  const url = new URL(manifestUrl, location.href);
  const path = url.searchParams.get("path") || decodeURIComponent(url.pathname);
  if (!path.endsWith(REVIEWED_MOBI_SOURCE) || !globalThis.crypto?.subtle || !Array.isArray(manifest.toc)) return manifest;
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
    const hex = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
    const corrections = REVIEWED_TOC_CORRECTIONS.get(hex);
    if (!corrections) return manifest;
    for (const [index, title, chapter, fragment, target, , titleIndex] of corrections) {
      const entry = manifest.toc[index], titlePage = manifest.toc[titleIndex];
      if (!entry || entry.title !== title || entry.chapter !== chapter || entry.fragment !== fragment ||
          !titlePage || titlePage.title !== "书名页" || titlePage.chapter !== target ||
          !manifest.chapters[target - 1]) return manifest;
    }
    const toc = manifest.toc.map(entry => ({ ...entry }));
    for (const [index, , , , chapter, fragment] of corrections) Object.assign(toc[index], { chapter, fragment });
    return { ...manifest, toc };
  }).catch(() => manifest);
}

export function createReaderChapterFormat(readerContext) {
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
    let navigationTargetChapter = 0, navigationProtectionCleanup = null;
    let chapterNavigating = 0;
    let chapterPreviousObserver = null;
    const chapterBudget = VoiceOfMLReaderSecurity.createByteBudget();
    if (!manifestBase) throw new Error("EPUB_INVALID_MANIFEST_PATH");
    const searchIndex = manifest.search_index;
    readerContext.chapterSearchConfiguration =
      searchIndex?.path === "epub-search-index.json.gz" &&
      Number.isSafeInteger(searchIndex.bytes) &&
      searchIndex.bytes > 0 &&
      /^[0-9a-f]{64}$/.test(searchIndex.sha256 || "")
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
    const chapterUrl = (chapter) => readerContext.trustedChapterUrl(chapter.path, manifestBase);
    const chapterAt = (index) => chapterByIndex.get(index) || null;
    const nextChapterNode = (index, selector) => {
      for (const node of frame.querySelectorAll(selector))
        if (Number(node.dataset.chapter) > index) return node;
      return null;
    };
    const resourceUrl = (raw, base, attribute) => {
      const value = String(raw || "").trim();
      if (!value || value.startsWith("#")) return null;
      return readerContext.trustedChapterResourceUrl(value, base, attribute, manifestBase);
    };
    const insertChapter = (article) => {
      const existing = frame.querySelector(
        `.reader-epub-chapter[data-chapter="${article.dataset.chapter}"]`
      );
      if (existing) return existing;
      const next = nextChapterNode(Number(article.dataset.chapter), ".reader-epub-chapter, .reader-chapter-sentinel");
      const marker = frame.querySelector(`.reader-chapter-sentinel[data-chapter="${article.dataset.chapter}"]`);
      const insert = () => {
        if (marker) {
          readerContext.chapterManifestObserver.unobserve(marker);
          chapterPreviousObserver.unobserve(marker);
          marker.replaceWith(article);
        } else frame.insertBefore(article, next || null);
      };
      const preservePosition = chapterWindowReady || !readerContext.isReaderGenerationCurrent("navigation", openingGeneration);
      if (preservePosition) readerContext.foliateScrollAnchors.preserve(insert);
      else insert();
      readerContext.chapterManifestObserver.observe(article);
      if (preservePosition) readerContext.foliateScrollAnchors.observe(article);
      return article;
    };
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
      (previous ? chapterPreviousObserver : readerContext.chapterManifestObserver).observe(marker);
      return marker;
    };
    const chapterTarget = (article, fragment) =>
      !fragment || article.id === fragment ? article :
        article.querySelector(`[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`);
    const normalizeTocLabel = value => String(value || "").replace(/\s+/gu, "").toLowerCase();
    // Old merged CHM bundles can lose the TOC fragment while retaining the
    // original, functioning book-internal link. Accept only a unique exact
    // label that points to an existing generated page in the same chapter.
    const repairMergedChmToc = (article, chapter) => {
      const missing = readerContext.navigationState.tocEntries.filter(entry =>
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
        const fragment = link.getAttribute("href").slice(1);
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
      chapter.source_path === "chm-fallback.html");
    const setChapterToc = () => {
      const entries = (manifest.toc ?? manifest.chapters.map((item) => ({
          title: item.title || `章节 ${item.index}`, chapter: item.index, depth: 0, fragment: ""
        }))).map((item) => ({
          label: item.title,
          chapterIndex: item.chapter,
          fragment: item.fragment,
          depth: item.depth,
          activate: (generation) => activateChapter(manifest.chapters[item.chapter - 1], generation, item.fragment)
        }));
      readerContext.setToc(entries);
      for (const entry of readerContext.navigationState.tocEntries)
        entry.activate = generation => activateChapter(chapterAt(entry.chapterIndex), generation, entry);
    };
    const chapterScheduler = VoiceOfMLReaderChapters.createChapterScheduler({
      create: async (index, signal, priority) => {
        const chapter = chapterAt(index);
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
          for (const element of doc.querySelectorAll("*")) {
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
          }
          const article = document.createElement("article");
          article.className = "reader-markdown reader-epub-chapter";
          article.dataset.chapter = String(chapter.index);
          if (doc.body?.id) article.id = doc.body.id;
          article.innerHTML = doc.body ? doc.body.innerHTML : "";
          for (const image of article.querySelectorAll("img")) {
            image.loading = priority === "high" ? "eager" : "lazy";
            image.fetchPriority = priority;
            image.decoding = "async";
          }
          // The generated text index includes head text (e.g. the chapter title).
          article._chapterSearchHead = doc.head ? document.importNode(doc.head, true) : null;
          insertChapter(article);
          loaded.add(chapter.index);
          retainedBytes.set(chapter.index, bytes.byteLength);
          inserted = true;
          if (mergedChmToc) repairMergedChmToc(article, chapter);
          for (const entry of readerContext.navigationState.tocEntries)
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
        const anchor = chapterTarget(node, id);
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
      const link = event.target.closest?.("a[href]");
      const article = link?.closest(".reader-epub-chapter");
      if (
        !article ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const current = chapterAt(Number(article.dataset.chapter));
      const destination = readerContext.trustedChapterReferenceUrl(link.getAttribute("href"), chapterUrl(current), manifestBase);
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
      getLoaded: () => [...frame.querySelectorAll(":scope > .reader-epub-chapter")],
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
        const marker = ensureSentinel(chapterAt(index));
        const style = getComputedStyle(article);
        marker.classList.add("reader-chapter-placeholder");
        marker.style.height = `${height}px`;
        marker.style.marginTop = style.marginTop;
        marker.style.marginBottom = style.marginBottom;
        marker.setAttribute("aria-hidden", "true");
        readerContext.chapterManifestObserver.unobserve(article);
        readerContext.foliateScrollAnchors.unobserve(article);
        for (const entry of readerContext.navigationState.tocEntries)
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
        bytes += chapter.bytes;
        if (chapter.index > chapterFocusIndex + chapterPrefetchCount && bytes > chapterPrefetchBytes) break;
        if (!loaded.has(chapter.index)) indices.push(chapter.index);
      }
      return indices;
    }
    function refreshChapterWindow() {
      chapterWindowFrame = 0;
      if (!chapterWindowReady || readerContext.readerAbortController.signal.aborted) return;
      const view = readerContext.viewport.getBoundingClientRect();
      const rows = [...frame.querySelectorAll(":scope > [data-chapter]")];
      const current = rows.find(row => {
        const rect = row.getBoundingClientRect();
        return rect.top <= view.top + 80 && rect.bottom > view.top + 80;
      }) || rows.find(row => row.getBoundingClientRect().top > view.top);
      if (current && !chapterNavigating) chapterFocusIndex = Number(current.dataset.chapter);
      if (!chapterNavigating && current?.classList.contains("reader-chapter-sentinel") &&
          current.getBoundingClientRect().top < view.bottom)
        fetchChapter(chapterAt(chapterFocusIndex)).catch(() => {});
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
        const chapter = chapterAt(Number(entry.target.dataset.chapter));
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
    readerContext.chapterManifestLoader = async (index) => {
      const chapter = chapterAt(index);
      if (!chapter) return null;
      chapterFocusIndex = index;
      chapterNavigating++;
      try { await fetchChapter(chapter, true, chapterWindowReady); }
      finally { chapterNavigating--; }
      return frame.querySelector(`.reader-epub-chapter[data-chapter="${index}"]`);
    };
    readerContext.chapterManifestLoader.count = manifest.chapters.length;
    setChapterToc();
    await readerContext.getInitialReaderRestoration();
    const savedChapter = Number(readerContext.readerRestorationEntry?.chapterIndex) - 1;
    const initialChapter = Number.isInteger(savedChapter)
      ? Math.max(0, Math.min(manifest.chapters.length - 1, savedChapter))
      : 0;
    chapterFocusIndex = manifest.chapters[initialChapter].index;
    if (initialChapter > 0) ensureSentinel(manifest.chapters[initialChapter - 1], true);
    try {
      const firstChapter = fetchChapter(manifest.chapters[initialChapter]);
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
          chapterIndex: Number(chapter.dataset.chapter),
          chapterManifest: readerContext.chapterManifestUrl || readerContext.sourceUrl,
          chapterOffset: marker - chapter.getBoundingClientRect().top
        }
      : null;
  }

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
