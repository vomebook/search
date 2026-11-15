const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

(async () => {
  const origin = 'https://example.test';
  const current = '/search/static/vendor/ruffle/release-dc9e7407549a/ruffle.js';
  const old = '/search/static/vendor/ruffle/release-aaaaaaaaaaaa/172de42e6619eac8f371.wasm';
  const stores = new Map();
  const key = request => new URL(request.url || request, origin).href;
  const source = fs.readFileSync('static/sw.js', 'utf8').replace('const CURRENT_HASHED_ASSETS = []',
    `const CURRENT_HASHED_ASSETS = [${JSON.stringify(current)}]`);

  function harness(text = source) {
    const listeners = {}, fetched = [], lifecycle = [];
    let network = 'missing';
    const identity = vm.runInNewContext(text + '\n({name: CACHE_NAME, prefix: CACHE_PREFIX, metadata: METADATA_CACHE, activeKey: ACTIVE_KEY})', {
      URL, Request, Response, console, importScripts() {},
      VoiceOfMLReaderResources: require('../../static/reader-resources.js'),
      caches: {
        keys: async () => [...stores.keys()],
        delete: async name => stores.delete(name),
        open: async name => {
          if (!stores.has(name)) stores.set(name, new Map());
          const entries = stores.get(name);
          return {
            keys: async () => [...entries.keys()].map(url => new Request(url)),
            match: async request => entries.get(key(request))?.clone(),
            put: async (request, response) => { entries.set(key(request), response.clone()); },
            delete: async request => entries.delete(key(request)),
            addAll: async requests => {
              for (const request of requests) entries.set(key(request), new Response('precache'));
              lifecycle.push('precache');
            },
          };
        },
      },
      fetch: async request => {
        fetched.push(key(request));
        if (network === 'offline') throw new Error('offline');
        return network === 'online' ? new Response('network') : new Response('missing', {status: 404});
      },
      self: {location: {hostname: 'example.test', origin},
        skipWaiting: async () => { lifecycle.push('skipWaiting'); },
        clients: {claim: async () => { lifecycle.push('claim'); }},
        addEventListener: (name, fn) => { listeners[name] = fn; }},
    });
    return {
      identity, fetched, lifecycle,
      setNetwork(value) { network = value; },
      state: async () => stores.get(identity.metadata).get(key(identity.activeKey)).clone().json(),
      async dispatch(name) {
        let pending;
        listeners[name]({waitUntil: promise => { pending = promise; }});
        await pending;
      },
      async fetchAsset(path) {
        let response;
        const pending = [];
        listeners.fetch({request: new Request(key(path)),
          respondWith: promise => { response = promise; }, waitUntil: promise => pending.push(promise)});
        try { return await response; } finally { await Promise.all(pending); }
      },
    };
  }

  const h = harness();
  const previousName = h.identity.prefix + 'previous-release';
  const olderName = h.identity.prefix + 'older-release';
  const previous = new Map([
    [key(current), new Response('current Ruffle')],
    [key(old), new Response('retired Ruffle')],
    [key(current.replace('ruffle.js', 'alias.js')), new Response('mutable alias')],
    ['https://foreign.test' + old, new Response('foreign Ruffle')],
  ]);
  stores.set(previousName, previous);
  stores.set(olderName, new Map());
  stores.set(h.identity.metadata, new Map([[key(h.identity.activeKey),
    new Response(JSON.stringify({active: previousName, previous: olderName}))]]));
  const beforeInstall = [...previous.entries()];
  await h.dispatch('install');
  assert.deepStrictEqual(h.lifecycle, ['precache', 'skipWaiting']);
  assert.deepStrictEqual(await h.state(), {active: previousName, previous: olderName});
  assert.deepStrictEqual([...previous.entries()], beforeInstall, 'install preserves the serving cache');
  assert.ok(stores.has(olderName), 'install must not remove serving generations');

  await h.dispatch('activate');
  assert.deepStrictEqual(await h.state(), {active: h.identity.name, previous: previousName});
  assert.deepStrictEqual(h.lifecycle, ['precache', 'skipWaiting', 'claim']);
  assert.strictEqual(stores.get(previousName), previous, 'retain the actual previous cache');
  assert.deepStrictEqual([...previous.keys()].sort(), [key(current), key(old)].sort(),
    'only same-origin immutable Ruffle assets survive previous-cache pruning');
  assert.ok(!stores.has(olderName), 'retain at most one previous generation');
  const entries = stores.get(h.identity.name);
  assert.ok(!entries.has(key(current)), 'current Ruffle starts only in the previous cache');
  assert.strictEqual(await (await h.fetchAsset(current)).text(), 'current Ruffle');
  assert.deepStrictEqual(h.fetched, [], 'current immutable Ruffle uses the previous cache before network');
  assert.strictEqual(await entries.get(key(current)).clone().text(), 'current Ruffle',
    'accessed current Ruffle is promoted for the next release');

  h.setNetwork('online');
  assert.strictEqual(await (await h.fetchAsset(old)).text(), 'network', 'retired Ruffle is network-first');
  h.setNetwork('missing');
  assert.strictEqual(await (await h.fetchAsset(old)).text(), 'retired Ruffle', '404 falls back to previous Ruffle');
  h.setNetwork('offline');
  assert.strictEqual(await (await h.fetchAsset(old)).text(), 'retired Ruffle', 'offline falls back to previous Ruffle');
  assert.deepStrictEqual(h.fetched, [key(old), key(old), key(old)]);
  assert.ok(!entries.has(key(old)), 'retired Ruffle must never repopulate the current cache');
  assert.strictEqual(await (await h.fetchAsset(current)).text(), 'current Ruffle', 'current Ruffle remains available offline');

  const next = harness(source.replace('"development"', '"next-release"'));
  assert.notStrictEqual(next.identity.name, h.identity.name);
  await next.dispatch('install');
  assert.deepStrictEqual(await next.state(), {active: h.identity.name, previous: previousName});
  assert.ok(stores.has(previousName), 'next install preserves the previous generation until activation');
  await next.dispatch('activate');
  assert.deepStrictEqual(await next.state(), {active: next.identity.name, previous: h.identity.name});
  assert.ok(!stores.has(previousName), 'next release removes the retired Ruffle generation');
  assert.deepStrictEqual([...stores.keys()].sort(), [next.identity.metadata, next.identity.name, h.identity.name].sort());
  next.setNetwork('missing');
  assert.strictEqual((await next.fetchAsset(old)).status, 404, 'removed Ruffle no longer has a 404 fallback');
  next.setNetwork('offline');
  await assert.rejects(next.fetchAsset(old), /offline/, 'removed Ruffle no longer has an offline fallback');
  assert.strictEqual(await (await next.fetchAsset(current)).text(), 'current Ruffle',
    'promoted current Ruffle survives removal of its original cache');
  assert.strictEqual(await stores.get(next.identity.name).get(key(current)).clone().text(), 'current Ruffle');
  console.log('Ruffle metadata lifecycle, current and retired fallback, and one-generation retention OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
