// Bounded, identity-pinned byte ranges for a single immutable DjVu source.
// A full-download fallback is legal only when the *first* request explicitly
// ignores Range. Bad/mismatched responses never become image data.
export async function openDjvuRange({url, signal, fetchResponse = fetch,
  readBytes = (response, limit) => VoiceOfMLReaderSecurity.readBytes(response, limit),
  windowBytes = 1024 * 1024, maxCacheBytes = 4 * 1024 * 1024,
  maxDocumentBytes = 512 * 1024 * 1024, timeoutMs = 60000, retries = 2} = {}) {
  if (typeof url !== 'string' || !signal || !Number.isSafeInteger(windowBytes) || windowBytes < 65536 ||
      windowBytes > 2 * 1024 * 1024 || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < windowBytes ||
      windowBytes % 65536 !== 0 || !Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 16 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(retries) || retries < 0 || retries > 3) throw new Error('DJVU_RANGE_CONFIG_INVALID');
  const owner = new AbortController(), cache = new Map(), active = new Map();
  let total = 0, etag = '', retained = 0, closed = false, failure = null, transferred = 0, requests = 0;
  const cancelled = () => signal.reason || new DOMException('DjVu range cancelled', 'AbortError');
  const stop = () => { owner.abort(cancelled()); cache.clear(); retained = 0; closed = true; };
  signal.addEventListener('abort', stop, {once:true});
  if (signal.aborted) stop();
  function check() {
    if (signal.aborted || closed) throw failure || (signal.aborted ? cancelled() : new DOMException('DjVu range closed','AbortError'));
  }
  function fail(error) {
    if (!failure) failure = error;
    owner.abort(failure); cache.clear(); retained = 0; closed = true;
    signal.removeEventListener('abort', stop);
    return failure;
  }
  const invalid = () => Object.assign(new Error('DJVU_RANGE_INVALID'), {code:'DJVU_RANGE_INVALID'});
  async function request(start, end, first = false) {
    check();
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController(), abort = () => controller.abort(owner.signal.reason);
      let timer = 0, response;
      owner.signal.addEventListener('abort', abort, {once:true});
      if (owner.signal.aborted) abort();
      try {
        timer = setTimeout(() => controller.abort(new DOMException('DjVu range timed out','TimeoutError')), timeoutMs);
        requests++;
        response = await fetchResponse(url, {headers:{Range:`bytes=${start}-${end}`,...(!first ? {'If-Range':etag} : {})}, signal:controller.signal, cache:'no-store'});
        if (first && response.status === 200) {
          await response.body?.cancel();
          throw Object.assign(new Error('DJVU_RANGE_UNSUPPORTED'), {code:'DJVU_RANGE_UNSUPPORTED'});
        }
        if ([408,429,500,502,503,504].includes(response.status))
          throw Object.assign(new Error(`DJVU_RANGE_HTTP_${response.status}`), {retryable:true});
        if (!first && response.status === 200) throw new Error('DJVU_SOURCE_CHANGED');
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        if (response.status !== 206 || !match) throw invalid();
        const [begin,last,size] = match.slice(1).map(Number);
        if (![begin,last,size].every(Number.isSafeInteger) || size < 16 || size > maxDocumentBytes ||
            begin !== start || last !== Math.min(end,size-1) || last < begin) throw invalid();
        const identity = response.headers.get('ETag') || '', encoding = response.headers.get('Content-Encoding');
        if (encoding && encoding !== 'identity') throw invalid();
        if (!/^"[^"\r\n]{1,250}"$/.test(identity)) {
          if (first && (!identity || /^W\/"[^"\r\n]{1,250}"$/.test(identity)))
            throw Object.assign(new Error('DJVU_RANGE_UNSUPPORTED'), {code:'DJVU_RANGE_UNSUPPORTED'});
          throw invalid();
        }
        if (!first && (size !== total || identity !== etag)) throw new Error('DJVU_SOURCE_CHANGED');
        const declared = response.headers.get('Content-Length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== last-begin+1)) throw invalid();
        const bytes = await readBytes(response,last-begin+1);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== last-begin+1) throw invalid();
        check();transferred += bytes.byteLength;
        return {bytes,total:size,etag:identity};
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        if (signal.aborted || closed) throw failure || cancelled();
        const timedOut = controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError';
        if (attempt < retries && (error?.retryable || error?.name === 'TypeError' || timedOut)) continue;
        throw error;
      } finally {
        clearTimeout(timer);owner.signal.removeEventListener('abort',abort);
      }
    }
  }
  function keep(start, bytes) {
    const previous=cache.get(start);if(previous)retained-=previous.byteLength;
    cache.delete(start);cache.set(start,bytes);retained+=bytes.byteLength;
    while(retained>maxCacheBytes){const key=cache.keys().next().value;retained-=cache.get(key).byteLength;cache.delete(key);}
  }
  try {
    const first=await request(0,windowBytes-1,true);
    total=first.total;etag=first.etag;keep(0,first.bytes);
  } catch (error) { fail(error);throw error; }
  async function read(offset,length) {
    check();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 ||
        offset+length > total || length > windowBytes) throw invalid();
    const start=Math.floor(offset/windowBytes)*windowBytes,end=Math.min(total,start+windowBytes);
    if (offset+length > end) throw invalid();
    let bytes=cache.get(start);
    if (!bytes) {
      if (!active.has(start)) active.set(start,request(start,end-1).then(result=>{
        check();keep(start,result.bytes);return result.bytes;
      }).catch(error=>{throw fail(error)}).finally(()=>active.delete(start)));
      bytes=await active.get(start);
    } else { cache.delete(start);cache.set(start,bytes); }
    check();return bytes.slice(offset-start,offset-start+length);
  }
  return Object.freeze({read,total,etag,close(){if(!closed)stop();signal.removeEventListener('abort',stop);},
    get failure(){return failure;},stats:()=>({requests,transferred,retained,windows:cache.size})});
}
