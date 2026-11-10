import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

/** @typedef {number | {valueOf(): number}} CoercibleNumber */
/** @typedef {{results: unknown[], page: CoercibleNumber, page_size: CoercibleNumber, total: number, generation?: string | undefined}} RawPage */
/** @typedef {[unknown, CoercibleNumber, CoercibleNumber, null | false | {total?: number, generation?: string | void}]} WindowArgs */
/** @typedef {(...args: WindowArgs) => unknown} RawValidator */
/** @typedef {(reads: string[]) => WindowArgs} CaseBuilder */

// The VM loads the reviewed fixture and host at runtime. Check that each export
// is callable, then pass untrusted inputs through without pretending they meet
// the production validator's typed contract.
/** @param {unknown} candidate @returns {RawValidator} */
function rawValidator(candidate) {
  if (typeof candidate !== 'function') throw new TypeError('window validator is not callable');
  return (...args) => Reflect.apply(candidate, undefined, args);
}

const root = process.cwd();
const fixture = fs.readFileSync(path.join(root, 'tests/search/baselines/search-window-original.js.fixture'), 'utf8');
assert.equal(createHash('sha256').update(fixture).digest('hex'),
  'c304ae02c0a28a48ccd5cb8b29df24fc1493005e3107b95e1aec09d39d02d4fd', 'reviewed original validator changed');
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const match = source.match(/^function validatePositionWindowPage\(data, page, pageSize, expected\) \{\n[^]*?^\}/m);
assert.ok(match, 'host validator missing');
const context = vm.createContext({});
vm.runInContext(fixture + '\nthis.oldWindowValidator = validatePositionWindowPage;', context);
vm.runInContext(fs.readFileSync(path.join(root, 'static/search/domain/search-window-page.js'), 'utf8'), context);
vm.runInContext(match[0], context);
/** @type {unknown} */
const originalCandidate = context.oldWindowValidator;
/** @type {unknown} */
const actualCandidate = context.validatePositionWindowPage;
const original = rawValidator(originalCandidate);
const actual = rawValidator(actualCandidate);

/** @param {RawValidator} fn @param {CaseBuilder} build */
function outcome(fn, build) {
  /** @type {string[]} */
  const reads = [];
  try { return {result: fn(...build(reads)), reads}; }
  catch (error) {
    // Errors originate in another VM realm; instanceof Error would reject them.
    assert.ok(error !== null && typeof error === 'object' && 'name' in error && 'message' in error);
    return {name: error.name, message: error.message, reads};
  }
}
/** @param {CaseBuilder} build */
function compare(build) {
  assert.deepEqual(outcome(actual, build), outcome(original, build));
}
/** @param {Partial<RawPage>} [overrides] @returns {RawPage} */
function page(overrides={}) {
  return {results:[{id:'one'}, {id:'two'}], page:1, page_size:2, total:3, generation:'a', ...overrides};
}

test('page validation preserves shape, lengths, generation and exact failure', () => {
  /** @type {WindowArgs[]} */
  const cases = [
    [null,1,2,null], [{},1,2,null], [page(),1,2,null], [page({results:[{}],page:2}),2,2,{total:3,generation:'a'}],
    [page({results:[],page:3,total:3}),3,2,null], [page({results:[{}]}),1,2,null],
    [page({page:2}),1,2,null], [page({page_size:3}),1,2,null], [page({total:-1}),1,2,null],
    [page({total:2.5}),1,2,null], [page({total:NaN}),1,2,null], [page({results:[{},null]}),1,2,null],
    [page({results:[{},'invalid']}),1,2,null], [page(),1,2,{total:4,generation:'a'}],
    [page(),1,2,{total:3,generation:'b'}], [page({generation:undefined}),1,2,{total:3}],
    [page({results:new Array(2)}),1,2,null], [page({results:[[],{}]}),1,2,null],
    [page({results:[{}],page:0,page_size:1,total:3}),0,1,null], [page({results:[],page:1,page_size:0,total:0}),1,0,null],
    [page({results:[{}],page:1,page_size:-1,total:3}),1,-1,null],
    [page({total:3,generation:undefined}),1,2,false], [page({total:3,generation:undefined}),1,2,{}],
  ];
  for (const [data, number, size, expected] of cases) compare(() => [data, number, size, expected]);
  for (const validate of [original, actual]) {
    assert.equal(validate(page({results:[{}],page:2}),2,2,{total:3,generation:'a'}), undefined);
    assert.equal(validate(page({results:[{}],page:0,page_size:1}),0,1,null), undefined);
    assert.equal(validate(page({results:[],page_size:0,total:0}),1,0,null), undefined);
  }
});

test('page validation preserves getter, array and coercion evaluation order', () => {
  compare(reads => {
    const values={page:1,page_size:2,total:3,generation:'a'};
    const result={};
    for (const [key,value] of Object.entries(values)) Object.defineProperty(result,key,{get(){reads.push(key);return value;}});
    Object.defineProperty(result,'results',{get(){reads.push('results');return [{id:1},{id:2}];}});
    const expected={get total(){reads.push('expected.total');return 3;},get generation(){reads.push('expected.generation');return 'a';}};
    return [result,1,2,expected];
  });
  compare(reads => {
    const results=[{},{}];results.some=function(callback){reads.push('some');return Array.prototype.some.call(this,callback);};
    const number={valueOf(){reads.push('page.valueOf');return 1;}};
    const size={valueOf(){reads.push('size.valueOf');return 2;}};
    return [page({results,page:number,page_size:size}),number,size,null];
  });
  compare(reads => {
    let count=0;const result=page();
    Object.defineProperty(result,'results',{get(){reads.push(`results${++count}`);return [{},{}];}});
    const expected={get total(){reads.push('expected.total');return 4;},get generation(){reads.push('expected.generation');throw new Error('must not read');}};
    return [result,1,2,expected];
  });
  compare(reads => {
    const results=[{},{}];results.some=function(){reads.push('some');throw new Error('some failure');};
    return [page({results}),1,2,null];
  });
  compare(reads => {
    let index=0;const totals=[3,NaN,3];const data=page();
    Object.defineProperty(data,'total',{get(){reads.push('total');return totals[index++];}});
    return [data,1,2,null];
  });
  compare(reads => [Object.defineProperty({}, 'results', {get(){reads.push('results');throw new Error('getter failure');}}),1,2,null]);
  for (const validate of [original, actual]) {
    const sentinel = new Error('original failure');
    assert.throws(() => validate({get results(){throw sentinel;}},1,2,null), error => error === sentinel);
    const records=[{},{}];records.some=()=>{throw sentinel;};
    assert.throws(() => validate(page({results:records}),1,2,null), error => error === sentinel);
    const number={valueOf(){throw sentinel;}};
    assert.throws(() => validate(page({page:number}),number,2,null), error => error === sentinel);
  }
  /** @param {RawValidator} validate */
  const reentrant = validate => {
    /** @type {string[]} */
    const reads=[];
    const inner=page();
    Object.defineProperty(inner,'generation',{get(){reads.push('inner.generation');return 'inner';}});
    const expected={get total(){reads.push('outer.total');return 3;},get generation(){
      reads.push('outer.generation');
      assert.equal(validate(inner,1,2,{total:3,generation:'inner'}),undefined);
      return 'a';
    }};
    assert.equal(validate(page(),1,2,expected),undefined);
    return reads;
  };
  assert.deepEqual(reentrant(actual), reentrant(original));
  assert.deepEqual(reentrant(actual), ['outer.total','outer.generation','inner.generation']);
});
