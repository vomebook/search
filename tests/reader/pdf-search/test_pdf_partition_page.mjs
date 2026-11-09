import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pdfPartitionPageOffset,decoratePdfPartitionHits} from '../../../static/reader/search/reader-pdf-partition-page.mjs';

test('offset clamps and rounds before results are paged',()=>{
 const cases=[[undefined,0,0],[null,0,0],[-100,120,0],[0,120,0],[49,120,0],
  [50,120,50],[99,120,50],[100,120,100],[9999,120,100],[Infinity,120,100],
  [-Infinity,120,0],[NaN,120,0],['101',120,100],[50,0,0]];
 for(const [requested,total,expected] of cases)assert.equal(pdfPartitionPageOffset(requested,total),expected);
});
test('generation mapping preserves result fields and input identity',()=>{
 const hit={page:9,start:3,length:4,boxes:[],snippet:{text:'fixture'}},pages=[
  {page:8,text_generation:'a'}, {page:9,text_generation:'b'}];
 const result=decoratePdfPartitionHits([hit],pages);
 assert.notStrictEqual(result[0],hit);assert.strictEqual(result[0].snippet,hit.snippet);
 assert.equal(result[0].textGeneration,'b');assert.equal(hit.textGeneration,undefined);
 assert.deepEqual(decoratePdfPartitionHits([],[]),[]);
});
test('missing matching page fails closed before publishing a result',()=>{
 assert.throws(()=>decoratePdfPartitionHits([{page:1}],[]),/PDF_TEXT_INDEX_INVALID/);
 assert.throws(()=>decoratePdfPartitionHits([{page:3}],[{page:1,text_generation:'a'}]),/PDF_TEXT_INDEX_INVALID/);
});
