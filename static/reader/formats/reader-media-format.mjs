/**
 * @typedef {object} ReaderMediaContext
 * @property {() => void} assertReaderActive
 * @property {HTMLElement} content
 * @property {() => void} markReaderContentReady
 * @property {HTMLElement} status
 * @property {{title: string, restorationReady: boolean}} documentState
 * @property {AbortController} readerAbortController
 * @property {HTMLElement} mediaPanel
 * @property {(seconds: number) => string} formatMediaTime
 * @property {() => void} scheduleMarkerSync
 * @property {() => void} saveProgress
 * @property {HTMLMediaElement | null} mediaElement
 * @property {() => Error} readerAbortError
 * @property {(message: string, code: string) => void} fail
 * @property {{original_extension?: unknown} | null} resolvedReaderData
 * @property {string} extension
 * @property {string} downloadUrl
 * @property {string} sourceUrl
 * @property {string} contentUrl
 * @property {(url: string) => boolean} validSource
 * @property {number} READER_PROXY_TIMEOUT_MS
 * @property {(cleanup: () => void) => () => void} trackReaderResource
 * @property {<T>(promise: T | PromiseLike<T>) => Promise<Awaited<T>>} awaitReader
 * @property {(url: string) => Promise<void>} loadScript
 * @property {string} RUFFLE_URL
 * @property {() => Promise<Response>} fetchReaderResponse
 * @property {HTMLElement | null} swfPlayer
 */
/** @param {ReaderMediaContext} readerContext */
export function createReaderMediaFormat(readerContext) {
  /** @param {unknown} seconds */
  function formatMediaTime(seconds) {
    if (!Number.isFinite(seconds) || (/** @type {number} */ (seconds)) < 0) return "00:00";
    const total = Math.floor(/** @type {number} */ (seconds)),
      hours = Math.floor(total / 3600),
      minutes = Math.floor((total % 3600) / 60),
      secs = total % 60;
    return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  /** @param {Node} image */
  function renderImageDocument(image) {
    readerContext.assertReaderActive();
    readerContext.content.appendChild(image);
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "图片";
  }

  /** @param {string} mode */
  async function renderMedia(mode) {
    readerContext.assertReaderActive();
    // The host registers only audio/video modes. Keep the original dynamic
    // createElement call: changing or validating mode would alter JS behavior.
    const media = /** @type {(HTMLAudioElement | HTMLVideoElement) & {_readerSourceRetry?: boolean, playsInline: boolean}} */ (document.createElement(mode));
    media.className = mode === "audio" ? "reader-audio" : "reader-video";
    media.controls = true;
    media.setAttribute("aria-label", `${readerContext.documentState.title} ${mode === "audio" ? "音频" : "视频"}`);
    media.preload = "metadata";
    if (mode === "video") media.playsInline = true;
    const refresh = () => {
      if (readerContext.readerAbortController.signal.aborted || media._readerSourceRetry) return;
      (/** @type {Element} */ (readerContext.mediaPanel.querySelector(".media-panel-time"))).textContent =
        `${readerContext.formatMediaTime(media.currentTime)} / ${readerContext.formatMediaTime(media.duration)}`;
      readerContext.scheduleMarkerSync();
    };
    for (const type of ["timeupdate", "durationchange", "loadedmetadata"])
      media.addEventListener(type, refresh, { passive: true });
    for (const type of ["pause", "ended", "seeked"])
      media.addEventListener(type, () => {
        refresh();
        readerContext.saveProgress();
      });
    readerContext.mediaElement = media;
    let sourceRetried = false, /** @type {{time: number, playing: boolean, rate: number} | null} */ retryPosition = null,
      /** @type {number | null | undefined} */ idle, /** @type {number | null | undefined} */ deadline,
      settled = false, /** @type {() => void} */ resolveMetadata, /** @type {(reason: unknown) => void} */ rejectMetadata;
    const metadata = /** @type {Promise<void>} */ (new Promise((resolve, reject) => { resolveMetadata = resolve; rejectMetadata = reject; }));
    // Browser clearTimeout also accepts null at runtime; these casts only bridge
    // the DOM library declaration, preserving the original values and calls.
    const clearDeadlines = () => { clearTimeout(/** @type {number | undefined} */ (idle)); clearTimeout(/** @type {number | undefined} */ (deadline)); idle = deadline = null; };
    /** @param {unknown} [error] */
    const finish = (error) => {
      clearDeadlines();
      if (settled) return;
      settled = true;
      if (error) rejectMetadata(error);
      else resolveMetadata();
    };
    /** @param {string} message */
    const failMedia = (message) => {
      if (readerContext.readerAbortController.signal.aborted) return;
      readerContext.saveProgress();
      media._readerSourceRetry = false;
      finish(readerContext.readerAbortError());
      readerContext.fail(message, "READER_MEDIA");
    };
    // The runtime capability helper stringifies unknown metadata; its ambient
    // declaration is narrower. This assertion preserves the original argument.
    const originalMode = VoiceOfMLReader.capability(/** @type {string} */ (readerContext.resolvedReaderData?.original_extension || readerContext.extension)).mode;
    const retryUrl = originalMode === mode && readerContext.validSource(readerContext.downloadUrl) ? readerContext.downloadUrl : readerContext.sourceUrl;
    const retryOriginal = () => {
      if (sourceRetried || retryUrl === media.src || !readerContext.validSource(retryUrl)) return false;
      readerContext.saveProgress();
      retryPosition = readerContext.documentState.restorationReady
        ? {time:media.currentTime, playing:!media.paused, rate:media.playbackRate} : null;
      sourceRetried = true;
      media._readerSourceRetry = true;
      media.src = retryUrl;
      media.load();
      arm();
      return true;
    };
    const arm = () => {
      clearTimeout(/** @type {number | undefined} */ (idle));
      if (media.readyState >= 1) return;
      // Progress can extend the idle budget, but not the metadata-only deadline.
      deadline ||= setTimeout(() => failMedia("媒体信息加载超时，请重试加载或下载原文件。"), readerContext.READER_PROXY_TIMEOUT_MS);
      idle = setTimeout(() => {
        if (!retryOriginal()) failMedia("媒体信息加载停顿，请重试加载或下载原文件。");
      }, 15000);
    };
    const loaded = () => {
      if (retryPosition) {
        if (Number.isFinite(retryPosition.time)) media.currentTime = Number.isFinite(media.duration)
          ? Math.min(retryPosition.time, media.duration) : retryPosition.time;
        media.playbackRate = retryPosition.rate;
        if (retryPosition.playing) media.play().catch(() => {});
        retryPosition = null;
      }
      media._readerSourceRetry = false;
      finish();
      refresh();
    };
    const failed = () => {
      if (readerContext.readerAbortController.signal.aborted) return;
      if (retryOriginal()) return;
      failMedia((/** @type {(number | undefined)[]} */ ([3, 4])).includes(media.error?.code)
        ? "媒体加载失败：浏览器可能不支持其编码，或响应无效。请重试加载或下载原文件。"
        : "媒体加载失败，请重试加载，或下载原文件。");
    };
    media.addEventListener("loadedmetadata", loaded);
    media.addEventListener("progress", arm);
    media.addEventListener("error", failed);
    readerContext.trackReaderResource(() => {
      media.removeEventListener("loadedmetadata", loaded);
      media.removeEventListener("progress", arm);
      media.removeEventListener("error", failed);
      finish(readerContext.readerAbortError());
    });
    media.src = readerContext.contentUrl;
    readerContext.content.appendChild(media);
    arm();
    await readerContext.awaitReader(metadata);
    readerContext.assertReaderActive();
    readerContext.markReaderContentReady();
    readerContext.status.textContent = mode === "audio" ? "音频" : "视频";
  }

  async function loadSwfDocument() {
    await readerContext.loadScript(readerContext.RUFFLE_URL);
    const response = await readerContext.fetchReaderResponse();
    return new Uint8Array(await response.arrayBuffer());
  }

  /** @param {unknown} data */
  async function renderSwf(data) {
    readerContext.assertReaderActive();
    const factory = window.RufflePlayer?.newest?.();
    if (!factory) throw Object.assign(new Error("Ruffle 未加载"), { code: "READER_SWF_ENGINE" });
    const player = factory.createPlayer();
    player.className = "reader-swf";
    player.setAttribute("aria-label", `${readerContext.documentState.title} Flash 内容`);
    player.style.width = "100%";
    player.style.minHeight = "360px";
    readerContext.content.appendChild(player);
    readerContext.swfPlayer = player;
    await player.ruffle().load({ data });
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "Flash 内容";
  }

  return {
    formatMediaTime,
    renderImageDocument,
    renderMedia,
    loadSwfDocument,
    renderSwf
  };
}
