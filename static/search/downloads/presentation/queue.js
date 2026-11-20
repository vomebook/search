// Queue rendering receives state and actions; it does not own batch transitions.
(function () {
  /** @param {SearchDownloadBatch | null} downloadBatch @param {SearchDownloadItem[]} uncertainDownloads @param {SearchDownloadQueueActions} actions @param {boolean} reset */
  function render(downloadBatch, uncertainDownloads, actions, reset = false) {
    let panel = document.getElementById("download-queue");
    if (reset) { panel?.remove(); panel = null; }
    if (!downloadBatch && !uncertainDownloads.length) { panel?.remove(); return; }
    const batch = downloadBatch || {
      items: [], started: 0, failed: [], blockedFailures: [], skippedUncertain: [],
      uncertain: uncertainDownloads, cancelled: false, done: true,
    };
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "download-queue";
      panel.className = "download-queue";
      panel.style.maxHeight = "calc(100vh - 32px)";
      panel.style.overflowY = "auto";
      panel.setAttribute("aria-label", "批量下载");
      panel.innerHTML = '<span role="status" aria-live="polite"></span><div data-uncertain-list></div><button type="button" data-queue="cancel">取消待下载</button><button type="button" data-queue="retry">重试失败项</button><button type="button" data-queue="close">关闭</button>';
      const status = /** @type {HTMLElement} */ (panel.querySelector('[role="status"]'));
      status.style.maxHeight = "min(40vh, 240px)";
      status.style.overflowY = "auto";
      status.style.overflowWrap = "anywhere";
      status.style.wordBreak = "break-word";
      panel.addEventListener("click", event => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target.dataset.acknowledgeLink) actions.acknowledge(target.dataset.acknowledgeLink);
        const action = target.dataset.queue;
        if (action === "cancel") actions.cancel();
        if (action === "retry") actions.retry();
        if (action === "close") actions.close();
      });
      document.body.appendChild(panel);
    }
    /** @param {SearchDownloadItem} item */
    const describe = item => `${JSON.stringify(item.filename)}（${JSON.stringify(item.link)}）`;
    const uncertainFiles = batch.uncertain.map(describe).join("、");
    const blockedFiles = batch.blockedFailures.map(describe).join("、");
    const skippedFiles = batch.skippedUncertain.map(describe).join("、");
    const status = /** @type {HTMLElement} */ (panel.querySelector('[role="status"]'));
    const cancellation = !batch.cancelled ? "" : batch.done ? "已取消待下载 · " : "已取消待下载 · 正在确认共享下载结果 · ";
    status.textContent = `${cancellation}已发起 ${batch.started}/${batch.items.length} · 失败 ${batch.failed.length} · 本次失败但此前状态不确定（不自动重试） ${batch.blockedFailures.length}${blockedFiles ? `：${blockedFiles}` : ""} · 因状态不确定跳过重试 ${batch.skippedUncertain.length}${skippedFiles ? `：${skippedFiles}` : ""} · 状态不确定 ${batch.uncertain.length}${uncertainFiles ? `：${uncertainFiles}` : ""}。请在浏览器下载列表查看文件进度，不确定项请检查后再手动重试。`;
    const uncertainList = /** @type {HTMLElement} */ (panel.querySelector('[data-uncertain-list]'));
    uncertainList.replaceChildren();
    for (const item of batch.uncertain) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = describe(item) + " ";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "已检查下载列表，清除此项记录";
      button.dataset.acknowledgeLink = item.link;
      button.disabled = !batch.done;
      row.append(label, button);
      uncertainList.append(row);
    }
    /** @type {HTMLElement} */ (panel.querySelector('[data-queue="cancel"]')).hidden = batch.done || batch.cancelled;
    /** @type {HTMLElement} */ (panel.querySelector('[data-queue="retry"]')).hidden = !batch.done || !batch.failed.length;
    /** @type {HTMLElement} */ (panel.querySelector('[data-queue="close"]')).hidden = !batch.done || !downloadBatch;
  }
  globalThis.VoiceOfMLDownloadQueue = { render };
})();
