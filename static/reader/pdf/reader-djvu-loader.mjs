import { openDjvuDocument } from "./reader-djvu-adapter.mjs";
import { openDjvuRange } from "./reader-djvu-range.mjs";
import { createDjvuWorkerAdapter } from "./reader-djvu-worker.mjs";
import { resolveDjvuSource } from "./reader-djvu-identity.mjs";

/** @typedef {{bytes: number, sha256: string}} DjvuPrimaryRef */
/** @typedef {{primary: {resource: DjvuPrimaryRef}}} DjvuManifest */
/** @typedef {{readerAbortController: AbortController, sourceUrl: string, ocrManifestUrl: string,
 * READER_PROXY_TIMEOUT_MS: number, pdfOcrManifest: unknown,
 * readerDownloadApiUrl(path: string): string, readerContentUrl(url: string): string,
 * fetchWithReaderTimeout(url: string, timeout: number, options?: RequestInit): Promise<Response>,
 * fetchReaderUrl(url: string, options: RequestInit): Promise<Response>,
 * readPdfOcrJson(url: string, limit: number, sha: string, retry: number, priority: string): Promise<unknown>,
 * trackReaderResource(cleanup: () => void): () => void, assertReaderActive(): void, v3ResourceUrl(ref: DjvuPrimaryRef): string}} DjvuContext */
/** @typedef {Awaited<ReturnType<typeof openDjvuRange>>} DjvuRange */
/** @param {unknown} error @returns {error is Record<string, unknown>} */
function isErrorDetail(error) { return error !== null && (typeof error === 'object' || typeof error === 'function'); }
/** @param {DjvuRange | undefined} range @returns {DjvuRange} */
function requireRange(range) { if (!range) throw new Error('DJVU_RANGE_INVALID'); return range; }
/** @param {Response} response @param {DjvuRange} range */
function sameOutlineSource(response,range) {
  const encoding=response.headers.get('Content-Encoding'),size=response.headers.get('Content-Length');
  if (response.status!==200 || response.headers.get('ETag')!==range.etag || (encoding && encoding!=='identity')) return false;
  return size===null || (/^\d+$/.test(size) && Number(size)===range.total);
}
/** @param {AbortSignal} signal */
function checkOutlineAbort(signal) {
  if (signal.aborted) throw signal.reason || new DOMException('DjVu outline cancelled','AbortError');
}
/** @param {DjvuContext} context @param {URL} resolved @param {DjvuRange} range @param {AbortSignal} signal @param {number} cacheBytes */
async function openFullOutline(context,resolved,range,signal,cacheBytes) {
  const response=await context.fetchReaderUrl(resolved.href,{signal});
  if (!sameOutlineSource(response,range)) {
    await response.body?.cancel().catch(()=>{});
    throw new Error('DJVU_SOURCE_CHANGED');
  }
  const packed=await VoiceOfMLReaderSecurity.readBytes(response,range.total);
  checkOutlineAbort(signal);
  if (packed.byteLength!==range.total) throw new Error('DJVU_SOURCE_CHANGED');
  const bytes=packed.byteOffset===0 && packed.byteLength===packed.buffer.byteLength ? packed.buffer :
    packed.buffer.slice(packed.byteOffset,packed.byteOffset+packed.byteLength);
  const full=await openDjvuDocument({workerUrl,bytes,signal,cacheBytes,cachePages:1});
  const destroy=()=>{signal.removeEventListener('abort',destroy);full.destroy();};
  signal.addEventListener('abort',destroy,{once:true});
  if(signal.aborted){destroy();checkOutlineAbort(signal);}
  return {...full,destroy};
}
/** @param {unknown} failure */
function transportAllowsFallback(failure) {
  const detail=isErrorDetail(failure) ? failure : null;
  return !failure || ['AbortError','TimeoutError'].some(value=>value===detail?.name) || detail?.code === 'DJVU_RANGE_UNSUPPORTED';
}
/** @param {unknown} error */
function supportsFallback(error) {
  const detail=isErrorDetail(error) ? error : null;
  const code=detail?.code || detail?.message;
  return ['DJVU_RANGE_UNSUPPORTED','DJVU_LAZY_UNSUPPORTED','DJVU_LAZY_METADATA_UNSUPPORTED'].some(value=>value===code);
}
/** @param {unknown} transportFailure @param {unknown} error */
function requireSupportedFallback(transportFailure,error) {
  if (!transportAllowsFallback(transportFailure)) throw transportFailure;
  if (!supportsFallback(error)) throw error;
}
/** @param {DjvuContext} context @param {URL} resolved @param {AbortSignal} signal @param {number} cacheBytes */
async function openFullNative(context,resolved,signal,cacheBytes) {
  const response = await context.fetchReaderUrl(resolved.href, {signal});
  if (!response.ok) throw new Error(`DJVU_SOURCE_HTTP_${response.status}`);
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let packed = await VoiceOfMLReaderSecurity.readBytes(response, VoiceOfMLReaderSecurity.LIMITS.documentBytes);
  signal.throwIfAborted?.();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',packed))]
    .map(value=>value.toString(16).padStart(2,'0')).join('');
  signal.throwIfAborted?.();
  const bytes = packed.byteOffset === 0 && packed.byteLength === packed.buffer.byteLength
    ? packed.buffer : packed.buffer.slice(packed.byteOffset,packed.byteOffset+packed.byteLength);
  if (context.ocrManifestUrl) await attachHistoricalOcr(context,hash,signal);
  packed = null;
  const opened = await openDjvuDocument({workerUrl,bytes,signal,cacheBytes,cachePages:2});
  const document = Object.assign(opened,{sourceSha256:hash});
  context.trackReaderResource(()=>document.destroy());
  context.assertReaderActive();
  return document;
}
/** @param {DjvuContext} context @param {string} hash @param {AbortSignal} signal */
async function attachHistoricalOcr(context,hash,signal) {
  try {
    const raw = await context.readPdfOcrJson(context.ocrManifestUrl, VoiceOfMLReaderSecurity.LIMITS.manifestBytes, '', 0, 'high');
    VoiceOfMLReaderSecurity.validatePdfOcrManifest(raw);
    if (!isErrorDetail(raw) || raw.source_sha256 !== hash) throw new Error('DJVU_OCR_SOURCE_MISMATCH');
    context.pdfOcrManifest = raw;
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('DjVu OCR text does not match this source; using embedded text', error);
    context.ocrManifestUrl = '';
    context.pdfOcrManifest = null;
  }
}
const workerUrl = new URL("./reader-djvu-engine-worker.mjs", import.meta.url);

// Native URLs can be read directly without creating or fetching a page map.
/** @param {DjvuContext} context */
export async function openNativeDjvu(context) {
  const signal = context.readerAbortController.signal;
  const resolved = await resolveDjvuSource(context,context.sourceUrl,signal);
  const cacheBytes=matchMedia('(max-width: 700px)').matches ? 32*1024*1024 : 64*1024*1024;
  // Historical OCR is retained only under the already-established full-source
  // SHA-256 check below. Until the bytes can be independently authenticated,
  // never substitute OCR from an unverified metadata claim.
  if (!context.ocrManifestUrl) {
    /** @type {DjvuRange | undefined} */
    let range;
    /** @type {ReturnType<typeof createDjvuWorkerAdapter> | undefined} */
    let documentWorker;
    const stopBootstrap=new AbortController();
    const abortBootstrap=()=>stopBootstrap.abort(signal.reason);
    signal.addEventListener('abort',abortBootstrap,{once:true});
    if (signal.aborted) abortBootstrap();
    const stopOutline=new AbortController();
    const abortOutline=()=>stopOutline.abort(signal.reason);
    signal.addEventListener('abort',abortOutline,{once:true});
    if(signal.aborted)abortOutline();
    const outlineFallback=()=>openFullOutline(context,resolved,requireRange(range),stopOutline.signal,cacheBytes);
    /** @type {typeof fetch} */
    const fetchResponse=(url,options)=>context.fetchWithReaderTimeout(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,context.READER_PROXY_TIMEOUT_MS,options);
    try {
      const rangeUrl=context.readerContentUrl(resolved.href);
      const opening=openDjvuRange({signal:stopBootstrap.signal,fetchResponse,url:rangeUrl,
        readBytes:(response,limit)=>VoiceOfMLReaderSecurity.readBytes(response,limit),
        timeoutMs:context.READER_PROXY_TIMEOUT_MS}).then(value=>{range=value;return value;});
      // Decoder initialization and the first validated Range are independent.
      // Start both after revision pinning; neither is sufficient to show a page.
      /** @type {import('./reader-djvu-worker.mjs').DjvuRangeReader} */
      const deferredRange = {get total(){return range?.total ?? 0}, get failure(){return range?.failure},
        read:(offset,length)=>requireRange(range).read(offset,length), close:()=>range?.close()};
      const preparing=Promise.resolve().then(()=>{
        documentWorker=createDjvuWorkerAdapter(workerUrl,{cacheBytes,rangeReader:deferredRange});
        return documentWorker.prepare(stopBootstrap.signal);
      });
      await Promise.all([opening,preparing]);
      const document=await openDjvuDocument({workerUrl,rangeReader:range,preparedWorker:documentWorker,
        signal,outlineFallback,cacheBytes,cachePages:2});
      // Until the transport has authenticated all slices as one immutable
      // object, do not claim to have locally computed a whole-file digest.
      context.trackReaderResource(()=>{stopOutline.abort();stopBootstrap.abort();
        signal.removeEventListener('abort',abortOutline);signal.removeEventListener('abort',abortBootstrap);document.destroy();});
      context.assertReaderActive();
      return document;
    } catch (error) {
      stopOutline.abort();stopBootstrap.abort();signal.removeEventListener('abort',abortOutline);
      signal.removeEventListener('abort',abortBootstrap);documentWorker?.close();
      const transportFailure=range?.failure;
      range?.close();
      if (signal.aborted) throw error;
      // Only an explicit lack of Range support or an unsupported lazy index
      // may use the previous full-original path. Network errors, mismatches,
      // corruption and security failures remain errors, not silent success.
      requireSupportedFallback(transportFailure,error);
    }
  }
  return openFullNative(context,resolved,signal,cacheBytes);
}

/** @param {DjvuContext} context @param {DjvuManifest} manifest @param {Promise<unknown>} pageMapPromise */
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
