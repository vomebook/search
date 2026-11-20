import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  const context = vm.createContext({Set, Map, performance: {now: () => 0}, setTimeout, clearTimeout});
  for (const file of ['domain/folder-selection.js', 'presentation/folder-tree.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../../../static/search/sidebar/${file}`, import.meta.url), 'utf8'), context);
  }
  const node = (path, children = [], direct = true) => ({path, name: path, children, isRoot: !path,
    hasDirectFiles: direct, hasChildren: !!children.length, showSelfToggle: direct && !!children.length});
  const c = node('a/b/c'), b = node('a/b', [c]), a = node('a', [b]);
  const root = node('', [a, node('ab'), node('empty', [node('empty/x')], false)]);
  const nodes = [root, a, b, c, root.children[1], root.children[2], root.children[2].children[0]];
  const view = {tree: [root], subtrees: [], selfs: [], collapsed: {'': true}, mode: 'repo', routeId: 1};
  const listeners = {}, rows = [];
  const container = {isConnected: true, addEventListener(type, fn) { listeners[type] = fn; },
    replaceChildren() { rows.length = 0; }, appendChild(row) { rows.push(row); },
    querySelectorAll() { return rows.filter(row => row._folderNode); }};
  context.document = {createElement() { return {style: {setProperty() {}}, dataset: {},
    querySelector() { return null; }, setAttribute() {}}; }};
  const original = context.VoiceOfMLSearchFolderSelection;
  let builds = 0, stateLookups = [];
  const selection = {...original,
    createFolderSelectionLookup(...args) { builds++; return original.createFolderSelectionLookup(...args); },
    folderSelectionState(...args) { stateLookups.push(args[3]); return original.folderSelectionState(...args); }};
  const controller = context.VoiceOfMLSidebarFolderTree.create({readView: () => view, container, selection,
    escape: x => x, commitSelection(subtrees, selfs) { view.subtrees = subtrees; view.selfs = selfs; },
    notify() { throw Error('unexpected limit'); }});
  const selected = () => nodes.filter(n => n.hasDirectFiles && (view.selfs.includes(n.path) ||
    original.folderPathCovered(n.path, new Set(view.subtrees)))).map(n => n.path);
  return {view, nodes, controller, selected, listeners, get builds() { return builds; }, stateLookups};
}

test('inversion preserves file-membership complement for 2048 mixed selections', () => {
  const f = fixture();
  const paths = f.nodes.filter(n => n.hasDirectFiles).map(n => n.path);
  const subtreePaths = f.nodes.slice(1).map(n => n.path);
  for (let mask = 0; mask < 2048; mask++) {
    f.view.selfs = paths.filter((_, i) => mask & (1 << i));
    f.view.subtrees = subtreePaths.filter((_, i) => mask & (1 << (i + paths.length)));
    const before = f.selected();
    f.controller.invertSelection();
    assert.deepEqual(f.selected(), paths.filter(path => !before.includes(path)), `mask ${mask}`);
    f.controller.invertSelection();
    assert.deepEqual(f.selected(), before, `double inversion ${mask}`);
  }
});

test('checkbox uses current memo, invalidates on mutation and tree replacement', () => {
  const f = fixture();
  f.controller.render();
  assert.equal(f.builds, 1);
  const change = node => f.listeners.change({target: {closest: () => ({_folderNode: node}), matches: () => true}});
  change(f.nodes[1]);
  assert.ok(f.stateLookups.at(-1) instanceof Map);
  assert.equal(f.builds, 3); // initial, normalization, refresh; no checkbox-only build
  assert.deepEqual(f.selected(), ['a', 'a/b', 'a/b/c']);
  change(f.nodes[2]);
  assert.equal(f.builds, 5);
  assert.deepEqual(f.selected(), ['a']);
  f.view.selfs.push('ab');
  change(f.nodes[4]);
  assert.equal(f.builds, 8); // changed input invalidates before checkbox evaluation
  assert.deepEqual(f.selected(), ['a']);
  f.view.tree = [...f.view.tree];
  change(f.nodes[1]);
  assert.equal(f.builds, 11); // changed tree invalidates too
  assert.deepEqual(f.selected(), ['a', 'a/b', 'a/b/c']);
  f.controller.cancel();
});
