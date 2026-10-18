(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  let pdf = params.get("ext")?.toLowerCase() === "pdf";
  try { pdf ||= new URL(params.get("url")).pathname.toLowerCase().endsWith(".pdf"); } catch (_) {}
  const base = new URL("../../", document.currentScript.src).href;
  const extension = pdf ? "pdf" : (params.get("ext") || "").toLowerCase();
  const suffix = new URL(base).pathname.startsWith("/search/") ? "?reader-v1" : "";
  const assets = pdf ? ["pdf", "pdfWorker"].map(name => VoiceOfMLReaderResources.vendorUrl(name, base))
    : VoiceOfMLReaderResources.engineAssets(extension, base, suffix);
  // Fetch/compile bytes only. The Reader still owns engine execution, source
  // validation and rendering; no book body is speculatively downloaded here.
  for (const href of assets) {
    const link = document.createElement("link");
    link.rel = /\.mjs(?:\?|$)/.test(href) || href.includes("/foliate-reader/") ? "modulepreload" : "preload";
    if (link.rel === "preload") link.as = "script";
    link.href = href;
    document.head.appendChild(link);
  }
})();
