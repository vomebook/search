(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  let pdf = params.get("ext")?.toLowerCase() === "pdf";
  try { pdf ||= new URL(params.get("url")).pathname.toLowerCase().endsWith(".pdf"); } catch (_) {}
  if (!pdf) return;
  const base = new URL(".", document.currentScript.src).href;
  for (const name of ["pdf", "pdfWorker"]) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = VoiceOfMLReaderResources.vendorUrl(name, base);
    document.head.appendChild(link);
  }
})();
