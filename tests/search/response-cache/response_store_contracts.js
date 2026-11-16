const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const {spawnSync} = require("node:child_process");
const {test} = require("../../support/test_harness");
const {searchTestProjects} = require("../../support/search_test_projects");

for (const {name, root} of searchTestProjects()) {
function responseFixture() {
  let id = 0;
  const frames = new Map(), timers = new Map(), metadata = [];
  const context = vm.createContext({clock:0, view:"query", canUseInitialSearchPayload:()=>false,
    requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key; },
    cancelAnimationFrame(key) { frames.delete(key); },
    setTimeout(fn, delay) { assert.equal(delay, 0); const key = ++id; timers.set(key, fn); return key; },
    clearTimeout(key) { timers.delete(key); },
    remember(data) { metadata.push(data); data.metadataSeen = true; },
  });
  for (const file of ["static/search/response-cache.js", "static/search/requests/application/response-store.js"]) {
    const filename = path.join(root, file);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, {filename});
  }
  vm.runInContext(`Date.now = () => clock;
    globalThis.searchResponseStore = VoiceOfMLSearchResponseStore.create({
      limit:3, ttl:100, getSearchViewKey:()=>view, rememberSearchPageMetadata:remember
    });`, context);
  const source = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
  for (const name of ["cloneSearchData", "getCachedSearchResponse", "setCachedSearchResponse", "cancelPendingSearchCacheWrites"]) {
    const match = source.match(new RegExp("^function " + name + "\\([^]*?^\\}", "m"));
    assert(match, name + " remains a host wrapper");
    vm.runInContext(match[0], context);
  }
  function drain(queue) { const work = [...queue.values()]; queue.clear(); for (const fn of work) fn(); }
  return {context, store:context.searchResponseStore, frames, timers, metadata,
    frame:()=>drain(frames), timer:()=>drain(timers)};
}
const page = value => ({results:[{File:value}], total:20, page:2, page_size:1});

test(name + " host response copies isolate arrays, retain records and register metadata before copying", () => {
  const f = responseFixture(), c = f.context, data = page("a");
  for (const unknown of [null, undefined, 7, "text", {}, {results:"invalid"}]) {
    assert.equal(c.cloneSearchData(unknown), unknown);
  }
  assert.equal(f.metadata.length, 0);
  const copy = c.cloneSearchData(data);
  assert.notEqual(copy, data); assert.notEqual(copy.results, data.results);
  assert.equal(copy.results[0], data.results[0]); assert.equal(copy.metadataSeen, true);
  assert.equal(f.metadata[0], data);
  c.setCachedSearchResponse("page", data, true);
  data.results.push({File:"source mutation"});
  const pending = c.getCachedSearchResponse("page");
  pending.results.length = 0;
  assert.equal(c.getCachedSearchResponse("page").results.length, 1);
  f.frame(); assert.equal(f.store.cache.size, 0); f.timer();
  const persisted = c.getCachedSearchResponse("page");
  persisted.results.push({File:"read mutation"});
  assert.equal(c.getCachedSearchResponse("page").results.length, 1);
  assert.equal(c.getCachedSearchResponse("page").results[0], data.results[0]);
  c.clock = 50;
  c.setCachedSearchResponse("page", c.cloneSearchData(copy), true);
  assert.equal(f.frames.size, 0); assert.equal(f.store.cache.get("page").time, 0);
  c.setCachedSearchResponse("page", {...copy, anchor_index:9}, true);
  f.frame(); f.timer(); assert.equal(c.getCachedSearchResponse("page").anchor_index, 9);
});

test(name + " cancellation removes either scheduled stage and a fresh write can restart", () => {
  for (const afterFrame of [false, true]) {
    const f = responseFixture(), c = f.context;
    c.setCachedSearchResponse("old", page("old"), true);
    if (afterFrame) f.frame();
    assert.equal(afterFrame ? f.timers.size : f.frames.size, 1);
    c.cancelPendingSearchCacheWrites();
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.store.pendingWrites.size, 0);
    c.setCachedSearchResponse("new", page("new"), true);
    f.frame(); f.timer();
    assert.deepEqual([...f.store.cache.keys()], ["new"]);
  }
});

test(name + " pending reads precede committed memory, replace in insertion order and guard the current view", () => {
  const f = responseFixture(), c = f.context;
  c.setCachedSearchResponse("a", page("committed"));
  for (const key of ["a", "b", "c", "a", "d"]) c.setCachedSearchResponse(key, page(key), true);
  assert.deepEqual([...f.store.pendingWrites.keys()], ["c", "a", "d"]);
  assert.equal(c.getCachedSearchResponse("a").results[0].File, "a");
  c.view = "other";
  assert.equal(c.getCachedSearchResponse("a").results[0].File, "committed");
  assert.equal(c.getCachedSearchResponse("d"), null);
  f.frame(); f.timer();
  assert.deepEqual([...f.store.cache.keys()], ["a"]);
  assert.equal(f.store.pendingWrites.size, 0);
  c.setCachedSearchResponse("new", page("new"), true);
  f.frame(); c.view = "third"; f.timer();
  assert.equal(f.store.cache.has("new"), false);
});

test(name + " deferred writes preserve acquisition age and cannot revive expired responses", () => {
  const f = responseFixture(), c = f.context;
  c.setCachedSearchResponse("pending", page("pending"), true);
  c.clock = 99; assert(c.getCachedSearchResponse("pending"));
  c.clock = 100; assert.equal(c.getCachedSearchResponse("pending"), null);
  f.frame(); f.timer(); assert.equal(f.store.cache.has("pending"), false);
  c.clock = 200; c.setCachedSearchResponse("delayed", page("delayed"), true);
  c.clock = 250; f.frame(); f.timer();
  assert.equal(f.store.cache.get("delayed").time, 200);
  c.clock = 300; assert.equal(c.getCachedSearchResponse("delayed"), null);
  c.setCachedSearchResponse("expired", page("expired"), true);
  c.clock = 400; f.frame(); f.timer();
  assert.equal(f.store.cache.has("expired"), false);
});

test(name + " view changes preserve pending age, and immediate replacement wins over scheduled work", () => {
  const f = responseFixture(), c = f.context;
  c.setCachedSearchResponse("key", page("committed"));
  c.clock = 10; c.setCachedSearchResponse("key", page("pending"), true);
  c.view = "other"; c.clock = 109;
  assert.equal(c.getCachedSearchResponse("key"), null);
  assert.equal(f.store.pendingWrites.size, 1);
  c.view = "query";
  assert.equal(c.getCachedSearchResponse("key").results[0].File, "pending");
  c.clock = 110;
  assert.equal(c.getCachedSearchResponse("key"), null);
  assert.equal(f.store.pendingWrites.size, 0);
  c.setCachedSearchResponse("key", page("deferred"), true);
  f.frame();
  c.setCachedSearchResponse("key", page("immediate"));
  f.timer();
  assert.equal(c.getCachedSearchResponse("key").results[0].File, "immediate");
  assert.equal(f.store.cache.get("key").time, 110);

  c.setCachedSearchResponse("return", page("return"), true);
  f.frame(); c.view = "other"; c.clock = 209;
  assert.equal(c.getCachedSearchResponse("return"), null);
  c.view = "query"; f.timer();
  assert.equal(f.store.cache.get("return").time, 110);
  assert.equal(c.getCachedSearchResponse("return").results[0].File, "return");
  c.clock = 210; assert.equal(c.getCachedSearchResponse("return"), null);
});

test(name + " response store declarations enforce page and dependency contracts", () => {
  const source = `
    const deps: SearchResponseStoreDependencies = {
      limit: 3, ttl: 100, getSearchViewKey: () => "view",
      rememberSearchPageMetadata: page => { const total: number = page.total; void total; }
    };
    const store = VoiceOfMLSearchResponseStore.create(deps);
    const page = {results: [], total: 1, page: 1, page_size: 1, marker: "literal" as const};
    const marker: "literal" = store.cloneSearchData(page).marker;
    const cached: VoiceOfMLSearchWindowPageData | null = store.getCachedSearchResponse("key");
    void marker; void cached;
    store.setCachedSearchResponse("key", page, true, 1);
    // @ts-expect-error cache misses can be null
    const mustExist: VoiceOfMLSearchWindowPageData = store.getCachedSearchResponse("key");
    // @ts-expect-error a page cannot be null
    store.setCachedSearchResponse("key", null);
    // @ts-expect-error undefined is not a cacheable page
    store.setCachedSearchResponse("key", undefined);
    // @ts-expect-error incomplete page
    store.setCachedSearchResponse("key", {results: []});
    // @ts-expect-error cache keys must be strings
    store.setCachedSearchResponse(7, page);
    // @ts-expect-error clone input must be a page
    store.cloneSearchData("not a page");
    // @ts-expect-error view keys must be strings
    VoiceOfMLSearchResponseStore.create({...deps, getSearchViewKey: () => null});
    // @ts-expect-error TTL must be numeric
    VoiceOfMLSearchResponseStore.create({...deps, ttl: "100"});
    // @ts-expect-error metadata callback must accept a page
    VoiceOfMLSearchResponseStore.create({...deps, rememberSearchPageMetadata: (data: string) => { void data; }});
    // @ts-expect-error cache timestamps must be numbers
    store.cache.set("key", {time: "now", data: page});
    // @ts-expect-error pending entries require acquisition time
    store.pendingWrites.set("key", {data: page, viewKey: "view"});
    void mustExist;
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "response-store-types-"));
  try {
    const filename = path.join(dir, "contract.ts");
    fs.writeFileSync(filename, source);
    const result = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"),
      "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--noEmit",
      "--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler",
      filename, path.join(root, "typings/reader-globals.d.ts"),
      path.join(root, "typings/search-response-store.d.ts")], {encoding:"utf8"});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

test(name + " response store keeps acquisition TTL and underlying TTL with LRU promotion", () => {
  const f = responseFixture(), c = f.context;
  for (const key of ["a", "b", "c"]) c.setCachedSearchResponse(key, page(key));
  c.getCachedSearchResponse("a"); c.setCachedSearchResponse("d", page("d"));
  assert.deepEqual([...f.store.cache.keys()], ["c", "a", "d"]);
  c.clock = 99; assert(c.getCachedSearchResponse("a"));
  c.clock = 100; assert.equal(c.getCachedSearchResponse("a"), null);
  // Give the cache a fresh insertion timestamp and an older response timestamp
  // to exercise the wrapper boundary independently of the underlying cache.
  f.store.cache.set("boundary", {time:0, data:page("boundary")});
  assert.equal(c.getCachedSearchResponse("boundary"), null);
  c.clock = 101; assert.equal(c.getCachedSearchResponse("boundary"), null);
  assert.equal(f.store.cache.has("boundary"), false);
});

}
