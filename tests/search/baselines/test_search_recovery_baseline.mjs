import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const fixturePath = path.join(root, 'tests/search/baselines/search-recovery-original.js.fixture');
const fixture = fs.readFileSync(fixturePath, 'utf8');
assert.equal(createHash('sha256').update(fixture).digest('hex'),
  '034fd96fd46e12bf0e2f5b94025255f32255feef7ae3afdcd3ed598d3c7a4a4f', 'reviewed original classifier changed');
const host = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const match = host.match(/^function isRecoverableSearchError\(error\) \{\n[^]*?^\}/m);
assert.ok(match, 'host recovery classifier missing');
const context = vm.createContext({});
vm.runInContext(fixture + '\nthis.originalRecovery = isRecoverableSearchError;', context);
vm.runInContext(fs.readFileSync(path.join(root, 'static/search/domain/search-recovery.js'), 'utf8'), context);
vm.runInContext(match[0], context);
const original = context.originalRecovery;
const actual = context.isRecoverableSearchError;

function outcome(fn, make) {
  const reads = [];
  try { return {value: fn(make(reads)), reads}; }
  catch (error) { return {error, reads}; }
}
function compare(make) {
  const before = outcome(original, make), after = outcome(actual, make);
  assert.deepEqual(after.reads, before.reads);
  assert.equal(after.value, before.value);
  assert.equal(after.error, before.error);
}

test('recovery status precedence and exact membership match the old host', () => {
  for (const value of [null, undefined, false, 0, '', {}, ...[408,429,500,502,503,504,400,403,404,599].map(status => ({status})),
    {status:404, message:'network failed'}, {status:'503', message:'network'}, {status:0, message:'network'}]) {
    assert.equal(actual(value), original(value));
  }
});

test('recovery messages and abort precedence match the old host', () => {
  for (const value of [{name:'AbortError',status:503,message:'network'}, {name:'TimeoutError'}, {code:'API_TIMEOUT'},
    {code:'WORKER_TIMEOUT'}, {code:'LOCAL_UNAVAILABLE'}, {message:'Network error'}, {message:'failed to fetch'},
    {message:'offline'}, {message:'timed out'}, {message:'Load failed'}, {message:'RESTORE_PAGE_CHANGED'},
    {message:'INVALID_API_RESPONSE'}, {name:'Error',code:'',message:''}]) {
    assert.equal(actual(value), original(value));
  }
});

test('recovery getter reads and error propagation remain observable', () => {
  for (const values of [{name:'AbortError', status:503}, {name:'Other', status:503},
    {name:'Other',status:0,code:'',message:'Load failed'}, {name:'Other',status:0,code:'API_TIMEOUT',message:''}]) {
    compare(reads => Object.defineProperties({}, Object.fromEntries(
      Object.entries(values).map(([key,value]) => [key, {get(){reads.push(key);return value;}}]))));
  }
  const failure = new Error('getter failure');
  compare(reads => ({get name(){reads.push('name');return 'Error';},get status(){reads.push('status');throw failure;}}));
  compare(reads => ({get name(){reads.push('name');return 'Error';},get status(){reads.push('status');return 0;},
    get code(){reads.push('code');return {toString(){reads.push('coerce');throw failure;}};}}));
});
