import { openDjvuDocument } from "./reader-djvu-adapter.mjs";

const libraryUrl = new URL("/search/static/vendor/djvujs-gpl-v0.5.4.js", location.origin).href;
let enginePromise;

function loadEngine(context) {
  if (window.DjVu?.Worker) return Promise.resolve(window.DjVu);
  if (!enginePromise) enginePromise = context.loadScript(libraryUrl).then(() => {
    if (!window.DjVu?.Worker) throw new Error("DJVU_ENGINE_UNAVAILABLE");
    return window.DjVu;
  }).catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

export async function openDirectDjvu(context, manifest, pageMapPromise) {
  const ref = manifest.primary.resource;
  const signal = context.readerAbortController.signal;
  // Start source, page map and engine concurrently, but do not hand the bytes
  // to a Worker until size/hash and the independent page map have passed.
  const download = new AbortController();
  const stopDownload = () => download.abort(signal.reason);
  signal.addEventListener("abort", stopDownload, { once: true });
  if (signal.aborted) stopDownload();
  const source = (async () => {
    const response = await context.fetchReaderUrl(context.v3ResourceUrl(ref), { signal: download.signal });
    if (!response.ok) throw new Error(`DJVU_SOURCE_HTTP_${response.status}`);
    // Reject an oversized primary immediately instead of buffering to the
    // generic document ceiling; exact bytes are verified before decoding.
    const bytes = await VoiceOfMLReaderSecurity.readBytes(response, Math.min(ref.bytes, VoiceOfMLReaderSecurity.LIMITS.documentBytes));
    signal.throwIfAborted?.();
    if (bytes.byteLength !== ref.bytes) throw new Error("DJVU_PRIMARY_SIZE_MISMATCH");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (hash !== ref.sha256) throw new Error("DJVU_PRIMARY_HASH_MISMATCH");
    return bytes;
  })();
  let packed, pageMap, DjVu;
  try {
    [packed, pageMap, DjVu] = await Promise.all([source, pageMapPromise, loadEngine(context)]);
  } catch (error) {
    download.abort();
    throw error;
  } finally {
    signal.removeEventListener("abort", stopDownload);
  }
  context.assertReaderActive();
  const bytes = packed.byteOffset === 0 && packed.byteLength === packed.buffer.byteLength
    ? packed.buffer : packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
  packed = null;
  const document = await openDjvuDocument({ DjVu, libraryUrl, bytes, pageMap, signal,
    cacheBytes: matchMedia("(max-width: 700px)").matches ? 32 * 1024 * 1024 : 64 * 1024 * 1024,
    cachePages: 2 });
  context.trackReaderResource(() => document.destroy());
  context.assertReaderActive();
  return document;
}
