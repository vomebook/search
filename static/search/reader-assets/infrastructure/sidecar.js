// Reader asset sidecar ownership; site-specific behavior is retained.
(function () {
/** @param {ReaderAssetPaintDependencies} deps @param {ReaderAssetScheduling} scheduling */
function create(deps, scheduling) {
const state = { compressedLimit: 32 * 1024 * 1024, expandedLimit: 128 * 1024 * 1024 };
/** @param {ReadableStream<Uint8Array>} stream @param {number} limit @param {AbortSignal} signal */
function readBoundedReaderStream(stream, limit, signal) {
  if (!stream || typeof stream.getReader !== "function") throw new Error("READER_ASSETS_UNAVAILABLE");
  var reader = stream.getReader();
  /** @type {Uint8Array[]} */
  var chunks = [];
  var total = 0;
  var abort = function() { reader.cancel().catch(function() {}); };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  return (async function() {
    try {
      while (true) {
        if (signal && signal.aborted) throw new DOMException("Reader assets timed out", "AbortError");
        var part = await reader.read();
        if (signal && signal.aborted) throw new DOMException("Reader assets timed out", "AbortError");
        if (part.done) break;
        if (!part.value || !part.value.byteLength) continue;
        total += part.value.byteLength;
        if (total > limit) throw new Error("READER_ASSETS_LIMIT");
        chunks.push(part.value);
      }
      var bytes = new Uint8Array(total), offset = 0;
      chunks.forEach(function(chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
      return bytes;
    } catch (error) {
      await Promise.resolve(reader.cancel(error)).catch(function() { return undefined; });
      throw error;
    } finally {
      if (signal) signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  })();
}

/** @param {AbortSignal} signal @returns {Promise<void>} */
function yieldReaderAssetLoad(signal) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    /** @param {Function} callback @param {unknown} [value] */
    var finish = function(callback, value) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    var abort = function() { finish(reject, new DOMException("Reader assets timed out", "AbortError")); };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      scheduling.yieldConvertedReaderBuild().then(function() { finish(resolve); }, function(error) { finish(reject, error); });
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function fetchReaderAssetMap(deferDecode = false) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 10000);
  // renderBrowser runs inside route application. Capture the settled view key
  // in a microtask, rather than the intermediate state seen on entry.
  var firstView = deferDecode ? Promise.resolve().then(() => deps.getSearchViewKey()).catch(() => null) : null;
  try {
    var firstViewKey = firstView ? await firstView : null;
    var response = await fetch("/search/data/reader_assets.json.gz", { signal: controller.signal });
    if (!response.ok || !response.body || typeof DecompressionStream === "undefined") throw new Error("READER_ASSETS_UNAVAILABLE");
    var compressedLength = Number(response.headers && response.headers.get && response.headers.get("content-length"));
    if (Number.isFinite(compressedLength) && compressedLength > state.compressedLimit) {
      await Promise.resolve().then(function() { return /** @type {ReadableStream<Uint8Array>} */ (response.body).cancel(); }).catch(function() { return undefined; });
      throw new Error("READER_ASSETS_LIMIT");
    }
    var compressed = await readBoundedReaderStream(response.body, state.compressedLimit, controller.signal);
    if (firstView) await scheduling.waitForReaderAssetFirstPaint(controller.signal, firstViewKey);
    if (controller.signal.aborted) throw new DOMException("Reader assets timed out", "AbortError");
    var expandedStream = /** @type {ReadableStream<Uint8Array<ArrayBuffer>>} */ (new Response(/** @type {Uint8Array<ArrayBuffer>} */ (compressed)).body).pipeThrough(new DecompressionStream("gzip"));
    var expanded = await readBoundedReaderStream(expandedStream, state.expandedLimit, controller.signal);
    // Keep decoding and parsing separate from decompression so a pending
    // interaction can run between these individually expensive operations.
    await yieldReaderAssetLoad(controller.signal);
    var text = new TextDecoder().decode(expanded);
    await yieldReaderAssetLoad(controller.signal);
    var data = JSON.parse(text);
    if (!data || data.v !== 1 || !data.f || typeof data.f !== "object") throw new Error("READER_ASSETS_UNAVAILABLE");
    return data.f;
  } finally {
    clearTimeout(timer);
  }
}

return { state, fetchReaderAssetMap, readBoundedReaderStream };
}

globalThis.VoiceOfMLReaderAssetTransport = { create };
})();
