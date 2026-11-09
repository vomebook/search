import assert from 'node:assert/strict';import {test} from 'node:test';import {canPrefetchPdfPartition,canRetainPdfPartition} from '../../../static/reader/search/reader-pdf-partition-policy.mjs';
const max=1024*1024;
test('network lookahead respects data-saver, speed and compressed byte cap',()=>{
 for(const [connection,size,allowed] of [[undefined,1,true],[null,max,true],[{saveData:true},10,false],
  [{effectiveType:'slow-2g'},10,false],[{effectiveType:'2g'},10,false],[{effectiveType:'3g'},10,true],
  [{effectiveType:'4g'},max+1,false],[{},0,false],[{},-1,false],[{},1.5,false],[{},NaN,false]])
  assert.equal(canPrefetchPdfPartition(connection,size),allowed);
});
test('verified page cache is bounded by UTF-16 and serialized UTF-8 sizes',()=>{
 for(const [text,allowed] of [['',true],['needle',true],['中'.repeat(10000),true],
  ['a'.repeat(max/2+1),false],['\u0001'.repeat(180000),false]])
  assert.equal(canRetainPdfPartition({pages:[{text}]}),allowed);
 assert.equal(canRetainPdfPartition({pages:[]}),true);
});
test('serialization failures are cache misses and do not fail search',()=>{
 const part={pages:[{text:'x'}]};part.self=part;
 assert.equal(canRetainPdfPartition(part),false);
});
