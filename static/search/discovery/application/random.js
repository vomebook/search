// Random discovery coordinates existing corpus, Reader and download controllers.
(function () {
  /** @param {VoiceOfMLRandomDiscoveryDependencies} deps */
  function create(deps) {
    let statusId = 0;
    /** @param {number} id @param {string} returnUrl */
    const current = (id, returnUrl) => id === deps.requests.id && location.href === returnUrl;

    async function updateRandomTxtVisibility() {
      const button = deps.button();
      if (!button) return;
      const id = ++statusId;
      const active = () => id === statusId && button === deps.button();
      button.style.display = "none";
      if (deps.readView().dataLoaded) {
        const originalCount = deps.nativeCount();
        if (originalCount) {
          // Native availability must not wait for the converted sidecar.
          deps.loadReaderAssets();
          button.style.display = "";
          return;
        }
        await deps.loadReaderAssets();
        if (!active()) return;
        const count = (await deps.getConvertedReaderRecords(deps.readView().repoFull || "")).length;
        if (!active()) return;
        button.style.display = count > 0 ? "" : "none";
        return;
      }
      const view = deps.readView();
      const repo = view.mode === "repo" && view.repo ? view.repo : "";
      const url = repo ? deps.apiBase + "/api/random-reader/status?repo=" + encodeURIComponent(repo) : deps.apiBase + "/api/random-reader/status";
      try {
        const data = await deps.fetchStatus(url, 4000);
        if (!active()) return;
        button.style.display = data && data.available ? "" : "none";
      } catch (e) {
        if (active()) button.style.display = "none";
      }
    }

    /** @param {boolean} readerOnly */
    async function getRandomLocal(readerOnly) {
      const data = await deps.localRecord(deps.readView().repoFull || "", !!readerOnly);
      return data && data.record || null;
    }

    async function randomBook() {
      const view = deps.readView();
      const clickUrl = location.href;
      const onClickRoute = () => location.href === clickUrl && deps.readView().repoFull === view.repoFull;
      deps.showToast("正在随机下载书籍...");
      try {
        let rec;
        if (view.dataLoaded) {
          rec = await deps.getRandomLocal(false);
        } else {
          const url = view.repoFull ? deps.apiBase + "/api/random?repo=" + encodeURIComponent(String(view.repo)) : deps.apiBase + "/api/random";
          try {
            const response = await fetch(url);
            if (!response.ok) throw new Error("HTTP " + response.status);
            rec = await response.json();
          } catch (error) {
            if (!onClickRoute()) return;
            if (!deps.readView().dataLoaded && !(await deps.ensureLocalDataLoaded())) throw new Error("LOCAL_UNAVAILABLE");
            if (!onClickRoute()) return;
            rec = await deps.getRandomLocal(false);
          }
        }
        if (!onClickRoute()) return;
        if (!rec) throw new Error("NO_RECORD");
        const filename = (rec.File || "file") + (rec.Extension ? "." + rec.Extension : "");
        await deps.downloadFile(filename, deps.getRecordLink(rec), { skipCheck: true });
      } catch (error) {
        if (onClickRoute()) deps.showToast("暂无可下载书籍");
      }
    }

    /** @param {string} url @param {number} requestId @param {string} returnUrl */
    async function fetchRandomReaderRecord(url, requestId, returnUrl) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!current(requestId, returnUrl)) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) {
            await response.body?.cancel();
            const error = Object.assign(new Error(`HTTP ${response.status}`), {
              permanent: response.status < 500 && ![408, 429].includes(response.status)
            });
            throw error;
          }
          return await response.json();
        } catch (error) {
          const err = /** @type {Error & {permanent?: boolean}} */ (error);
          if (err.permanent || attempt || err instanceof SyntaxError || navigator.onLine === false) throw error;
        } finally {
          clearTimeout(timer);
        }
      }
    }

    /** @param {VoiceOfMLDiscoveryRecord | null | undefined} rec @param {string} [returnUrl] */
    function openReaderRecord(rec, returnUrl) {
      returnUrl = returnUrl || location.href;
      if (!rec || location.href !== returnUrl) return false;
      const url = deps.getReaderLink(rec, returnUrl);
      if (!url) return false;
      return deps.navigateToReader(url, returnUrl);
    }

    /** @param {number} originalCount */
    async function waitForReaderAssets(originalCount) {
      let timer;
      try {
        const loading = deps.loadReaderAssets();
        if (!originalCount) await loading;
        else await Promise.race([loading, new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 1000); })]);
      } catch (e) { /* Native books remain available. */ }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }

    async function randomTxt() {
      const requestId = ++deps.requests.id;
      const returnUrl = location.href;
      deps.showToast("正在随机打开书籍...");
      if (deps.readView().dataLoaded) {
        try {
          const originalCount = deps.nativeCount();
          await waitForReaderAssets(originalCount);
          if (!current(requestId, returnUrl)) return;
          const converted = await deps.getConvertedReaderRecords(deps.readView().repoFull || "");
          if (!current(requestId, returnUrl)) return;
          const useConverted = converted.length > 0 && Math.random() * (originalCount + converted.length) >= originalCount;
          const rec = useConverted ? converted[Math.floor(Math.random() * converted.length)] : await deps.getRandomLocal(true);
          if (!current(requestId, returnUrl)) return;
          if (!deps.openReaderRecord(rec, returnUrl)) throw new Error("NO_READER");
        } catch (e) {
          if (!current(requestId, returnUrl)) return;
          deps.showToast("暂无可读书籍");
        }
        return;
      }
      const view = deps.readView();
      const url = view.repoFull ? deps.apiBase + "/api/random-reader?repo=" + encodeURIComponent(String(view.repo)) : deps.apiBase + "/api/random-reader";
      return deps.fetchRandomReaderRecord(url, requestId, returnUrl).then(function(rec) {
        if (!current(requestId, returnUrl)) return;
        if (!deps.openReaderRecord(rec, returnUrl)) throw new Error("NO_READER");
      }).catch(function() {
        if (!current(requestId, returnUrl)) return;
        async function fallback() {
          if (!current(requestId, returnUrl)) return;
          const originalCount = deps.nativeCount();
          await waitForReaderAssets(originalCount);
          if (!current(requestId, returnUrl)) return;
          const converted = await deps.getConvertedReaderRecords(deps.readView().repoFull || "");
          if (!current(requestId, returnUrl)) return;
          const useConverted = converted.length > 0 && Math.random() * (originalCount + converted.length) >= originalCount;
          const rec = useConverted ? converted[Math.floor(Math.random() * converted.length)] : await deps.getRandomLocal(true);
          if (!current(requestId, returnUrl)) return;
          if (!deps.openReaderRecord(rec, returnUrl)) deps.showToast("暂无可读书籍");
        }
        if (deps.readView().dataLoaded) fallback().catch(function() {
          if (!current(requestId, returnUrl)) return;
          deps.showToast("暂无可读书籍");
        });
        else deps.ensureLocalDataLoaded().then(function(ok) { if (ok) return fallback(); throw new Error("LOCAL_UNAVAILABLE"); }).catch(function() {
          if (!current(requestId, returnUrl)) return;
          deps.showToast("暂无可读书籍");
        });
      });
    }
    return { randomBook, randomTxt, getRandomLocal, fetchRandomReaderRecord, openReaderRecord, updateRandomTxtVisibility };
  }
  globalThis.VoiceOfMLRandomDiscovery = { create };
})();
