import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({Set, Map, performance: {now: () => 0},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }});
  for (const file of ['domain/folder-selection.js', 'presentation/folder-tree.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../../../static/search/sidebar/${file}`, import.meta.url), 'utf8'), context);
  }
  const node = (path, children = [], direct = true) => ({path, name: path, children, isRoot: !path,
    hasDirectFiles: direct, hasChildren: !!children.length, showSelfToggle: direct && !!children.length});
  const c = node('a/b/c'), b = node('a/b', [c]), a = node('a', [b]);
  const root = node('', [a, node('ab'), node('empty', [node('empty/x')], false)]);
  const nodes = [root, a, b, c, root.children[1], root.children[2], root.children[2].children[0]];
  const view = {tree: [root], subtrees: [], selfs: [], collapsed: {'': true}, mode: 'repo', routeId: 1};
  const listeners = {}, commits = [], notices = [], stateLookups = [], lookups = [];
  function element() {
    const input = {setAttribute() {}};
    const button = {classList: {toggle(_, active) { button.active = active; }},
      setAttribute(name, value) { button[name] = value; }};
    const children = [];
    return {isConnected: true, style: {setProperty() {}}, dataset: {},
      set innerHTML(_) { children.length = 0; }, addEventListener(type, fn) { listeners[type] = fn; },
      replaceChildren() { children.length = 0; }, appendChild(child) { children.push(child); },
      querySelectorAll(selector) { return children.flatMap(child => child.className === selector.slice(1) ?
        [child] : child.querySelectorAll(selector)); },
      querySelector(selector) { return selector.startsWith('input') ? input :
        selector === '.folder-self-toggle' && this._folderNode?.showSelfToggle ? button : null; }};
  }
  const container = element();
  context.document = {createElement: element};
  const original = context.VoiceOfMLSearchFolderSelection;
  const hooks = {};
  const selection = {...original,
    createFolderSelectionLookup(...args) {
      const lookup = original.createFolderSelectionLookup(...args);
      lookups.push(lookup);
      return lookup;
    },
    folderSelectionState(...args) { stateLookups.push(args[3]); return original.folderSelectionState(...args); }};
  const controller = context.VoiceOfMLSidebarFolderTree.create({readView: () => view, container, selection,
    escape: x => x, commitSelection(subtrees, selfs) {
      commits.push([Array.from(subtrees), Array.from(selfs)]);
      Object.assign(view, {subtrees, selfs});
      hooks.commit?.(subtrees, selfs);
    },
    notify(message) { notices.push(message); }});
  const selected = () => nodes.filter(n => n.hasDirectFiles && (view.selfs.includes(n.path) ||
    original.folderPathCovered(n.path, new Set(view.subtrees)))).map(n => n.path);
  const change = node => listeners.change({target: {closest: () => ({_folderNode: node}), matches: () => true}});
  const toggleSelf = node => listeners.click({target: {closest: selector =>
    selector === '.filter-folder-item' ? {_folderNode: node} : selector === '.folder-self-toggle'}, preventDefault() {}});
  return {view, nodes, controller, selected, change, toggleSelf, commits, notices, hooks, lookups, original, stateLookups,
    get builds() { return lookups.length; }, rows: () => container.querySelectorAll('.filter-folder-item'),
    drain() { while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } }};
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

test('inversion keeps forest order and does not treat the empty path as subtree coverage', () => {
  const f = fixture();
  const [root, a, , , ab, empty] = f.nodes;
  f.view.tree = [ab, {...root, children: [a, empty]}, {...ab, path: 'aa'}];
  f.view.subtrees = ['', 'a/b'];
  f.view.selfs = ['ab'];
  f.controller.invertSelection();
  assert.deepEqual(f.commits, [[['aa', 'empty'], ['', 'a']]]);
});

test('checkbox uses current memo, invalidates on mutation and tree replacement', () => {
  const f = fixture();
  f.controller.render();
  assert.equal(f.builds, 1);
  f.change(f.nodes[1]);
  assert.equal(f.stateLookups.at(-1), f.lookups[0]);
  assert.equal(f.builds, 2); // initial and normalization, reused for refresh
  assert.deepEqual(f.selected(), ['a', 'a/b', 'a/b/c']);
  f.change(f.nodes[2]);
  assert.equal(f.stateLookups.at(-1), f.lookups[1]);
  assert.equal(f.builds, 3);
  assert.deepEqual(f.selected(), ['a']);
  f.view.selfs.push('ab');
  f.change(f.nodes[4]);
  assert.equal(f.builds, 5); // changed input invalidates before checkbox evaluation
  assert.deepEqual(f.selected(), ['a']);
  f.view.tree = [...f.view.tree];
  f.change(f.nodes[1]);
  assert.equal(f.builds, 7); // changed tree invalidates too
  assert.deepEqual(f.selected(), ['a', 'a/b', 'a/b/c']);
  f.controller.render();
  assert.equal(f.builds, 8); // full render resets the memo even on the same tree
});

test('already normalized first click skips the topology scan', () => {
  const f = fixture();
  const root = f.nodes[0], children = root.children;
  let reads = 0;
  Object.defineProperty(root, 'children', {get() { reads++; return children; }});
  f.controller.render();
  reads = 0;
  f.original.createFolderSelectionLookup(f.view.tree, new Set(['a']), new Set());
  const readsPerLookup = reads;
  reads = 0;
  f.change(f.nodes[1]);
  assert.equal(f.builds, 2);
  assert.equal(reads, readsPerLookup);
});

test('normalization lookup matches fresh checkbox and self projection for mixed selections', () => {
  const f = fixture();
  f.view.collapsed = {};
  f.controller.render();
  const paths = f.nodes.map(node => node.path);
  for (let mask = 0; mask < 1 << (2 * paths.length); mask++) {
    const subtrees = new Set(paths.filter((_, i) => mask & (1 << i)));
    const selfs = new Set(paths.filter((_, i) => mask & (1 << (i + paths.length))));
    const builds = f.builds;
    f.controller.persistSelection(subtrees, selfs);
    f.controller.refresh();
    assert.equal(f.builds, builds + 1, `mask ${mask}`);
    const fresh = f.original.createFolderSelectionLookup(f.view.tree, subtrees, selfs);
    for (const row of f.rows()) {
      const node = row._folderNode, input = row.querySelector('input'), button = row.querySelector('.folder-self-toggle');
      assert.deepEqual(f.lookups.at(-1).get(node), fresh.get(node), `${mask} ${node.path}`);
      const {full, partial} = fresh.get(node);
      assert.equal(input.checked, full);
      assert.equal(input.indeterminate, partial);
      if (button) {
        const self = selfs.has(node.path) || f.original.folderPathCovered(node.path, subtrees);
        assert.equal(button.active, self);
        assert.equal(button['aria-pressed'], String(self));
      }
    }
  }
});

test('root selection and direct-file exclusion preserve normalized commit values', () => {
  const f = fixture();
  f.controller.render();
  f.controller.selectAll();
  assert.deepEqual(f.commits.at(-1), [['a', 'ab', 'empty'], ['']]);
  f.toggleSelf(f.nodes[0]);
  f.toggleSelf(f.nodes[1]);
  assert.deepEqual(f.commits.at(-1), [['ab', 'empty', 'a/b'], []]);
  assert.deepEqual(f.selected(), ['a/b', 'a/b/c', 'ab', 'empty/x']);
  assert.equal(f.builds, 4);
});

test('select-all toggle reuses the rendered lookup across top-level branches', () => {
  const f = fixture();
  f.view.tree = f.nodes[0].children;
  f.controller.render();
  f.controller.selectAll();
  assert.deepEqual(f.commits.at(-1), [['a', 'ab', 'empty'], []]);
  f.controller.selectAll();
  assert.deepEqual(f.commits.at(-1), [[], []]);
  assert.equal(f.builds, 3, 'initial projection and one normalization per commit');
  assert.deepEqual(f.stateLookups, [], 'no independent subtree projections during either toggle');
});

test('rejected selection neither commits nor replaces the rendered memo', () => {
  const f = fixture();
  f.view.selfs = [''];
  f.controller.render();
  for (const overflow of [0, 1]) {
    const sets = [new Set(), new Set()];
    for (let i = 0; i <= 10000; i++) sets[overflow].add(`unknown-${i}`);
    f.controller.persistSelection(...sets);
    f.controller.refresh();
  }
  assert.equal(f.builds, 3);
  assert.equal(f.notices.length, 2);
  assert.equal(f.commits.length, 0);
  assert.deepEqual(f.selected(), ['']);
  f.change(f.nodes[1]);
  assert.equal(f.stateLookups.at(-1), f.lookups[0]);
});

test('invalid tree topology or child metadata forces a fresh projection', () => {
  for (const corrupt of [
    f => { f.nodes[1].hasChildren = false; f.nodes[1].showSelfToggle = false; },
    f => { f.nodes[2].path = 'elsewhere'; },
    f => { f.view.tree.push({...f.nodes[4]}); },
  ]) {
    const f = fixture();
    f.view.collapsed = {};
    f.controller.render();
    f.controller.persistSelection(new Set(), new Set(['a']));
    assert.equal(f.builds, 2);
    corrupt(f);
    f.controller.render(); // A render on the same tree must not keep its old topology proof.
    f.controller.persistSelection(new Set(), new Set(['a', 'a/b', 'a/b/c']));
    f.controller.refresh();
    assert.equal(f.builds, 5);
    for (const row of f.rows()) {
      assert.equal(row.querySelector('input').checked, f.lookups.at(-1).get(row._folderNode).full);
    }
  }
});

test('commits do not publish lookup metadata for a replaced tree or rewritten selection', () => {
  const f = fixture();
  f.controller.render();
  f.hooks.commit = subtrees => { subtrees.splice(0, subtrees.length, 'ab'); };
  f.change(f.nodes[1]);
  assert.equal(f.builds, 3);
  assert.deepEqual(f.selected(), ['ab']);
  f.hooks.commit = () => { f.view.tree = [...f.view.tree]; };
  f.change(f.nodes[1]);
  assert.equal(f.builds, 5);
  assert.deepEqual(f.selected(), ['a', 'a/b', 'a/b/c', 'ab']);
});

test('pending render uses committed memo or falls back after the selection changes', () => {
  for (const rewrite of [false, true]) {
    const f = fixture();
    f.view.tree = Array.from({length: 40}, (_, i) => ({...f.nodes[4], path: `node-${i}`}));
    f.controller.render();
    assert.equal(f.rows().length, 32);
    assert.ok(f.controller.pending() > 0);
    if (rewrite) f.hooks.commit = (_, selfs) => { selfs.push('node-39'); };
    f.controller.persistSelection(new Set(['node-38']), new Set());
    f.drain(); // No explicit refresh: the pending batch reads the current view.
    assert.equal(f.builds, rewrite ? 3 : 2);
    assert.equal(f.rows().length, 40);
    assert.equal(f.rows()[38].querySelector('input').checked, true);
    assert.equal(f.rows()[39].querySelector('input').checked, rewrite);
  }
});
