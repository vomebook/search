import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

// This classic source is deliberately not imported: VM execution exercises the
// host wrapper while this test covers Node's instrumented production module.
await import(path.join(process.cwd(), 'static/search/domain/search-recovery.js'));
const recovery = globalThis.VoiceOfMLSearchRecovery.isRecoverable;

test('shared recovery rule covers abort, HTTP status and transport messages', () => {
  for (const value of [null, undefined, {name:'AbortError'}, {status:403}, {message:'bad response'}])
    assert.equal(recovery(value), false);
  for (const value of [{status:408}, {status:429}, {status:500}, {status:502}, {status:503}, {status:504},
    {code:'API_TIMEOUT'}, {name:'TimeoutError'}, {message:'network'}, {message:'failed to fetch'},
    {message:'offline'}, {message:'timed out'}, {message:'Load failed'}])
    assert.equal(recovery(value), true);
  assert.equal(recovery({status:404,message:'network'}), false);
});

test('shared recovery rule reads repeated getters without swallowing exceptions', () => {
  const reads=[];
  const error={get name(){reads.push('name');return 'Error';},get status(){reads.push('status');return 0;},
    get code(){reads.push('code');return '';},get message(){reads.push('message');return 'Load failed';}};
  assert.equal(recovery(error), true);
  assert.deepEqual(reads, ['name','status','code','name','message','message']);
  const failure=new Error('read failure');
  assert.throws(() => recovery({get name(){throw failure;}}), e => e === failure);
});
