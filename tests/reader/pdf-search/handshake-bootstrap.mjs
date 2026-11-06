import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.location = new URL('https://voiceofml-search.hf.space/static/worker.mjs');
globalThis.postMessage = message => { parentPort.postMessage({wire: message}); };
let release;
globalThis.fetch = async (url, {signal} = {}) => {
  const key = String(url);
  parentPort.postMessage({event:'fetch', url:key, aborted:signal?.aborted});
  if (key === workerData.block) {
    await new Promise((resolve, reject) => {
      const abort = () => { parentPort.postMessage({event:'abort', url:key}); reject(new DOMException('aborted','AbortError')); };
      release = () => { signal?.removeEventListener('abort', abort); resolve(); };
      signal?.addEventListener('abort', abort, {once:true});
    });
    parentPort.postMessage({event:'released', url:key, aborted:signal?.aborted});
  }
  const bytes = workerData.resources[key];
  return bytes ? new Response(bytes) : new Response(null,{status:404});
};
await import(workerData.workerUrl);
let heldPrefetch;
parentPort.on('message', data => {
  if (data.fixture === 'release') { release?.(); return; }
  if (data.fixture === 'release-prefetch') {
    if (heldPrefetch) void globalThis.onmessage({data: heldPrefetch});
    heldPrefetch = undefined;
    return;
  }
  if (workerData.holdPrefetch && data.type === 'prefetch') {
    heldPrefetch = data;
    parentPort.postMessage({event:'prefetch-held', id:data.id});
    return;
  }
  void globalThis.onmessage({data});
});
