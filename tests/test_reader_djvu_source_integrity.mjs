import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {openDirectDjvu, openNativeDjvu} from '../static/reader/pdf/reader-djvu-loader.mjs';

Object.defineProperty(globalThis, 'crypto', {configurable: true, value: webcrypto});
globalThis.matchMedia = () => ({matches: false});
globalThis.VoiceOfMLReaderSecurity = {
  LIMITS: {documentBytes: 512 * 1024 * 1024},
  async readBytes(response, limit) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('READER_RESOURCE_LIMIT');
    return bytes;
  },
  async readText(response, limit) { return new TextDecoder().decode(await this.readBytes(response,limit)); }
};
let workers = 0;
globalThis.Worker = class { constructor() { workers++; throw new Error('unexpected decoder start'); } };
const bytes = new TextEncoder().encode('AT&TFORM fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = {primary: {resource: {kind: 'dataset-source', bytes: bytes.length, sha256}}};
const url = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/' + 'a'.repeat(40) + '/book.djvu';
function context(fetchReaderUrl, controller = new AbortController()) {
  return {readerAbortController: controller, v3ResourceUrl: () => url, fetchReaderUrl,
    assertReaderActive: () => controller.signal.throwIfAborted(), trackReaderResource() {}};
}
{
  const contextValue = context(async actual => {
    assert.equal(actual, url);
    const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
    return new Response(corrupt);
  });
  await assert.rejects(openDirectDjvu(contextValue, manifest, Promise.resolve({})), /DJVU_PRIMARY_HASH_MISMATCH/);
  assert.equal(workers, 0, 'corrupt source must not reach decoder');
}
{
  const contextValue = context(async () => new Response(bytes.slice(0, -1)));
  await assert.rejects(openDirectDjvu(contextValue, manifest, Promise.resolve({})), /DJVU_PRIMARY_SIZE_MISMATCH/);
  assert.equal(workers, 0, 'truncated source must not reach decoder');
}
{
  let started, release;
  const waiting = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const contextValue = context((_url, options) => new Promise((resolve, reject) => {
    release = resolve;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
    started();
  }), controller);
  const opening = openDirectDjvu(contextValue, manifest, Promise.resolve({}));
  await waiting;
  controller.abort();
  await assert.rejects(opening, {name: 'AbortError'});
  release(new Response(bytes));
  assert.equal(workers, 0, 'cancelled download must not reach decoder');
}
{
  let stopped = false;
  const contextValue = context((_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { stopped = true; reject(new DOMException('aborted', 'AbortError')); }, {once: true});
  }));
  await assert.rejects(openDirectDjvu(contextValue, manifest, Promise.reject(new Error('bad page map'))), /bad page map/);
  assert.equal(stopped, true, 'failed page map cancels source download');
  assert.equal(workers, 0);
}
{
  let sourceReads=0;
  const value = context(async()=>{sourceReads++;return new Response(bytes);});
  Object.assign(value,{sourceUrl:url,readerDownloadApiUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async()=>new Response(JSON.stringify({revision:'b'.repeat(40),
      url:url.replace('a'.repeat(40),'b'.repeat(40))}))});
  await assert.rejects(openNativeDjvu(value),/DJVU_SOURCE_REVISION_INVALID/);
  assert.equal(sourceReads,0,'changed immutable revision must not be downloaded');
  assert.equal(workers,0);
}
console.log('DjVu dataset source size, hash, cancellation and map-failure guards passed');
