// Expectations pin the existing inline merge before any possible extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const app = fs.readFileSync(path.join(process.cwd(), 'static/app.js'), 'utf8');
const match = app.match(/^function mergeFolderFilters\([^]*?^}/m);
assert.ok(match, 'the original inline folder merge must be available');
const fragment = process.env.FOLDER_MERGE_FRAGMENT;
if (fragment) assert.equal(fs.readFileSync(fragment, 'utf8'), match[0]);

function fixture(globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(match[0], context, {filename: fragment || 'folder-merge-baseline.js'});
  return context;
}

test('self paths retain order and duplicates while matching subtree paths are excluded', () => {
  const {mergeFolderFilters: merge} = fixture();
  const selfs = ['', 'a', 'a', '__proto__', '文化'];
  const subtrees = ['a', 'ab', 'ab', '', 'constructor', '文化'];
  const result = merge(selfs, subtrees);
  assert.deepEqual(Array.from(result), ['', 'a', 'a', '__proto__', '文化', 'ab', 'ab', 'constructor']);
  assert.deepEqual(selfs, ['', 'a', 'a', '__proto__', '文化']);
  assert.deepEqual(subtrees, ['a', 'ab', 'ab', '', 'constructor', '文化']);
  assert.notEqual(result, selfs);
});

test('falsy arguments use empty arrays without discarding truthy paths', () => {
  const {mergeFolderFilters: merge} = fixture();
  for (const value of [undefined, null, false, 0, '', NaN]) {
    assert.deepEqual(Array.from(merge(value, ['x', 'x'])), ['x', 'x']);
    assert.deepEqual(Array.from(merge(['x', 'x'], value)), ['x', 'x']);
    assert.deepEqual(Array.from(merge(value, value)), []);
  }
});

test('set membership uses SameValueZero and object identity', () => {
  const {mergeFolderFilters: merge} = fixture();
  const shared = {}, separate = {};
  const result = merge([NaN, -0, shared], [NaN, 0, shared, separate, separate]);
  assert.equal(result.length, 5);
  assert.ok(Number.isNaN(result[0]));
  assert.ok(Object.is(result[1], -0));
  assert.equal(result[2], shared);
  assert.equal(result[3], separate);
  assert.equal(result[4], separate);
});

test('sparse input holes follow Set, filter and concat semantics', () => {
  const {mergeFolderFilters: merge} = fixture();
  const selfs = new Array(2);
  selfs[1] = 'a';
  const subtrees = new Array(5);
  Object.assign(subtrees, {0: undefined, 2: 'a', 3: 'b', 4: undefined});
  const result = merge(selfs, subtrees);
  assert.equal(result.length, 3);
  assert.equal(Object.hasOwn(result, 0), false);
  assert.equal(result[1], 'a');
  assert.equal(result[2], 'b');
});

test('membership is captured before subtree filter access mutates the self array', () => {
  const {mergeFolderFilters: merge} = fixture();
  const selfs = ['a'];
  const subtrees = ['b', 'c'];
  Object.defineProperty(subtrees, 'filter', {get() {
    selfs.push('b');
    return Array.prototype.filter;
  }});
  assert.deepEqual(Array.from(merge(selfs, subtrees)), ['a', 'b', 'b', 'c']);
});

test('iterator, method lookup and membership calls keep their observable order', () => {
  const trace = [];
  class TraceSet extends Set {
    has(value) { trace.push('has:' + value); return super.has(value); }
  }
  const {mergeFolderFilters: merge} = fixture({Set: TraceSet});
  const selfs = ['a'];
  Object.defineProperty(selfs, Symbol.iterator, {value: function* () { trace.push('iterate:selfs'); yield 'a'; }});
  Object.defineProperty(selfs, 'concat', {get() {
    trace.push('concat:get');
    return function(...args) { trace.push('concat:call'); return Array.prototype.concat.apply(this, args); };
  }});
  const subtrees = ['a', 'b'];
  Object.defineProperty(subtrees, 'filter', {get() { trace.push('filter:get'); return Array.prototype.filter; }});
  assert.deepEqual(Array.from(merge(selfs, subtrees)), ['a', 'b']);
  assert.deepEqual(trace, ['iterate:selfs', 'concat:get', 'filter:get', 'has:a', 'has:b', 'concat:call']);
});

test('iterator and getter failures propagate without later property reads', () => {
  const {mergeFolderFilters: merge} = fixture();
  const trace = [];
  const selfs = [];
  Object.defineProperty(selfs, Symbol.iterator, {get() { trace.push('iterator'); throw new Error('iterator failed'); }});
  Object.defineProperty(selfs, 'concat', {get() { trace.push('concat'); return Array.prototype.concat; }});
  assert.throws(() => merge(selfs, []), {message: 'iterator failed'});
  assert.deepEqual(trace, ['iterator']);
  const other = [];
  Object.defineProperty(other, 'concat', {get() { trace.push('concat:error'); throw new Error('concat failed'); }});
  const subtrees = [];
  Object.defineProperty(subtrees, 'filter', {get() { trace.push('filter'); return Array.prototype.filter; }});
  assert.throws(() => merge(other, subtrees), {message: 'concat failed'});
  assert.deepEqual(trace, ['iterator', 'concat:error']);
});

test('rebound Set receives the original iterable without an intermediate copy', () => {
  const calls = [];
  class InspectSet extends Set {
    constructor(values) { calls.push(values); super(values); }
  }
  const {mergeFolderFilters: merge} = fixture({Set: InspectSet});
  const selfs = ['a'];
  assert.deepEqual(Array.from(merge(selfs, ['a', 'b'])), ['a', 'b']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], selfs);
});

test('the original global function binding remains writable but not deletable', () => {
  const context = fixture();
  context.mergeFolderFilters = () => 'replaced';
  assert.equal(vm.runInContext('mergeFolderFilters()', context), 'replaced');
  assert.equal(vm.runInContext('delete globalThis.mergeFolderFilters', context), false);
});
