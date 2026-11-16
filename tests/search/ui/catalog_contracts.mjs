import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {APP_DEPENDENCIES} from '../../../scripts/build/compose_app.mjs';

const space = fs.existsSync('pyrightconfig.json');
const app = fs.readFileSync('static/app.js', 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
function fixture(baseline = false) {
  const calls = [], workers = [], timers = new Map();
  let nextTimer = 0;
  const c = vm.createContext({AbortController, Map, console, clock: 0,
    apiAvailable: true, API_BASE: 'https://metadata.test', WORKER_REQUEST_TIMEOUT: 60000,
    noteApiSuccess() { c.successes++; }, noteApiFailure() { c.failures++; }, successes: 0, failures: 0,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { return new Promise((resolve, reject) => calls.push({url, options, resolve, reject})); },
    corpusWorkerRequest(type, payload, timeout) {
      return new Promise(resolve => workers.push({type, payload, timeout, resolve}));
    },
  });
  vm.runInContext(fs.readFileSync('static/search/requests/infrastructure/response-cache.js', 'utf8'), c);
  vm.runInContext('Date.now = () => clock', c);
  const old = baseline && fs.readFileSync(process.env.CATALOG_BASELINE_ROOT + '/static/app.js', 'utf8');
  const source = old || app;
  if (space) {
    vm.runInContext(`function abortSignalWithTimeout(_, timeout) {
      const controller = new AbortController(); const id = setTimeout(() => controller.abort(), timeout);
      return {signal:controller.signal, cleanup:()=>clearTimeout(id)};
    }`, c);
    vm.runInContext(slice(source, 'async function fetchJsonWithTimeout(', old ? 'function readInitialSearchView()' : 'function readInitialSearchView()'), c);
  } else {
    vm.runInContext(slice(source, 'async function fetchJsonWithTimeout(', 'async function fetchWithTimeout('), c);
  }
  if (old) {
    if (space) {
      vm.runInContext('const sidebarInitialCache = new Map(), sidebarInitialPending = new Map();\n' +
        'const API = {\n' + slice(old, '  async getRepos()', 'function sidebarInitialUrlForRepo(') +
        slice(old, 'function sidebarInitialUrlForRepo(', '/** @param {unknown} value */') +
        '\nglobalThis.owner = API; globalThis.catalog = {sidebarInitialCache, sidebarInitialPending};', c);
    } else {
      vm.runInContext('const folderTreeCache = new Map();\n' + slice(old, 'let repoApiCache = null;', 'let sidebarScroll;') +
        slice(old, 'function normalizeSidebarPayload(', 'function getCurrentExtensionCounts()') +
        slice(old, 'const folderContentsCache = new BoundedResponseCache', 'const STATE = {') +
        '\nglobalThis.catalog = {folderTreeCache, folderContentsCache, browserApiCache, browserApiPending, sidebarInitialCache, sidebarInitialPending, extensionApiCache, extensionApiPending};', c);
    }
  } else {
    for (const file of ['domain/sidebar-payload', 'application/client']) {
      vm.runInContext(fs.readFileSync(`static/search/catalog/${file}.js`, 'utf8'), c);
    }
    if (space) {
      vm.runInContext(slice(app, 'const catalog = VoiceOfMLCatalogClient.create(', 'const API = {') +
        'const API = {\n' + slice(app, '  getRepos()', 'function loadSidebarInitial(') +
        app.match(/^function loadSidebarInitial\([^\n]+$/m)[0] + '\nglobalThis.owner = API; globalThis.catalog = catalog;', c);
    } else {
      vm.runInContext(slice(app, 'const catalog = VoiceOfMLCatalogClient.create(', 'let sidebarScroll;') +
        '\nglobalThis.catalog = catalog;', c);
    }
  }
  const invoke = (name, ...args) => space && name !== 'loadSidebarInitial'
    ? c.owner[name](...args) : c[name](...args);
  return {c, calls, workers, timers, invoke,
    repos: () => invoke(space ? 'getRepos' : 'fetchRepos'),
    extensions: repo => invoke(space ? 'getExtensions' : 'fetchExtensions', repo),
    folders: repo => invoke(space ? 'getFolders' : 'fetchFolderTree', repo),
    contents: (repo, path = '') => invoke(space ? 'getContents' : 'fetchFolderContents', repo, path),
    reply(index, value, status = 200) { calls[index].resolve({ok:status === 200, status, json:async () => value}); },
    settleBootstrap(value = null) { if (space) c.owner.getBootstrap = async () => value; },
  };
}

for (const baseline of process.env.CATALOG_BASELINE_ROOT ? [false, true] : [false]) {
const label = `catalog ${space ? 'Space' : 'Pages'} ${baseline ? 'baseline' : 'current'}`;
test(label + ' repo/body waiters share requests and failures release retry', async () => {
  const f = fixture(baseline); f.settleBootstrap();
  const a = f.repos(), b = f.repos(); await turn();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/api\/repos$/);
  let body; f.calls[0].resolve({ok:true, json:() => new Promise(resolve => { body = resolve; })});
  await turn(); const d = f.repos(); assert.equal(f.calls.length, 1);
  body({error:'malformed'});
  const failed = await Promise.allSettled([a, b, d]);
  assert.equal(failed.every(result => space ? result.status === 'rejected' : result.value === null), true);
  const retry = f.repos(); await turn(); f.reply(1, []); assert.deepEqual(plain(await retry), []);
  assert.deepEqual(plain(await f.repos()), []); assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
  if (!space) assert.equal(f.c.failures, 1);
});
test(label + ' contents waiters preserve URL, retry, cache TTL and lazy receiver ownership', async () => {
  const f = fixture(baseline);
  if (space) assert.equal(f.c.owner._browserCache, undefined);
  const a = f.contents('owner/repo', 'a b/#'), b = f.contents('owner/repo', 'a b/#');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, space ? '/api/folders/owner/repo/contents?path=a%20b%2F%23' : 'https://metadata.test/api/folders/owner%2Frepo/contents?path=a%20b%2F%23');
  f.reply(0, null, 503);
  const failed = await Promise.allSettled([a,b]);
  assert.equal(failed.every(result => space ? result.status === 'rejected' : result.value === null), true);
  const retry = f.contents('owner/repo', 'a b/#'); const data = {folders:[], files:[]}; f.reply(1, data);
  assert.equal(await retry, data); assert.equal(await f.contents('owner/repo', 'a b/#'), data);
  const cache = space ? f.c.owner._browserCache : f.c.catalog.browserApiCache;
  assert.equal(cache.get('owner/repo|a b/#'), data);
  for (let i=0; i<201; i++) cache.set('key'+i, data);
  assert.equal(cache.size, 200); assert.equal(cache.has('key0'), false);
  f.c.clock = 300000; assert.equal(cache.has('key200'), false);
  const expired = f.contents('owner/repo'); f.reply(2, data); await expired;
  assert.equal(f.calls[2].url.endsWith('/contents'), true); assert.equal(f.timers.size, 0);
  if (space) {
    const receiver = {getBootstrap:async () => null};
    const pending = f.c.owner.getContents.call(receiver, 'other', ''); f.reply(3, data); await pending;
    assert.equal(receiver._browserCache.get('other|'), data);
    assert.equal(f.c.owner._browserCache.has('other|'), false);
  } else {
    f.c.apiAvailable = false;
    assert.equal(await f.contents('owner/repo'), null);
  }
});
test(label + ' extension empty inventory, copy and concurrent behavior remain site-specific', async () => {
  const f = fixture(baseline); f.settleBootstrap({extensions:[]});
  if (space) { assert.deepEqual(plain(await f.extensions(null)), []); assert.equal(f.calls.length, 0); }
  const a = f.extensions('owner/repo'), b = f.extensions('owner/repo'); await turn();
  assert.equal(f.calls.length, space ? 2 : 1);
  assert.equal(f.calls[0].url, space ? '/api/extensions?repo=owner/repo' : 'https://metadata.test/api/extensions?repo=owner%2Frepo');
  f.reply(0, []); if (space) f.reply(1, []);
  assert.deepEqual(plain(await a), []); const value = await b; assert.deepEqual(plain(value), []);
  value.push({name:'selected-only'});
  const cached = await f.extensions('owner/repo');
  assert.equal(cached.length, space ? 1 : 0);
  cached.push({name:'mutated-cache-read'});
  assert.equal((await f.extensions('owner/repo')).length, space ? 2 : 0);
});
test(label + ' sidebar bootstrap/static fallback coalesces and preserves compact values', async () => {
  const f = fixture(baseline); f.settleBootstrap();
  const a = f.invoke('loadSidebarInitial', 'owner/repo'), b = f.invoke('loadSidebarInitial', 'owner/repo');
  await turn(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, (space ? '' : '/search') + '/data/sidebar/repos/owner%2Frepo.json');
  const raw = {repo:'owner/repo', path:'root', folders:[{n:'child',c:2}], files:[{n:'a',e:'txt',t:1,s:0},{}]};
  f.reply(0, raw); const result = await a;
  assert.equal(await b, result); assert.equal(await f.invoke('loadSidebarInitial', 'owner/repo'), result);
  assert.deepEqual(plain(result), {repo:'owner/repo',path:'root',folders:[{name:'child',path:'child',count:2}],files:[
    {name:'a',ext:'txt',hasTxt:true,size:0,link:''},{name:'',ext:'',hasTxt:false,size:'',link:''}]});
  const global = {repos:[]}; f.settleBootstrap({sidebar:global});
  const pending = f.invoke('loadSidebarInitial', null); await turn();
  if (!space) f.reply(1, global);
  assert.equal(await pending, global); assert.equal(f.calls.length, space ? 1 : 2);
});
test(label + ' malformed metadata is never cached and normalization failures permit retry', async () => {
  const f = fixture(baseline); f.settleBootstrap();
  const folder = f.folders('owner/repo'); f.reply(0, {error:'invalid'});
  if (space) await assert.rejects(folder, /Invalid metadata/); else assert.equal(await folder, null);
  const retry = f.folders('owner/repo'); f.reply(1, []); assert.deepEqual(plain(await retry), []);
  const sidebar = f.invoke('loadSidebarInitial', 'bad'); await turn(); f.reply(2, {folders:{}});
  assert.equal(await sidebar, null);
  const again = f.invoke('loadSidebarInitial', 'bad'); await turn(); f.reply(3, {folders:[],files:[]});
  assert.deepEqual(plain(await again), {repo:'',path:'',folders:[],files:[]});
  if (space) {
    const invalid = f.contents('bad'); f.reply(4, {folders:[]}); await assert.rejects(invalid, /Invalid folder contents/);
    assert.equal(f.c.owner._browserCache.has('bad|'), false); assert.equal(f.c.owner._browserPending.size, 0);
  } else {
    const local = f.invoke('getFolderContents', 'owner/repo', '');
    assert.deepEqual(plain(f.workers[0].payload), {repo:'owner/repo',path:''});
    assert.equal(f.workers[0].type, 'folder-contents'); assert.equal(f.workers[0].timeout, 60000);
    const data = {folders:[],files:[]}; f.workers[0].resolve(data); assert.equal(await local, data);
    assert.equal(await f.invoke('getFolderContents','owner/repo',''),data);
    const cache = f.c.catalog.folderContentsCache;
    for (let i=0;i<101;i++) cache.set('local'+i,data);
    assert.equal(cache.size,100); assert.equal(cache.has('local0'),false);
    f.c.clock=300000; assert.equal(cache.has('local100'),false);
  }
});
}

test('catalog modules are composed before host without search or route ownership', () => {
  const html = fs.readFileSync('static/index.html','utf8');
  for (const name of ['search/catalog/domain/sidebar-payload.js','search/catalog/application/client.js']) {
    assert.ok(APP_DEPENDENCIES.includes(name)); assert.equal(html.split(name).length-1,1);
    assert.ok(html.indexOf(name)<html.indexOf('static/app.js'));
  }
  const client = fs.readFileSync('static/search/catalog/application/client.js','utf8');
  assert.doesNotMatch(client, /\bSTATE\b|fetchSearchPage|buildSearchApiBody|routeRenderId/);
  if (space) assert.match(app, /getContents\(repo, path\) \{ return catalog\.getContents\.call\(this, repo, path\); \}/);
});
