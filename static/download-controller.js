// Shared download admission and paced browser handoff controller.
if (!globalThis.VoiceOfMLDownloadController) {
  globalThis.VoiceOfMLDownloadController = (() => {
    function createDownloadController({
      buildCheckUrl,
      buildDownloadUrl,
      triggerDownload,
      showToast,
      isSpeculativeAllowed = () => true,
      isBatchActive = () => false,
      timeout = 8000,
    }) {
      const downloadChecks = new Map();
      const downloadCheckQueue = [];
      const pendingDownloads = new Map();
      let activeDownloadChecks = 0;
      let downloadLaunchTail = Promise.resolve();
      let lastDownloadLaunch = 0;

      function checkDownload(link, speculative = false) {
        if (speculative && !isSpeculativeAllowed()) return Promise.resolve(false);
        const now = Date.now();
        downloadChecks.forEach((entry, key) => {
          if (entry.expires && entry.expires <= now) downloadChecks.delete(key);
        });
        const existing = downloadChecks.get(link);
        if (existing) return existing.promise;
        if (speculative && (activeDownloadChecks || downloadCheckQueue.length || isBatchActive())) return Promise.resolve(false);
        let resolve;
        const entry = { promise: new Promise(done => { resolve = done; }), expires: 0 };
        downloadChecks.set(link, entry);
        downloadCheckQueue.push({ link, entry, resolve });
        pumpDownloadChecks();
        return entry.promise;
      }

      async function runDownloadCheck({ link, entry, resolve }) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(buildCheckUrl(link), { signal: controller.signal });
          const data = await response.json();
          if (!response.ok || data.ok !== true) throw new Error(data.error || "下载检查失败，请重试");
          entry.expires = Date.now() + 30000;
          const cached = Array.from(downloadChecks).filter(([, value]) => value.expires);
          while (cached.length > 64) downloadChecks.delete(cached.shift()[0]);
          resolve(true);
        } catch (error) {
          downloadChecks.delete(link);
          resolve(error.name === "AbortError" ? "下载检查超时，请重试" : error.message || "下载失败，请稍后重试");
        } finally {
          clearTimeout(timer);
          activeDownloadChecks--;
          pumpDownloadChecks();
        }
      }

      function pumpDownloadChecks() {
        while (activeDownloadChecks < 2 && downloadCheckQueue.length) {
          activeDownloadChecks++;
          runDownloadCheck(downloadCheckQueue.shift());
        }
      }

      function scheduleDownloadLaunch(filename, link, cancelled) {
        const launch = downloadLaunchTail.then(async () => {
          if (cancelled()) return false;
          const delay = Math.max(0, 300 - (Date.now() - lastDownloadLaunch));
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          if (cancelled()) return false;
          triggerDownload(buildDownloadUrl(filename, link));
          lastDownloadLaunch = Date.now();
          return true;
        });
        downloadLaunchTail = launch.catch(() => {});
        return launch;
      }

      function downloadFile(filename, link, options = {}) {
        if (options.batch && options.batch.cancelled) return Promise.resolve(false);
        if (pendingDownloads.has(link)) return pendingDownloads.get(link);
        const button = options.button;
        const label = button && button.textContent;
        if (button) { button.textContent = "准备中…"; button.setAttribute("aria-busy", "true"); }
        if (!options.quiet) showToast("正在准备下载…");
        const cancelled = () => !!(options.batch && options.batch.cancelled);
        const task = (async () => {
          try {
            if (cancelled()) return false;
            const checked = options.skipCheck ? true : await checkDownload(link);
            if (cancelled()) return false;
            if (checked !== true) {
              if (!options.quiet) showToast(checked || "下载检查失败，请重试", 3500);
              return false;
            }
            const started = await scheduleDownloadLaunch(filename, link, cancelled);
            if (started && !options.quiet) showToast("已发起下载，请在浏览器下载列表查看");
            return started;
          } catch (_) {
            if (!options.quiet) showToast("下载失败，请稍后重试", 3500);
            return false;
          } finally {
            pendingDownloads.delete(link);
            if (button && button.textContent === "准备中…") {
              button.textContent = label;
              button.removeAttribute("aria-busy");
            }
          }
        })();
        pendingDownloads.set(link, task);
        return task;
      }

      return {
        downloadChecks,
        downloadCheckQueue,
        pendingDownloads,
        checkDownload,
        runDownloadCheck,
        pumpDownloadChecks,
        scheduleDownloadLaunch,
        downloadFile,
        get activeDownloadChecks() { return activeDownloadChecks; },
      };
    }

    return { createDownloadController };
  })();
}
