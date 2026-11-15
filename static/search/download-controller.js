// Shared download admission and paced browser handoff controller.
/** @param {typeof globalThis} root */
(function (root) {
    // A transport can reject with an arbitrary non-Error value whose truthy
    // `message` is forwarded unchanged, so check results must remain unknown.
    /** @typedef {unknown} DownloadCheckResult */
    /** @typedef {{users: number, controller: AbortController, promise: Promise<DownloadCheckResult>, expires: number}} DownloadCheckEntry */
    // The pending entry is initialized with null before its promise is attached;
    // it is published to subscribers only after assignment in the same turn.
    /** @typedef {"started" | "failed" | "uncertain" | "cancelled"} DownloadResult */
    /** @typedef {{users: number, controller: AbortController, promise: Promise<DownloadResult> | null, handoff: boolean, failure: unknown}} PendingDownloadEntry */
    /** @typedef {{link: string, entry: DownloadCheckEntry, resolve: (value: DownloadCheckResult) => void}} DownloadQueueItem */
    /** @typedef {{button?: HTMLElement, quiet?: boolean, skipCheck?: boolean, batch?: {cancelled?: boolean, abortController?: AbortController}}} DownloadOptions */
    /** @param {Parameters<DownloadControllerApi["createDownloadController"]>[0]} options
     * @returns {ReturnType<DownloadControllerApi["createDownloadController"]>} */
    function createDownloadController({
      buildCheckUrl,
      buildDownloadUrl,
      triggerDownload,
      onUncertain = () => {},
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
      /** @type {WeakMap<HTMLElement, {users: number, label: string | null, busy: string | null}>} */
      const busyButtons = new WeakMap();
      let activeDownloadChecks = 0;
      let downloadLaunchTail = Promise.resolve();
      let lastDownloadLaunch = 0;

      /** @template T
       * @param {{users: number, promise: Promise<T> | null}} entry
       * @param {AbortSignal | null | undefined} signal @param {() => void} abandon
       * @param {() => boolean} [canCancel] @returns {Promise<T | false>} */
      function subscribe(entry, signal, abandon, canCancel = () => true) {
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
            if (!canCancel()) return;
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
          const data = (await response.json().catch(error => {
            if (error && error.name === "AbortError") throw error;
            return {};
          })) ?? {};
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
          const failure = /** @type {{name?: unknown, message?: unknown} | null | undefined} */ (error);
          resolve(failure?.name === "AbortError" ? "下载检查超时，请重试" : failure?.message || "下载失败，请稍后重试");
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

      /** @param {string} filename @param {string} link @param {() => boolean} cancelled @param {() => void} onHandoff
       * @returns {Promise<DownloadResult>} */
      function scheduleDetailedLaunch(filename, link, cancelled, onHandoff) {
        const launch = downloadLaunchTail.then(async () => {
          if (cancelled()) return /** @type {const} */ ("cancelled");
          const delay = Math.max(0, 300 - (Date.now() - lastDownloadLaunch));
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          if (cancelled()) return /** @type {const} */ ("cancelled");
          const url = buildDownloadUrl(filename, link);
          if (cancelled()) return /** @type {const} */ ("cancelled");
          onHandoff();
          // An exception may occur after the browser has received the handoff.
          lastDownloadLaunch = Date.now();
          try { triggerDownload(url); } catch (_) {
            try { onUncertain(filename, link); } catch (_) { /* best effort */ }
            return /** @type {const} */ ("uncertain");
          }
          return /** @type {const} */ ("started");
        });
        downloadLaunchTail = launch.then(() => {}, () => {});
        return launch;
      }

      /** @param {string} filename @param {string} link @param {DownloadOptions} [options] */
      function downloadFile(filename, link, options = {}) {
        return downloadFileDetailed(filename, link, options).then(result => result === "started");
      }

      /** @param {string} filename @param {string} link @param {DownloadOptions} [options] @returns {Promise<DownloadResult>} */
      function downloadFileDetailed(filename, link, options = {}) {
        if (options.batch && options.batch.cancelled) return Promise.resolve("cancelled");
        const signal = options.batch?.abortController?.signal;
        if (signal?.aborted) return Promise.resolve("cancelled");
        /** @param {PendingDownloadEntry} entry */
        const join = entry => {
          const button = options.button;
          if (button) {
            let state = busyButtons.get(button);
            if (!state) {
              state = {users: 0, label: button.textContent, busy: button.getAttribute("aria-busy")};
              busyButtons.set(button, state);
              button.textContent = "准备中…";
              button.setAttribute("aria-busy", "true");
            }
            state.users++;
          }
          // Own the subscription before invoking feedback, which may reenter or abort.
          const result = subscribe(entry, signal, () => {
            if (pendingDownloads.get(link) === entry) pendingDownloads.delete(link);
            entry.controller.abort();
          }, () => !entry.handoff).then(result => {
            if (!options.quiet) {
              try {
                if (result === "uncertain") showToast("下载状态不确定，请检查浏览器下载列表后再重试", 3500);
                else if (result === "started") showToast("已发起下载，请在浏览器下载列表查看");
                else if (result === "failed") showToast(entry.failure, 3500);
              } catch (_) { /* best effort */ }
            }
            return result === false ? /** @type {const} */ ("cancelled") : result;
          }).finally(() => {
            if (!button) return;
            const state = /** @type {{users: number, label: string | null, busy: string | null}} */ (busyButtons.get(button));
            if (--state.users) return;
            busyButtons.delete(button);
            if (button.textContent === "准备中…") button.textContent = state.label;
            if (button.getAttribute("aria-busy") === "true") {
              if (state.busy === null) button.removeAttribute("aria-busy");
              else button.setAttribute("aria-busy", state.busy);
            }
          });
          if (!options.quiet) {
            try { showToast("正在准备下载…"); } catch (_) { /* best effort */ }
          }
          return result;
        };
        if (pendingDownloads.has(link)) return join(/** @type {PendingDownloadEntry} */ (pendingDownloads.get(link)));
        /** @type {PendingDownloadEntry} */
        const entry = { users: 0, controller: new AbortController(), promise: null, handoff: false, failure: "下载失败，请稍后重试" };
        const cancelled = () => entry.controller.signal.aborted;
        entry.promise = Promise.resolve().then(async () => {
          try {
            if (cancelled()) return "cancelled";
            const checked = options.skipCheck
              ? true
              : await checkDownload(link, false, entry.controller.signal);
            if (cancelled()) return "cancelled";
            if (checked !== true) {
              entry.failure = checked || "下载检查失败，请重试";
              return "failed";
            }
            return await scheduleDetailedLaunch(filename, link, cancelled, () => { entry.handoff = true; });
          } catch (_) {
            return "failed";
          } finally {
            if (pendingDownloads.get(link) === entry) pendingDownloads.delete(link);
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
        downloadFileDetailed,
        get activeDownloadChecks() { return activeDownloadChecks; },
      };
    }

    /** @type {typeof globalThis & {VoiceOfMLDownloadController: DownloadControllerApi}} */ (root).VoiceOfMLDownloadController = { createDownloadController };
})(typeof self !== "undefined" ? self : globalThis);
