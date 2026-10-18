(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  let pdf = params.get("ext")?.toLowerCase() === "pdf";
  try { pdf ||= new URL(params.get("url")).pathname.toLowerCase().endsWith(".pdf"); } catch (_) {}
  const base = new URL("../../", document.currentScript.src).href;
  const extension = pdf ? "pdf" : (params.get("ext") || "").toLowerCase();
  const suffix = new URL(base).pathname.startsWith("/search/") ? "?reader-v1" : "";
  const workerWrapper = new URL("./pdf-worker-wrapper.mjs", document.currentScript.src).href;
  const assets = VoiceOfMLReaderResources.engineAssets(pdf ? "pdf" : extension, base, suffix, workerWrapper);
  // PDF.js loads its small ICC color engine synchronously in the Worker. Warm
  // only those pinned bytes; actual color conversion and Worker creation remain
  // document-owned, with exactly the same engine/quality and no book prefetch.
  const support = [];
  if (pdf) {
    support.push(workerWrapper);
    if (!navigator.connection?.saveData) support.push(...VoiceOfMLReaderResources.pdfSupportAssets(base));
    const controller = new AbortController();
    const dispose = () => controller.abort();
    const timer = setTimeout(dispose, 8000);
    addEventListener("pagehide", dispose, {once:true});
    addEventListener("voice-reader-dispose", dispose, {once:true});
    // Worker entry scripts and synchronous ICC XHR use no Origin header. A
    // crossorigin link preload has a different Vary: Origin cache identity on
    // HF, so warm these bytes with the same-origin fetch identity instead.
    Promise.allSettled(support.map(href => fetch(href, {
      mode:"same-origin", credentials:"same-origin", signal:controller.signal
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
    if (support.includes(href)) continue;
    const link = document.createElement("link");
    link.rel = /\.mjs(?:\?|$)/.test(href) || href.includes("/foliate-reader/") ? "modulepreload" : "preload";
    if (link.rel === "preload") link.as = "script";
    link.href = href;
    document.head.appendChild(link);
  }
})();
