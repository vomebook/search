(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  let pdf = params.get("ext")?.toLowerCase() === "pdf";
  try { pdf ||= new URL(params.get("url") ?? "").pathname.toLowerCase().endsWith(".pdf"); } catch (_) {}
  const script = /** @type {HTMLScriptElement} */ (document.currentScript);
  const base = new URL("../../", script.src).href;
  const extension = pdf ? "pdf" : (params.get("ext") || "").toLowerCase();
  const workerWrapper = new URL("./pdf-worker-wrapper.mjs", script.src).href;
  // Known DjVu opens need this graph, but not until the format controller
  // runs its dynamic import. Start all three dependency levels together and
  // before the ordered boot scripts; do not execute them or read book bytes.
  if (extension === "djvu" || extension === "djv") {
    for (const module of ["./reader-djvu-loader.mjs", "./reader-djvu-adapter.mjs",
      "./reader-djvu-identity.mjs", "./reader-djvu-range.mjs", "./reader-djvu-worker.mjs",
      "./reader-djvu-scheduler.mjs"]) {
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = new URL(module, script.src).href;
      document.head.appendChild(link);
    }
  }
  // Async warming must not hold up demand rendering. When it wins the
  // download race, wait for the two ordered bootstrap dependencies, not DCL
  // (the Reader module graph itself can still be fetching).
  const ready = () => typeof VoiceOfMLReaderResources !== "undefined" && typeof VoiceOfMLReaderSecurity !== "undefined";
  if (ready()) warm();
  else {
    const dependencies = [document.getElementById("reader-boot-security"), document.getElementById("reader-boot-resources")];
    const stop = () => {
      for (const node of dependencies) {
        node?.removeEventListener("load", start);
        node?.removeEventListener("error", stop);
      }
      removeEventListener("DOMContentLoaded", stop);
      removeEventListener("pagehide", stop);
      removeEventListener("voice-reader-dispose", stop);
    };
    const start = () => { if (ready()) { stop(); warm(); } };
    if (document.readyState === "complete" || document.documentElement.dataset.readerPhase) return;
    for (const node of dependencies) {
      node?.addEventListener("load", start);
      node?.addEventListener("error", stop);
    }
    addEventListener("DOMContentLoaded", stop, {once:true});
    addEventListener("pagehide", stop, {once:true});
    addEventListener("voice-reader-dispose", stop, {once:true});
  }

  function warm() {
    const phase = document.documentElement?.dataset.readerPhase;
    if (phase === "ready" || phase === "failed" || phase === "disposed") return;
    const assets = VoiceOfMLReaderResources.engineAssets(extension, base, workerWrapper);
    // PDF.js loads its small ICC color engine synchronously in the Worker. Warm
    // only those pinned bytes; actual color conversion and Worker creation remain
    // document-owned, with exactly the same engine/quality and no book prefetch.
    const support = [];
    if (pdf) {
      support.push(workerWrapper);
      if (!navigator.connection?.saveData) support.push(...VoiceOfMLReaderResources.pdfSupportAssets(base));
    } else if (!navigator.connection?.saveData) {
      support.push(...assets.filter(href => href.endsWith(".wasm")));
    }
    if (support.length) {
      const controller = new AbortController();
      const dispose = () => controller.abort();
      const timer = setTimeout(dispose, 8000);
      addEventListener("pagehide", dispose, {once:true});
      addEventListener("voice-reader-dispose", dispose, {once:true});
      // Worker entry scripts and synchronous ICC XHR use no Origin header. A
      // crossorigin link preload has a different Vary: Origin cache identity on
      // HF, so warm these bytes with the same-origin fetch identity instead.
      Promise.allSettled(support.map(href => fetch(href, {
        mode:pdf ? "same-origin" : "cors", credentials:"same-origin", signal:controller.signal
      }).then(response => {
        if (!response.ok) { response.body?.cancel().catch(() => {}); return; }
        return VoiceOfMLReaderSecurity.readBytes(response, 1024 * 1024);
      }))).finally(() => {
        clearTimeout(timer);
        removeEventListener("pagehide", dispose);
        removeEventListener("voice-reader-dispose", dispose);
      });
    }
    // Fetch/compile bytes only. The Reader still owns engine execution, source
    // validation and rendering; no book body is speculatively downloaded here.
    for (const href of assets) {
      if (support.includes(href) || href.endsWith(".wasm")) continue;
      const link = document.createElement("link");
      link.rel = /\.mjs(?:\?|$)/.test(href) ? "modulepreload" : "preload";
      if (link.rel === "preload") link.as = "script";
      link.href = href;
      document.head.appendChild(link);
    }
  }
})();
