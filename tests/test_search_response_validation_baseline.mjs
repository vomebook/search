// Expectations were pinned against both original inline validators before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const match = source.match(/^function isValidSearchResponse\([^]*?^}/m);
assert.ok(match, 'host validator binding must remain inline');
const context = vm.createContext({});
const filename = path.join(root, 'static/search/response-validation.js');
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename});
vm.runInContext(match[0], context);
const validate = context.isValidSearchResponse;
const records = n => Array.from({length: n}, (_, index) => ({id: index}));
const response = (total, page, page_size, results) => ({total, page, page_size, results});

test('complete, final, empty and past-end pages preserve exact cardinality', () => {
  for (const [value, page, size, expected] of [
    [response(5, 1, 2, records(2)), 1, 2, true],
    [response(5, 2, 2, records(2)), 2, 2, true],
    [response(5, 3, 2, records(1)), 3, 2, true],
    [response(5, 4, 2, []), 4, 2, true],
    [response(0, 1, 2, []), 1, 2, true],
    [response(5, 3, 2, []), 3, 2, false],
    [response(5, 3, 2, records(2)), 3, 2, false],
    [response(5, 1, 2, records(1)), 1, 2, false]
  ]) assert.equal(validate(value, page, size), expected, JSON.stringify(value));
});

test('response shape, safe total and requested page fields are strictly checked', () => {
  for (const value of [null, undefined, {}, [], {results: 'x', total: 0, page: 1, page_size: 2},
    response(-1, 1, 2, []), response(Number.MAX_SAFE_INTEGER + 1, 1, 2, []),
    response(0.5, 1, 2, []), response('0', 1, 2, []), response(0, '1', 2, []),
    response(0, 1.5, 2, []), response(0, 1, '2', []), response(0, 2, 2, []),
    response(0, 1, 3, [])]) assert.equal(validate(value, 1, 2), false, String(value));
  assert.equal(validate(response(Number.MAX_SAFE_INTEGER + 1, 1, 2, records(2)), 1, 2), false);
});

test('record elements accept objects only, preserving sparse-array every semantics', () => {
  for (const value of [null, undefined, 0, false, 'x', [], () => {}])
    assert.equal(validate(response(1, 1, 2, [value]), 1, 2), false);
  for (const value of [{}, new Date(0), Object.create(null)])
    assert.equal(validate(response(1, 1, 2, [value]), 1, 2), true);
  assert.equal(validate(response(1, 1, 2, Array(1)), 1, 2), true);
});

test('legacy boundary values and getter evaluation order remain unchanged', () => {
  assert.equal(validate(response(0, 0, 2, []), 0, 2), false);
  assert.equal(validate(response(0, 1, 0, []), 1, 0), true);
  assert.equal(validate(response(0, 1, -1, []), 1, -1), false);
  const seen = [];
  const value = {
    get results() { seen.push('results'); return []; },
    get total() { seen.push('total'); return 0; },
    get page() { seen.push('page'); return 1; },
    get page_size() { seen.push('page_size'); return 2; }
  };
  assert.equal(validate(value, 1, 2), true);
  assert.deepEqual(seen, ['results', 'total', 'total', 'page', 'page', 'page_size', 'page_size', 'total', 'results', 'results']);
  assert.throws(() => validate({get results() { throw new Error('probe'); }}, 1, 2), {message: 'probe'});
  for (const [field, expectedTrace] of [
    ['total', ['results', 'total']],
    ['page', ['results', 'total', 'total', 'page']],
    ['page_size', ['results', 'total', 'total', 'page', 'page', 'page_size']]
  ]) {
    const trace = [];
    const input = {};
    for (const [name, item] of [['results', []], ['total', 0], ['page', 1], ['page_size', 2]]) {
      Object.defineProperty(input, name, {get() {
        trace.push(name);
        if (name === field) throw new Error(field);
        return item;
      }});
    }
    assert.throws(() => validate(input, 1, 2), {message: field});
    assert.deepEqual(trace, expectedTrace);
  }
  const results = [];
  const sentinel = {value: 'custom every'};
  results.every = function(callback) {
    assert.equal(this, results);
    assert.equal(typeof callback, 'function');
    return sentinel;
  };
  assert.equal(validate(response(0, 1, 2, results), 1, 2), sentinel);
  results.every = () => { throw new Error('every probe'); };
  assert.throws(() => validate(response(0, 1, 2, results), 1, 2), {message: 'every probe'});
  Object.defineProperty(results, 'every', {get() { throw new Error('every getter'); }});
  assert.throws(() => validate(response(0, 1, 2, results), 1, 2), {message: 'every getter'});
});

test('host function remains replaceable while forwarding the exact arguments and return value', () => {
  const calls = [];
  const responseValue = {value: 'uncoerced'};
  const prior = context.VoiceOfMLSearchValidation.isValidSearchResponse;
  context.VoiceOfMLSearchValidation.isValidSearchResponse = (...args) => { calls.push(args); return responseValue; };
  const input = {probe: true};
  assert.equal(context.isValidSearchResponse(input, 3, 7), responseValue);
  assert.deepEqual(calls, [[input, 3, 7]]);
  context.VoiceOfMLSearchValidation.isValidSearchResponse = prior;
  const original = context.isValidSearchResponse;
  const replacement = () => 'replaced';
  context.isValidSearchResponse = replacement;
  assert.equal(vm.runInContext('isValidSearchResponse()', context), 'replaced');
  context.isValidSearchResponse = original;
  assert.equal(vm.runInContext('delete globalThis.isValidSearchResponse', context), false);
  assert.equal(vm.runInContext('typeof isValidSearchResponse', context), 'function');
});
