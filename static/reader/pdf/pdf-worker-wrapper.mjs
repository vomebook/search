if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function(key, callback) {
    if (this.has(key)) return this.get(key);
    const value = callback(key);
    this.set(key, value);
    return value;
  };
}
if (!Math.sumPrecise) {
  Math.sumPrecise = function(values) {
    let sum = 0;
    let correction = 0;
    for (const value of values) {
      const next = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      sum = next;
    }
    return sum + correction;
  };
}

import "../../reader-resources.js";
const pendingMessages = [];
const bufferMessage = event => pendingMessages.push(event);
self.addEventListener("message", bufferMessage);

const staged = new URL(self.location.href).searchParams.get("reader-first-page") === "1";
const opening = staged
  ? import("./pdf-first-page-worker-adapter.mjs").then(adapter =>
      adapter.installFirstPageWorker(VoiceOfMLReaderResources.vendorUrl("pdfWorkerSource", "../../"),
        VoiceOfMLReaderResources.vendors.pdfWorkerSource.sha256)
    ).then(handler => { globalThis.pdfjsWorker = {WorkerMessageHandler:handler}; })
      .catch(() => import(VoiceOfMLReaderResources.vendorUrl("pdfWorker", "../../")))
  : import(VoiceOfMLReaderResources.vendorUrl("pdfWorker", "../../"));
opening.then(() => {
  self.removeEventListener("message", bufferMessage);
  for (const event of pendingMessages) self.dispatchEvent(new MessageEvent("message", { data: event.data }));
}).catch(error => { setTimeout(() => { throw error; }); });
