const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { test, run } = require("../support/test_harness");

const source = fs.readFileSync("static/sw.js", "utf8");
function cacheName(text = source) {
  return new RegExp('const CACHE_PREFIX = "([^"]+)"').exec(text)[1] +
    new RegExp('const CACHE_VERSION = "([^"]+)"').exec(text)[1];
}
const CACHE_NAME = cacheName();
const METADATA_CACHE = 'vomebook-search-metadata';
const ACTIVE_KEY = '/search/.sw-active-generation';
function generationState(stores) {
  return stores.get(METADATA_CACHE).get(ACTIVE_KEY).json();
}
function generationSource(version, paths) {
  return source.replace('"development"', JSON.stringify(version))
    .replace('const CURRENT_HASHED_ASSETS = []', 'const CURRENT_HASHED_ASSETS = ' + JSON.stringify(paths));
}

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
  const stores = settings.stores || new Map();
  const operations = { addAll: [], put: [], deleted: [], fetch: [], warnings: [], lifetimes: [], skipWaiting: 0, claim: 0 };
  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }
  if (settings.cacheEntries) stores.set(cacheName(settings.source), new Map(settings.cacheEntries));
  if (settings.oldCaches) for (const name of settings.oldCaches) stores.set(name, new Map());
  const caches = {
    open(name) {
      if (settings.openError) return Promise.reject(settings.openError);
      const values = store(name);
      return Promise.resolve({
        addAll(urls) {
          operations.addAll.push(urls.slice());
          if (settings.addAllError && operations.addAll.length === (settings.addAllFailureCall || 1)) return Promise.reject(settings.addAllError);
          for (const url of urls) values.set(keyOf(url), response('precache:' + keyOf(url)));
          return Promise.resolve();
        },
        match(request, options) {
          if (settings.match) return settings.match(request, options, values);
          const key = keyOf(request);
          return Promise.resolve(values.get(key) || values.get(key.replace('https://example.test', '')));
        },
        keys() { return Promise.resolve(Array.from(values.keys(), url => ({url: new URL(url, 'https://example.test').href}))); },
        delete(request) {
          if (settings.entryDeleteError) return Promise.reject(settings.entryDeleteError);
          const key = keyOf(request);
          return Promise.resolve(values.delete(key) || values.delete(key.replace('https://example.test', '')));
        },
        put(request, value) {
          operations.put.push(keyOf(request));
          if (settings.put) return settings.put(request, value);
          values.set(keyOf(request), value); return Promise.resolve();
        },
      });
    },
    keys() { return Promise.resolve(Array.from(stores.keys())); },
    delete(name) {
      operations.deleted.push(name);
      if (settings.deleteError) return Promise.reject(settings.deleteError);
      stores.delete(name); return Promise.resolve(true);
    },
    match(request) {
      for (const values of stores.values()) if (values.has(keyOf(request))) return Promise.resolve(values.get(keyOf(request)));
      return Promise.resolve(undefined);
    },
  };
  const fetchImpl = settings.fetch || ((request) => Promise.resolve(response(`network:${keyOf(request)}`)));
  const context = {
    importScripts() {}, VoiceOfMLReaderResources: require('../../static/reader-resources.js'),
    URL, Request: settings.Request,
    Response: function(body, options) { return response(body, options); },
    caches,
    fetch(request) { operations.fetch.push(keyOf(request)); return fetchImpl(request); },
    console: {
      log: console.log,
      error: console.error,
      warn() { operations.warnings.push(Array.prototype.slice.call(arguments)); },
    },
    self: {
      location: { hostname: "example.test", origin: "https://example.test" },
      clients: { claim() { operations.claim += 1; return Promise.resolve(); } },
      skipWaiting() { operations.skipWaiting += 1; return Promise.resolve(); },
      addEventListener(type, listener) { listeners[type] = listener; },
    },
  };
  vm.createContext(context);
  vm.runInContext(settings.source || source, context, { filename: "sw.js" });
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

class MockRequest {
  constructor(input, init) {
    this.url = typeof input === "string" ? input : input.url;
    this.mode = typeof input === "string" ? "cors" : input.mode;
    this.cache = (init && init.cache) || "default";
  }
}
test("unversioned shells and data revalidate past the HTTP cache; pinned hashes do not", async () => {
  const hashed = source.replace('"/search/static/app.js",', '"/search/static/app.0123456789ab.js",');
  const install = harness({ Request: MockRequest, source: hashed, fetch: manifestsFetch() });
  await lifecycle(install.listeners.install);
  const byUrl = new Map(install.operations.addAll[0].map(item => [keyOf(item), item]));
  for (const url of ["/search/", "/search/data/initial/global.json", "/search/static/style.css"]) {
    assert.strictEqual(byUrl.get(url).cache, "no-cache", url);
  }
  assert.strictEqual(byUrl.get("/search/static/app.0123456789ab.js"), "/search/static/app.0123456789ab.js");
  for (const [pathname, mode] of [["/search/", "navigate"], ["/search/static/reader.html", "navigate"], ["/search/data/sidebar/global.json", "cors"]]) {
    const requests = [];
    const instance = harness({ Request: MockRequest, fetch(request) { requests.push(request); return Promise.resolve(response("fresh")); } });
    await dispatchFetch(instance, "https://example.test" + pathname, mode);
    await Promise.all(instance.operations.lifetimes);
    assert.ok(requests[0] instanceof MockRequest, pathname);
    assert.strictEqual(requests[0].cache, "no-cache", pathname);
  }
  const requests = [];
  const pinned = harness({ Request: MockRequest, fetch(request) { requests.push(request); return Promise.resolve(response("fresh")); } });
  await dispatchFetch(pinned, "https://example.test/search/static/app.0123456789ab.js");
  await Promise.all(pinned.operations.lifetimes);
  assert.ok(!(requests[0] instanceof MockRequest));
});
test("content-addressed DjVu decoder survives activation and reuses cached bytes", async () => {
  const path = "/search/static/vendor/djvu-rs-reader/release-a03526f445b4-a99c0e299e95/simd128/djvu_rs.js";
  const url = "https://example.test" + path;
  const old = "https://example.test/search/static/vendor/djvu-rs-reader/release-aaaaaaaaaaaa-bbbbbbbbbbbb/scalar/djvu_rs_bg.wasm";
  const configured = source.replace("const CURRENT_HASHED_ASSETS = []", 'const CURRENT_HASHED_ASSETS = ["/search/static/app.111111111111.js", "' + path + '"]');
  const instance = harness({ source: configured });
  instance.stores.set('vomebook-search-v1.0.0', new Map([[url, response("cached-decoder")], [old, response("old-decoder")]]));
  await lifecycle(instance.listeners.install);
  await lifecycle(instance.listeners.activate);
  assert.ok(!instance.stores.get(CACHE_NAME).has(url), 'activation does not copy bodies');
  assert.ok(instance.stores.get('vomebook-search-v1.0.0').has(url));
  assert.ok(instance.stores.get('vomebook-search-v1.0.0').has(old));
  assert.deepStrictEqual(await generationState(instance.stores), { active: CACHE_NAME, previous: 'vomebook-search-v1.0.0' });
  const result = await dispatchFetch(instance, url);
  assert.strictEqual(result.body, "cached-decoder");
  await Promise.all(instance.operations.lifetimes);
  assert.deepStrictEqual(instance.operations.fetch, []);
});
test("registers install activate and fetch listeners", () => {
  const instance = harness();
  assert.deepStrictEqual(Object.keys(instance.listeners).sort(), ["activate", "fetch", "install"]);
});
test("catalog navigations and SEO manifests bypass the SPA cache", () => {
  const instance = harness();
  for (const pathname of ['/search/catalog/', '/search/VOMEBOOK/', '/search/book/0ym7e7wbcxau0/']) {
    assert.strictEqual(dispatchFetch(instance, 'https://example.test' + pathname, 'navigate'), undefined);
  }
  for (const pathname of ['/search/sitemap.xml', '/search/seo-publication.json']) {
    assert.strictEqual(dispatchFetch(instance, 'https://example.test' + pathname), undefined);
  }
  assert.deepStrictEqual(instance.operations.fetch, []);
  assert.deepStrictEqual(instance.operations.put, []);
});
test("only pinned static hashes ignore Origin Vary mismatches", async () => {
  for (const [text, prefix] of [[source, '/search/static/']]) {
    const calls = [];
    const pinned = 'https://example.test' + prefix + 'reader.123456789abc.js';
    const ordinary = 'https://example.test/data/payload.json';
    const instance = harness({ source: text,
      cacheEntries: [[pinned, response('cached pinned')], [ordinary, response('private variant')]],
      match(request, options, values) {
        calls.push([keyOf(request), options.ignoreVary]);
        return Promise.resolve(options.ignoreVary ? values.get(keyOf(request)) : undefined);
      }
    });
    assert.strictEqual((await dispatchFetch(instance, pinned)).body, 'cached pinned');
    assert.strictEqual((await dispatchFetch(instance, ordinary)).body, 'network:' + ordinary);
    await Promise.all(instance.operations.lifetimes);
    assert.deepStrictEqual(calls, [[pinned, true], [ordinary, false]]);
    assert.deepStrictEqual(instance.operations.fetch, [ordinary]);
  }
});
test("retains only the actual previous cache for one release without copying bodies", async () => {
  const prefix = '/search/static/';
  const paths = ['111111111111', '222222222222', '333333333333'].map(hash => prefix + 'app.' + hash + '.js');
  const source1 = generationSource('development', [paths[0]]);
  const values = new Map(paths.map(path => ['https://example.test' + path, response('asset ' + path)]));
  const excluded = ['/search/', '/search/data/initial/global.json', prefix + 'app.js',
    prefix + 'reader/pdf/reader-pdf-search.mjs', prefix + 'app.999999999999.js?sw-retained-generation'];
  for (const path of excluded) values.set('https://example.test' + path, response('must not retain'));
  const nested = prefix + 'reader/pdf/reader-pdf-search.555555555555.mjs?reader-v1';
  values.set('https://example.test' + nested, response('nested retired hash'));
  const legacy = 'vomebook-search-v1.0.0';
  const offline = harness({source: source1, fetch: () => Promise.reject(new TypeError('offline'))});
  offline.stores.set(legacy, values);
  await lifecycle(offline.listeners.install);
  assert.strictEqual(values.size, paths.length + excluded.length + 1, 'install leaves the active cache untouched');
  await lifecycle(offline.listeners.activate);
  const current = offline.stores.get(CACHE_NAME);
  assert.deepStrictEqual([...values.keys()].sort(), [...paths, nested].map(path => 'https://example.test' + path).sort());
  assert.ok(![...current.keys()].some(key => key.startsWith('https:')), 'no snapshot copies');
  assert.strictEqual((await dispatchFetch(offline, 'https://example.test' + paths[1])).body, 'asset ' + paths[1]);
  await assert.rejects(dispatchFetch(offline, 'https://example.test' + prefix + 'app.js'));
  assert.deepStrictEqual(offline.operations.put, [ACTIVE_KEY]);
  const online = harness({source: source1, stores: offline.stores, fetch: request => Promise.resolve(keyOf(request).endsWith('333333333333.js')
    ? response('gone', { ok: false, status: 404 }) : response('network'))});
  assert.strictEqual((await dispatchFetch(online, 'https://example.test' + paths[1])).body, 'network');
  assert.strictEqual((await dispatchFetch(online, 'https://example.test' + paths[2])).body, 'asset ' + paths[2]);
  assert.deepStrictEqual(online.operations.put, []);
  const nextSource = generationSource('next-release', ['/search/static/app.aaaaaaaaaaaa.js']);
  const later = harness({source: nextSource, stores: offline.stores, fetch: () => Promise.reject(new Error('offline'))});
  await lifecycle(later.listeners.install);
  await lifecycle(later.listeners.activate);
  assert.ok(!later.stores.has(legacy));
  assert.ok(later.stores.has(CACHE_NAME));
  assert.deepStrictEqual(await generationState(later.stores), { active: cacheName(nextSource), previous: CACHE_NAME });
  await assert.rejects(dispatchFetch(later, 'https://example.test' + paths[1]));
});
for (const [site, workerSource, prefix] of [
  ['Pages', source, '/search/static/'],
  ['HF', fs.readFileSync('../hf-search/static/sw.js', 'utf8'), '/static/'],
]) {
  test(`${site} previous Ruffle cache retains retired assets and promotes current assets for one release`, async () => {
    const files = ['ruffle.js', 'core.ruffle.0123456789abcdefabcd.js', '0123456789abcdefabcd.wasm'];
    const paths = release => files.map(file => prefix + 'vendor/ruffle/release-' + release + '/' + file);
    const retired = paths('111111111111');
    const current = paths('222222222222');
    const release = (version, assets) => workerSource.replace('"development"', JSON.stringify(version))
      .replace('const CURRENT_HASHED_ASSETS = []', 'const CURRENT_HASHED_ASSETS = ' + JSON.stringify(assets));
    const url = path => 'https://example.test' + path + '?ruffle-v1';
    for (const offline of [false, true]) {
      const firstSource = release('ruffle-first', [...retired, ...current]);
      const first = harness({source: firstSource});
      await lifecycle(first.listeners.install);
      await lifecycle(first.listeners.activate);
      const previous = first.stores.get(cacheName(firstSource));
      for (const path of [...retired, ...current]) previous.set(url(path), response('bytes:' + path));
      const excluded = [prefix + 'vendor/ruffle/ruffle.js', retired[0] + '?sw-retained-generation'];
      for (const path of excluded) previous.set('https://example.test' + path, response('obsolete alias or snapshot'));
      const secondSource = release('ruffle-second', current);
      const second = harness({source: secondSource, stores: first.stores,
        fetch: () => offline ? Promise.reject(new Error('offline')) : Promise.resolve(response('gone', {ok: false, status: 404}))});
      await lifecycle(second.listeners.install);
      await lifecycle(second.listeners.activate);
      assert.deepStrictEqual([...previous.keys()].sort(), [...retired, ...current].map(url).sort());
      assert.deepStrictEqual(second.operations.put, [workerSource.includes('vomebook-search-') ? '/search/.sw-active-generation' : '/.sw-active-generation']);
      for (const path of [...retired, ...current]) {
        assert.strictEqual((await dispatchFetch(second, url(path))).body, 'bytes:' + path);
      }
      await Promise.all(second.operations.lifetimes);
      const promoted = second.stores.get(cacheName(secondSource));
      for (const path of retired) assert.ok(!promoted.has(url(path)), 'retired Ruffle assets must not repopulate the current cache');
      for (const path of current) assert.strictEqual(promoted.get(url(path)).body, 'bytes:' + path);
      assert.deepStrictEqual(second.operations.fetch, retired.map(url), 'only retired Ruffle assets try the network');
      if (offline) await assert.rejects(dispatchFetch(second, 'https://example.test' + retired[0] + '?different'), /offline/);
      else assert.strictEqual((await dispatchFetch(second, 'https://example.test' + retired[0] + '?different')).status, 404);
      const thirdSource = release('ruffle-third', current);
      const third = harness({source: thirdSource, stores: first.stores, fetch: () => Promise.reject(new Error('offline'))});
      await lifecycle(third.listeners.install);
      await lifecycle(third.listeners.activate);
      assert.ok(!third.stores.has(cacheName(firstSource)), 'retired Ruffle generation expires after one release');
      for (const path of retired) await assert.rejects(dispatchFetch(third, url(path)), /offline/);
      for (const path of current) assert.strictEqual((await dispatchFetch(third, url(path))).body, 'bytes:' + path);
      await Promise.all(third.operations.lifetimes);
    }
  });
  test(`${site} requested current immutable asset survives the next offline generation`, async () => {
    const path = prefix + 'reader/unchanged.111111111111.mjs';
    const url = 'https://example.test' + path + '?reader-v1';
    const release = version => workerSource.replace('"development"', JSON.stringify(version))
      .replace('const CURRENT_HASHED_ASSETS = []', 'const CURRENT_HASHED_ASSETS = ' + JSON.stringify([path]));
    const firstSource = release('first');
    const first = harness({source: firstSource});
    await lifecycle(first.listeners.install);
    await lifecycle(first.listeners.activate);
    first.stores.get(cacheName(firstSource)).set(url, response('unchanged bytes'));
    const secondSource = release('second');
    const second = harness({source: secondSource, stores: first.stores, fetch: () => Promise.reject(new Error('offline'))});
    await lifecycle(second.listeners.install);
    await lifecycle(second.listeners.activate);
    assert.ok(!second.stores.get(cacheName(secondSource)).has(url), 'no bulk snapshot during upgrade');
    assert.strictEqual((await dispatchFetch(second, url)).body, 'unchanged bytes');
    await Promise.all(second.operations.lifetimes);
    assert.strictEqual(second.stores.get(cacheName(secondSource)).get(url).body, 'unchanged bytes');
    assert.deepStrictEqual(second.operations.fetch, []);
    const thirdSource = release('third');
    const third = harness({source: thirdSource, stores: first.stores, fetch: () => Promise.reject(new Error('offline'))});
    await lifecycle(third.listeners.install);
    await lifecycle(third.listeners.activate);
    assert.ok(!third.stores.has(cacheName(firstSource)), 'original cache was collected');
    assert.strictEqual((await dispatchFetch(third, url)).body, 'unchanged bytes');
    await Promise.all(third.operations.lifetimes);
    assert.strictEqual(third.stores.get(cacheName(thirdSource)).get(url).body, 'unchanged bytes');
    assert.deepStrictEqual(third.operations.fetch, []);
  });
  test(`${site} immutable promotion does not block delivery and stays in the event lifetime`, async () => {
    const path = prefix + 'reader/unchanged.111111111111.mjs';
    const url = 'https://example.test' + path;
    const configured = workerSource.replace('const CURRENT_HASHED_ASSETS = []', 'const CURRENT_HASHED_ASSETS = ' + JSON.stringify([path]));
    const instance = harness({source: configured});
    const legacyName = cacheName(configured).replace('development', 'v1.0.0');
    instance.stores.set(legacyName, new Map([[url, response('ready')]]));
    await lifecycle(instance.listeners.install);
    await lifecycle(instance.listeners.activate);
    for (const fail of [false, true]) {
      let finishWrite;
      const restarted = harness({source: configured, stores: instance.stores,
        put: () => new Promise((resolve, reject) => { finishWrite = () => fail ? reject(new Error('quota')) : resolve(); }),
        fetch: () => Promise.reject(new Error('offline'))});
      assert.strictEqual((await dispatchFetch(restarted, url)).body, 'ready');
      let lifetimeFinished = false;
      restarted.operations.lifetimes[0].then(() => { lifetimeFinished = true; });
      await tick();
      assert.strictEqual(lifetimeFinished, false);
      finishWrite();
      await Promise.all(restarted.operations.lifetimes);
      assert.strictEqual(lifetimeFinished, true);
      assert.deepStrictEqual(restarted.operations.fetch, []);
      assert.deepStrictEqual(restarted.operations.put, [url]);
    }
  });
}
test("install precaches only the search shell and global data", async () => {
  const instance = harness({ fetch: manifestsFetch() });
  await lifecycle(instance.listeners.install);
  assert.strictEqual(instance.operations.addAll.length, 1);
  assert.ok(instance.operations.addAll[0].includes("/search/static/app.js"));
  assert.ok(instance.operations.addAll[0].includes("/search/static/search/index-worker.js"));
  assert.ok(instance.operations.addAll[0].includes("/search/data/initial/global.json"));
  assert.ok(instance.operations.addAll[0].includes("/search/data/sidebar/global.json"));
  assert.ok(!instance.operations.addAll[0].some(url => /\/repos\/|\/reader\.(?:html|js|css)$/.test(url)));
  assert.deepStrictEqual(instance.operations.fetch, []);
  assert.strictEqual(instance.operations.skipWaiting, 1);
});
test("failed installation leaves the active generation intact and removes the candidate", async () => {
  const oldName = 'vomebook-search-v1.0.0';
  const old = new Map([['/search/', response('old shell')]]);
  const stores = new Map([[oldName, old]]);
  const instance = harness({ stores, addAllError: new Error('503 missing core asset') });
  await assert.rejects(lifecycle(instance.listeners.install), /503/);
  assert.strictEqual(stores.get(oldName), old);
  assert.strictEqual(old.get('/search/').body, 'old shell');
  assert.ok(!stores.has(CACHE_NAME));
  assert.strictEqual(instance.operations.skipWaiting, 0);
  const retry = harness({ stores });
  await lifecycle(retry.listeners.install);
  assert.strictEqual(stores.get(oldName), old, 'install must not delete the serving generation');
  assert.ok(stores.get(CACHE_NAME).has('/search/'));
  assert.strictEqual(retry.operations.skipWaiting, 1);
  await lifecycle(retry.listeners.activate);
  assert.ok(stores.has(oldName));
});
test("metadata failure prevents cleanup and claim but install needs no body copies", async () => {
  const oldName = 'vomebook-search-v1.0.0';
  const stores = new Map([[oldName, new Map([['https://example.test/search/static/app.111111111111.js', response('old')]])]]);
  const instance = harness({ stores, put: () => Promise.reject(new Error('metadata quota')) });
  await lifecycle(instance.listeners.install);
  assert.deepStrictEqual(instance.operations.put, []);
  await assert.rejects(lifecycle(instance.listeners.activate), /metadata quota/);
  assert.ok(stores.has(oldName));
  assert.ok(stores.has(CACHE_NAME));
  assert.deepStrictEqual(instance.operations.deleted, []);
  assert.strictEqual(instance.operations.claim, 0);
});
test("activation selects the recorded active generation over a newer unactivated candidate", async () => {
  const path = '/search/static/app.111111111111.js';
  const activeSource = generationSource('active', [path]);
  const active = harness({source: activeSource});
  await lifecycle(active.listeners.install);
  await lifecycle(active.listeners.activate);
  active.stores.get(cacheName(activeSource)).set('https://example.test' + path, response('actual active'));
  const candidateSource = generationSource('failed-candidate', ['/search/static/app.222222222222.js']);
  const candidate = harness({source: candidateSource, stores: active.stores,
    put: () => Promise.reject(new Error('activation failed'))});
  await lifecycle(candidate.listeners.install);
  await assert.rejects(lifecycle(candidate.listeners.activate), /activation failed/);
  candidate.stores.get(cacheName(candidateSource)).set('https://example.test' + path, response('wrong candidate'));
  const nextSource = generationSource('next', ['/search/static/app.333333333333.js']);
  const next = harness({source: nextSource, stores: active.stores, fetch: () => Promise.reject(new Error('offline'))});
  await lifecycle(next.listeners.install);
  await lifecycle(next.listeners.activate);
  assert.deepStrictEqual(await generationState(next.stores), { active: cacheName(nextSource), previous: cacheName(activeSource) });
  assert.ok(!next.stores.has(cacheName(candidateSource)));
  assert.strictEqual((await dispatchFetch(next, 'https://example.test' + path)).body, 'actual active');
});
test("rollback to an existing generation replaces previous metadata and reinstalls its core", async () => {
  const pathA = '/search/static/app.111111111111.js';
  const pathB = '/search/static/app.222222222222.js';
  const sourceA = generationSource('a', [pathA]);
  const sourceB = generationSource('b', [pathB]);
  const a = harness({source: sourceA});
  await lifecycle(a.listeners.install);
  await lifecycle(a.listeners.activate);
  a.stores.get(cacheName(sourceA)).set('https://example.test' + pathA, response('A'));
  const b = harness({source: sourceB, stores: a.stores});
  await lifecycle(b.listeners.install);
  await lifecycle(b.listeners.activate);
  b.stores.get(cacheName(sourceB)).set('https://example.test' + pathB, response('B'));
  assert.ok(!a.stores.get(cacheName(sourceA)).has('/search/'), 'previous shell was pruned');
  const rollback = harness({source: sourceA, stores: a.stores, fetch: () => Promise.reject(new Error('offline'))});
  await lifecycle(rollback.listeners.install);
  assert.strictEqual(rollback.operations.addAll.length, 1);
  assert.deepStrictEqual(await generationState(rollback.stores), { active: cacheName(sourceB), previous: cacheName(sourceA) });
  await lifecycle(rollback.listeners.activate);
  assert.deepStrictEqual(await generationState(rollback.stores), { active: cacheName(sourceA), previous: cacheName(sourceB) });
  assert.ok(rollback.stores.get(cacheName(sourceA)).has('/search/'));
  assert.strictEqual((await dispatchFetch(rollback, 'https://example.test' + pathB)).body, 'B');
  assert.strictEqual((await dispatchFetch(rollback, 'https://example.test' + pathA)).body, 'A');
});
test("reinstalling the active generation preserves serving bytes and its previous pointer", async () => {
  const first = harness({oldCaches: ['vomebook-search-v1.0.0']});
  await lifecycle(first.listeners.install);
  await lifecycle(first.listeners.activate);
  const shell = response('serving shell');
  first.stores.get(CACHE_NAME).set('/search/', shell);
  const reinstall = harness({stores: first.stores, addAllError: new Error('must not refresh active')});
  await lifecycle(reinstall.listeners.install);
  await lifecycle(reinstall.listeners.activate);
  assert.deepStrictEqual(reinstall.operations.addAll, []);
  assert.strictEqual(first.stores.get(CACHE_NAME).get('/search/'), shell);
  assert.deepStrictEqual(await generationState(first.stores), { active: CACHE_NAME, previous: 'vomebook-search-v1.0.0' });
});
test("late old-worker writes remain available only at exact immutable URLs", async () => {
  const oldPath = '/search/static/reader/late.111111111111.mjs';
  const oldSource = generationSource('old-active', [oldPath]);
  let finishOldFetch;
  const old = harness({source: oldSource, fetch: () => new Promise(resolve => { finishOldFetch = resolve; })});
  await lifecycle(old.listeners.install);
  await lifecycle(old.listeners.activate);
  const pending = dispatchFetch(old, 'https://example.test' + oldPath);
  await tick();
  const nextSource = generationSource('next-active', ['/search/static/app.222222222222.js']);
  const next = harness({source: nextSource, stores: old.stores, fetch: () => Promise.reject(new Error('offline')),
    entryDeleteError: new Error('best effort prune failed')});
  await lifecycle(next.listeners.install);
  await lifecycle(next.listeners.activate);
  finishOldFetch(response('late immutable bytes'));
  await pending;
  await Promise.all(old.operations.lifetimes);
  // A restarted worker must recover the previous pointer from persistent metadata.
  const restarted = harness({source: nextSource, stores: old.stores, fetch: () => Promise.reject(new Error('offline'))});
  assert.strictEqual((await dispatchFetch(restarted, 'https://example.test' + oldPath)).body, 'late immutable bytes');
  const queried = oldPath + '?reader-v1';
  old.stores.get(cacheName(oldSource)).set('https://example.test' + queried, response('queried immutable bytes'));
  assert.strictEqual((await dispatchFetch(restarted, 'https://example.test' + queried)).body, 'queried immutable bytes');
  await assert.rejects(dispatchFetch(restarted, 'https://example.test' + oldPath + '?different'), 'query matches must be exact');
  const excluded = ['/search/static/reader.html', '/search/data/late.json', '/search/static/reader/late.mjs',
    oldPath + '?sw-retained-generation', oldPath + '?reader-v1&sw-retained-generation'];
  for (const path of excluded) {
    old.stores.get(cacheName(oldSource)).set('https://example.test' + path, response('late mutable or marker bytes'));
    await assert.rejects(dispatchFetch(restarted, 'https://example.test' + path));
  }
  assert.deepStrictEqual(restarted.operations.put, []);
});
test("failed reinstall never deletes an existing current cache", async () => {
  const instance = harness({ cacheEntries: [['/search/', response('active')]], addAllError: new Error('offline') });
  await assert.rejects(lifecycle(instance.listeners.install), /offline/);
  assert.strictEqual(instance.stores.get(CACHE_NAME).get('/search/').body, 'active');
  assert.deepStrictEqual(instance.operations.deleted, []);
});
test("cleanup errors cannot prevent a complete generation from claiming clients", async () => {
  const instance = harness({ oldCaches: ['vomebook-search-old'], deleteError: new Error('storage busy') });
  await lifecycle(instance.listeners.install);
  await lifecycle(instance.listeners.activate);
  assert.strictEqual(instance.operations.claim, 1);
  assert.ok(instance.stores.has('vomebook-search-old'));
});
test("failed core installation cannot activate a partial generation", async () => {
  const instance = harness({ addAllError: new Error("quota"), fetch: manifestsFetch() });
  await assert.rejects(lifecycle(instance.listeners.install), /quota/);
  assert.strictEqual(instance.operations.skipWaiting, 0);
  assert.strictEqual(instance.operations.fetch.length, 0, "manifests are not attempted after core precache failure");
});
test("same-host requests on another origin bypass the cache", () => {
  const instance = harness();
  for (const origin of ['http://example.test', 'https://example.test:8443']) {
    assert.strictEqual(dispatchFetch(instance, origin + '/search/static/app.js'), undefined);
  }
  assert.deepStrictEqual(instance.operations.fetch, []);
});
test("activation deletes only this site's old caches and claims clients", async () => {
  const instance = harness({ oldCaches: ["vomebook-search-v1.0.0", "vomebook-search-old", "reader-documents", "voiceofml-search-hf-release"] });
  await lifecycle(instance.listeners.activate);
  assert.deepStrictEqual(instance.operations.deleted, ["vomebook-search-old"]);
  assert.ok(instance.stores.has('vomebook-search-v1.0.0'));
  assert.deepStrictEqual(await generationState(instance.stores), { active: CACHE_NAME, previous: 'vomebook-search-v1.0.0' });
  assert.ok(instance.stores.has('reader-documents'));
  assert.ok(instance.stores.has('voiceofml-search-hf-release'));
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
test("reader warming and navigations reuse cache immediately while refreshing one shell key", async () => {
  const cached = response("cached-reader");
  const network = response("network-reader");
  const instance = harness({ cacheEntries: [["/search/static/reader.html", cached]], fetch: () => Promise.resolve(network) });
  const url = "https://example.test/search/static/reader.html?url=one";
  assert.strictEqual(await dispatchFetch(instance, url, "navigate"), cached);
  await tick();
  assert.deepStrictEqual(instance.operations.fetch, [url]);
  assert.deepStrictEqual(instance.operations.put, ["/search/static/reader.html"]);
});
test("a stalled shell revalidation cannot block repeated Reader navigation", async () => {
  for (const [text, prefix, currentCache] of [
    [source, '/search/static/', CACHE_NAME],
    ...(fs.existsSync('../hf-search/static/sw.js') ? [[fs.readFileSync('../hf-search/static/sw.js', 'utf8'), '/static/', cacheName(fs.readFileSync('../hf-search/static/sw.js', 'utf8'))]] : [])
  ]) {
    let release;
    const cached = response('reader-ready');
    const instance = harness({source: text, fetch: () => new Promise(resolve => { release = resolve; })});
    instance.stores.set(currentCache, new Map([[prefix + 'reader.html', cached]]));
    assert.strictEqual(await dispatchFetch(instance, 'https://example.test' + prefix + 'reader.html?id=one', 'navigate'), cached);
    await tick();
    release(response('updated'));
    await Promise.all(instance.operations.lifetimes);
    assert.strictEqual(instance.stores.get(currentCache).get(prefix + 'reader.html').body, 'updated');
  }
});
test("cached responses return immediately while event lifetime covers delayed network and cache writes", async () => {
  const url = "https://example.test/search/other.txt";
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
  test(`${route.name} cache hit prefers the network and updates the cache`, async () => {
    const cached = response(`cached:${route.name}`);
    const instance = harness({ cacheEntries: [[route.url, cached]] });
    const result = await dispatchFetch(instance, route.url);
    assert.strictEqual(result.body, `network:${route.url}`);
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
  test(`${route.name} cache miss plus network failure rejects as a network error`, async () => {
    const instance = harness({ fetch: () => Promise.reject(new Error("offline")) });
    await assert.rejects(dispatchFetch(instance, route.url), /Network unavailable and no cached response/);
    await Promise.all(instance.operations.lifetimes);
    assert.deepStrictEqual(instance.operations.put, []);
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
test("general static miss and network failure rejects as a network error", async () => {
  const instance = harness({ fetch: () => Promise.reject(new Error("offline")) });
  await assert.rejects(dispatchFetch(instance, "https://example.test/search/missing.js"), /Network unavailable and no cached response/);
  await Promise.all(instance.operations.lifetimes);
  assert.deepStrictEqual(instance.operations.put, []);
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
