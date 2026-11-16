import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const app = await readFile('static/app.js', 'utf8');
const workerSource = await readFile('static/search/index-worker.js', 'utf8');
const legacy = await readFile(new URL('./fixtures/pages-app-4b0e1e4c-boundary.txt', import.meta.url), 'utf8');
const scriptFiles = await Promise.all(['text', 'intersection'].map(name => readFile(`static/search/worker/domain/${name}.js`, 'utf8')));

function workerHarness() {
  let listener, response;
  const context = vm.createContext({TextEncoder, crypto: {subtle: {digest: async (_name, bytes) => {
    const hash = createHash('sha256').update(bytes).digest();
    return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
  }}}, self: {addEventListener(_type, fn) { listener = fn; }, postMessage(value) { response = value; }}});
  context.importScripts = url => vm.runInContext(scriptFiles[url.includes('intersection') ? 1 : 0], context);
  vm.runInContext(workerSource, context);
  return async (type, payload) => {
    await listener({data: {protocol: 1, type, id: 1, payload}});
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  };
}
function hostPort(source, name, request) {
  const line = source.split('\n').find(item => item.trimStart().startsWith(`${name}:`));
  assert.ok(line, `missing ${name}`);
  return vm.runInNewContext(`({${line.trim()}}).${name}`, {corpusWorkerRequest: request, WORKER_REQUEST_TIMEOUT: 100});
}

function hostFunction(source, name, stubs) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('\n}', start);
  return vm.runInNewContext(`(${source.slice(start, end + 2)})`, stubs);
}

test('metadata and local-search preserve HEAD behavior for partial protocol results', async () => {
  for (const metadata of [{repos: [], extensions: []}, {repos: [{name: 'R', count: 1}], extensions: [{name: 'pdf', count: 1}] }]) {
    const run = async source => {
      const context = vm.createContext({URL, document: {baseURI: 'https://example.test/'}, DATA_URL: 'data', WORKER_LOAD_TIMEOUT: 1,
        searchIntentId: 1, getSearchViewKey: () => 'k', corpusWorkerRequest: async () => metadata,
        repoList: [], extensionCounts: {}, repoExtensionCounts: {}, extensionList: [], readerMetadata: null,
        console, showToast() {}});
      const start = source.indexOf('async function loadData()');
      const end = source.indexOf('\n}', start);
      await vm.runInContext(`(${source.slice(start, end + 2)})()`, context);
      return JSON.stringify([context.repoList, context.extensionCounts, context.repoExtensionCounts, context.extensionList, context.readerMetadata]);
    };
    assert.equal(await run(app), await run(legacy));
  }
  for (const page of [{records: [{File: 7}]}, {records: [], total: 0, page: 1, pageSize: 100, snapshot_generation: 'g'}]) {
    const stubs = {WORKER_REQUEST_TIMEOUT: 1, corpusWorkerRequest: async () => page, cloneSearchData: x => x};
    const params = {page: 1};
    const old = await hostFunction(legacy, 'doSearchLocal', stubs)(params);
    const current = await hostFunction(app, 'doSearchLocal', stubs)(params);
    assert.equal(JSON.stringify(current), JSON.stringify(old));
  }
});

test('legacy Worker values cross all three Pages host ports unchanged', async () => {
  const requestWorker = workerHarness();
  await requestWorker('replace-corpus', {data: {v: 2, rp: ['R'], fd: [[42]], rc: [[0, 7, ['pdf'], 0, {odd: 1}, 0]]}});
  for (const [port, type, args] of [
    ['localWorker', 'folder-contents', ['R', '42']],
    ['localFolders', 'folder-tree', ['R']],
    ['localRecord', 'random-record', ['R', false]],
  ]) {
    const result = await requestWorker(type, port === 'localWorker' ? {repo: 'R', path: '42'} : {repo: 'R'});
    const calls = [];
    const request = (...params) => { calls.push(params); return Promise.resolve(result); };
    const oldValue = await hostPort(legacy, port, request)(...args);
    const newValue = await hostPort(app, port, request)(...args);
    assert.strictEqual(newValue, result, `${port} must preserve result identity`);
    assert.strictEqual(oldValue, result);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), JSON.parse(JSON.stringify(calls[1])));
    if (port === 'localWorker') assert.deepEqual(JSON.parse(JSON.stringify(result.files[0].size)), {odd: 1});
    if (port === 'localFolders') assert.equal(result.tree[0].children[0].name, 42);
    if (port === 'localRecord') assert.equal(result.record.File, 7);
  }
});
