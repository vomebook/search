/** @param {HTMLIFrameElement | null | undefined} frame */
export function captureHtmlDisclosure(frame) {
  const thread = frame?.contentDocument?.querySelector("article[data-reader-reviewed-thread]");
  if (!thread) return {};
  return { htmlReplySource: thread.getAttribute("data-reader-reviewed-thread") || "",
    htmlOpenReplies: Array.from(thread.querySelectorAll("details.reader-clean-web-reply"),
      (reply, i) => reply.hasAttribute("open") ? i + 1 : 0).filter(Boolean).slice(0, 256) };
}

/** @param {number | undefined} index @param {number} count @returns {index is number} */
export function chapterIndexInRange(index, count) {
  return index !== undefined && Number.isInteger(index) && index >= 1 && index <= count;
}

/** @param {string | undefined} saved @param {string} current
 * @param {(url: string) => string | null} trustedManifestUrl */
export function matchesChapterManifest(saved, current, trustedManifestUrl) {
  if (saved === current) return true;
  // Legacy v5 required an exact identity, including for direct bookmark restores.
  if (/-epub-chapters-v5\//.test(current)) return false;
  // Otherwise older positions can still restore if their chapter is in range.
  if (typeof saved !== "string" || !saved) return true;
  const previous = trustedManifestUrl(saved), active = trustedManifestUrl(current);
  // The trusted resolver fixes the bucket and endpoint. Compare non-empty object
  // paths, including the version, without mistaking URL spelling for a revision.
  const savedPath = previous && new URL(previous).searchParams.get("path");
  return !!savedPath && !!active && savedPath === new URL(active).searchParams.get("path");
}

/** @param {import('../../../typings/reader-progress-strict').ProgressContext & Pick<import('../../../typings/reader-chapter-format-strict').ChapterFormatContext, 'trustedReaderAssetManifestUrl'>} readerContext */
export function createReaderProgress(readerContext) {
  const readerDocumentUrl = typeof location === "undefined" ? null : location.href;
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

  /** @type {ReadonlySet<string | null | undefined>} */
  const mediaModes = new Set(["audio", "video"]);

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
    const hiding = event?.type === "pagehide" || document.visibilityState === "hidden";
    if (!hiding) readerContext.syncCurrentPageFromMarker();
    let page = readerContext.documentState.page;
    let shell = null;
    if (readerContext.documentState.pageCount) {
      // A final scroll may not have reached the marker frame. Snapshot the
      // live marker without publishing UI during pagehide, but respect jumps
      // and ignore collapsed or offscreen shells if layout is already gone.
      if (hiding && !(performance.now() < readerContext.pageNavigationLockUntil)) {
        const marked = readerContext.pageAtMarker();
        if (marked) {
          const next = Number(marked.dataset.page);
          if (next > 0 && next <= readerContext.documentState.pageCount) {
            const rect = marked.getBoundingClientRect(), view = readerContext.viewport.getBoundingClientRect();
            if (rect.height > 0 && view.height > 0 && rect.bottom > view.top && rect.top < view.bottom) {
              page = next;
              shell = marked;
            }
          }
        }
      }
      shell ??= readerContext.content.querySelector(`.reader-page[data-page="${page}"]`);
    }
    const pageOffset = shell ? Math.max(0, readerContext.viewport.scrollTop - readerContext.readerPageScrollTop(shell)) : 0;
    const htmlScrollTop = readerContext.htmlFrame?.contentWindow?.scrollY ?? 0;
    const readerUrl = readerContext.currentReaderUrl();
    const chapterPosition = readerContext.captureChapterPosition();
    const mediaTime = readerContext.mediaElement?.currentTime;
    return {
      url: readerContext.sourceUrl,
      title: readerContext.documentState.title,
      extension: readerContext.extension,
      readerUrl: readerUrl.href,
      page,
      pageCount: readerContext.documentState.pageCount,
      pageOffset,
      mediaTime: Number.isFinite(mediaTime) ? /** @type {number} */ (mediaTime) : 0,
      scrollTop: readerContext.viewport.scrollTop,
      htmlScrollTop,
      ...captureHtmlDisclosure(readerContext.htmlFrame),
      zoom: Math.round(readerContext.documentState.zoom * 100),
      ...chapterPosition
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

  function hasStandaloneProgress() {
    return !readerContext.navigationState.tocEntries.length && !readerContext.mediaElement;
  }

  function placeReadingProgress() {
    const panel = /** @type {HTMLElement} */ (document.querySelector("#history-panel")),
      tocPanel = /** @type {HTMLElement} */ (document.querySelector("#toc-panel")),
      tocList = tocPanel.querySelector(".panel-list"),
      noToc = readerContext.readerContentReady && hasStandaloneProgress();
    if (readerContext.progressTools.classList.contains("reader-no-toc") !== noToc)
      readerContext.progressTools.classList.toggle("reader-no-toc", noToc);
    const title = /** @type {HTMLElement} */ (tocPanel.querySelector(".panel-view-header strong")),
      label = noToc ? "阅读状态" : "目录";
    if (title.textContent !== label) title.textContent = label;
    if (noToc) {
      if (readerContext.progressTools.parentElement !== tocPanel || readerContext.progressTools.nextElementSibling !== tocList)
        tocPanel.insertBefore(readerContext.progressTools, tocList);
    } else if (panel.lastElementChild !== readerContext.progressTools) panel.appendChild(readerContext.progressTools);
  }

  function currentReaderUrl() {
    const current = new URL(location.href);
    const opened = new URL(readerDocumentUrl || current.href);
    // Native Back may already expose the search URL while the Reader document
    // still owns pagehide and progress/speech handoff.
    const url = current.pathname === opened.pathname ? current : opened;
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
        entry && !matchesChapterManifest(entry.chapterManifest, readerContext.chapterManifestUrl || readerContext.sourceUrl,
          readerContext.trustedReaderAssetManifestUrl)
      ) return null;
      return entry;
    };
    try {
      const bookmarkId = readerContext.params.get("bookmark"),
        bookmarkSource = readerContext.params.get("bookmark_source");
      if (bookmarkId && bookmarkSource === readerContext.sourceUrl) {
        const entries = await VoiceOfMLReaderStore.listBookmarks(readerContext.sourceUrl);
        const bookmark = entries.find((entry) => entry.id === bookmarkId && entry.url === readerContext.sourceUrl);
        const matched = bookmark && currentEntry(/** @type {import('../../../typings/reader-progress-strict').ProgressState} */ (bookmark));
        if (matched) return matched;
      }
      const history = await VoiceOfMLReaderStore.get(readerContext.sourceUrl);
      // A stale chapter position does not make a previously opened book unread.
      readerContext.readerHasHistory = !!history;
      return currentEntry(/** @type {import('../../../typings/reader-progress-strict').ProgressState | null} */ (history));
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

  function mediaSeekDuration() {
    const duration = readerContext.mediaElement?.duration ?? 0;
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  function readerProgressPercent() {
    if (readerContext.mediaElement) {
      const duration = mediaSeekDuration();
      return duration ? Math.round((readerContext.mediaElement.currentTime / duration) * 1000) / 10 : 0;
    }
    if (readerContext.capability.mode === "epub-chapters")
      return Math.round((readerContext.chapterManifestLoader?.progressFraction() ?? 0) * 1000) / 10;
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
      const chapters = mode === "epub-chapters";
      if (chapters && Number.isInteger(entry.chapterIndex)) {
        if (!(await readerContext.restoreChapterPosition(entry, generation))) return false;
      } else if (!chapters && readerContext.documentState.pageCount && entry.page) {
        if (
          !(await readerContext.goToPage(entry.page, generation)) ||
          !readerContext.isReaderGenerationCurrent("navigation", generation)
        )
          return false;
        const shell = readerContext.content.querySelector(
          `.reader-page[data-page="${readerContext.documentState.page}"]`
        );
        if (shell) {
          const fraction = entry.pageOffsetFraction;
          const pdf = ["pdf", "pdf-pages"].includes(mode);
          const height = pdf ? shell.getBoundingClientRect().height : 0;
          // The inclusive range already excludes NaN and infinities.
          const offset = pdf && typeof fraction === "number" && fraction >= 0 && fraction <= 1
            ? fraction * height : entry.pageOffset;
          if (Number.isFinite(offset)) {
            // Older bookmarks lack a capture scale. Keep their pixel offset
            // when possible, but never let it carry the marker into another page.
            let pixels = /** @type {number} */ (offset);
            if (pdf) {
              const marker = readerContext.bookmarkRibbon.getBoundingClientRect().bottom -
                readerContext.viewport.getBoundingClientRect().top;
              pixels = Math.min(Math.max(0, pixels), Math.max(0, height - Math.max(0, marker) - 2));
            }
            readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(shell) + pixels;
          }
        }
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
    // Ignore stale indices, not failures to load a chapter that still exists.
    const loader = readerContext.chapterManifestLoader, index = entry?.chapterIndex;
    if (readerContext.capability.mode === "epub-chapters" && loader && Number.isInteger(index) &&
        !chapterIndexInRange(index, loader.count)) entry = null;
    readerContext.updateDocumentState({ restoredEntry: entry });
    // Reflowable HTML follows the last explicit Reader zoom across documents.
    // Older entries can still restore a zoom if no preference was ever saved.
    let hasHtmlZoomPreference = false;
    if (readerContext.capability.mode === "html") {
      try {
        const saved = Number(localStorage.getItem("reader-zoom"));
        hasHtmlZoomPreference = saved >= 25 && saved <= 400;
      } catch (_) {}
    }
    // Reapplying an identical value needlessly invalidates PDF canvases.
    if (entry?.zoom && !hasHtmlZoomPreference && !readerContext.zoomChangedByUser && readerContext.isReaderGenerationCurrent("navigation", generation) &&
        VoiceOfMLReader.clampNumber(entry.zoom, 25, 400, 100) / 100 !== readerContext.documentState.zoom)
      readerContext.setZoom(entry.zoom, false);
    await restoreInitialPosition(entry, generation);
  }

  /** @param {number} [percent] */
  function updateReadingProgressSummary(percent) {
    const noToc = hasStandaloneProgress();
    if (readerContext.readingProgressSummary.hidden !== !noToc) readerContext.readingProgressSummary.hidden = !noToc;
    if (noToc) {
      const value = /** @type {HTMLElement} */ (readerContext.readingProgressSummary.querySelector(".reader-progress-summary-value")),
        label = `${(percent ?? readerContext.readerProgressPercent()).toFixed(1)}%`;
      if (value.textContent !== label) value.textContent = label;
    }
  }

  function updateProgressTools() {
    const mode = readerContext.capability.mode;
    const disabled = (mode === "epub-chapters" && !readerContext.chapterManifestLoader) ||
      ((mediaModes.has(mode) || !!readerContext.mediaElement) && !mediaSeekDuration());
    if (readerContext.progressRange.disabled !== disabled) readerContext.progressRange.disabled = disabled;
    if (readerContext.progressSeeking && !disabled) return;
    const percent = readerContext.readerProgressPercent(),
      value = String(percent), label = `${percent.toFixed(1)}%`;
    if (readerContext.progressRange.value !== value) readerContext.progressRange.value = value;
    if (readerContext.progressPercent.textContent !== label) readerContext.progressPercent.textContent = label;
    if (readerContext.progressRange.getAttribute("aria-valuetext") !== label)
      readerContext.progressRange.setAttribute("aria-valuetext", label);
    const hasChapters = readerContext.navigationState.tocEntries.some(isChapterDestination),
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
    return readerContext.capability.mode === "epub-chapters"
        ? readerContext.captureChapterPosition()
        : readerContext.mediaElement
          ? { mediaTime: readerContext.mediaElement.currentTime }
          : readerContext.htmlFrame && readerContext.htmlFrame.contentWindow
            ? { htmlScrollTop: readerContext.htmlFrame.contentWindow.scrollY, ...captureHtmlDisclosure(readerContext.htmlFrame) }
            : { scrollTop: readerContext.viewport.scrollTop };
  }

  /** @param {import('../../../typings/reader-progress-strict').ProgressState | null} state
   * @param {number} [generation] */
  async function restoreProgressState(state, generation = readerContext.beginReaderNavigation()) {
    if (!state || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
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
      } else if (readerContext.htmlFrame?.contentWindow && Number.isFinite(state.htmlScrollTop)) {
        const { htmlFrame } = readerContext;
        const thread = htmlFrame.contentDocument?.querySelector("article[data-reader-reviewed-thread]");
        if (thread && thread.getAttribute("data-reader-reviewed-thread") === state.htmlReplySource &&
            Array.isArray(state.htmlOpenReplies) && state.htmlOpenReplies.length <= 256) {
          // Membership uses strict identity against positive integer indices.
          // Invalid stored values cannot match and need not be copied first.
          const open = new Set(state.htmlOpenReplies);
          thread.querySelectorAll("details.reader-clean-web-reply")
            .forEach((reply, i) => reply.toggleAttribute("open", open.has(i + 1)));
        }
        htmlFrame.contentWindow?.scrollTo(0, /** @type {number} */ (state.htmlScrollTop));
      } else if (Number.isFinite(state.scrollTop)) {
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
    return readerContext.epubSeekPromise;
  }

  /** @param {string | number} value
   * @param {boolean} [preserve] */
  function seekProgress(value, preserve = false) {
    const numeric = Number(value), media = readerContext.mediaElement, duration = mediaSeekDuration();
    // Duration can only be positive when there is a media element. A pending
    // media seek must not turn into a viewport scroll or a history write.
    if (!Number.isFinite(numeric) || ((media || mediaModes.has(readerContext.capability.mode)) && !duration)) return false;
    const percent = Math.max(0, Math.min(100, numeric));
    let target;
    if (!media && readerContext.capability.mode === "epub-chapters") {
      // A seek without a chapter target must not supersede initial restoration.
      target = readerContext.chapterManifestLoader?.progressTarget(percent / 100);
      if (!target) return false;
    }
    if (!preserve || !readerContext.previousProgressState) readerContext.previousProgressState = readerContext.captureProgressState();
    const generation = readerContext.beginReaderNavigation();
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    if (media) media.currentTime = (duration * percent) / 100;
    else if (target) {
      readerContext.epubSeekPromise = readerContext.restoreChapterPosition({
        chapterIndex: target.chapterIndex, chapterManifest: readerContext.chapterManifestUrl || readerContext.sourceUrl
      }, generation, target.fraction).catch(error => {
        readerContext.reportNavigationError(error, generation);
        return false;
      });
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
    return true;
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

  /** @param {unknown} entry */
  function isChapterDestination(entry) {
    if (!entry || typeof entry !== "object") return false;
    const destination = /** @type {{group?: unknown, page?: number}} */ (entry);
    if (destination.group) return false;
    // Native PDF and DjVu share this mode. Other TOCs need not have page metadata.
    if (readerContext.capability.mode !== "pdf") return true;
    const page = /** @type {number} */ (destination.page);
    return Number.isSafeInteger(page) && page > 0;
  }

  /** @param {number} direction */
  function adjacentTocIndex(direction) {
    for (let index = readerContext.navigationState.currentChapterIndex + direction;
      index >= 0 && index < readerContext.navigationState.tocEntries.length; index += direction) {
      if (isChapterDestination(readerContext.navigationState.tocEntries[index])) return index;
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
