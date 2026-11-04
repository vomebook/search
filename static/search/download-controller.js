// Shared download admission and paced browser handoff controller.
/** @param {typeof globalThis} root */
(function (root) {
    // A transport can reject with an arbitrary non-Error value whose truthy
    // `message` is forwarded unchanged, so check results must remain unknown.
    /** @typedef {unknown} DownloadCheckResult */
    /** @typedef {{users: number, controller: AbortController, promise: Promise<DownloadCheckResult>, expires: number}} DownloadCheckEntry */
    // The pending entry is initialized with null before its promise is attached;
    // it is published to subscribers only after assignment in the same turn.
    /** @typedef {{users: number, controller: AbortController, promise: Promise<boolean> | null}} PendingDownloadEntry */
    /** @typedef {{link: string, entry: DownloadCheckEntry, resolve: (value: DownloadCheckResult) => void}} DownloadQueueItem */
    /** @typedef {{button?: HTMLElement, quiet?: boolean, skipCheck?: boolean, batch?: {cancelled?: boolean, abortController?: AbortController}}} DownloadOptions */
    /** @param {Parameters<DownloadControllerApi["createDownloadController"]>[0]} options
     * @returns {ReturnType<DownloadControllerApi["createDownloadController"]>} */
    function createDownloadController({
      buildCheckUrl,
      buildDownloadUrl,
      triggerDownload,
      showToast,
      isSpeculativeAllowed = () => true,
      isBatchActive = () => false,
      timeout = 8000,
    }) {
      /** @type {Map<string, DownloadCheckEntry>} */
      const downloadChecks = new Map();
      /** @type {DownloadQueueItem[]} */
      const downloadCheckQueue = [];
      /** @type {Map<string, PendingDownloadEntry>} */
      const pendingDownloads = new Map();
      let activeDownloadChecks = 0;
      let downloadLaunchTail = Promise.resolve();
      let lastDownloadLaunch = 0;

      /** @template T
       * @param {{users: number, promise: Promise<T> | null}} entry
       * @param {AbortSignal | null | undefined} signal @param {() => void} abandon @returns {Promise<T | false>} */
      function subscribe(entry, signal, abandon) {
        entry.users++;
        return new Promise(resolve => {
          let settled = false;
          /** @param {T | false} value */
          const finish = value => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            entry.users--;
            resolve(value);
          };
          const abort = () => {
            finish(false);
            if (!entry.users) abandon();
          };
          signal?.addEventListener("abort", abort, { once: true });
          (/** @type {Promise<T>} */ (entry.promise)).then(finish);
          if (signal?.aborted) abort();
        });
      }

      /** @param {string} link @param {DownloadCheckEntry} entry @param {AbortSignal | null | undefined} signal */
      function joinDownloadCheck(link, entry, signal) {
        return subscribe(entry, signal, () => {
          if (entry.expires) return;
          if (downloadChecks.get(link) === entry) downloadChecks.delete(link);
          entry.controller.abort();
        });
      }

      /** @param {string} link @param {boolean} [speculative] @param {AbortSignal | null} [signal] */
      function checkDownload(link, speculative = false, signal = null) {
        if (speculative && !isSpeculativeAllowed()) return Promise.resolve(false);
        if (signal?.aborted) return Promise.resolve(false);
        const now = Date.now();
        downloadChecks.forEach((entry, key) => {
          if (entry.expires && entry.expires <= now) downloadChecks.delete(key);
        });
        const existing = downloadChecks.get(link);
        if (existing) return joinDownloadCheck(link, existing, signal);
        if (speculative && (activeDownloadChecks || downloadCheckQueue.length || isBatchActive())) {
          return Promise.resolve(false);
        }
        /** @type {((value: DownloadCheckResult) => void) | undefined} */
        let resolve;
        /** @type {DownloadCheckEntry} */
        const entry = {
          promise: new Promise(done => { resolve = done; }), expires: 0,
          users: 0, controller: new AbortController(),
        };
        downloadChecks.set(link, entry);
        downloadCheckQueue.push({ link, entry, resolve: /** @type {(value: DownloadCheckResult) => void} */ (resolve) });
        const subscription = joinDownloadCheck(link, entry, signal);
        pumpDownloadChecks();
        return subscription;
      }

      /** @param {DownloadQueueItem} item */
      async function runDownloadCheck({ link, entry, resolve }) {
        const controller = entry.controller;
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(buildCheckUrl(link), { signal: controller.signal });
          // Gateway errors may return HTML; never surface a JSON parse error as the message.
          const data = await response.json().catch(error => {
            if (error && error.name === "AbortError") throw error;
            return {};
          });
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (!response.ok || data.ok !== true)
            throw new Error((typeof data.error === "string" && data.error) ||
              (response.ok ? "下载检查失败，请重试" : `下载检查失败（HTTP ${response.status}），请重试`));
          entry.expires = Date.now() + 30000;
          const cached = Array.from(downloadChecks).filter(([, value]) => value.expires);
          while (cached.length > 64) downloadChecks.delete(/** @type {[string, DownloadCheckEntry]} */ (cached.shift())[0]);
          resolve(true);
        } catch (error) {
          if (downloadChecks.get(link) === entry) downloadChecks.delete(link);
          resolve(/** @type {{name?: unknown, message?: unknown}} */ (error).name === "AbortError" ? "下载检查超时，请重试" : /** @type {{message?: unknown}} */ (error).message || "下载失败，请稍后重试");
        } finally {
          clearTimeout(timer);
          activeDownloadChecks--;
          pumpDownloadChecks();
        }
      }

      function pumpDownloadChecks() {
        while (activeDownloadChecks < 2 && downloadCheckQueue.length) {
          const item = /** @type {DownloadQueueItem} */ (downloadCheckQueue.shift());
          if (item.entry.controller.signal.aborted) {
            if (downloadChecks.get(item.link) === item.entry) downloadChecks.delete(item.link);
            item.resolve(false);
            continue;
          }
          activeDownloadChecks++;
          runDownloadCheck(item);
        }
      }

      /** @param {string} filename @param {string} link @param {() => boolean} cancelled */
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
        downloadLaunchTail = launch.then(() => {}, () => {});
        return launch;
      }

      /** @param {string} filename @param {string} link @param {DownloadOptions} [options] */
      function downloadFile(filename, link, options = {}) {
        if (options.batch && options.batch.cancelled) return Promise.resolve(false);
        const signal = options.batch?.abortController?.signal;
        /** @param {PendingDownloadEntry} entry */
        const join = entry => subscribe(entry, signal, () => {
          if (pendingDownloads.get(link) === entry) pendingDownloads.delete(link);
          entry.controller.abort();
        });
        if (pendingDownloads.has(link)) return join(/** @type {PendingDownloadEntry} */ (pendingDownloads.get(link)));
        const button = options.button;
        const label = button && button.textContent;
        if (button) { button.textContent = "准备中…"; button.setAttribute("aria-busy", "true"); }
        if (!options.quiet) showToast("正在准备下载…");
        /** @type {PendingDownloadEntry} */
        const entry = { users: 0, controller: new AbortController(), promise: null };
        const cancelled = () => entry.controller.signal.aborted;
        entry.promise = Promise.resolve().then(async () => {
          try {
            if (cancelled()) return false;
            const checked = options.skipCheck
              ? true
              : await checkDownload(link, false, entry.controller.signal);
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
            if (pendingDownloads.get(link) === entry) pendingDownloads.delete(link);
            if (button && button.textContent === "准备中…") {
              button.textContent = /** @type {string | null} */ (label);
              button.removeAttribute("aria-busy");
            }
          }
        });
        pendingDownloads.set(link, entry);
        return join(entry);
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

    /** @type {typeof globalThis & {VoiceOfMLDownloadController: DownloadControllerApi}} */ (root).VoiceOfMLDownloadController = { createDownloadController };
})(typeof self !== "undefined" ? self : globalThis);
