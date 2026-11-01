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
let opening;
if (staged) {
  // Adapter code and its pinned worker source are independent immutable
  // assets. Fetch concurrently, but never execute the source before the
  // existing size, checksum and adapter-version checks complete.
  const owner = new AbortController();
  const timer = setTimeout(() => owner.abort(), 20000);
  const source = VoiceOfMLReaderResources.vendorUrl("pdfWorkerSource", "../../");
  const response = fetch(source, {signal:owner.signal, credentials:"same-origin", cache:"force-cache"});
  response.then(value => {
    if (owner.signal.aborted) value.body?.cancel().catch(() => {});
  }, () => {});
  opening = import("./pdf-first-page-worker-adapter.mjs").then(adapter =>
    adapter.installFirstPageWorker(source, VoiceOfMLReaderResources.vendors.pdfWorkerSource.sha256,
      {signal:owner.signal, response})
  ).then(handler => { globalThis.pdfjsWorker = {WorkerMessageHandler:handler}; })
    .catch(() => {
      owner.abort();
      response.then(value => value.body?.cancel().catch(() => {}), () => {});
      return import(VoiceOfMLReaderResources.vendorUrl("pdfWorker", "../../"));
    })
    .finally(() => clearTimeout(timer));
} else opening = import(VoiceOfMLReaderResources.vendorUrl("pdfWorker", "../../"));
opening.then(() => {
  self.removeEventListener("message", bufferMessage);
  for (const event of pendingMessages) self.dispatchEvent(new MessageEvent("message", { data: event.data }));
}).catch(error => { setTimeout(() => { throw error; }); });
