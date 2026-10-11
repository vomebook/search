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

  function renderMedia(mode) {
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
    let sourceRetried = false;
    const originalMode = VoiceOfMLReader.capability(readerContext.resolvedReaderData?.original_extension || readerContext.extension).mode;
    const retryUrl = originalMode === mode && readerContext.validSource(readerContext.downloadUrl) ? readerContext.downloadUrl : readerContext.sourceUrl;
    media.addEventListener("error", () => {
      if (readerContext.readerAbortController.signal.aborted) return;
      if (!sourceRetried && retryUrl !== media.src && readerContext.validSource(retryUrl)) {
        sourceRetried = true;
        media._readerSourceRetry = true;
        media.src = retryUrl;
        media.load();
        return;
      }
      media._readerSourceRetry = false;
      readerContext.fail("媒体加载失败，请检查网络后重试，或下载原文件。", "READER_MEDIA");
    });
    media.src = readerContext.contentUrl;
    readerContext.content.appendChild(media);
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
