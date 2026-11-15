import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createReaderChapterFormat, chapterPrefetchSize, isChapterSearchIndex } from '../../../static/reader/formats/reader-chapter-format.mjs';

const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(readFileSync(new URL('../../../static/reader/core/reader-security.js', import.meta.url), 'utf8'), sandbox);
const validate = sandbox.VoiceOfMLReaderSecurity.validateChapterManifest;
for (const [extra, expected] of [[{bytes:'12'}, 12], [{size:'13'}, 13], [{}, 0], [{bytes:null,size:14}, 14], [{bytes:0,size:14}, 0]]) {
  const manifest = validate({version:1, kind:'epub-chapters', chapters:[{index:1,path:'1.html',...extra}]});
  assert.equal(chapterPrefetchSize(manifest.chapters[0]), expected);
}
const good = {path:'epub-search-index.json.gz', bytes:1, sha256:'a'.repeat(64)};
assert.equal(isChapterSearchIndex(good), true);
for (const sha256 of [null, 123, ['a'.repeat(64)], {toString:()=> 'a'.repeat(64)}, 'A'.repeat(64), 'a'.repeat(63)])
  assert.equal(isChapterSearchIndex({...good, sha256}), false);
assert.equal(chapterPrefetchSize({index:1,path:'1',bytes:Symbol()}), 0);

// Exercise the actual TOC fallback with unvalidated chapter metadata.
globalThis.VoiceOfMLReaderSecurity = sandbox.VoiceOfMLReaderSecurity;
globalThis.location = {href:'https://example.test/'};
globalThis.document = {createElement:()=>({style:{}, addEventListener(){}}), addEventListener(){}};
globalThis.window = {addEventListener(){}};
globalThis.IntersectionObserver = class { observe() {} };
globalThis.VoiceOfMLReaderChapters = {createChapterScheduler:()=>({})};
globalThis.VoiceOfMLReaderVirtual = {createSectionVirtualizer:()=>({})};
let toc;
const context = {
  chapterManifestUrl:'https://example.test/manifest', sourceUrl:'', content:{appendChild(){}},
  readerRuntime:{currentGeneration:()=>0}, trustedReaderAssetManifestUrl:()=> 'https://example.test/',
  viewport:{addEventListener(){}}, navigationState:{tocEntries:[]},
  assertReaderActive(){}, setToc(entries){toc=entries;}, trackReaderResource(){},
  getInitialReaderRestoration(){throw new Error('stop');}
};
const chapters = [{index:1,path:'1.html',title:{html:'<img onerror=alert(1)>'},source_path:{toString(){throw Error('coercion');}}}, {index:2,path:'2.html',title:'正常'}];
await assert.rejects(createReaderChapterFormat(context).renderChapterManifest(new Response(JSON.stringify({version:1,kind:'epub-chapters',chapters}))), /stop/);
assert.deepEqual(toc.map(item=>item.label), ['章节 1','正常']);
console.log('chapter metadata validation and prefetch sizes passed');
