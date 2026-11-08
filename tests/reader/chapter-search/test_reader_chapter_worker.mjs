import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {gzipSync} from "node:zlib";

// The real module's message handler, loader, SHA verification and search core
// execute with a controlled Worker-like global and a deterministic transport.
const isSpace = false;
const localOrigin = "https://reader.example";
const proxyOrigin = isSpace ? localOrigin : "https://voiceofml-search.hf.space";
const messages = [], requests = [];
const scope = {location: {origin: localOrigin}, postMessage: value => messages.push(structuredClone(value))};
Object.defineProperty(globalThis, "crypto", {configurable: true, value: webcrypto});
globalThis.self = scope;
let responseMode = "valid", packed, firstRead, firstFetch, releaseFetch, expire;
let streamCancelled = false;
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay === 60000) expire = fn;
  return nativeSetTimeout(fn, delay, ...args);
};
globalThis.fetch = async (url, options) => {
  requests.push({url: String(url), credentials: options.credentials, signal: options.signal});
  if (responseMode === "http") return new Response("unavailable", {status: 503});
  if (responseMode === "null") return new Response(null, {status: 204});
  if (responseMode === "throw") throw new Error("transport failed");
  if (responseMode === "throw-string") throw "transport string failure";
  if (responseMode === "stream-error") return new Response(new ReadableStream({
    pull() { throw new Error("stream read failed"); }
  }));
  if (responseMode === "wrong-bytes") return new Response(packed.subarray(1));
  if (responseMode === "too-large") {
    const chunk = new Uint8Array(16 * 1024 * 1024);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { streamCancelled = true; }
    }));
  }
  if (responseMode === "shared-fetch") {
    firstFetch();
    return new Promise(resolve => { releaseFetch = () => resolve(new Response(packed.subarray(1))); });
  }
  if (responseMode === "held-fetch") {
    responseMode = "valid";
    firstFetch();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {once: true});
    });
  }
  if (responseMode === "held-stream") {
    responseMode = "valid";
    return new Response(new ReadableStream({
      pull() { firstRead(); return new Promise(() => {}); },
      cancel() { streamCancelled = true; throw new Error("injected stream cancel error"); }
    }));
  }
  return new Response(packed);
};
await import("../../../static/reader/search/workers/reader-chapter-search-worker.mjs");
const send = async data => { await scope.onmessage({data}); };
const latest = () => messages.at(-1);
let id = 0;
async function search(query = "needle") { await send({type:"search", id:++id, query}); return latest(); }
async function buildConfiguration(data, chapters = [{index:1, path:"one", title:"First"}]) {
  packed = gzipSync(Buffer.from(JSON.stringify(data)));
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", packed)).toString("hex");
  return {index:{url:proxyOrigin + "/api/reader-content?url=source", bytes:packed.length, sha256}, chapters};
}
// Legacy manifests may use non-string titles and version-1 filters represented
// as array-like JSON. Neither was rejected by the previous implementation.
const legacyFilter = Object.assign({length:32}, Object.fromEntries(Array.from({length:32}, (_, i) => [i,255])));
const goodIndex = {version:1, kind:"epub-search-index", chapters:[
  {index:1,path:"one",text:"needle ".repeat(120)+"手机",bigramFilter:legacyFilter}
]};
let config = await buildConfiguration(goodIndex, [{index:1,path:"one",title:42}]);
assert.match((await search()).error, /索引无效/);
await send({type:"init", configuration:null});
assert.match((await search()).error, /索引无效/);
const before = messages.length;
await send(null); await send({type:"cancel"});
assert.equal(messages.length, before);
await send({type:"page", id:++id, session:null, offset:"bad"});
assert.match(latest().error, /索引无效/);
await send({type:"unknown", id:++id});
assert.match(latest().error, /索引无效/);
for (const index of [
  {...config.index, url:"https://evil.example/api/reader-content"},
  {...config.index, bytes:0}, {...config.index, bytes:64*1024*1024+1},
  {...config.index, sha256:"bad"},
  {...config.index, url:proxyOrigin+"/api/reader-bucket-resource?path=../bad"}
]) {
  await send({type:"init", configuration:{...config,index}});
  const count = requests.length;
  assert.match((await search()).error, /索引无效/);
  assert.equal(requests.length, count);
}
for (const [mode, expected] of [["http",/HTTP 503/],["null",/索引无效/],
    ["throw",/transport failed/],["throw-string",/transport string failure/],
    ["stream-error",/stream read failed/],["wrong-bytes",/校验失败/],["too-large",/超过大小限制/]]) {
  responseMode = mode; await send({type:"init", configuration:config});
  assert.match((await search()).error, expected, mode);
}
assert.equal(streamCancelled, true);
// Abort while the response stream is blocked in read(): the Worker must cancel
// the underlying stream and a subsequent fetch must still be possible.
responseMode = "held-stream"; streamCancelled = false;
await send({type:"init", configuration:config});
let reading = new Promise(resolve => { firstRead = resolve; });
const streamId = ++id, streamSearch = send({type:"search", id:streamId, query:"needle"});
await reading; await send({type:"cancel"}); await streamSearch;
assert.equal(streamCancelled, true);
assert.equal(messages.some(value => value.id === streamId), false);
responseMode = "valid";
config = await buildConfiguration({...goodIndex, kind:"invalid"});
await send({type:"init", configuration:config});
assert.match((await search()).error, /索引不完整/);
config = await buildConfiguration(goodIndex, [{index:1,path:"one",title:42}]);
await send({type:"init", configuration:config});
assert.match((await search(" ")).error, /1–2048/);
assert.match((await search("x".repeat(2049))).error, /1–2048/);

// Overlapping searches share one in-flight load; if that load fails, only the
// latest request receives the error and a later search is allowed to retry.
responseMode = "shared-fetch";
let sharedStarted = new Promise(resolve => { firstFetch = resolve; });
const requestCount = requests.length;
const oldId = ++id, old = send({type:"search", id:oldId, query:"needle"});
await sharedStarted;
const currentId = ++id, current = send({type:"search", id:currentId, query:"手机"});
assert.equal(requests.length, requestCount + 1);
releaseFetch(); await Promise.all([old, current]);
assert.equal(messages.some(value => value.id === oldId), false);
assert.equal(latest().id, currentId); assert.match(latest().error, /校验失败/);

// Drive the actual 60-second load deadline deterministically, without waiting.
responseMode = "held-fetch";
let timedStart = new Promise(resolve => { firstFetch = resolve; });
const timedId = ++id, timed = send({type:"search", id:timedId, query:"needle"});
await timedStart; assert.equal(typeof expire, "function"); expire(); await timed;
assert.equal(latest().id, timedId); assert.match(latest().error, /取消或加载超时/);

// Cancel while fetch is pending and retry before the aborted promise settles.
responseMode = "held-fetch";
let started = new Promise(resolve => { firstFetch = resolve; });
const abandonedId = ++id, abandoned = send({type:"search", id:abandonedId, query:"needle"});
await started; await send({type:"cancel"});
const resumedId = ++id, resumed = send({type:"search", id:resumedId, query:"needle"});
await Promise.all([abandoned, resumed]);
assert.equal(messages.some(value => value.id === abandonedId), false);
assert.equal(latest().id, resumedId); assert.equal(latest().total, 120);
assert.equal(latest().results.length, 50);
assert.equal(latest().results[0].location, "第 1 章 · 42");
const loadedRequests = requests.length;
const cached = await search("手机");
assert.equal(cached.total, 1);
assert.equal(requests.length, loadedRequests); // the validated index is cached
await send({type:"search", id:resumedId, query:"needle"});
assert.equal(latest().total, 120);
assert.equal(requests.at(-1).credentials, isSpace ? "same-origin" : "omit");
assert.ok(requests.at(-1).url.startsWith(proxyOrigin));
await send({type:"page", id:++id, session:resumedId, offset:100});
assert.equal(latest().offset, 100); assert.equal(latest().results.length, 20);
await send({type:"page", id:++id, session:resumedId, offset:9999});
assert.equal(latest().offset, 100); assert.equal(latest().results.length, 20);
await send({type:"page", id:++id, session:999, offset:0});
assert.match(latest().error, /取消/);
await send({type:"cancel"});
await send({type:"page", id:++id, session:resumedId, offset:0});
assert.match(latest().error, /取消/);
globalThis.setTimeout = nativeSetTimeout;
console.log("chapter Worker: transport, integrity, cancellation, retry and paging passed");
