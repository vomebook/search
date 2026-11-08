// Pin observable behavior of each site's original canonical cache-key encoder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const app = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const match = app.match(/^function stableSearchStringify\([^]*?^}/m);
assert.ok(match, 'original stableSearchStringify must remain available');
const context = vm.createContext({});
const modulePath = path.join(root, 'static/search/domain/stable-stringify.js');
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), context, {filename: modulePath});
vm.runInContext(match[0], context, {filename: 'stable-search-stringify-host.js'});
const stringify = context.stableSearchStringify;

test('stable object keys are sorted recursively while arrays retain order', () => {
  assert.equal(stringify({z: 1, a: {y: [2, {z: 3, a: 1}], b: '文'}}), '{"a":{"b":"文","y":[2,{"a":1,"z":3}]},"z":1}');
  assert.equal(stringify({}), '{}');
  assert.equal(stringify([]), '[]');
  assert.equal(stringify([3, 2, 1]), '[3,2,1]');
});

test('primitive values preserve the original JSON semantics', () => {
  for (const value of [null, false, true, 0, -0, 1.25, 'x\n文', NaN, Infinity, undefined, Symbol('x')]) {
    assert.equal(stringify(value), JSON.stringify(value));
  }
  assert.throws(() => stringify(1n), {name: 'TypeError'});
});

test('undefined, functions and sparse arrays retain the exact original representation', () => {
  const sparse = new Array(3);
  sparse[1] = undefined;
  assert.equal(stringify(sparse), '[,,]');
  assert.equal(stringify({a: undefined, b: () => {}}), '{"a":undefined,"b":undefined}');
  assert.equal(stringify([undefined, () => {}]), '[,]');
});

test('property access order and exception propagation remain observable', () => {
  const calls = [];
  const input = {};
  Object.defineProperty(input, 'z', {enumerable: true, get() { calls.push('z'); return 1; }});
  Object.defineProperty(input, 'a', {enumerable: true, get() { calls.push('a'); return 2; }});
  assert.equal(stringify(input), '{"a":2,"z":1}');
  assert.deepEqual(calls, ['a', 'z']);
  const broken = {get x() { throw new Error('value failure'); }};
  assert.throws(() => stringify(broken), {message: 'value failure'});
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => stringify(cycle), {name: 'RangeError'});
});

test('original global binding can be replaced and recursive calls resolve through it', () => {
  const original = context.stableSearchStringify;
  try {
    context.stableSearchStringify = () => 'replacement';
    assert.equal(original([1]), '[replacement]');
    context.stableSearchStringify = original;
    const dynamic = {get a() { context.stableSearchStringify = () => 'replacement'; return 5; }, b: 6};
    assert.equal(original(dynamic), '{"a":5,"b":replacement}');
    assert.equal(vm.runInContext('delete globalThis.stableSearchStringify', context), false);
  } finally {
    context.stableSearchStringify = original;
  }
});
