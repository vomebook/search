import './result_interactions_contracts.mjs';
import './random_discovery_contracts.mjs';
import './history_quotation_contracts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {APP_DEPENDENCIES} from '../../../scripts/build/compose_app.mjs';

const space = fs.existsSync('pyrightconfig.json');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const timers = [], draws = [], requests = [], assets = [];
  const context = vm.createContext({setTimeout(fn, delay) { timers.push({fn, delay}); }});
  vm.runInContext(fs.readFileSync('static/search/sidebar/application/directory.js', 'utf8'), context);
  const view = {mode: 'repo', repo: 'A', repoFull: 'VoiceOfML/A', browserPath: '', routeId: 1,
    repos: [], apiAvailable: true, useLocalMode: false, dataLoaded: false, tree: null};
  const lists = [];
  let cache;
  const ports = {
    cachedContents: key => cache?.get(key),
    readView: () => view, cache: new Map(), scroll: {activate() {}, keyFor: (repo, path) => `${repo}|${path}`, restore() {}},
    view: {
      begin(path, readRepo) {
        for (const list of lists) list.isConnected = false;
        view.browserPath = path;
        const list = {isConnected: true, innerHTML: ''}; lists.push(list);
        return {list, currentRepo: readRepo()};
      },
      items: (list, data, repo, path) => draws.push({list, data, repo, path}), message() {},
    },
    initial: async () => null, fetchRepos: async () => [], renderRepos: repos => draws.push({repos}), updateHeader() {},
    publishRepos: repos => { view.repos = repos; },
    fetchContents: (repo, path) => new Promise((resolve, reject) => requests.push({repo, path, resolve, reject})),
    localContents: async () => null, ensureLocal: async () => false,
    refreshAssets: (...args) => assets.push(args), ...overrides,
  };
  return {controller: context.VoiceOfMLSidebarDirectory.create(ports), view, lists, draws, requests, timers, assets, ports, setCache(value) { cache = value; }};
}

test('directory modules are composed before app and retain explicit site effects', () => {
  for (const module of ['infrastructure/scroll', 'presentation/directory', 'application/directory']) {
    assert.ok(APP_DEPENDENCIES.includes(`search/sidebar/${module}.js`));
  }
  const app = fs.readFileSync('static/app.js', 'utf8');
  assert.match(app, /refreshAssets: refreshSidebarReaderAssets/);
  assert.match(app, /fetchContents: \(repo, path\) => /);
  assert.doesNotMatch(fs.readFileSync('static/search/sidebar/application/directory.js', 'utf8'), /\bSTATE\b|loadReaderAssets|\bfetch\(/);
});

test('directory response retains captured repository identity across list reorder', async () => {
  const f = fixture();
  const pending = f.controller.browse('docs', 1);
  await turn();
  f.view.repos = [{name: 'VoiceOfML/B'}, {name: 'VoiceOfML/A'}];
  const data = {files: [{name: 'A-file', ext: 'txt'}]};
  f.requests[0].resolve(data);
  await pending;
  assert.equal(f.draws.length, 1);
  assert.equal(f.draws[0].repo, space ? 'A' : 'VoiceOfML/A');
  assert.equal(f.draws[0].data, data);
  assert.equal(f.assets[0][4](), data);
});

test('late directory API response cannot replace a newer repository route', async () => {
  const f = fixture();
  const older = f.controller.browse('docs', 1);
  await turn();
  Object.assign(f.view, {repo: 'B', repoFull: 'VoiceOfML/B', routeId: 2});
  const newer = f.controller.browse('docs', 2);
  await turn();
  const data = {files: [{name: 'new'}]};
  f.requests[1].resolve(data); await newer;
  f.requests[0].resolve({files: [{name: 'old'}]}); await older;
  assert.equal(f.draws.length, 1);
  assert.equal(f.draws[0].data, data);
});

test('late root initial payload cannot draw over a changed route', async () => {
  let resolveInitial;
  const f = fixture({initial: () => new Promise(resolve => { resolveInitial = resolve; })});
  const pending = f.controller.browse('', 1);
  Object.assign(f.view, {repo: 'B', repoFull: 'VoiceOfML/B', routeId: 2});
  resolveInitial({folders: [{name: 'old', path: 'old'}]});
  await turn();
  if (f.requests.length) f.requests[0].resolve({files: []});
  await pending;
  assert.equal(f.draws.length, 0);
});

test('directory retry timers stop after two and stop on route change', async () => {
  const f = fixture({fetchContents: async () => { if (space) throw Error('offline'); return null; }});
  await f.controller.browse('docs', 1);
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 1200);
  f.timers[0].fn(); await turn();
  assert.equal(f.timers.length, 2); assert.equal(f.timers[1].delay, 1200);
  f.timers[1].fn(); await turn();
  assert.equal(f.timers.length, 2);
  assert.match(f.lists.at(-1).innerHTML, /加载失败/);
  f.controller.resetRetries();
  await f.controller.browse('docs', 1);
  assert.equal(f.timers.length, 3);
  f.view.routeId = 2;
  const count = f.lists.length;
  f.timers[2].fn(); await turn();
  assert.equal(f.lists.length, count);
});

test('initial repository payload survives API failure or empty fallback', async () => {
  const repos = [{name: 'VoiceOfML/Initial', count: 3}];
  const f = fixture({initial: async () => ({repos}), fetchRepos: async () => { if (space) throw Error('offline'); return null; }});
  f.view.mode = 'global';
  await f.controller.repos(1);
  assert.equal(f.draws.at(-1).repos, repos);
});

test('site directory fallback preserves cached HF and mixed Pages behavior', async () => {
  const f = fixture();
  const data = {files: [{name: 'cached'}]};
  if (space) {
    f.setCache(new Map([['A|docs', data]]));
    await f.controller.browse('docs', 1);
    assert.equal(f.requests.length, 0);
  } else {
    f.view.useLocalMode = true;
    f.ports.ensureLocal = async () => true;
    f.ports.localContents = async () => data;
    await f.controller.browse('docs', 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].repo, 'A');
  }
  assert.equal(f.draws[0].data, data);
});

test('HF observes cache created after controller construction before a held root initial fetch', async () => {
  if (!space) return;
  let initialCalls = 0;
  const f = fixture({initial: () => { initialCalls++; return new Promise(() => {}); }});
  const first = f.controller.browse('docs', 1);
  await turn();
  const data = {files: [{name: 'root-cache'}]};
  // API.getContents creates its cache lazily during the first request.
  f.setCache(new Map([['A|', data]]));
  f.requests[0].resolve({files: []});
  await first;
  const revisit = f.controller.browse('', 1);
  assert.equal(f.draws.at(-1).data, data);
  assert.equal(initialCalls, 0);
  assert.equal(f.requests.length, 1);
  await revisit;
});

test('sidebar scroll bounds storage, restores after layout and flushes lifecycle', () => {
  const frames = new Map(), timers = new Map(), events = new Map(), writes = [];
  let serial = 0;
  const content = {scrollTop: 0, scrollHeight: 500, clientHeight: 100, addEventListener: (name, fn, options) => events.set(name, {fn, options})};
  const context = vm.createContext({sessionStorage: {getItem: () => null, setItem: (key, value) => writes.push({key, value})},
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
    window: {addEventListener: (name, fn) => events.set(name, {fn})},
    document: {visibilityState: 'visible', addEventListener: (name, fn) => events.set(name, {fn})},
  });
  vm.runInContext(fs.readFileSync('static/search/sidebar/infrastructure/scroll.js', 'utf8'), context);
  const scroll = context.VoiceOfMLSidebarScroll.create({content: () => content, storageKey: 'sidebar-test'});
  scroll.install();
  assert.equal(events.get('scroll').options.passive, true);
  for (let i = 0; i < 90; i++) { scroll.activate(`repo:${i}`); content.scrollTop = i + 1; scroll.remember(); }
  assert.equal(scroll.positions.size, 80);
  assert.equal(scroll.positions.has('repo:0'), false);
  scroll.activate('repo:85'); scroll.restore();
  assert.equal(content.scrollTop, 86); assert.equal(scroll.restoring, true);
  content.scrollTop = 0; scroll.remember();
  assert.equal(scroll.positions.get('repo:85'), 86);
  for (const fn of frames.values()) fn(); frames.clear();
  assert.equal(scroll.restoring, false);
  content.scrollTop = 123;
  events.get('pagehide').fn();
  assert.equal(timers.size, 0);
  assert.equal(JSON.parse(writes.at(-1).value)['repo:85'], 123);
  context.document.visibilityState = 'hidden'; content.scrollTop = 124;
  events.get('visibilitychange').fn();
  assert.equal(JSON.parse(writes.at(-1).value)['repo:85'], 124);
});
