import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('static/search/results/application/interactions.js', 'utf8'), context);
  let clickHandler;
  let updates = 0;
  const selection = {indices: {}, lastIndex: -1};
  const loaded = new Set([0, 1, 3, 4, 5]);
  const elements = {
    multiSelectToggle: {checked: true, addEventListener() {}},
    resultsList: {addEventListener(type, handler) { if (type === 'click') clickHandler = handler; }},
  };
  context.VoiceOfMLResultInteractions.create({
    elements, selection, hasRecord: index => loaded.has(index),
    updateSelectionUI: () => updates++, warmSelectedDownload() {},
  }).installSelection();
  function click(index, checked, shiftKey = false) {
    const checkbox = {checked, dataset: {index: String(index)}, closest: () => checkbox};
    const event = {target: checkbox, shiftKey, stopPropagation() { this.stopped = true; }};
    clickHandler(event);
    assert.equal(event.stopped, true);
  }
  return {selection, click, updates: () => updates};
}

test('shift range follows post-click checked state in both directions and skips unloaded records', () => {
  const {selection, click, updates} = fixture();
  click(0, true);
  selection.indices[2] = true; // An unloaded entry must not be changed by a range operation.
  selection.indices[5] = true; // Outside the range must remain selected.
  click(4, true, true);
  assert.deepEqual(selection.indices, {0: true, 1: true, 2: true, 3: true, 4: true, 5: true});
  assert.equal(selection.lastIndex, 4);
  click(0, false, true);
  assert.deepEqual(selection.indices, {2: true, 5: true});
  assert.equal(selection.lastIndex, 0);
  click(4, true);
  click(0, true, true);
  assert.deepEqual(selection.indices, {0: true, 1: true, 2: true, 3: true, 4: true, 5: true});
  click(4, false, true);
  assert.deepEqual(selection.indices, {2: true, 5: true});
  assert.equal(updates(), 6);
});

test('ordinary clicks and shift without an anchor use the clicked checkbox state', () => {
  const {selection, click} = fixture();
  click(3, true, true);
  assert.deepEqual(selection.indices, {3: true});
  click(3, false);
  assert.deepEqual(selection.indices, {});
  assert.equal(selection.lastIndex, 3);
});
