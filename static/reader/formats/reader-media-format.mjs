export function createReaderMediaFormat(readerContext) {
  function formatMediaTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const total = Math.floor(seconds),
      hours = Math.floor(total / 3600),
      minutes = Math.floor((total % 3600) / 60),
      secs = total % 60;
    return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function renderImageDocument(image) {
    readerContext.assertReaderActive();
    readerContext.content.appendChild(image);
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "图片";
  }

  async function renderMedia(mode) {
    readerContext.assertReaderActive();
    const media = document.createElement(mode);
    media.className = mode === "audio" ? "reader-audio" : "reader-video";
    media.controls = true;
    media.setAttribute("aria-label", `${readerContext.documentState.title} ${mode === "audio" ? "音频" : "视频"}`);
    media.preload = "metadata";
    if (mode === "video") media.playsInline = true;
    const refresh = () => {
      if (readerContext.readerAbortController.signal.aborted) return;
      readerContext.mediaPanel.querySelector(".media-panel-time").textContent =
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
    let sourceRetried = false, idle, deadline, settled = false, resolveMetadata, rejectMetadata;
    const metadata = new Promise((resolve, reject) => { resolveMetadata = resolve; rejectMetadata = reject; });
    const clearDeadlines = () => { clearTimeout(idle); clearTimeout(deadline); idle = deadline = null; };
    const finish = (error) => {
      clearDeadlines();
      if (settled) return;
      settled = true;
      if (error) rejectMetadata(error);
      else resolveMetadata();
    };
    const failMedia = (message) => {
      if (readerContext.readerAbortController.signal.aborted) return;
      media._readerSourceRetry = false;
      finish(readerContext.readerAbortError());
      readerContext.fail(message, "READER_MEDIA");
    };
    const originalMode = VoiceOfMLReader.capability(readerContext.resolvedReaderData?.original_extension || readerContext.extension).mode;
    const retryUrl = originalMode === mode && readerContext.validSource(readerContext.downloadUrl) ? readerContext.downloadUrl : readerContext.sourceUrl;
    const retryOriginal = () => {
      if (sourceRetried || retryUrl === media.src || !readerContext.validSource(retryUrl)) return false;
      sourceRetried = true;
      media._readerSourceRetry = true;
      media.src = retryUrl;
      media.load();
      arm();
      return true;
    };
    const arm = () => {
      clearTimeout(idle);
      if (media.readyState >= 1) return;
      // Progress can extend the idle budget, but not the metadata-only deadline.
      deadline ||= setTimeout(() => failMedia("媒体信息加载超时，请重试加载或下载原文件。"), readerContext.READER_PROXY_TIMEOUT_MS);
      idle = setTimeout(() => {
        if (!retryOriginal()) failMedia("媒体信息加载停顿，请重试加载或下载原文件。");
      }, 15000);
    };
    const loaded = () => { media._readerSourceRetry = false; finish(); };
    const failed = () => {
      if (readerContext.readerAbortController.signal.aborted) return;
      if (retryOriginal()) return;
      failMedia([3, 4].includes(media.error?.code)
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
