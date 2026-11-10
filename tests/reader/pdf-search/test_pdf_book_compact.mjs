import assert from 'node:assert/strict';import {test} from 'node:test';import {compactPdfBookPage} from '../../../static/reader/search/reader-pdf-book-compact.mjs';
test('legacy text and geometry survive without duplicate layout',()=>{
 const box=[0,0,1,1],page={page:3,text:'手机 😀',layout:{large:true},text_spans:[{start:0,end:2,box,block:9,precision:'glyph',extra:'discard'}]};
 const result=compactPdfBookPage(page);assert.notStrictEqual(result,page);assert.equal(result.page,3);assert.equal(result.text,'手机 😀');
 assert.deepEqual(result.text_spans,[{start:0,end:2,box,block:9,precision:'glyph'}]);assert.strictEqual(result.text_spans[0].box,box);assert.equal('layout' in result,false);assert.equal('extra' in result.text_spans[0],false);
});
test('empty spans and absent optional fields preserve old representation',()=>{
 assert.deepEqual(compactPdfBookPage({page:1,text:'',text_spans:[]}),{page:1,text:'',text_spans:[]});
 const value=compactPdfBookPage({page:2,text:'x',text_spans:[{start:0,end:1,box:null}]});
 assert.ok(Object.hasOwn(value.text_spans[0],'block'));assert.equal(value.text_spans[0].block,undefined);assert.ok(Object.hasOwn(value.text_spans[0],'precision'));
});
