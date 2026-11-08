import test from 'node:test';import assert from 'node:assert/strict';import {validPdfBookUrl,searchPath} from '../../../static/reader/search/reader-pdf-book-url.mjs';
const base='https://reader.example/static/worker.mjs',remote='https://voiceofml-search.hf.space',sha='a'.repeat(64),rev='b'.repeat(16),book=`objects/aa/${sha}/${rev}/text/book-text.json.gz`,part=`objects/aa/${sha}/${rev}/text/search-000001-000032.json.gz`;
const url=(origin,path)=>`${origin}/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
test('immutable origins, scopes and credentials are constrained',()=>{
 for(const origin of ['https://reader.example',remote]){assert.equal(validPdfBookUrl(url(origin,book),base),true);assert.equal(validPdfBookUrl(url(origin,part),base,searchPath),true);}
 for(const input of [url('https://evil.example',book),url(remote,'../x'),url(remote,book)+'&path=x',url(remote,book)+'&bad=x',url(remote,book)+'#anchor',url(remote,book).replace('https://','https://user@'),remote+'/api/reader-content?path='+book]) assert.equal(validPdfBookUrl(input,base),false,input);
 assert.throws(()=>validPdfBookUrl('http://[','https://reader.example'),TypeError);
});
