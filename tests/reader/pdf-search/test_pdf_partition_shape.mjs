import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePdfSearchPartition} from '../../../static/reader/search/reader-pdf-partition-shape.mjs';
const sha='a'.repeat(64), generation='b'.repeat(64);
const config={sourceSha:sha,generation}, part={start:1,end:2};
const fixture=()=>({version:1,kind:'pdf-search-text-partition',source_sha256:sha,generation,
 offset_unit:'unicode-codepoint',start:1,end:2,pages:[{page:1,text:'手机 😀',text_generation:sha},
 {page:2,text:'needle',text_generation:'c'.repeat(64)}]});
const invalid=value=>assert.throws(()=>validatePdfSearchPartition(value,part,config),/PDF_TEXT_INDEX_INVALID/);
test('verified metadata and page identities preserve original records',()=>{
 const item=fixture(), first=item.pages[0], validated=validatePdfSearchPartition(item,part,config);
 assert.strictEqual(validated,item);assert.strictEqual(validated.pages[0],first);assert.equal(first.text,'手机 😀');
});
test('reject missing or mismatched partition identity and boundaries',()=>{
 for(const value of [null,undefined,42,'text',[]])invalid(value);
 for(const [field,value] of [['version',2],['kind','other'],['source_sha256','f'.repeat(64)],
  ['generation','0'.repeat(64)],['offset_unit','utf16'],['start',2],['end',3],['pages',null],['pages',[]]]){
  const candidate=fixture();candidate[field]=value;invalid(candidate);
 }
});
test('reject malformed page records and untrusted fields',()=>{
 for(const page of [null,undefined,false,{},'x',{page:1,text:5,text_generation:sha},
   {page:1,text:'x',text_generation:'bad'},{page:2,text:'x',text_generation:sha},
   {page:1,text:'x',text_generation:sha,extra:true}]){
  const item=fixture();item.pages[0]=page;invalid(item);
 }
});
test('legacy regexp coercion is preserved for text generation',()=>{
 const item=fixture();item.pages[0].text_generation=1111111111111111111111111111111111111111111111111111111111111111n;
 assert.strictEqual(validatePdfSearchPartition(item,part,config),item);
});
