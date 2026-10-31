import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { applyReviewedTocCorrections } from '../static/reader/formats/reader-chapter-format.mjs';

globalThis.location = { href: 'https://voiceofml-search.hf.space/static/reader.html' };
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const expectedHex = '7b150f1ba768d3bf4380b805676a32b8b2c18d7a8b4efb75be49a38da1dbf3a8';
const expectedDigest = Uint8Array.from(expectedHex.match(/../g), x => parseInt(x, 16));
const path = 'chapters/ebook/mobi/046c991cc6fb1b05e4c95e24fea7dd34112a9ba239ff4e2f22d68221bb8fd6aa/6df0c142735b1a1a/chapter-manifest.json';
const manifestUrl = `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
const toc = Array.from({length: 976}, () => ({title:'ordinary', chapter:1, depth:2, fragment:''}));
const groups = [
  [1,'费曼物理学讲义：新千年版．第1卷',4,'',4,3],
  [355,'费曼物理学讲义：新千年版．第2卷',50,'2NI-3c4a5b77066c4db48850b1e309e1eb0b',306,357],
  [684,'费曼物理学讲义：新千年版．第3卷',84,'68C-3c4a5b77066c4db48850b1e309e1eb0b',595,686],
  [855,'费曼物理学讲义补编',109,'88V-3c4a5b77066c4db48850b1e309e1eb0b',744,857],
  [875,'费曼物理学讲义习题集：新千年版',118,'9LP-3c4a5b77066c4db48850b1e309e1eb0b',763,877]
];
for (const [index,title,chapter,fragment,target,titleIndex] of groups) {
  toc[index] = {title,chapter,fragment,depth:0};
  toc[index+1] = {title:'封面',chapter,fragment,depth:1};
  toc[titleIndex] = {title:'书名页',chapter:target,fragment:'',depth:1};
}
const manifest = {version:1,kind:'epub-chapters',chapters:Array.from({length:861},(_,i)=>({index:i+1})),toc};
const fakeBytes = new Uint8Array([1,2,3]);
crypto.subtle.digest = async () => expectedDigest.buffer.slice(0);
const corrected = await applyReviewedTocCorrections(manifest, fakeBytes, manifestUrl);
assert.notStrictEqual(corrected, manifest);
for (const [index,,, ,target] of groups) {
  assert.equal(corrected.toc[index].chapter,target);
  assert.equal(corrected.toc[index].fragment,'chapter');
  assert.equal(corrected.toc[index+1].chapter,target);
  assert.equal(corrected.toc[index+1].fragment,'chapter');
}
assert.equal(manifest.toc[355].chapter,50, 'original manifest must remain unchanged');
assert.deepEqual(corrected.toc[500],manifest.toc[500]);
const changed = structuredClone(manifest); changed.toc[357].chapter = 307;
assert.strictEqual(await applyReviewedTocCorrections(changed, fakeBytes, manifestUrl), changed,
  'a changed or ambiguous title-page target must fail closed');
assert.strictEqual(await applyReviewedTocCorrections(manifest, fakeBytes,
  'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=other'), manifest,
  'another book must never be patched');
crypto.subtle.digest = async () => new Uint8Array(32).buffer;
assert.strictEqual(await applyReviewedTocCorrections(manifest, fakeBytes, manifestUrl), manifest,
  'a different manifest revision must never be patched');
crypto.subtle.digest = async () => { throw new Error('WebCrypto unavailable'); };
assert.strictEqual(await applyReviewedTocCorrections(manifest, fakeBytes, manifestUrl), manifest,
  'an unavailable optional checksum must not prevent the book from opening');
crypto.subtle.digest = originalDigest;
console.log('reviewed Feynman TOC corrections passed');
