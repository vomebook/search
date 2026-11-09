import assert from 'node:assert/strict';
import {PDF_ADAPTIVE_CHUNK_BYTES, PDF_LARGE_FLAT_CHUNK_BYTES, PDF_DEFAULT_CHUNK_BYTES, choosePdfRangeChunkSize,
  firstImageSectionEnd, firstPageSectionEnd, firstPageTailHintStart, isFirstPageCandidate}
  from '../../../static/reader/pdf/reader-pdf-range-hints.mjs';
import {choosePdfRangeChunkSize as legacyChunkSize, isFirstPageCandidate as legacyFirstPage}
  from '../../../static/reader/pdf/reader-pdf-network.mjs';

// These are scheduling hints only. None of these fixtures supplies PDF.js
// with a page identity or bypasses its normal page-tree validation.
assert.equal(legacyChunkSize,choosePdfRangeChunkSize,'legacy network export remains the same function');
assert.equal(legacyFirstPage,isFirstPageCandidate,'legacy network export remains the same function');
const encode = text => new TextEncoder().encode(text);
const chunk = PDF_DEFAULT_CHUNK_BYTES, large = 64 * 1024 * 1024;
const sparse = Array.from({length:160},(_,index)=>4+index*6);
const clustered = Array.from({length:160},(_,index)=>5+index);
const tree = (ids, count=ids.length) => '%PDF-1.7\n2 0 obj\n<</Type/Pages/Count '+count+
  '/Kids['+ids.map(id=>`${id} 0 R`).join(' ')+']>>\nendobj\n';
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse)),large),PDF_ADAPTIVE_CHUNK_BYTES);
assert.equal(choosePdfRangeChunkSize(encode(tree(clustered)),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse)),8*1024*1024-1),chunk,
  'small files must retain fallback');
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse)),large,4096),4096);
assert.equal(choosePdfRangeChunkSize(null,large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse.slice(0,127))),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse,159)),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(tree([...sparse.slice(0,159),sparse[0]])),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse).replace(' 10 0 R',' INVALID 10 0 R')),large),chunk);
const fakeStream = encode('%PDF-1.7\n1 0 obj\n<</Length 20>>\nstream\n'+tree(sparse)+'\nendstream\nendobj');
assert.equal(choosePdfRangeChunkSize(fakeStream,large),chunk,
  'fake sparse tree in stream must not change range chunk size');
assert.equal(isFirstPageCandidate(fakeStream,large,chunk),false);
assert.equal(choosePdfRangeChunkSize(encode('%PDF-1.7\n1 0 obj\n<</Linearized 1>>\nendobj\n'+tree(sparse)),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(tree(sparse).replace('endobj','')),large),chunk);
assert.equal(isFirstPageCandidate(null,large,chunk),false);
assert.equal(isFirstPageCandidate(encode(tree(sparse)),large,PDF_ADAPTIVE_CHUNK_BYTES),true);
assert.equal(isFirstPageCandidate(encode(tree(sparse)),large,chunk),false);
const twoChildren = encode('%PDF-1.7\n2 0 obj\n<</Type/Pages/Count 500/Kids[3 0 R 11 0 R]>>\nendobj');
assert.equal(isFirstPageCandidate(twoChildren,large,chunk),true);
assert.equal(isFirstPageCandidate(twoChildren,large,chunk/16),true);
assert.equal(isFirstPageCandidate(twoChildren,large-63*1024*1024,chunk),false);
const total=10*1024*1024;
const linear = (length=total,end=chunk*2+1,page='') => encode(
  `%PDF-1.7\n1 0 obj\n<</Linearized 1/L ${length}/E ${end}${page}>>\nendobj`);
assert.equal(firstPageSectionEnd(linear(),total,chunk),chunk*3);
assert.equal(firstPageSectionEnd(linear(total,chunk*2,'/P 0'),total,chunk),chunk*2);
assert.equal(firstPageSectionEnd(linear(total,chunk*2,'/P 1'),total,chunk),0);
assert.equal(firstPageSectionEnd(linear(total+1),total,chunk),0);
assert.equal(firstPageSectionEnd(linear(total,chunk),total,chunk),0);
assert.equal(firstPageSectionEnd(linear(total,chunk*4+1),total,chunk),0);
assert.equal(firstPageSectionEnd(linear(total,chunk*2,'/P 2 0 R'),total,chunk),0);
assert.equal(firstPageSectionEnd(linear(),chunk*6,chunk),0);
const firstPage='%PDF-1.7\n1 0 obj\n<</Type/Page/Contents[9 0 R]/Parent 18274 0 R/Resources 7 0 R>>\nendobj\n';
const tailStart=Math.floor((total-1)/chunk)*chunk-chunk*4;
assert.equal(firstPageTailHintStart(encode(firstPage),total,chunk),tailStart);
assert.equal(isFirstPageCandidate(encode(firstPage.replace('18274','127')),total,chunk),false);
assert.equal(firstPageTailHintStart(encode(firstPage.replace('18274','127')),total,chunk),0);
assert.equal(firstPageTailHintStart(encode(firstPage),chunk*8,chunk),0);
assert.equal(firstPageTailHintStart(null,total,chunk),0);
const image='%PDF-1.7\n3 0 obj\n<</Type/Page/Resources 4 0 R>>\nendobj\n'+
  '4 0 obj\n<</XObject<</Im1 2 0 R>>>>\nendobj\n1 0 obj\n<</Length 3>>\nstream\nabc\nendstream\nendobj\n'+
  '2 0 obj\n<</Type/XObject/Subtype/Image/Length 600000>>\nstream\n';
assert.equal(firstImageSectionEnd(encode(image),total,chunk),chunk*3);
for (const altered of [image.replace('/Im1 2 0 R','/Im1 8 0 R'),
  image.replace('/Length 600000','/Length 600000 0 R'),
  image.replace('/Subtype/Image','/Subtype/Form'),image.replace('endstream','badstream')]) {
  assert.equal(firstImageSectionEnd(encode(altered),total,chunk),0);
}
assert.equal(firstImageSectionEnd(null,total,chunk),0);

// Regression: a large flat tree may follow small direct-length streams and
// exceed 16 KiB; an inserted cover ref can precede otherwise ordered pages.
const longIds = [42552, ...Array.from({length:1450},(_,i)=>10002+i*17)];
const longTree = tree(longIds);
const streamObject = (length, content) => `5 0 obj<</Length ${length}>>\nstream\n${content}\nendstream\nendobj\n`;
const longPrefix = '%PDF-1.7\n%binary-comment\n1 0 obj<</Title (escaped \\) >> content)>>\nendobj\n' +
  streamObject(4500,'x'.repeat(4500)) + longTree.slice('%PDF-1.7\n'.length);
assert.ok(encode(longPrefix).length > 16384);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix),large),PDF_LARGE_FLAT_CHUNK_BYTES);
assert.equal(isFirstPageCandidate(encode(longPrefix),large,PDF_LARGE_FLAT_CHUNK_BYTES),true);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.slice(0,16384)),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('42552 0 R','10002 0 R')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('10019 0 R','1 0 R')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Type/Pages/Count 1451','/Type/Pages/Count 1451 0 R')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Length 4e3')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Length 4500 0 R')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Length 4499')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Length 4500 /Length 4500')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Foo (/Length 4500)')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Foo << /Length 4500 >>')),large),chunk);
const deceptive = longPrefix.replace('/Length 4500','/Foo [ /Length 4500 ]');
assert.equal(choosePdfRangeChunkSize(encode(deceptive),large),chunk,
  'Length nested in an array is not a direct stream length');
const fakeFields = '%PDF-1.7\n5 0 obj<</Length 3>>\nstream\nabc\nendstream\nendobj\n'+
  '2 0 obj<</Foo [ /Type /Pages /Count 1451 /Kids ['+longIds.map(id=>`${id} 0 R`).join(' ')+'] ]>>\nendobj\n';
assert.equal(choosePdfRangeChunkSize(encode(fakeFields),large),chunk,
  'Pages keys nested inside another array are not direct page-tree fields');
const dupType=longPrefix.replace('/Type/Pages','/Type /Catalog /Type/Pages');
assert.equal(choosePdfRangeChunkSize(encode(dupType),large),chunk,'ambiguous duplicate direct keys fall back');
const dupLength=longPrefix.replace('/Length 4500','/Length 1 0 R/Length 4500');
assert.equal(choosePdfRangeChunkSize(encode(dupLength),large),chunk,'indirect and direct lengths cannot coexist');
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('endstream','not-stream')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Title (escaped \\) >> content)', '/Title <AABB>')),large),PDF_LARGE_FLAT_CHUNK_BYTES);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Title (escaped \\) >> content)', '/Title (outer (inner) end)')),large),PDF_LARGE_FLAT_CHUNK_BYTES);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Title (escaped \\) >> content)', '/Title (unterminated')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Title (escaped \\) >> content)', '/Title <ABC')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Title (escaped \\) >> content)', '/Comment % x\n/Title (ok)')),large),PDF_LARGE_FLAT_CHUNK_BYTES);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Foo 0 % x\n/Length 4500')),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.slice(0,longPrefix.indexOf('/Length 4500'))+'/Length 3 % never closed'),large),chunk);
assert.equal(choosePdfRangeChunkSize(encode(longPrefix.replace('/Length 4500','/Length 90071992547409999')),large),chunk);
const fake = longTree.slice('%PDF-1.7\n'.length);
assert.equal(choosePdfRangeChunkSize(encode('%PDF-1.7\n'+streamObject(fake.length,fake)),large),chunk,
  'syntax inside a completed stream must remain inert');
assert.equal(choosePdfRangeChunkSize(encode('%PDF-1.7\n1 0 obj<</Value ('+fake+')>>\nendobj\n'),large),chunk,
  'syntax inside a literal string must remain inert');
assert.equal(choosePdfRangeChunkSize(encode('%PDF-1.7\n1 0 obj<</Value <'+Buffer.from(fake).toString('hex')+'>>>\nendobj\n'),large),chunk,
  'syntax inside a hex string must remain inert');

console.log('PDF range hints: bounded scheduling, malformed inputs and compatibility exports passed');
