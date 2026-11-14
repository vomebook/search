const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

(async () => {
  const origin = 'https://example.test';
  const current = '/search/static/vendor/ruffle/release-dc9e7407549a/ruffle.js';
  const old = '/search/static/vendor/ruffle/release-aaaaaaaaaaaa/172de42e6619eac8f371.wasm';
  const entries = new Map([[origin + current, {ok: true, current: true}], [origin + old, {ok: true, old: true}]]);
  const cache = {keys: async () => [...entries.keys()].map(url => ({url})),
    match: async req => entries.get(req.url || req),
    put: async (req, response) => entries.set(req.url || req, response),
    delete: async req => entries.delete(req.url || req)};
  const listeners = {};
  const source = fs.readFileSync('static/sw.js', 'utf8').replace('const CURRENT_HASHED_ASSETS = []',
    `const CURRENT_HASHED_ASSETS = [${JSON.stringify(current)}]`);
  vm.runInNewContext(source, {URL, console, importScripts() {},
    VoiceOfMLReaderResources: require('../../static/reader-resources.js'),
    caches: {open: async () => cache, keys: async () => ['vomebook-search-v1.0.0']},
    fetch: async () => ({ok: false, status: 404}),
    self: {location: {hostname: 'example.test'}, clients: {claim: async () => {}},
      addEventListener: (name, fn) => { listeners[name] = fn; }}});
  let pending;
  listeners.activate({waitUntil: p => { pending = p; }});
  await pending;
  assert(entries.has(origin + current));
  assert(!entries.has(origin + old));
  assert(entries.has(origin + old + '?sw-retained-generation'));
  let response;
  listeners.fetch({request: {url: origin + old, method: 'GET'}, respondWith: p => { response = p; }, waitUntil() {}});
  assert.equal((await response).old, true);
  listeners.fetch({request: {url: origin + current, method: 'GET'}, respondWith: p => { response = p; }, waitUntil() {}});
  assert.equal((await response).current, true);
  console.log('Ruffle current and retained previous generation cache OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
