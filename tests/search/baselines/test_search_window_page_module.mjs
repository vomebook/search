import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

await import(path.join(process.cwd(), 'static/search/domain/search-window-page.js'));
const validate = globalThis.VoiceOfMLSearchWindowPage.validate;
/** @param {Partial<VoiceOfMLSearchWindowPageData>} [extra] @returns {VoiceOfMLSearchWindowPageData} */
const page = (extra={}) => ({results:[{},{}],page:1,page_size:2,total:3,generation:'a',...extra});

// Reflect.apply passes malformed data through unchanged. The checked tuple
// keeps every other argument tied to the production validator's signature.
/** @typedef {Parameters<typeof validate>} ValidateParameters */
/** @typedef {(data: unknown, pageNumber: ValidateParameters[1], pageSize: ValidateParameters[2], expected?: ValidateParameters[3]) => void} MalformedValidator */
/** @param {typeof validate} validator @returns {MalformedValidator} */
function malformedValidator(validator) {
  return function(data, pageNumber, pageSize, expected) {
    /** @type {[unknown, ValidateParameters[1], ValidateParameters[2], ValidateParameters[3]?]} */
    const args = [data, pageNumber, pageSize];
    if (arguments.length >= 4) args.push(expected);
    Reflect.apply(validator, undefined, args);
  };
}
const validateMalformed = malformedValidator(validate);
const changed = {message:'RESTORE_PAGE_CHANGED'};

test('window page rejects each inconsistent shape and mismatched generation', () => {
  const malformed = {invalid:true};
  const pin = {total:3,generation:'a'};
  /** @type {{count: number, pageNumber: number, pageSize: number, expected: ValidateParameters[3]}[]} */
  const calls = [];
  /** @type {typeof validate} */
  const spy = function(data, pageNumber, pageSize, expected) {
    assert.strictEqual(data, malformed);
    calls.push({count:arguments.length,pageNumber,pageSize,expected});
  };
  const probe = malformedValidator(spy);
  probe(malformed,11,12);
  probe(malformed,13,14,undefined);
  probe(malformed,15,16,null);
  probe(malformed,17,18,pin);
  assert.deepStrictEqual(calls, [
    {count:3,pageNumber:11,pageSize:12,expected:undefined},
    {count:4,pageNumber:13,pageSize:14,expected:undefined},
    {count:4,pageNumber:15,pageSize:16,expected:null},
    {count:4,pageNumber:17,pageSize:18,expected:pin}
  ], 'malformed adapter must preserve argument counts and values');
  assert.strictEqual(calls.at(-1)?.expected, pin);

  /** @type {unknown[]} */
  const invalid = [null, undefined, {}, {...page(),results:null}, page({page:2}), page({page_size:3}),
    page({total:NaN}), page({total:-1}), page({results:[{}]}), page({results:[{},null]}),
    page({results:[{},'x']})];
  for (const value of invalid) assert.throws(() => validateMalformed(value,1,2),changed);
  assert.throws(() => validate(page(),1,2,{total:4,generation:'a'}),changed);
  assert.throws(() => validate(page(),1,2,{total:3,generation:'b'}),changed);
  assert.throws(() => validateMalformed(page(),1,2,{total:4,generation:'a'}),changed);
  assert.doesNotThrow(() => validate(page(),1,2,{total:3,generation:'a'}));
  assert.doesNotThrow(() => validateMalformed(page(),1,2,{total:3,generation:'a'}));
  assert.doesNotThrow(() => validateMalformed(page({results:[],page:3}),3,2,null));
  assert.doesNotThrow(() => validate(page({results:[],page:3}),3,2));
  assert.doesNotThrow(() => validate(page({results:new Array(2)}),1,2,null));
  let count=0;const dynamic=page();
  Object.defineProperty(dynamic,'total',{get(){return [3,NaN,3][count++];}});
  assert.doesNotThrow(() => validate(dynamic,1,2));
});

test('window page propagates getter and array callback failures', () => {
  const failure=new Error('access failed');
  assert.throws(() => validateMalformed({get results(){throw failure;}},1,2), error => error === failure);
  const values=[{},{}];values.some=()=>{throw failure;};
  assert.throws(() => validate(page({results:values}),1,2), error => error === failure);
});
