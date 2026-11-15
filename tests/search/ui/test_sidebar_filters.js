const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('static/search/sidebar/application/filters.js', 'utf8'), context);
  const view = {mode: 'repo', repo: 'A', repoFull: 'VoiceOfML/A', routeId: 1,
    repos: [], extensions: [], selectedRepos: [], selectedExtensions: [], tree: [], apiAvailable: true, dataLoaded: false};
  const pending = [], published = [], retained = [];
  const elements = Object.fromEntries(['repoSection','repoList','folderSection','folderTree','extList'].map(key => [key, {style: {}, innerHTML: ''}]));
  const cache = new Map();
  const controller = context.VoiceOfMLSidebarFilters.create({
    readView: () => view, elements, cache,
    tree: {updateControls() {}, initialize() {}, render() {}, retain: route => retained.push(route)},
    lists: {renderCheckboxList() {}, renderExtensionTree() {}}, orderedExtensions: ['txt'],
    initial: async () => null, fetchRepos: async () => [], fetchExtensions: async () => [],
    fetchFolders: repo => new Promise(resolve => pending.push({repo, resolve})),
    localFolders: async () => null, hasExtensionCounts: () => false, extensionCounts: () => ({}),
    publishRepos: repos => { view.repos = repos; }, publishExtensions: extensions => { view.extensions = extensions; },
    publishTree: tree => { view.tree = tree; published.push(tree); }, selectRepos() {}, selectExtensions() {},
  });
  return {controller, view, pending, published, retained, cache};
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('late folder response cannot publish over the current repository', async () => {
  const f = fixture();
  const older = f.controller.render(1);
  await turn();
  assert.equal(f.pending[0].repo, 'A');
  Object.assign(f.view, {repo: 'B', repoFull: 'VoiceOfML/B', routeId: 2});
  const newer = f.controller.render(2);
  await turn();
  const current = [{name: 'current', path: 'current', children: []}];
  f.pending[1].resolve(current);
  await newer;
  f.pending[0].resolve([{name: 'old', path: 'old', children: []}]);
  await older;
  assert.equal(f.published.length, 1);
  assert.equal(f.view.tree, current);
  assert.equal(f.controller.status().done, f.controller.status().token);
});

test('completed filter rendering transfers queued work without refetching', async () => {
  const f = fixture();
  const render = f.controller.render(1);
  await turn();
  f.pending[0].resolve([{name: 'a', path: 'a', children: []}]);
  await render;
  f.view.routeId = 2;
  f.controller.retain(2);
  assert.deepEqual(f.retained, [2]);
  assert.equal(f.pending.length, 1);
  assert.equal(f.controller.status().token, 1);
});
