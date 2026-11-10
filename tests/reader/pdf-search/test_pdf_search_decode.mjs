import assert from 'node:assert/strict';import {test} from 'node:test';import {createHash,webcrypto} from 'node:crypto';import {gzipSync} from 'node:zlib';import {readVerifiedPdfSearchText} from '../../../static/reader/search/reader-pdf-search-decode.mjs';
Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
const sha=value=>createHash('sha256').update(value).digest('hex');
test('verified compressed text decodes exact JSON without mutating input',async()=>{
 const payload={version:2,pages:[{text:'手机 😀'}]},bytes=gzipSync(JSON.stringify(payload)),original=Buffer.from(bytes);
 assert.deepEqual(JSON.parse(await readVerifiedPdfSearchText(bytes,sha(bytes),new AbortController().signal,1024)),payload);
 assert.deepEqual(bytes,original);
});
test('corrupt or unexpected digest rejects before decompression',async()=>{
 const bytes=Uint8Array.of(1,2,3);await assert.rejects(readVerifiedPdfSearchText(bytes,'0'.repeat(64),new AbortController().signal,1024),/PDF_OCR_HASH_MISMATCH/);
});
test('verified invalid gzip and JSON propagate errors',async()=>{
 const invalid=Uint8Array.of(1,2,3);await assert.rejects(readVerifiedPdfSearchText(invalid,sha(invalid),new AbortController().signal,1024));
 const bad=gzipSync('{');const text=await readVerifiedPdfSearchText(bad,sha(bad),new AbortController().signal,1024);assert.throws(()=>JSON.parse(text),SyntaxError);
});
test('decompressed bound and cancellation are enforced before JSON is exposed',async()=>{
 const data=gzipSync(JSON.stringify({text:'x'.repeat(100)}));await assert.rejects(readVerifiedPdfSearchText(data,sha(data),new AbortController().signal,10),/READER_RESOURCE_LIMIT/);
 const owner=new AbortController();owner.abort();await assert.rejects(readVerifiedPdfSearchText(data,sha(data),owner.signal,1024),{name:'AbortError'});
});
