const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { test, run } = require("./test_harness");

const source = fs.readFileSync("sw.js", "utf8");
const CACHE_NAME = "vomebook-search-v1.0.0";

function response(body, options) {
  const settings = Object.assign({ ok: true, status: 200 }, options || {});
  return {
    body,
    ok: settings.ok,
    status: settings.status,
    clone() { return response(body, settings); },
    json() { return settings.jsonError ? Promise.reject(settings.jsonError) : Promise.resolve(JSON.parse(body)); },
  };
}

function keyOf(request) {
  return typeof request === "string" ? request : request.url;
}

function harness(options) {
  const settings = options || {};
  const listeners = {};
  const stores = new Map();
  const operations = { addAll: [], put: [], deleted: [], fetch: [], warnings: [], lifetimes: [], skipWaiting: 0, claim: 0 };
  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }
  if (settings.cacheEntries) stores.set(CACHE_NAME, new Map(settings.cacheEntries));
  if (settings.oldCaches) for (const name of settings.oldCaches) stores.set(name, new Map());
  const caches = {
    open(name) {
      if (settings.openError) return Promise.reject(settings.openError);
      const values = store(name);
      return Promise.resolve({
        addAll(urls) {
          operations.addAll.push(urls.slice());
          if (settings.addAllError && operations.addAll.length === (settings.addAllFailureCall || 1)) return Promise.reject(settings.addAllError);
          return Promise.resolve();
        },
        match(request) { return Promise.resolve(values.get(keyOf(request))); },
        put(request, value) {
          operations.put.push(keyOf(request));
          if (settings.put) return settings.put(request, value);
          values.set(keyOf(request), value); return Promise.resolve();
        },
      });
    },
    keys() { return Promise.resolve(Array.from(stores.keys())); },
    delete(name) { operations.deleted.push(name); stores.delete(name); return Promise.resolve(true); },
    match(request) {
      for (const values of stores.values()) if (values.has(keyOf(request))) return Promise.resolve(values.get(keyOf(request)));
      return Promise.resolve(undefined);
    },
  };
  const fetchImpl = settings.fetch || ((request) => Promise.resolve(response(`network:${keyOf(request)}`)));
  const context = {
    URL,
    caches,
    fetch(request) { operations.fetch.push(keyOf(request)); return fetchImpl(request); },
    console: {
      log: console.log,
      error: console.error,
      warn() { operations.warnings.push(Array.prototype.slice.call(arguments)); },
    },
    self: {
      location: { hostname: "example.test" },
      clients: { claim() { operations.claim += 1; return Promise.resolve(); } },
      skipWaiting() { operations.skipWaiting += 1; return Promise.resolve(); },
      addEventListener(type, listener) { listeners[type] = listener; },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "sw.js" });
  return { listeners, stores, operations };
}

function lifecycle(listener) {
  let promise;
  listener({ waitUntil(value) { promise = value; } });
  assert.ok(promise && typeof promise.then === "function");
  return promise;
}

function dispatchFetch(instance, url, mode, method) {
  let promise;
  instance.listeners.fetch({ request: { url, mode, method: method || "GET" },
    respondWith(value) { promise = value; }, waitUntil(value) { instance.operations.lifetimes.push(value); } });
  return promise;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function manifestsFetch(failPath) {
  const manifests = {
    "/search/data/initial/manifest.json": { urls: ["/search/data/initial/global.json"] },
    "/search/data/sidebar/manifest.json": { urls: ["/search/data/sidebar/global.json"] },
  };
  return (request) => {
    const url = keyOf(request);
    if (url === failPath) return Promise.reject(new Error("manifest unavailable"));
    return Promise.resolve(response(JSON.stringify(manifests[url])));
  };
}

test("registers install activate and fetch listeners", () => {
  const instance = harness();
  assert.deepStrictEqual(Object.keys(instance.listeners).sort(), ["activate", "fetch", "install"]);
});
test("install precaches only the search shell and global data", async () => {
  const instance = harness({ fetch: manifestsFetch() });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 1);
  assert.ok(instance.operations.addAll[0].includes("/search/static/app.js"));
  assert.ok(instance.operations.addAll[0].includes("/search/static/index-worker.js"));
  assert.ok(instance.operations.addAll[0].includes("/search/data/initial/global.json"));
  assert.ok(instance.operations.addAll[0].includes("/search/data/sidebar/global.json"));
  assert.ok(!instance.operations.addAll[0].some(url => /\/repos\/|\/reader\.(?:html|js|css)$/.test(url)));
  assert.deepStrictEqual(instance.operations.fetch, []);
  assert.strictEqual(instance.operations.skipWaiting, 1);
});
test("install tolerates one manifest fetch failure", async () => {
  const instance = harness({ fetch: manifestsFetch("/search/data/sidebar/manifest.json") });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 1);
  assert.deepStrictEqual(instance.operations.fetch, []);
  assert.strictEqual(instance.operations.skipWaiting, 1);
});
test("install ignores non-ok manifest responses", async () => {
  const instance = harness({ fetch: () => Promise.resolve(response("{}", { ok: false, status: 503 })) });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 1);
  assert.strictEqual(instance.operations.skipWaiting, 1);
});
test("core addAll failure is warned and install still activates", async () => {
  const instance = harness({ addAllError: new Error("quota"), fetch: manifestsFetch() });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.warnings.length, 1);
  assert.strictEqual(instance.operations.skipWaiting, 1);
  assert.strictEqual(instance.operations.fetch.length, 0, "manifests are not attempted after core precache failure");
});
test("payload addAll rejection is isolated inside manifest preload", async () => {
  const instance = harness({ addAllError: new Error("payload quota"), addAllFailureCall: 2, fetch: manifestsFetch() });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 1);
  assert.strictEqual(instance.operations.warnings.length, 0);
  assert.strictEqual(instance.operations.skipWaiting, 1);
});
test("activation deletes old caches and claims clients", async () => {
  const instance = harness({ oldCaches: ["old-a", "old-b"] });
  await lifecycle(instance.listeners.activate);
  assert.deepStrictEqual(instance.operations.deleted.sort(), ["old-a", "old-b"]);
  assert.strictEqual(instance.operations.claim, 1);
});
test("activation preserves the current cache", async () => {
  const instance = harness({ cacheEntries: [] });
  await lifecycle(instance.listeners.activate);
  assert.deepStrictEqual(instance.operations.deleted, []);
});
test("external request bypasses respondWith and network", () => {
  const instance = harness();
  assert.strictEqual(dispatchFetch(instance, "https://external.test/api/search"), undefined);
  assert.deepStrictEqual(instance.operations.fetch, []);
});
for (const method of ["HEAD", "POST"]) {
  test(`same-origin ${method} bypasses Service Worker caching`, () => {
    const instance = harness();
    assert.strictEqual(dispatchFetch(instance, "https://example.test/search/internal", "same-origin", method), undefined);
    assert.deepStrictEqual(instance.operations.fetch, []);
    assert.deepStrictEqual(instance.operations.put, []);
  });
}
test("reader navigations prefer the network and share one query-independent cache key", async () => {
  const cached = response("cached-reader");
  const network = response("network-reader");
  const instance = harness({ cacheEntries: [["/search/static/reader.html", cached]], fetch: () => Promise.resolve(network) });
  const url = "https://example.test/search/static/reader.html?url=one";
  assert.strictEqual(await dispatchFetch(instance, url, "navigate"), network);
  await tick();
  assert.deepStrictEqual(instance.operations.fetch, [url]);
  assert.deepStrictEqual(instance.operations.put, ["/search/static/reader.html"]);
});
test("cached responses return immediately while event lifetime covers delayed network and cache writes", async () => {
  const url = "https://example.test/search/data/search_data.json.gz";
  const cached = response("old");
  let networkDone, writeDone;
  const instance = harness({cacheEntries: [[url, cached]],
    fetch: () => new Promise(resolve => { networkDone = resolve; }),
    put: () => new Promise(resolve => { writeDone = resolve; }),
  });
  const result = dispatchFetch(instance, url);
  assert.strictEqual(instance.operations.lifetimes.length, 1);
  assert.strictEqual(await result, cached);
  let finished = false;
  instance.operations.lifetimes[0].then(() => { finished = true; });
  networkDone(response("new"));
  await tick();
  assert.strictEqual(finished, false);
  writeDone();
  await instance.operations.lifetimes[0];
  assert.strictEqual(finished, true);
});
test("network cache misses stream without waiting for persistent cache writes", async () => {
  let writeDone;
  const network = response("stream");
  const instance = harness({fetch: () => Promise.resolve(network), put: () => new Promise(resolve => { writeDone = resolve; })});
  assert.strictEqual(await dispatchFetch(instance, "https://example.test/search/static/app.js"), network);
  writeDone();
  await Promise.all(instance.operations.lifetimes);
});
test("unavailable Cache Storage and quota errors preserve successful network responses", async () => {
  for (const options of [{openError: new Error("storage unavailable")}, {put: () => Promise.reject(new Error("quota"))}]) {
    const network = response("usable");
    const instance = harness(Object.assign({fetch: () => Promise.resolve(network)}, options));
    assert.strictEqual(await dispatchFetch(instance, "https://example.test/search/static/app.js"), network);
    await Promise.all(instance.operations.lifetimes);
  }
});
test("generated data and Reader partial responses never enter the static cache", async () => {
  for (const path of ["data/search_data.json.gz", "static/reader.js"]) {
    const instance = harness({fetch: () => Promise.resolve(response("partial", {status: 206}))});
    assert.strictEqual((await dispatchFetch(instance, "https://example.test/search/" + path)).status, 206);
    await Promise.all(instance.operations.lifetimes);
    assert.deepStrictEqual(instance.operations.put, []);
  }
});

for (const route of [
  { name: "gzip", url: "https://example.test/search/data/search_data.json.gz" },
  { name: "initial JSON", url: "https://example.test/search/data/initial/global.json" },
  { name: "sidebar JSON", url: "https://example.test/search/data/sidebar/global.json" },
]) {
  test(`${route.name} cache hit returns cached response and revalidates`, async () => {
    const cached = response(`cached:${route.name}`);
    const instance = harness({ cacheEntries: [[route.url, cached]] });
    assert.strictEqual(await dispatchFetch(instance, route.url), cached);
    await tick();
    assert.deepStrictEqual(instance.operations.fetch, [route.url]);
    assert.deepStrictEqual(instance.operations.put, [route.url]);
  });
  test(`${route.name} cache miss returns network response and caches it`, async () => {
    const network = response(`network:${route.name}`);
    const instance = harness({ fetch: () => Promise.resolve(network) });
    assert.strictEqual(await dispatchFetch(instance, route.url), network);
    assert.deepStrictEqual(instance.operations.put, [route.url]);
  });
  test(`${route.name} cache hit survives network failure`, async () => {
    const cached = response(`cached:${route.name}`);
    const instance = harness({ cacheEntries: [[route.url, cached]], fetch: () => Promise.reject(new Error("offline")) });
    assert.strictEqual(await dispatchFetch(instance, route.url), cached);
  });
  test(`${route.name} cache miss plus network failure resolves undefined`, async () => {
    const instance = harness({ fetch: () => Promise.reject(new Error("offline")) });
    assert.strictEqual(await dispatchFetch(instance, route.url), undefined);
  });
  test(`${route.name} non-ok network response is not cached`, async () => {
    const network = response("bad", { ok: false, status: 503 });
    const instance = harness({ fetch: () => Promise.resolve(network) });
    assert.strictEqual(await dispatchFetch(instance, route.url), network);
    assert.deepStrictEqual(instance.operations.put, []);
  });
}

test("general static cache hit is returned while network updates cache", async () => {
  const url = "https://example.test/search/static/app.js";
  const cached = response("cached-app");
  const instance = harness({ cacheEntries: [[url, cached]] });
  assert.strictEqual(await dispatchFetch(instance, url), cached);
  await tick();
  assert.deepStrictEqual(instance.operations.put, [url]);
});
test("content-addressed cache hits need no network request", async () => {
  const url = "https://example.test/search/static/app.0123456789ab.js";
  const cached = response("pinned-app");
  const instance = harness({ cacheEntries: [[url, cached]] });
  assert.strictEqual(await dispatchFetch(instance, url), cached);
  await Promise.all(instance.operations.lifetimes);
  assert.deepStrictEqual(instance.operations.fetch, []);
});
test("general static cache miss returns and caches network response", async () => {
  const url = "https://example.test/search/static/style.css";
  const network = response("network-css");
  const instance = harness({ fetch: () => Promise.resolve(network) });
  assert.strictEqual(await dispatchFetch(instance, url), network);
  await tick();
  assert.deepStrictEqual(instance.operations.put, [url]);
});
test("general static network failure falls back to cache", async () => {
  const url = "https://example.test/search/static/app.js";
  const cached = response("cached-app");
  const instance = harness({ cacheEntries: [[url, cached]], fetch: () => Promise.reject(new Error("offline")) });
  assert.strictEqual(await dispatchFetch(instance, url), cached);
});
test("general static miss and network failure resolves undefined", async () => {
  const instance = harness({ fetch: () => Promise.reject(new Error("offline")) });
  assert.strictEqual(await dispatchFetch(instance, "https://example.test/search/missing.js"), undefined);
});
test("general static 206 response is not cached", async () => {
  const instance = harness({ fetch: () => Promise.resolve(response("partial", { status: 206 })) });
  const network = await dispatchFetch(instance, "https://example.test/search/file.bin");
  await tick();
  assert.strictEqual(network.status, 206);
  assert.deepStrictEqual(instance.operations.put, []);
});
test("general static non-ok response is not cached", async () => {
  const instance = harness({ fetch: () => Promise.resolve(response("missing", { ok: false, status: 404 })) });
  const network = await dispatchFetch(instance, "https://example.test/search/missing.js");
  await tick();
  assert.strictEqual(network.status, 404);
  assert.deepStrictEqual(instance.operations.put, []);
});

run("service worker");
