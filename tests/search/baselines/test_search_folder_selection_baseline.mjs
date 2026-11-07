// Expectations were pinned against both original inline folder selection functions before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const modulePath = path.join(root, 'static/search/folder-selection.js');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), context, {filename: modulePath});
const api = context.VoiceOfMLSearchFolderSelection;
const {folderPathCovered, createFolderSelectionLookup, folderSelectionState, applyFolderSelectionToNode} = api;
const plain = value => JSON.parse(JSON.stringify(value));

/** Records every Set membership probe while delegating to a real Set. */
function tracedSet(values, trace, label) {
  const set = new Set(values);
  return {has(value) { trace.push(`${label}:${value}`); return set.has(value); }};
}

function folder(path, children = [], extra = {}) {
  return {path, children, hasChildren: children.length > 0, hasDirectFiles: true, ...extra};
}

test('covered paths match exact ancestors in their original probe order', () => {
  const trace = [];
  assert.equal(folderPathCovered('a/b/c', tracedSet([], trace, 's')), false);
  assert.deepEqual(trace, ['s:a/b/c', 's:a/b', 's:a']);
  trace.length = 0;
  assert.equal(folderPathCovered('a/b/c', tracedSet(['a/b'], trace, 's')), true);
  assert.deepEqual(trace, ['s:a/b/c', 's:a/b']);
  assert.equal(folderPathCovered('', new Set([''])), false);
  assert.equal(folderPathCovered('a', new Set([''])), false);
  assert.equal(folderPathCovered('ab/c', new Set(['a'])), false);
  assert.equal(folderPathCovered('a/b', new Set(['a'])), true);
  assert.equal(folderPathCovered('文化/sub', new Set(['文化'])), true);
  assert.equal(folderPathCovered('/x', new Set([''])), false);
  assert.equal(folderPathCovered('a//b', new Set(['a/'])), true);
});

test('lookup projects full and partial states for every node kind', () => {
  assert.equal(createFolderSelectionLookup(null, new Set(), new Set()).size, 0);
  assert.equal(createFolderSelectionLookup(undefined, new Set(), new Set()).size, 0);
  const leaf = folder('a/leaf');
  const empty = folder('a/empty', [], {hasDirectFiles: false});
  const toggled = folder('a/toggled', [folder('a/toggled/x')], {showSelfToggle: true});
  const inner = folder('a/inner', [folder('a/inner/x')], {hasDirectFiles: false});
  const a = folder('a', [leaf, empty, toggled, inner], {hasDirectFiles: false});
  const top = {path: '', isRoot: true, hasDirectFiles: true, children: [a]};
  const childless = {path: '', isRoot: true, hasDirectFiles: true};
  const bare = {path: '', isRoot: true, hasDirectFiles: false, children: []};
  const state = (subtrees, selfs, nodes = [top]) => {
    const lookup = createFolderSelectionLookup(nodes, new Set(subtrees), new Set(selfs));
    return Object.fromEntries(Array.from(lookup, ([node, value]) => [node.path || '<root>', plain(value)]));
  };
  assert.deepEqual(state([], []), {
    'a/leaf': {full: false, partial: false}, 'a/empty': {full: false, partial: false},
    'a/toggled/x': {full: false, partial: false}, 'a/toggled': {full: false, partial: false},
    'a/inner/x': {full: false, partial: false}, 'a/inner': {full: false, partial: false},
    a: {full: false, partial: false}, '<root>': {full: false, partial: false}
  });
  assert.deepEqual(state(['a'], ['']), {
    'a/leaf': {full: true, partial: false}, 'a/empty': {full: true, partial: false},
    'a/toggled/x': {full: true, partial: false}, 'a/toggled': {full: true, partial: false},
    'a/inner/x': {full: true, partial: false}, 'a/inner': {full: true, partial: false},
    a: {full: true, partial: false}, '<root>': {full: true, partial: false}
  });
  assert.deepEqual(state(['a/toggled/x', 'a/inner/x', 'a/empty'], ['a/leaf']), {
    'a/leaf': {full: true, partial: false}, 'a/empty': {full: true, partial: false},
    'a/toggled/x': {full: true, partial: false}, 'a/toggled': {full: false, partial: true},
    'a/inner/x': {full: true, partial: false}, 'a/inner': {full: true, partial: false},
    a: {full: false, partial: true}, '<root>': {full: false, partial: true}
  });
  assert.deepEqual(state(['a/toggled/x'], ['a/toggled', 'a/inner'])['a/toggled'], {full: true, partial: false});
  assert.deepEqual(state([], ['a/inner'])['a/inner'], {full: false, partial: true});
  assert.deepEqual(state(['a/inner'], [])['a/inner'], {full: true, partial: false});
  assert.deepEqual(state([], ['a/toggled'])['a/toggled'], {full: false, partial: true});
  assert.deepEqual(state([], [''], [childless]), {'<root>': {full: true, partial: false}});
  assert.deepEqual(state([], [], [childless]), {'<root>': {full: false, partial: false}});
  assert.deepEqual(state([], [], [bare]), {'<root>': {full: false, partial: false}});
  assert.deepEqual(state(['x'], [], [folder('x', [], {hasDirectFiles: false})]), {x: {full: true, partial: false}});
  assert.deepEqual(state([], ['x'], [folder('x', [], {hasDirectFiles: false})]), {x: {full: false, partial: true}});
});

test('lookup visits each node once in original post-order without recursion', () => {
  const order = [];
  const lookup = createFolderSelectionLookup([folder('a', [folder('a/b'), folder('a/c')]), folder('d')], new Set(), new Set());
  for (const node of lookup.keys()) order.push(node.path);
  assert.deepEqual(order, ['d', 'a/b', 'a/c', 'a']);
  let reads = 0;
  let deep = {path: 'n', children: [], hasChildren: false, hasDirectFiles: true};
  for (let i = 0; i < 20000; i++) deep = {path: `n${i}`, children: [deep], hasChildren: true, hasDirectFiles: false};
  const count = node => {
    for (let current = node; current;) {
      const children = current.children;
      Object.defineProperty(current, 'children', {get() { reads++; return children; }});
      current = children[0];
    }
  };
  count(deep);
  const deepLookup = createFolderSelectionLookup([deep], new Set(), new Set(['n']));
  assert.equal(deepLookup.size, 20001);
  assert.deepEqual(plain(deepLookup.get(deep)), {full: true, partial: false});
  assert.equal(reads, 20000 * 3 + 2);
});

test('selection state keeps null handling, supplied lookups and missing entries', () => {
  const first = folderSelectionState(null, new Set(), new Set());
  const second = folderSelectionState(undefined, new Set(), new Set());
  assert.deepEqual(plain(first), {full: false, partial: false});
  assert.notEqual(first, second);
  const node = folder('a');
  const sentinel = {full: 'sentinel'};
  assert.equal(folderSelectionState(node, new Set(), new Set(), new Map([[node, sentinel]])), sentinel);
  assert.equal(folderSelectionState(node, new Set(), new Set(), new Map()), undefined);
  assert.deepEqual(plain(folderSelectionState(node, new Set(), new Set(['a']))), {full: true, partial: false});
  assert.deepEqual(plain(folderSelectionState(node, new Set(), new Set(['a']), null)), {full: true, partial: false});
});

test('checkbox projection writes checked, indeterminate and self toggle state', () => {
  const trace = [];
  const fixture = (withCheckbox, withSelf) => {
    const input = {};
    const self = {classList: {toggle(name, value) { trace.push(['toggle', name, value]); }},
      setAttribute(name, value) { trace.push(['attr', name, value]); }};
    const row = {querySelector(selector) {
      trace.push(['query', selector]);
      return selector === "input[type='checkbox']" ? (withCheckbox ? input : null) : (withSelf ? self : null);
    }};
    return {input, row};
  };
  const child = folder('a/b');
  const parent = folder('a', [child]);
  let {input, row} = fixture(false, true);
  assert.equal(applyFolderSelectionToNode(parent, row, new Set(['a']), new Set()), undefined);
  assert.deepEqual(trace, [['query', "input[type='checkbox']"]]);
  assert.deepEqual(input, {});
  trace.length = 0;
  ({input, row} = fixture(true, false));
  applyFolderSelectionToNode(parent, row, new Set(), new Set(['a/b']));
  assert.deepEqual(input, {checked: false, indeterminate: true});
  assert.deepEqual(trace, [['query', "input[type='checkbox']"], ['query', '.folder-self-toggle']]);
  trace.length = 0;
  ({input, row} = fixture(true, true));
  applyFolderSelectionToNode(parent, row, new Set(), new Set(['a']));
  assert.deepEqual(input, {checked: false, indeterminate: true});
  assert.deepEqual(trace, [['query', "input[type='checkbox']"], ['query', '.folder-self-toggle'],
    ['toggle', 'active', true], ['attr', 'aria-pressed', 'true']]);
  trace.length = 0;
  ({input, row} = fixture(true, true));
  applyFolderSelectionToNode(child, row, new Set(['a']), new Set());
  assert.deepEqual(input, {checked: true, indeterminate: false});
  assert.deepEqual(trace.slice(2), [['toggle', 'active', true], ['attr', 'aria-pressed', 'true']]);
  trace.length = 0;
  ({input, row} = fixture(true, true));
  applyFolderSelectionToNode(child, row, new Set(), new Set());
  assert.deepEqual(input, {checked: false, indeterminate: false});
  assert.deepEqual(trace.slice(2), [['toggle', 'active', false], ['attr', 'aria-pressed', 'false']]);
  trace.length = 0;
  ({input, row} = fixture(true, true));
  const lookup = new Map([[child, {full: 0, partial: 'yes'}]]);
  applyFolderSelectionToNode(child, row, new Set(), new Set(), lookup);
  assert.deepEqual(input, {checked: 0, indeterminate: 'yes'});
});

test('input exceptions and missing child states propagate unchanged', () => {
  const failure = new Error('membership failure');
  assert.throws(() => folderPathCovered('a', {has() { throw failure; }}), error => error === failure);
  const child = folder('a/b');
  assert.throws(() => applyFolderSelectionToNode(child, {querySelector() { return {}; }}, new Set(), new Set(), new Map()),
    error => error.name === 'TypeError' && /Cannot destructure property 'full'/.test(error.message));
  assert.equal(folderPathCovered(null, new Set(['x'])), false);
});

test('namespace exposes the four functions on a mutable global object', () => {
  assert.deepEqual(Object.keys(api), ['folderPathCovered', 'createFolderSelectionLookup', 'folderSelectionState', 'applyFolderSelectionToNode']);
  assert.equal(Object.isFrozen(api), false);
  for (const name of Object.keys(api)) assert.equal(typeof api[name], 'function');
  for (const name of Object.keys(api)) assert.equal(name in context, false, `${name} must not leak as a global`);
  const descriptor = Object.getOwnPropertyDescriptor(context, 'VoiceOfMLSearchFolderSelection');
  assert.equal(descriptor.writable && descriptor.enumerable && descriptor.configurable, true);
});
