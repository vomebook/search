export function createReaderProgress(readerContext) {
  function scheduleSave() {
    if (readerContext.readerLifecycle.disposed || readerContext.readerAbortController.signal.aborted) return;
    const now = performance.now();
    if (!readerContext.saveDeadline) readerContext.saveDeadline = now + 2000;
    readerContext.readerRuntime.cancel(readerContext.saveTimer);
    readerContext.saveTimer = readerContext.readerRuntime.schedule(
      () => {
        readerContext.saveTimer = 0;
        readerContext.saveDeadline = 0;
        readerContext.saveProgress();
      },
      Math.max(0, Math.min(500, readerContext.saveDeadline - now))
    );
  }

  function captureProgressEntry(event) {
    if (
      readerContext.readerLifecycle.disposed ||
      !readerContext.documentState.restorationReady ||
      !readerContext.validSource(readerContext.sourceUrl) ||
      readerContext.historySuppressed ||
      readerContext.pdfDocument?._pdfInfo?.readerPageCountPending ||
      readerContext.mediaElement?._readerSourceRetry
    )
      return;
    if (event?.type !== "pagehide" && document.visibilityState !== "hidden")
      readerContext.syncCurrentPageFromMarker();
    const shell = readerContext.documentState.pageCount
      ? readerContext.content.querySelector(
          `.reader-page[data-page="${readerContext.documentState.page}"]`
        )
      : null;
    const pageOffset = shell ? Math.max(0, readerContext.viewport.scrollTop - readerContext.readerPageScrollTop(shell)) : 0;
    const htmlScrollTop = readerContext.htmlFrame && readerContext.htmlFrame.contentWindow ? readerContext.htmlFrame.contentWindow.scrollY : 0;
    const readerUrl = readerContext.currentReaderUrl();
    const foliatePosition = readerContext.captureFoliateBookmarkPosition() || readerContext.captureChapterPosition();
    return {
      url: VoiceOfMLReaderStore.localBookRecordKey?.(readerContext.readerId, readerContext.sourceUrl) || readerContext.sourceUrl,
      title: readerContext.documentState.title,
      extension: readerContext.extension,
      readerUrl: readerUrl.href,
      page: readerContext.documentState.page,
      pageCount: readerContext.documentState.pageCount,
      pageOffset,
      mediaTime:
        readerContext.mediaElement && Number.isFinite(readerContext.mediaElement.currentTime) ? readerContext.mediaElement.currentTime : 0,
      scrollTop: readerContext.viewport.scrollTop,
      htmlScrollTop,
      zoom: Math.round(readerContext.documentState.zoom * 100),
      ...(foliatePosition || {})
    };
  }

  function progressNotSaved(error) {
    if (error?.name === "ReaderHistoryFullError")
      readerContext.showDownloadFeedback("阅读历史已满，当前进度未保存。请删除不需要的阅读记录后重试。", 0);
    console.warn("Reader progress was not saved", error);
  }

  async function saveProgress(event) {
    const progress = captureProgressEntry(event);
    if (!progress) return;
    const capturedAt = Date.now();
    const signature = JSON.stringify(progress);
    if (signature === readerContext.lastSavedProgress) return readerContext.progressSaveChain;
    readerContext.lastSavedProgress = signature;
    readerContext.progressSaveChain = readerContext.progressSaveChain
      .catch(() => {})
      .then(() => {
        if (!readerContext.historySuppressed)
          return VoiceOfMLReaderStore.put({ ...progress, lastReadAt: capturedAt });
      })
      .catch((error) => {
        if (readerContext.lastSavedProgress === signature) readerContext.lastSavedProgress = "";
        progressNotSaved(error);
      });
    return readerContext.progressSaveChain;
  }

  function placeReadingProgress() {
    const panel = document.querySelector("#history-panel"),
      tocPanel = document.querySelector("#toc-panel"),
      tocList = tocPanel.querySelector(".panel-list"),
      noToc = readerContext.loadingStatus.hidden && !readerContext.navigationState.tocEntries.length && !readerContext.mediaElement;
    readerContext.progressTools.classList.toggle("reader-no-toc", noToc);
    tocPanel.querySelector(".panel-view-header strong").textContent = noToc ? "阅读状态" : "目录";
    if (
      noToc &&
      (readerContext.progressTools.parentElement !== tocPanel || readerContext.progressTools.nextElementSibling !== tocList)
    )
      tocPanel.insertBefore(readerContext.progressTools, tocList);
    else if (!noToc && panel.lastElementChild !== readerContext.progressTools) panel.appendChild(readerContext.progressTools);
  }

  function currentReaderUrl() {
    const url = new URL(location.href);
    for (const key of ["return", "nav", "bookmark", "bookmark_source"]) url.searchParams.delete(key);
    return url;
  }

  async function loadReaderRestoration() {
    const recordKey = VoiceOfMLReaderStore.localBookRecordKey?.(readerContext.readerId, readerContext.sourceUrl) || readerContext.sourceUrl;
    const currentEntry = (entry) => {
      if (entry && VoiceOfMLReaderStore.localLegacyChapterUrl?.(readerContext.chapterManifestUrl || readerContext.sourceUrl) &&
          readerContext.normalizeSourceUrl(entry.chapterManifest || "") !==
            readerContext.normalizeSourceUrl(readerContext.chapterManifestUrl || readerContext.sourceUrl)) return null;
      if (
        readerContext.capability.mode === "epub-chapters" &&
        /-epub-chapters-v5\//.test(readerContext.chapterManifestUrl || readerContext.sourceUrl) &&
        entry?.chapterManifest !== (readerContext.chapterManifestUrl || readerContext.sourceUrl)
      ) return null;
      return entry;
    };
    try {
      const bookmarkId = readerContext.params.get("bookmark"),
        bookmarkSource = readerContext.params.get("bookmark_source");
      // Loopback-only warning prototype. Existing pixel offsets are never
      // interpreted against split chapters, and old records remain untouched.
      const legacySource = VoiceOfMLReaderStore.localLegacyChapterUrl?.(
        readerContext.chapterManifestUrl || readerContext.sourceUrl) || "";
      if (legacySource) {
        if (recordKey !== readerContext.sourceUrl) {
          // New-client local experiment: do not guess ownership of the shared
          // manifest key. New per-book records are stored separately.
          const entries = await VoiceOfMLReaderStore.listBookmarks(recordKey);
          const bookmark = entries.find(entry => entry.id === bookmarkId && entry.url === bookmarkSource);
          if (bookmark) {
            const compatible = currentEntry(bookmark);
            if (compatible) return compatible;
            readerContext.consumeBookmarkHandoff(bookmark);
            readerContext.showDownloadFeedback("旧书签位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
            return null;
          }
          if (bookmarkId && bookmarkSource && bookmarkSource !== recordKey) {
            const legacyEntries = VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(bookmarkSource)
              ? (await VoiceOfMLReaderStore.localLegacyRecords(bookmarkSource)).bookmarks
              : bookmarkSource === readerContext.sourceUrl ||
                VoiceOfMLReaderStore.isLocalSharedSplitRecord?.({url: bookmarkSource})
                ? await VoiceOfMLReaderStore.listBookmarks(bookmarkSource) : [];
            const legacyBookmark = legacyEntries.find(entry => entry.id === bookmarkId && entry.url === bookmarkSource);
            if (legacyBookmark) readerContext.consumeBookmarkHandoff(legacyBookmark);
            readerContext.showDownloadFeedback("旧书签来源或位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
            return null;
          }
          const legacy = await VoiceOfMLReaderStore.localLegacyRecords(legacySource);
          if (legacy.history.length || VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(readerContext.sourceUrl) &&
              await VoiceOfMLReaderStore.get(readerContext.sourceUrl))
            readerContext.showDownloadFeedback("旧阅读位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
          const saved = await VoiceOfMLReaderStore.get(recordKey);
          const compatible = currentEntry(saved);
          if (saved && !compatible) {
            readerContext.historySuppressed = true;
            readerContext.showDownloadFeedback("旧阅读位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
          }
          return compatible;
        }
        // Same source + a different or unknown chapter/foliate locator has no
        // proven conversion. Preserve the record instead of guessing whether
        // it belongs to this book or saving new pixels into that key.
        const sameSourceHistory = await VoiceOfMLReaderStore.get(readerContext.sourceUrl);
        const sameSourceBookmarks = await VoiceOfMLReaderStore.listBookmarks(readerContext.sourceUrl);
        const currentManifest = readerContext.normalizeSourceUrl(readerContext.chapterManifestUrl || readerContext.sourceUrl);
        const incompatible = entry => entry && readerContext.normalizeSourceUrl(entry.chapterManifest || "") !== currentManifest;
        if (incompatible(sameSourceHistory)) readerContext.historySuppressed = true;
        const selectedIncompatible = sameSourceBookmarks.find(entry => entry.id === bookmarkId && incompatible(entry));
        if (selectedIncompatible && bookmarkSource === readerContext.sourceUrl) {
          readerContext.consumeBookmarkHandoff(selectedIncompatible);
          readerContext.showDownloadFeedback("旧书签位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
          return null;
        }
        const legacy = await VoiceOfMLReaderStore.localLegacyRecords(legacySource);
        if (legacy.history.some(entry => entry.url === readerContext.sourceUrl)) readerContext.historySuppressed = true;
        const bookmark = legacy.bookmarks.find(entry => entry.id === bookmarkId && entry.url === bookmarkSource);
        if (bookmarkId && (bookmark || VoiceOfMLReaderStore.localSameLegacyChapter?.(bookmarkSource, legacySource))) {
          if (bookmark) readerContext.consumeBookmarkHandoff(bookmark);
          readerContext.showDownloadFeedback("旧书签位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
          return null;
        }
        // An old history row must not hide a separately selected bookmark
        // whose exact chapter identity is current. Keep history suppressed;
        // normal restoration consumes only the selected bookmark handoff.
        const selectedCurrent = sameSourceBookmarks.find(entry => entry.id === bookmarkId &&
          entry.url === bookmarkSource && !incompatible(entry));
        if (selectedCurrent) return currentEntry(selectedCurrent);
        if (incompatible(sameSourceHistory) || legacy.history.length)
          readerContext.showDownloadFeedback("旧阅读位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
        if (incompatible(sameSourceHistory)) return null;
      }
      if (VoiceOfMLReaderStore.isLocalLegacyChapterUrl?.(readerContext.sourceUrl) &&
          VoiceOfMLReaderStore.localSameLegacyChapter?.(
            readerContext.sourceUrl,
            VoiceOfMLReaderStore.localLegacyChapterUrl?.(readerContext.chapterManifestUrl) || "")) {
        // Do not restore or save under an old key when a different split
        // manifest is explicitly supplied. A mismatch must not rewrite it.
        readerContext.historySuppressed = true;
        readerContext.showDownloadFeedback("旧阅读位置无法准确转换；旧记录仍保留，请使用目录或搜索定位。", 0);
        return null;
      }
      if (bookmarkId && bookmarkSource === readerContext.sourceUrl) {
        const entries = await VoiceOfMLReaderStore.listBookmarks(readerContext.sourceUrl);
        const bookmark = entries.find((entry) => entry.id === bookmarkId && entry.url === readerContext.sourceUrl);
        if (bookmark) return currentEntry(bookmark);
      }
      return currentEntry(await VoiceOfMLReaderStore.get(readerContext.sourceUrl));
    } catch (_) {
      readerContext.restorationFailed = true;
      return null;
    }
  }

  async function getInitialReaderRestoration() {
    if (!readerContext.readerRestorationPromise) return null;
    if (!readerContext.readerRestorationLoaded) {
      readerContext.readerRestorationEntry = await readerContext.awaitReader(Promise.race([
        readerContext.readerRestorationPromise,
        readerContext.waitForReader(150).then(() => null)
      ]));
      readerContext.readerRestorationLoaded = true;
    }
    return readerContext.readerRestorationEntry;
  }

  function initialReaderPage(total) {
    const page = Number(readerContext.readerRestorationEntry?.page);
    return Number.isInteger(page) ? Math.max(1, Math.min(total, page)) : 1;
  }

  function readerProgressPercent() {
    if (readerContext.mediaElement)
      return readerContext.mediaElement.duration
        ? Math.round((readerContext.mediaElement.currentTime / readerContext.mediaElement.duration) * 1000) / 10
        : 0;
    if (readerContext.foliateContinuous) {
      const position = readerContext.captureFoliateBookmarkPosition(),
        count = readerContext.epubBook?.sections?.filter((section) => section.linear !== "no").length || 0,
        article =
          position &&
          document.querySelector(
            `.foliate-continuous article[data-section="${position.foliateSection}"]`
          ),
        fraction = article
          ? Math.max(
              0,
              Math.min(
                1,
                position.foliateOffset / Math.max(1, article.getBoundingClientRect().height)
              )
            )
          : 0;
      return count && position
        ? Math.round(((position.foliateSection + fraction) / count) * 1000) / 10
        : 0;
    }
    if (readerContext.htmlFrame && readerContext.htmlFrame.contentDocument) {
      const doc = readerContext.htmlFrame.contentDocument.documentElement,
        win = readerContext.htmlFrame.contentWindow;
      return (
        Math.round(
          Math.max(0, Math.min(1, win.scrollY / Math.max(1, doc.scrollHeight - win.innerHeight))) *
            1000
        ) / 10
      );
    }
    return (
      Math.round(
        Math.max(
          0,
          Math.min(1, readerContext.viewport.scrollTop / Math.max(1, readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight))
        ) * 1000
      ) / 10
    );
  }

  function pageAtMarker() {
    const y = readerContext.bookmarkRibbon.getBoundingClientRect().bottom,
      pages = [...readerContext.content.querySelectorAll(".reader-page")];
    if (!pages.length) return null;
    const end = readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight;
    if (["pdf", "pdf-pages"].includes(readerContext.capability.mode) && end > 2 && readerContext.viewport.scrollTop > 0 &&
        end - readerContext.viewport.scrollTop <= 2) {
      const last = pages[pages.length - 1], rect = last.getBoundingClientRect(), view = readerContext.viewport.getBoundingClientRect();
      if (rect.bottom > view.top && rect.top < view.bottom) return last;
    }
    let low = 0, high = pages.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pages[middle].getBoundingClientRect().bottom > y) high = middle;
      else low = middle + 1;
    }
    return pages[Math.min(low, pages.length - 1)];
  }

  function syncCurrentPageFromMarker() {
    if (performance.now() < readerContext.pageNavigationLockUntil) return;
    const page = readerContext.pageAtMarker();
    if (!page) return;
    const next = Number(page.dataset.page);
    if (!next || next === readerContext.documentState.page) return;
    readerContext.updateDocumentState({ page: next });
    if (document.activeElement !== readerContext.pageInput) readerContext.pageInput.value = String(next);
    readerContext.updateTocCurrentMark();
    readerContext.updateProgressTools();
  }

  function scheduleMarkerSync() {
    if (readerContext.markerFrame) return;
    readerContext.markerFrame = requestAnimationFrame(() => {
      readerContext.markerFrame = 0;
      if (readerContext.readerAbortController.signal.aborted) return;
      readerContext.syncCurrentPageFromMarker();
      readerContext.refreshNearbyPdfPages();
      readerContext.syncHeadingLocation();
      readerContext.updateProgressTools();
      readerContext.scheduleSave();
    });
  }

  async function restoreFormat(mode, entry, generation = readerContext.beginReaderNavigation()) {
    try {
      if (!entry || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      let consumeHandoff = true;
      if (mode === "epub-chapters") {
        const localLegacy = VoiceOfMLReaderStore.localLegacyChapterUrl?.(
          readerContext.chapterManifestUrl || readerContext.sourceUrl);
        if (localLegacy && (!Number.isInteger(entry.chapterIndex) || entry.chapterIndex < 1 ||
            entry.chapterIndex > readerContext.chapterManifestLoader?.count)) {
          // An incomplete chapter locator is not a trustworthy global scrollTop.
          readerContext.historySuppressed = true;
          readerContext.showDownloadFeedback(
            "阅读位置无法在当前版式准确定位；原记录仍保留。本页暂不自动保存进度，可调整缩放或使用目录、搜索定位。", 0);
          return true;
        }
        if (Number.isInteger(entry.chapterIndex)) {
          const result = await readerContext.restoreChapterPosition(entry, generation);
          // Keep a selected bookmark URL intact if this local experiment could
          // not locate its pixels. The book remains open with saving disabled.
          if (result === "local-chm-position-unavailable") consumeHandoff = false;
          if (!result) return false;
        } else if (!(await readerContext.restoreProgressState(entry, generation))) return false;
      } else if (mode === "foliate" && Number.isInteger(entry.foliateSection)) {
        if (!(await readerContext.restoreFoliateBookmarkPosition(entry, generation))) return false;
      } else if (readerContext.documentState.pageCount && entry.page) {
        if (
          !(await readerContext.goToPage(entry.page, generation)) ||
          !readerContext.isReaderGenerationCurrent("navigation", generation)
        )
          return false;
        const shell = readerContext.content.querySelector(
          `.reader-page[data-page="${readerContext.documentState.page}"]`
        );
        if (shell && Number.isFinite(entry.pageOffset))
          readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(shell) + entry.pageOffset;
        readerContext.updateProgressTools();
        readerContext.scheduleSave();
      } else if (!(await readerContext.restoreProgressState(entry, generation))) return false;
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      if (consumeHandoff) readerContext.consumeBookmarkHandoff(entry);
      return true;
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
      return false;
    }
  }

  async function restoreInitialPosition(entry, generation) {
    if (!entry || !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
    const restored = await readerContext.formatAdapters.active.restore(entry, generation);
    if (!restored && readerContext.isReaderGenerationCurrent("navigation", generation))
      throw Object.assign(new Error("阅读位置恢复失败，原进度已保留，请重试加载。"), {
        code: "READER_RESTORE"
      });
  }

  async function applyInitialRestoration(entry, generation) {
    readerContext.updateDocumentState({ restoredEntry: entry });
    // Startup already applied the current zoom. Reapplying an identical saved
    // value needlessly invalidates PDF canvases and lays out every format again.
    if (entry?.zoom && !readerContext.zoomChangedByUser && readerContext.isReaderGenerationCurrent("navigation", generation) &&
        VoiceOfMLReader.clampNumber(entry.zoom, 25, 400, 100) / 100 !== readerContext.documentState.zoom)
      readerContext.setZoom(entry.zoom, false);
    await readerContext.restoreInitialPosition(entry, generation);
  }

  function updateReadingProgressSummary() {
    const noToc = !readerContext.navigationState.tocEntries.length && !readerContext.mediaElement;
    readerContext.readingProgressSummary.hidden = !noToc;
    if (noToc)
      readerContext.readingProgressSummary.querySelector(".reader-progress-summary-value").textContent =
        `${readerContext.readerProgressPercent().toFixed(1)}%`;
  }

  function updateProgressTools() {
    if (readerContext.progressSeeking) return;
    const percent = readerContext.readerProgressPercent();
    readerContext.progressRange.value = String(percent);
    readerContext.progressPercent.textContent = `${percent.toFixed(1)}%`;
    if (readerContext.progressRange.getAttribute("aria-valuetext") !== readerContext.progressPercent.textContent)
      readerContext.progressRange.setAttribute("aria-valuetext", readerContext.progressPercent.textContent);
    const hasChapters = readerContext.navigationState.tocEntries.some((entry) => !entry.group),
      hasPreviousChapter = readerContext.adjacentTocIndex(-1) >= 0,
      hasNextChapter = readerContext.adjacentTocIndex(1) >= 0;
    readerContext.chapterPrev.hidden = !hasChapters;
    readerContext.chapterNext.hidden = !hasChapters;
    readerContext.chapterPrev.disabled = !hasPreviousChapter;
    readerContext.chapterNext.disabled = !hasNextChapter;
    readerContext.progressUndo.hidden = !readerContext.previousProgressState;
    readerContext.updateReadingProgressSummary();
    readerContext.placeReadingProgress();
  }

  function captureProgressState() {
    return readerContext.foliateContinuous
      ? readerContext.captureFoliateBookmarkPosition()
      : readerContext.capability.mode === "epub-chapters"
        ? readerContext.captureChapterPosition()
        : readerContext.mediaElement
          ? { mediaTime: readerContext.mediaElement.currentTime }
          : readerContext.htmlFrame && readerContext.htmlFrame.contentWindow
            ? { htmlScrollTop: readerContext.htmlFrame.contentWindow.scrollY }
            : { scrollTop: readerContext.viewport.scrollTop };
  }

  async function restoreProgressState(state, generation = readerContext.beginReaderNavigation()) {
    if (!state || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    if (readerContext.foliateContinuous && Number.isInteger(state.foliateSection))
      return readerContext.restoreFoliateBookmarkPosition(state, generation);
    if (readerContext.capability.mode === "epub-chapters" && Number.isInteger(state.chapterIndex))
      return readerContext.restoreChapterPosition(state, generation);
    try {
      if (readerContext.mediaElement && Number.isFinite(state.mediaTime)) {
        const media = readerContext.mediaElement;
        if (!media.readyState)
          await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const finish = (error) => {
              media.removeEventListener("loadedmetadata", loaded);
              media.removeEventListener("error", failed);
              untrack();
              if (error) reject(error);
              else resolve();
            };
            const loaded = () => finish(),
              failed = () => {
                if (!media._readerSourceRetry) finish(new Error("Media metadata unavailable"));
              };
            const untrack = readerContext.trackReaderResource(() => finish(readerContext.readerAbortError()));
            media.addEventListener("loadedmetadata", loaded, { once: true });
            media.addEventListener("error", failed);
          }));
        if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
        media.currentTime = state.mediaTime;
      } else if (readerContext.htmlFrame && readerContext.htmlFrame.contentWindow && Number.isFinite(state.htmlScrollTop))
        readerContext.htmlFrame.contentWindow.scrollTo(0, state.htmlScrollTop);
      else if (Number.isFinite(state.scrollTop)) {
        if (readerContext.capability.mode === "text") {
          let measured = 0, batch = 0, started = performance.now();
          for (const block of readerContext.content.querySelectorAll(".reader-text-block")) {
            if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
            block.style.contentVisibility = "visible";
            const height = block.getBoundingClientRect().height;
            block.style.containIntrinsicBlockSize = `auto ${height}px`;
            block.style.contentVisibility = "auto";
            measured += height;
            if (measured > state.scrollTop + readerContext.viewport.clientHeight) break;
            if (++batch >= 8 || performance.now() - started >= 8) {
              await readerContext.waitForReader();
              batch = 0;
              started = performance.now();
            }
          }
        }
        if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
        readerContext.viewport.scrollTop = state.scrollTop;
      }
      readerContext.updateProgressTools();
      readerContext.scheduleSave();
      return true;
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
      return false;
    }
  }

  function flushEpubSeek() {
    if (readerContext.epubSeekFrame) {
      cancelAnimationFrame(readerContext.epubSeekFrame);
      readerContext.epubSeekFrame = 0;
      readerContext.epubSeekPromise = readerContext.seekFoliateProgress(readerContext.epubSeekTarget.percent, readerContext.epubSeekTarget.generation);
    }
    return readerContext.epubSeekPromise;
  }

  function seekProgress(value, preserve = false) {
    if (!preserve || !readerContext.previousProgressState) readerContext.previousProgressState = readerContext.captureProgressState();
    const generation = readerContext.beginReaderNavigation(),
      percent = Math.max(0, Math.min(100, Number(value)));
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return;
    if (readerContext.mediaElement && readerContext.mediaElement.duration)
      readerContext.mediaElement.currentTime = (readerContext.mediaElement.duration * percent) / 100;
    else if (readerContext.foliateContinuous) {
      readerContext.epubSeekTarget = { percent, generation };
      readerContext.epubSeekFrame = requestAnimationFrame(() => {
        readerContext.epubSeekFrame = 0;
        readerContext.epubSeekPromise = readerContext.seekFoliateProgress(percent, generation);
      });
    } else if (readerContext.capability.mode === "epub-chapters" && readerContext.chapterManifestLoader?.count) {
      const position = Math.min(0.999999, percent / 100) * readerContext.chapterManifestLoader.count;
      readerContext.epubSeekPromise = (async () => {
        const index = Math.floor(position) + 1;
        const article = await readerContext.chapterManifestLoader(index);
        if (!article?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
        return readerContext.restoreChapterPosition({chapterIndex:index,chapterManifest:readerContext.chapterManifestUrl || readerContext.sourceUrl,
          chapterOffset:article.getBoundingClientRect().height * (position - Math.floor(position))}, generation);
      })().catch(error => { readerContext.reportNavigationError(error, generation); return false; });
    } else if (readerContext.htmlFrame && readerContext.htmlFrame.contentWindow)
      readerContext.htmlFrame.contentWindow.scrollTo(
        0,
        (Math.max(
          0,
          readerContext.htmlFrame.contentDocument.documentElement.scrollHeight - readerContext.htmlFrame.contentWindow.innerHeight
        ) *
          percent) /
          100
      );
    else
      readerContext.viewport.scrollTop =
        (Math.max(0, readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight) * percent) / 100;
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
  }

  async function activateChapter(index) {
    if (
      index < 0 ||
      index >= readerContext.navigationState.tocEntries.length ||
      index === readerContext.navigationState.currentChapterIndex
    )
      return;
    try {
      await readerContext.navigateTocEntry(index, { closePanel: false });
    } finally {
      readerContext.updateProgressTools();
    }
  }

  function adjacentTocIndex(direction) {
    for (let index = readerContext.navigationState.currentChapterIndex + direction;
      index >= 0 && index < readerContext.navigationState.tocEntries.length; index += direction) {
      if (!readerContext.navigationState.tocEntries[index].group) return index;
    }
    return -1;
  }

  return {
    progressNotSaved,
    scheduleSave,
    saveProgress,
    captureProgressEntry,
    placeReadingProgress,
    currentReaderUrl,
    loadReaderRestoration,
    getInitialReaderRestoration,
    initialReaderPage,
    readerProgressPercent,
    pageAtMarker,
    syncCurrentPageFromMarker,
    scheduleMarkerSync,
    restoreFormat,
    restoreInitialPosition,
    applyInitialRestoration,
    updateReadingProgressSummary,
    updateProgressTools,
    captureProgressState,
    restoreProgressState,
    flushEpubSeek,
    seekProgress,
    activateChapter,
    adjacentTocIndex
  };
}
