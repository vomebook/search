// Expectations pin the existing inline helper before any possible extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const app = fs.readFileSync(path.join(process.cwd(), 'static/app.js'), 'utf8');
const match = app.match(/^function sameSearchFilterValues\([^]*?^}/m);
assert.ok(match, 'the original inline filter comparison must be available');
const context = vm.createContext({});
// A coverage fixture may provide an identical physical copy of this fragment.
// It is not a coverage report for app.js or its callers.
const fragment = process.env.FILTER_EQUALITY_FRAGMENT;
if (fragment) assert.equal(fs.readFileSync(fragment, 'utf8'), match[0]);
vm.runInContext(match[0], context, {filename: fragment || 'same-search-filter-values.js'});
const same = context.sameSearchFilterValues;

test('falsy saved values short-circuit before inspecting current', () => {
  for (const saved of [null, undefined, false, 0, '', NaN]) assert.equal(same(null, saved), false);
  assert.throws(() => same(null, []), {name: 'TypeError'});
});

test('length and elements use strict equality in order', () => {
  const shared = {};
  for (const [current, saved, expected] of [
    [[], [], true], [['a', 'b'], ['a', 'b'], true],
    [['a', 'b'], ['b', 'a'], false], [['a'], ['a', 'b'], false],
    [[1], ['1'], false], [[NaN], [NaN], false], [[0], [-0], true],
    [[shared], [shared], true], [[{}], [{}], false]
  ]) assert.equal(same(current, saved), expected);
});

test('sparse arrays and array-like objects retain indexed property semantics', () => {
  const sparse = new Array(2);
  assert.equal(same(sparse, [undefined, undefined]), true);
  assert.equal(same('ab', {0: 'a', 1: 'b', length: 2}), true);
  assert.equal(same(new Uint8Array([1, 2]), [1, 2]), true);
  const inherited = Object.create({0: 'inherited'});
  inherited.length = 1;
  assert.equal(same(inherited, ['inherited']), true);
});

test('length and element getters preserve their read order and early exit', () => {
  const trace = [];
  const wrap = (label, values) => new Proxy(values, {get(target, key, receiver) {
    trace.push(`${label}.${String(key)}`);
    return Reflect.get(target, key, receiver);
  }});
  assert.equal(same(wrap('current', ['x', 'y']), wrap('saved', ['x', 'z'])), false);
  assert.deepEqual(trace, ['current.length', 'saved.length', 'current.length', 'current.0', 'saved.0',
    'current.length', 'current.1', 'saved.1']);
  trace.length = 0;
  assert.equal(same(wrap('current', ['x']), wrap('saved', ['x'])), true);
  assert.deepEqual(trace, ['current.length', 'saved.length', 'current.length', 'current.0', 'saved.0', 'current.length']);
  trace.length = 0;
  assert.equal(same(wrap('current', []), wrap('saved', ['x'])), false);
  assert.deepEqual(trace, ['current.length', 'saved.length']);
});

test('the current length is re-read after indexed getters mutate it', () => {
  const current = ['a', 'b'];
  Object.defineProperty(current, 0, {get() { current.length = 1; return 'a'; }});
  assert.equal(same(current, ['a', 'different']), true);
});

test('getter exceptions propagate without later property reads', () => {
  const trace = [];
  const current = new Proxy(['a'], {get(target, key, receiver) {
    trace.push(`current.${String(key)}`);
    if (key === '0') throw new RangeError('current value');
    return Reflect.get(target, key, receiver);
  }});
  const saved = new Proxy(['a'], {get(target, key, receiver) {
    trace.push(`saved.${String(key)}`);
    return Reflect.get(target, key, receiver);
  }});
  assert.throws(() => same(current, saved), {name: 'RangeError', message: 'current value'});
  assert.deepEqual(trace, ['current.length', 'saved.length', 'current.length', 'current.0']);
  assert.throws(() => same([], {get length() { throw new Error('saved length'); }}), {message: 'saved length'});
});

test('the original global function binding remains writable but not deletable', () => {
  const original = context.sameSearchFilterValues;
  try {
    context.sameSearchFilterValues = () => 'replaced';
    assert.equal(vm.runInContext('sameSearchFilterValues()', context), 'replaced');
    assert.equal(vm.runInContext('delete globalThis.sameSearchFilterValues', context), false);
  } finally {
    context.sameSearchFilterValues = original;
  }
});
