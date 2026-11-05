// Pin the original Pages extension-filter behavior before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'static/app.js'), 'utf8');
const local = value => JSON.parse(JSON.stringify(value));

function fixture(data, selected = []) {
  const changes = [];
  const state = {mode: 'global', repo: '', repoFull: '', filterExtensions: selected.slice(),
    extensionList: data, extensionOtherCollapsed: true};
  const container = {innerHTML: ''};
  const c = vm.createContext({STATE: state, DOM: {filterExtList: container}, extensionFilterRenderId: 0,
    routeRenderId: 7, extensionList: [], extensionCounts: {}, repoExtensionCounts: {}, apiAvailable: true,
    fetchExtensions: async () => data, saveStoredExtensionFilters: () => changes.push('save'),
    updateFilterCancelButtons: () => changes.push('buttons'), scheduleFilterSearch: () => changes.push('search'),
    renderExtensionTree(_container, items, rest, selection, callback) {
      c.capture = {items: local(items), rest: local(rest), selected: local(selection), callback};
    }});
  const filename = path.join(process.cwd(), 'static/search/file-types.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), c, {filename});
  for (const pattern of [/^const ORDERED_EXTENSIONS = [^\n]+/m,
    /^(?:async )?function renderExtensionFilter\([^]*?^}/m]) {
    const match = source.match(pattern);
    assert.ok(match, `inline declaration missing: ${pattern}`);
    vm.runInContext(match[0], c);
  }
  return {c, state, container, changes, run: () => c.renderExtensionFilter()};
}

test('known order, unknown grouping, selected-only entries and change callbacks', async () => {
  const data = [{name: 'z', count: 3}, {name: 'pdf', count: 4}, {name: 'aac', count: 2},
    {name: 'PDF', count: 5}, {name: 'txt', count: 1}, null, {name: 0}];
  const f = fixture(data, ['md', 'z9']);
  await f.run();
  assert.deepEqual(f.c.capture.items, [{key: 'pdf', label: '.pdf', count: 4},
    {key: 'txt', label: '.txt', count: 1}, {key: 'md', label: '.md', count: 0},
    {key: 'aac', label: '.aac', count: 2}]);
  assert.deepEqual(f.c.capture.rest, [{name: 'z', count: 3}, {name: 'PDF', count: 5}, {name: 'z9', count: 0}]);
  assert.deepEqual(f.c.capture.selected, ['md', 'z9']);
  assert.equal(data.length, 9);
  f.c.capture.callback(['pdf', 'z']);
  assert.deepEqual(local(f.state.filterExtensions), ['pdf', 'z']);
  assert.deepEqual(f.changes, ['save', 'buttons', 'search']);
});

test('empty input follows each original rendering path', async () => {
  const f = fixture([]);
  await f.run();
  assert.deepEqual(f.c.capture.items, []);
  assert.deepEqual(f.c.capture.rest, []);
});

test('duplicate known items and zero counts retain original ordering', async () => {
  const f = fixture([{name: 'txt', count: 5}, {name: 'pdf'}, {name: 'pdf', count: 0}]);
  await f.run();
  assert.deepEqual(f.c.capture.items, [{key: 'pdf', label: '.pdf', count: 0},
    {key: 'pdf', label: '.pdf', count: 0}, {key: 'txt', label: '.txt', count: 5}]);
});

test('stale asynchronous render does not publish an old route', async () => {
  const f = fixture([]);
  let resolve;
  f.c.fetchExtensions = () => new Promise(done => { resolve = done; });
  const pending = f.run();
  f.state.mode = 'repo';
  resolve([{name: 'pdf', count: 1}]);
  await pending;
  assert.equal(f.c.capture, undefined);
});

test('a newer same-route render supersedes an older pending result', async () => {
  const f = fixture([]);
  const releases = [];
  f.c.fetchExtensions = () => new Promise(done => { releases.push(done); });
  const older = f.run();
  const newer = f.run();
  releases[1]([{name: 'txt', count: 2}]);
  await newer;
  assert.deepEqual(f.c.capture.items, [{key: 'txt', label: '.txt', count: 2}]);
  releases[0]([{name: 'pdf', count: 1}]);
  await older;
  assert.deepEqual(f.c.capture.items, [{key: 'txt', label: '.txt', count: 2}]);
});
