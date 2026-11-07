const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the DOM-facing selection projection against actual file membership.
// The pure projection lives in static/search/folder-selection.js; the host keeps
// the memo, branch splitting and normalization that call it through the namespace.
const source = fs.readFileSync(path.join(__dirname, '../../../static/app.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(__dirname, '../../../static/search/folder-selection.js'), 'utf8');
const context = vm.createContext({Set, STATE: {folderTree: []}});
vm.runInContext(moduleSource, context);
assert.strictEqual(source.indexOf('function folderPathCovered('), -1);
assert.strictEqual(source.indexOf('function applyFolderSelectionToNode('), -1);
const start = source.indexOf('let folderSelectionMemo = null;');
const end = source.indexOf('function persistFolderSelection(', start);
assert(start >= 0 && end > start);
vm.runInContext(source.slice(start, end), context);
context.applyFolderSelectionToNode = context.VoiceOfMLSearchFolderSelection.applyFolderSelectionToNode;

function node(path, children = []) {
  return {path, children, isRoot: path === '', hasDirectFiles: true,
    hasChildren: children.length > 0, showSelfToggle: children.length > 0};
}
const c = node('a/b/c'), b = node('a/b', [c]), a = node('a', [b]);
const ab = node('ab'), x = node('x'), root = node('', [a, ab, x]);
const nodes = [root, a, b, c, ab, x];
context.STATE.folderTree = [root];
const paths = nodes.map(item => item.path);
const below = (value, prefix) => value === prefix || value.startsWith(prefix + '/');
const filesIn = item => paths.filter(value => item.isRoot || below(value, item.path));
const selectedFiles = (subtrees, selfs) => paths.filter(value => selfs.has(value) ||
  [...subtrees].some(prefix => prefix && below(value, prefix)));

for (let mask = 0; mask < 2048; mask++) {
  const selfs = new Set(paths.filter((_, i) => mask & (1 << i)));
  const subtrees = new Set(paths.slice(1).filter((_, i) => mask & (1 << (i + paths.length))));
  const selected = selectedFiles(subtrees, selfs);
  for (const item of nodes) {
    const input = {};
    const self = {classList: {toggle(_, value) { self.active = value; }},
      setAttribute(_, value) { self.pressed = value; }};
    const row = {querySelector(selector) { return selector === "input[type='checkbox']" ? input : self; }};
    context.applyFolderSelectionToNode(item, row, subtrees, selfs);
    const files = filesIn(item);
    const full = files.every(file => selected.includes(file));
    const partial = !full && files.some(file => selected.includes(file));
    assert.strictEqual(input.checked, full, `checked ${mask} ${item.path}`);
    assert.strictEqual(input.indeterminate, partial, `partial ${mask} ${item.path}`);
    assert.strictEqual(self.active, selected.includes(item.path));
    assert.strictEqual(self.pressed, String(self.active));
  }
  context.normalizeFolderSelection(subtrees, selfs);
  assert.deepStrictEqual(selectedFiles(subtrees, selfs), selected, `normalization ${mask}`);
}

for (const target of nodes) {
  const subtrees = new Set(['a', 'ab', 'x']);
  const selfs = new Set(['']);
  context.setNodeSubtreeSelection(target, false, subtrees, selfs);
  context.normalizeFolderSelection(subtrees, selfs);
  assert.deepStrictEqual(selectedFiles(subtrees, selfs), paths.filter(file => !filesIn(target).includes(file)));
}
console.log('folder selection: 2048 combinations and branch removal preserve file membership');
