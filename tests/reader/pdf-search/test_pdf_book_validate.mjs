import assert from 'node:assert/strict';import {test} from 'node:test';import {validatePdfBookText} from '../../../static/reader/search/reader-pdf-book-validate.mjs';
const source='a'.repeat(64);
const fixture=()=>({version:2,kind:'pdf-book-text',complete:true,offset_unit:'unicode-codepoint',page_count:2,source_sha256:source,pages:[{page:1,text:'😀中a',layout:{offset_unit:'unicode-codepoint'},text_spans:[{start:0,end:1,box:[0,0,1,1],block:7,precision:'glyph'}]},{page:2,text:'纯文本',layout:{offset_unit:'unicode-codepoint'},text_spans:[]}]});
test('validated OCR book and nested geometry preserve reference identity',()=>{
 const book=fixture(),page=book.pages[0],box=page.text_spans[0].box;assert.strictEqual(validatePdfBookText(book,2,source),book);assert.strictEqual(book.pages[0],page);assert.strictEqual(book.pages[0].text_spans[0].box,box);
});
test('book envelope fails closed for corrupt or mismatched identity',()=>{
 for(const value of [null,undefined,0,{},...['version','kind','complete','offset_unit','page_count','source_sha256','pages'].map(key=>{const x=fixture();x[key]=null;return x})])assert.throws(()=>validatePdfBookText(value,2,source),/PDF_TEXT_INDEX_INCOMPLETE/);
 const x=fixture();assert.strictEqual(validatePdfBookText(x,2),x);assert.throws(()=>validatePdfBookText(x,1,source),/PDF_TEXT_INDEX_INCOMPLETE/);
});
test('page and Unicode mapping bounds reject invalid records',()=>{
 for(const value of [null,{}, {page:1,text:5}, {page:1,text:'x',layout:{offset_unit:'bad'},text_spans:[]},{page:1,text:'x',layout:{offset_unit:'unicode-codepoint'},text_spans:null}]){const x=fixture();x.pages[0]=value;assert.throws(()=>validatePdfBookText(x,2,source),/PDF_TEXT_INDEX_INVALID/)}
 const badSpans=[null,{}, {start:0,end:0,box:[0,0,1,1]}, {start:0,end:4,box:[0,0,1,1]}, {start:0,end:1,box:[1,0,0,1]}, {start:0,end:1,box:[0,1,1,0]}, {start:0,end:1,box:[0,0,1,Infinity]}, {start:0,end:1,box:[0,0,1]}, {start:0,end:1,box:null}, {start:-1,end:1,box:[0,0,1,1]}, {start:0,end:1.5,box:[0,0,1,1]}];
 for(const span of badSpans){const x=fixture();x.pages[0].text_spans=[span];assert.throws(()=>validatePdfBookText(x,2,source),/PDF_TEXT_MAPPING_INVALID/)}
 const x=fixture();x.pages[0].text_spans=[{start:1,end:2,box:[0,0,1,1]},{start:0,end:1,box:[0,0,1,1]}];assert.throws(()=>validatePdfBookText(x,2,source),/PDF_TEXT_MAPPING_INVALID/);
});
test('box-free large text avoids Unicode iteration and invalid mappings publish nothing',()=>{
 const x=fixture();x.pages[0].text='😀'.repeat(5000);x.pages[0].text_spans=[];const old=String.prototype[Symbol.iterator];let units=0;
 try{String.prototype[Symbol.iterator]=function(...args){units+=this.length;return old.apply(this,args)};assert.strictEqual(validatePdfBookText(x,2,source),x);assert.equal(units,0)}finally{String.prototype[Symbol.iterator]=old}
});
