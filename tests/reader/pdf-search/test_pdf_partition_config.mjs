import assert from 'node:assert/strict';import {test} from 'node:test';import {validatePdfPartitionConfiguration} from '../../../static/reader/search/reader-pdf-partition-config.mjs';
const sha='a'.repeat(64),gen='b'.repeat(64),rev='c'.repeat(16),origin='https://voiceofml-search.hf.space',href=origin+'/static/worker.mjs',limit=1024;
const ref=(start,end)=>({start,end,url:origin+'/api/reader-bucket-resource?path='+`objects/aa/${sha}/${rev}/text/search-${String(start).padStart(6,'0')}-${String(end).padStart(6,'0')}.json.gz`,bytes:10,sha256:sha});
const fixture=()=>({sourceSha:sha,generation:gen,pageCount:2,partitions:[ref(1,1),ref(2,2)]});
const invalid=(x,re=/PDF_TEXT_INDEX_INVALID/)=>assert.throws(()=>validatePdfPartitionConfiguration(x,href,limit),re);
test('valid immutable partition configuration covers pages in order',()=>{const c=fixture(),rows=c.partitions;assert.equal(validatePdfPartitionConfiguration(c,href,limit),undefined);assert.strictEqual(c.partitions,rows)});
test('incomplete identity and page manifests fail closed',()=>{
 for(const c of [null,undefined,{}, {sourceSha:sha,generation:'x',pageCount:1,partitions:[]},{sourceSha:'x',generation:gen,pageCount:1,partitions:[]},{sourceSha:sha,generation:gen,pageCount:0,partitions:[]},{sourceSha:sha,generation:gen,pageCount:2,partitions:[]}]) invalid(c,/PDF_TEXT_INDEX_INCOMPLETE/);
});
test('partition ordering, bounds, identity and bytes are required',()=>{
 for(const [field,value] of [['start',0],['end',0],['end',3],['bytes',0],['bytes',1025],['sha256','x'],['url','https://evil.example/api/reader-bucket-resource?path=x']]){const c=fixture();c.partitions[0][field]=value;invalid(c)}
 const tooMany=fixture();tooMany.pageCount=33;tooMany.partitions=[ref(1,33)];invalid(tooMany);
 const short=fixture();short.partitions.pop();invalid(short,/PDF_TEXT_INDEX_INCOMPLETE/);
 const notRecord=fixture();notRecord.partitions[0]=null;invalid(notRecord);
});
test('source SHA and trusted immutable URL must match partition path',()=>{
 const badSource=fixture();badSource.partitions[0].url=badSource.partitions[0].url.replace(sha,'f'.repeat(64));invalid(badSource);
 const badRange=fixture();badRange.partitions[0].url=badRange.partitions[0].url.replace('000001-000001','000001-000002');invalid(badRange);
 const extra=fixture();extra.partitions[0].url+='&extra=1';invalid(extra);
 const badURL=fixture();badURL.partitions[0].url='http://[';assert.throws(()=>validatePdfPartitionConfiguration(badURL,href,limit),TypeError);
 const missingPath=fixture();missingPath.partitions[0].url=origin+'/api/reader-bucket-resource';invalid(missingPath);
});
