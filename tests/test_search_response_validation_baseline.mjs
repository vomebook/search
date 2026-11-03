// Before extraction: run the exact inline validator against a pinned edge matrix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const match = source.match(/^function isValidSearchResponse\([^]*?^}/m);
assert.ok(match, 'original validator must remain inline');
const context = vm.createContext({});
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
});
