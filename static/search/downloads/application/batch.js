// Owns batch workers and the tab's uncertain-handoff ledger. URL policy and
// selected-record materialization stay with the host; the checker is shared.
(function () {
  /** @param {SearchDownloadBatchDependencies} deps @returns {SearchDownloadBatches} */
  function create(deps) {
    /** @type {SearchDownloadBatch | null} */
    let batch = null;
    const uncertain = restoreUncertainDownloads();

    /** @returns {SearchDownloadItem[]} */
    function restoreUncertainDownloads() {
      try {
        const saved = JSON.parse(sessionStorage.getItem("uncertain-downloads") || "[]");
        return Array.isArray(saved) ? saved.filter(item => item && typeof item.filename === "string" && typeof item.link === "string" && item.link) : [];
      } catch { return []; }
    }
    function saveUncertainDownloads() {
      try { sessionStorage.setItem("uncertain-downloads", JSON.stringify(uncertain)); }
      catch { /* Keep the current tab's in-memory record when storage is unavailable. */ }
    }
    function render() { deps.render(batch, uncertain, actions); }
    /** @param {string} link */
    function acknowledge(link) {
      const index = uncertain.findIndex(item => item.link === link);
      if (index === -1) return;
      uncertain.splice(index, 1);
      saveUncertainDownloads();
      if (batch) {
        const acknowledged = [...batch.blockedFailures, ...batch.skippedUncertain].filter(item => item.link === link);
        batch.blockedFailures = batch.blockedFailures.filter(item => item.link !== link);
        batch.skippedUncertain = batch.skippedUncertain.filter(item => item.link !== link);
        for (const item of acknowledged) {
          if (!batch.failed.some(failed => failed.link === item.link)) batch.failed.push(item);
        }
      }
      render();
    }
    /** @param {string} filename @param {string} link */
    function onUncertain(filename, link) {
      if (!uncertain.some(item => item.link === link)) uncertain.push({filename, link});
      saveUncertainDownloads();
      if (batch) {
        const index = batch.failed.findIndex(item => item.link === link);
        if (index !== -1) batch.blockedFailures.push(...batch.failed.splice(index, 1));
      }
      render();
    }
    /** @param {SearchDownloadItem[]} items @param {boolean} retry */
    function start(items, retry = false) {
      if (batch && !batch.done) { deps.showToast("已有批量任务，请先完成或取消"); return; }
      items = Array.from(new Map(items.filter(item => item.link).map(item => [item.link, item])).values());
      if (!items.length) { deps.showToast("未选中任何文件"); return; }
      /** @type {SearchDownloadBatch} */
      const current = {
        items, next: 0, started: 0, failed: [], blockedFailures: [], skippedUncertain: [], uncertain, retry, cancelled: false, done: false,
        abortController: new AbortController(),
      };
      batch = current;
      render();
      Promise.all([runWorker(current), runWorker(current)]).then(() => {
        for (const item of current.items.slice(current.next)) current.failed.push(item);
        current.done = true;
        render();
      });
    }
    /** @param {SearchDownloadBatch} current */
    async function runWorker(current) {
      while (!current.cancelled && current.next < current.items.length) {
        const item = /** @type {SearchDownloadItem} */ (current.items[current.next++]);
        if (current.uncertain.some(previous => previous.link === item.link)) {
          current.skippedUncertain.push(item);
          render();
          continue;
        }
        const options = { quiet: true, batch: current, observeSharedOnCancel: true };
        const result = await deps.downloadFileDetailed(item.filename, item.link, options);
        if (result === "started") current.started++;
        else if (result === "uncertain" && !current.uncertain.some(previous => previous.link === item.link)) current.uncertain.push(item);
        else if (result === "cancelled") current.failed.push(item);
        else if (result === "failed") {
          if (current.uncertain.some(previous => previous.link === item.link)) current.blockedFailures.push(item);
          else current.failed.push(item);
        }
        render();
      }
    }
    function cancel() {
      if (!batch) return;
      batch.cancelled = true;
      batch.abortController.abort();
      render();
    }
    function retry() { if (batch?.done && batch.failed.length) start(batch.failed, true); }
    function close() {
      if (batch?.done) { batch = null; deps.render(batch, uncertain, actions, true); }
    }
    const actions = {
      /** @param {string} link */
      acknowledge(link) { if (!batch || batch.done) acknowledge(link); },
      cancel, retry, close,
    };
    return { start, render, onUncertain, ...actions, acknowledge,
      get batch() { return batch; }, get uncertain() { return uncertain; },
      isActive: () => !!(batch && !batch.done),
    };
  }
  globalThis.VoiceOfMLDownloadBatch = { create };
})();
