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
  const operations = { addAll: [], put: [], deleted: [], fetch: [], warnings: [], skipWaiting: 0, claim: 0 };
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
        put(request, value) { operations.put.push(keyOf(request)); values.set(keyOf(request), value); return Promise.resolve(); },
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

function dispatchFetch(instance, url) {
  let promise;
  instance.listeners.fetch({ request: { url }, respondWith(value) { promise = value; } });
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
test("install precaches core and both manifest payload lists", async () => {
  const instance = harness({ fetch: manifestsFetch() });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 3);
  assert.ok(instance.operations.addAll[0].includes("/search/static/app.js"));
  assert.ok(instance.operations.addAll[0].includes("/search/static/index-worker.js"));
  assert.deepStrictEqual(instance.operations.addAll[1], ["/search/data/initial/global.json"]);
  assert.deepStrictEqual(instance.operations.addAll[2], ["/search/data/sidebar/global.json"]);
  assert.strictEqual(instance.operations.skipWaiting, 1);
});
test("install tolerates one manifest fetch failure", async () => {
  const instance = harness({ fetch: manifestsFetch("/search/data/sidebar/manifest.json") });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 2);
  assert.deepStrictEqual(instance.operations.addAll[1], ["/search/data/initial/global.json"]);
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
  assert.strictEqual(instance.operations.addAll.length, 3);
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
