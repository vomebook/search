import { openDjvuDocument } from "./reader-djvu-adapter.mjs";

const workerUrl = new URL("./reader-djvu-engine-worker.mjs", import.meta.url);

// Native URLs can be read directly without creating or fetching a page map.
// The complete source is bounded and hashed locally before worker ownership.
export async function openNativeDjvu(context) {
  const signal = context.readerAbortController.signal;
  const endpoint = context.readerDownloadApiUrl(`/api/reader-source-revision?url=${encodeURIComponent(context.sourceUrl)}`);
  const metadata = await context.fetchWithReaderTimeout(endpoint, context.READER_PROXY_TIMEOUT_MS, {signal});
  if (!metadata.ok) throw new Error(`DJVU_SOURCE_REVISION_HTTP_${metadata.status}`);
  const pinned = JSON.parse(await VoiceOfMLReaderSecurity.readText(metadata, 64 * 1024));
  const original = new URL(context.sourceUrl), resolved = new URL(pinned?.url);
  const originalRevision = /\/resolve\/([0-9a-f]{40})\//.exec(original.pathname)?.[1];
  if (resolved.origin !== 'https://huggingface.co' || resolved.username || resolved.password ||
      !['huggingface.co','hf-mirror.com'].includes(original.hostname) ||
      resolved.search || resolved.hash || !/^[0-9a-f]{40}$/.test(pinned.revision || '') ||
      (originalRevision && originalRevision !== pinned.revision) ||
      resolved.pathname !== original.pathname.replace(/\/(?:resolve|raw)\/(?:main|[0-9a-f]{40})\//,
        `/resolve/${pinned.revision}/`)) throw new Error('DJVU_SOURCE_REVISION_INVALID');
  const response = await context.fetchReaderUrl(resolved.href, {signal});
  if (!response.ok) throw new Error(`DJVU_SOURCE_HTTP_${response.status}`);
  let packed = await VoiceOfMLReaderSecurity.readBytes(response, VoiceOfMLReaderSecurity.LIMITS.documentBytes);
  signal.throwIfAborted?.();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',packed))]
    .map(value=>value.toString(16).padStart(2,'0')).join('');
  signal.throwIfAborted?.();
  const bytes = packed.byteOffset === 0 && packed.byteLength === packed.buffer.byteLength
    ? packed.buffer : packed.buffer.slice(packed.byteOffset,packed.byteOffset+packed.byteLength);
  // When a complete historical OCR manifest was supplied, check its claimed
  // source before any text request; never attach corrections to changed bytes.
  if (context.ocrManifestUrl) {
    try {
      const manifest = await context.readPdfOcrJson(context.ocrManifestUrl, VoiceOfMLReaderSecurity.LIMITS.manifestBytes, '', 0, 'high');
      VoiceOfMLReaderSecurity.validatePdfOcrManifest(manifest);
      if (manifest.source_sha256 !== hash) throw new Error('DJVU_OCR_SOURCE_MISMATCH');
      context.pdfOcrManifest = manifest;
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn('DjVu OCR text does not match this source; using embedded text', error);
      context.ocrManifestUrl = '';
      context.pdfOcrManifest = null;
    }
  }
  packed = null;
  const document = await openDjvuDocument({workerUrl,bytes,signal,
    cacheBytes:matchMedia('(max-width: 700px)').matches ? 32*1024*1024 : 64*1024*1024,cachePages:2});
  document.sourceSha256 = hash;
  context.trackReaderResource(()=>document.destroy());
  context.assertReaderActive();
  return document;
}

export async function openDirectDjvu(context, manifest, pageMapPromise) {
  const ref = manifest.primary.resource;
  const signal = context.readerAbortController.signal;
  // Never hand bytes to a Worker until size/hash and the page map have passed.
  const download = new AbortController();
  const stopDownload = () => download.abort(signal.reason);
  signal.addEventListener("abort", stopDownload, { once: true });
  if (signal.aborted) stopDownload();
  const source = (async () => {
    const response = await context.fetchReaderUrl(context.v3ResourceUrl(ref), { signal: download.signal });
    if (!response.ok) throw new Error(`DJVU_SOURCE_HTTP_${response.status}`);
    // A checksummed immutable primary has an exact expected length. Reject a
    // larger body immediately rather than buffering up to the generic ceiling.
    const bytes = await VoiceOfMLReaderSecurity.readBytes(response, Math.min(ref.bytes, VoiceOfMLReaderSecurity.LIMITS.documentBytes));
    signal.throwIfAborted?.();
    if (bytes.byteLength !== ref.bytes) throw new Error("DJVU_PRIMARY_SIZE_MISMATCH");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (hash !== ref.sha256) throw new Error("DJVU_PRIMARY_HASH_MISMATCH");
    return bytes;
  })();
  let packed, pageMap;
  try {
    [packed, pageMap] = await Promise.all([source, pageMapPromise]);
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
  const document = await openDjvuDocument({ workerUrl, bytes, pageMap, signal,
    cacheBytes: matchMedia("(max-width: 700px)").matches ? 32 * 1024 * 1024 : 64 * 1024 * 1024,
    cachePages: 2 });
  context.trackReaderResource(() => document.destroy());
  context.assertReaderActive();
  return document;
}
