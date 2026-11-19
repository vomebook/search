/** @param {import('../../../typings/reader-progress-strict').ProgressContext} readerContext */
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

  /** @param {Event} [event] */
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
      url: readerContext.sourceUrl,
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

  /** @param {unknown} error */
  function progressNotSaved(error) {
    if ((/** @type {{name?: string} | null | undefined} */ (error))?.name === "ReaderHistoryFullError")
      readerContext.showDownloadFeedback("阅读历史已满，当前进度未保存。请删除不需要的阅读记录后重试。", 0);
    console.warn("Reader progress was not saved", error);
  }

  /** @param {Event} [event] */
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
        return readerContext.historySuppressed ? undefined
          : VoiceOfMLReaderStore.put({ ...progress, lastReadAt: capturedAt });
      })
      .catch((error) => {
        if (readerContext.lastSavedProgress === signature) readerContext.lastSavedProgress = "";
        progressNotSaved(error);
      });
    return readerContext.progressSaveChain;
  }

  function placeReadingProgress() {
    const panel = /** @type {HTMLElement} */ (document.querySelector("#history-panel")),
      tocPanel = /** @type {HTMLElement} */ (document.querySelector("#toc-panel")),
      tocList = tocPanel.querySelector(".panel-list"),
      noToc = readerContext.loadingStatus.hidden && !readerContext.navigationState.tocEntries.length && !readerContext.mediaElement;
    if (readerContext.progressTools.classList.contains("reader-no-toc") !== noToc)
      readerContext.progressTools.classList.toggle("reader-no-toc", noToc);
    const title = /** @type {HTMLElement} */ (tocPanel.querySelector(".panel-view-header strong")),
      label = noToc ? "阅读状态" : "目录";
    if (title.textContent !== label) title.textContent = label;
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
    // History and bookmarks already store the position; the opening anchor may be stale.
    if (readerContext.capability.mode === "markdown") url.hash = "";
    return url;
  }

  async function loadReaderRestoration() {
    /** @template {import('../../../typings/reader-progress-strict').ProgressState | null} T
     * @param {T} entry */
    const currentEntry = (entry) => {
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
      if (bookmarkId && bookmarkSource === readerContext.sourceUrl) {
        const entries = await VoiceOfMLReaderStore.listBookmarks(readerContext.sourceUrl);
        const bookmark = entries.find((entry) => entry.id === bookmarkId && entry.url === readerContext.sourceUrl);
        if (bookmark) return currentEntry(/** @type {import('../../../typings/reader-progress-strict').ProgressState} */ (bookmark));
      }
      return currentEntry(/** @type {import('../../../typings/reader-progress-strict').ProgressState | null} */ (await VoiceOfMLReaderStore.get(readerContext.sourceUrl)));
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

  /** @param {number} total */
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
      if (position && position.foliateSection < 0) {
        const index = -position.foliateSection - 1, spine = readerContext.epubBook?.sections || [];
        if (!spine[index]) return 0;
        const preceding = spine.slice(0, index).filter(item => item.linear !== "no").length;
        return count ? Math.round((preceding / count) * 1000) / 10 : 0;
      }
      return count && position
        ? Math.round(((position.foliateSection + fraction) / count) * 1000) / 10
        : 0;
    }
    if (readerContext.htmlFrame && readerContext.htmlFrame.contentDocument) {
      const doc = readerContext.htmlFrame.contentDocument.documentElement,
        win = /** @type {Window} */ (readerContext.htmlFrame.contentWindow);
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

  /** @type {HTMLCollectionOf<Element> | undefined} */
  let markerPages;
  function pageAtMarker() {
    // The content root is stable; the live list follows added, replaced and unmounted shells.
    const pages = markerPages ??= readerContext.content.getElementsByClassName("reader-page");
    const count = pages.length;
    if (!count) return null;
    const y = readerContext.bookmarkRibbon.getBoundingClientRect().bottom;
    const end = readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight;
    if (["pdf", "pdf-pages", "image-pages"].includes(/** @type {string} */ (readerContext.capability.mode)) && end > 2 && readerContext.viewport.scrollTop > 0 &&
        end - readerContext.viewport.scrollTop <= 2) {
      const last = /** @type {HTMLElement} */ (pages[count - 1]), rect = last.getBoundingClientRect(), view = readerContext.viewport.getBoundingClientRect();
      if (rect.bottom > view.top && rect.top < view.bottom) return last;
    }
    let low = 0, high = count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((/** @type {HTMLElement} */ (pages[middle])).getBoundingClientRect().bottom > y) high = middle;
      else low = middle + 1;
    }
    return /** @type {HTMLElement} */ (pages[Math.min(low, count - 1)]);
  }

  /** @param {boolean} [updateProgress] */
  function syncCurrentPageFromMarker(updateProgress = true) {
    if (performance.now() < readerContext.pageNavigationLockUntil) return;
    const page = readerContext.pageAtMarker();
    if (!page) return;
    const next = Number(page.dataset.page);
    if (!next || next === readerContext.documentState.page) return;
    readerContext.updateDocumentState({ page: next });
    if (document.activeElement !== readerContext.pageInput) readerContext.pageInput.value = String(next);
    readerContext.updateTocCurrentMark();
    if (updateProgress) readerContext.updateProgressTools();
  }

  function scheduleMarkerSync() {
    if (readerContext.markerFrame) return;
    readerContext.markerFrame = requestAnimationFrame(() => {
      readerContext.markerFrame = 0;
      if (readerContext.readerAbortController.signal.aborted) return;
      // Publish once, after both page and heading state have been synchronized.
      // The standalone entry point still publishes immediately.
      syncCurrentPageFromMarker(false);
      try {
        readerContext.refreshNearbyPdfPages();
        readerContext.syncHeadingLocation();
      } finally {
        readerContext.updateProgressTools();
      }
      readerContext.scheduleSave();
    });
  }

  /** @param {string} mode
   * @param {import('../../../typings/reader-progress-strict').ProgressState | null} entry
   * @param {number} [generation] */
  async function restoreFormat(mode, entry, generation = readerContext.beginReaderNavigation()) {
    try {
      if (!entry || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      if (mode === "epub-chapters") {
        if (Number.isInteger(entry.chapterIndex)) {
          if (!(await readerContext.restoreChapterPosition(entry, generation))) return false;
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
          readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(shell) + /** @type {number} */ (entry.pageOffset);
        readerContext.updateProgressTools();
        readerContext.scheduleSave();
      } else if (!(await readerContext.restoreProgressState(entry, generation))) return false;
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      readerContext.consumeBookmarkHandoff(entry);
      return true;
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
      return false;
    }
  }

  /** @param {import('../../../typings/reader-progress-strict').ProgressState | null} entry
   * @param {number} generation */
  async function restoreInitialPosition(entry, generation) {
    if (!entry || !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
    const restored = await readerContext.formatAdapters.active?.restore(entry, generation);
    if (!restored && readerContext.isReaderGenerationCurrent("navigation", generation))
      throw Object.assign(new Error("阅读位置恢复失败，原进度已保留，请重试加载。"), {
        code: "READER_RESTORE"
      });
  }

  /** @param {import('../../../typings/reader-progress-strict').ProgressState | null} entry
   * @param {number} generation */
  async function applyInitialRestoration(entry, generation) {
    readerContext.updateDocumentState({ restoredEntry: entry });
    // Startup already applied the current zoom. Reapplying an identical saved
    // value needlessly invalidates PDF canvases and lays out every format again.
    if (entry?.zoom && !readerContext.zoomChangedByUser && readerContext.isReaderGenerationCurrent("navigation", generation) &&
        VoiceOfMLReader.clampNumber(entry.zoom, 25, 400, 100) / 100 !== readerContext.documentState.zoom)
      readerContext.setZoom(entry.zoom, false);
    await readerContext.restoreInitialPosition(entry, generation);
  }

  /** @param {number} [percent] */
  function updateReadingProgressSummary(percent) {
    const noToc = !readerContext.navigationState.tocEntries.length && !readerContext.mediaElement;
    if (readerContext.readingProgressSummary.hidden !== !noToc) readerContext.readingProgressSummary.hidden = !noToc;
    if (noToc) {
      const value = /** @type {HTMLElement} */ (readerContext.readingProgressSummary.querySelector(".reader-progress-summary-value")),
        label = `${(percent ?? readerContext.readerProgressPercent()).toFixed(1)}%`;
      if (value.textContent !== label) value.textContent = label;
    }
  }

  function updateProgressTools() {
    if (readerContext.progressSeeking) return;
    const percent = readerContext.readerProgressPercent(),
      value = String(percent), label = `${percent.toFixed(1)}%`;
    if (readerContext.progressRange.value !== value) readerContext.progressRange.value = value;
    if (readerContext.progressPercent.textContent !== label) readerContext.progressPercent.textContent = label;
    if (readerContext.progressRange.getAttribute("aria-valuetext") !== label)
      readerContext.progressRange.setAttribute("aria-valuetext", label);
    const hasChapters = readerContext.navigationState.tocEntries.some((entry) => !!entry && typeof entry === "object" && !("group" in entry && entry.group)),
      hasPreviousChapter = readerContext.adjacentTocIndex(-1) >= 0,
      hasNextChapter = readerContext.adjacentTocIndex(1) >= 0;
    if (readerContext.chapterPrev.hidden !== !hasChapters) readerContext.chapterPrev.hidden = !hasChapters;
    if (readerContext.chapterNext.hidden !== !hasChapters) readerContext.chapterNext.hidden = !hasChapters;
    if (readerContext.chapterPrev.disabled !== !hasPreviousChapter) readerContext.chapterPrev.disabled = !hasPreviousChapter;
    if (readerContext.chapterNext.disabled !== !hasNextChapter) readerContext.chapterNext.disabled = !hasNextChapter;
    if (readerContext.progressUndo.hidden !== !readerContext.previousProgressState)
      readerContext.progressUndo.hidden = !readerContext.previousProgressState;
    updateReadingProgressSummary(percent);
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

  /** @param {import('../../../typings/reader-progress-strict').ProgressState | null} state
   * @param {number} [generation] */
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
            /** @param {Error} [error] */
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
        media.currentTime = /** @type {number} */ (state.mediaTime);
      } else if (readerContext.htmlFrame && readerContext.htmlFrame.contentWindow && Number.isFinite(state.htmlScrollTop))
        readerContext.htmlFrame.contentWindow.scrollTo(0, /** @type {number} */ (state.htmlScrollTop));
      else if (Number.isFinite(state.scrollTop)) {
        if (readerContext.capability.mode === "text") {
          let measured = 0, batch = 0, started = performance.now();
          for (const block of /** @type {NodeListOf<HTMLElement>} */ (readerContext.content.querySelectorAll(".reader-text-block"))) {
            if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
            block.style.contentVisibility = "visible";
            const height = block.getBoundingClientRect().height;
            block.style.containIntrinsicBlockSize = `auto ${height}px`;
            block.style.contentVisibility = "auto";
            measured += height;
            if (measured > /** @type {number} */ (state.scrollTop) + readerContext.viewport.clientHeight) break;
            if (++batch >= 8 || performance.now() - started >= 8) {
              await readerContext.waitForReader();
              batch = 0;
              started = performance.now();
            }
          }
        }
        if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
        readerContext.viewport.scrollTop = /** @type {number} */ (state.scrollTop);
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
      readerContext.epubSeekPromise = readerContext.seekFoliateProgress((/** @type {{percent: number, generation: number}} */ (readerContext.epubSeekTarget)).percent, (/** @type {{percent: number, generation: number}} */ (readerContext.epubSeekTarget)).generation);
    }
    return readerContext.epubSeekPromise;
  }

  /** @param {string | number} value
   * @param {boolean} [preserve] */
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
        const article = await (/** @type {NonNullable<import('../../../typings/reader-progress-strict').ProgressContext['chapterManifestLoader']>} */ (readerContext.chapterManifestLoader))(index);
        if (!article?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
        return readerContext.restoreChapterPosition({chapterIndex:index,chapterManifest:readerContext.chapterManifestUrl || readerContext.sourceUrl,
          chapterOffset:article.getBoundingClientRect().height * (position - Math.floor(position))}, generation);
      })().catch(error => { readerContext.reportNavigationError(error, generation); return false; });
    } else if (readerContext.htmlFrame && readerContext.htmlFrame.contentWindow)
      readerContext.htmlFrame.contentWindow.scrollTo(
        0,
        (Math.max(
          0,
          (/** @type {Document} */ (readerContext.htmlFrame.contentDocument)).documentElement.scrollHeight - readerContext.htmlFrame.contentWindow.innerHeight
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

  /** @param {number} index */
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

  /** @param {number} direction */
  function adjacentTocIndex(direction) {
    for (let index = readerContext.navigationState.currentChapterIndex + direction;
      index >= 0 && index < readerContext.navigationState.tocEntries.length; index += direction) {
      const entry = readerContext.navigationState.tocEntries[index];
      if (entry && typeof entry === "object" && !("group" in entry && entry.group)) return index;
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
