import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createReaderSource } from '../../../static/reader/core/reader-source.mjs';
import { createChapterProgress, createReaderChapterFormat, chapterPrefetchSize, isChapterSearchIndex } from '../../../static/reader/formats/reader-chapter-format.mjs';

const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(readFileSync(new URL('../../../static/reader/core/reader-security.js', import.meta.url), 'utf8'), sandbox);
const validate = sandbox.VoiceOfMLReaderSecurity.validateChapterManifest;
for (const [extra, expected] of [[{bytes:'12'}, 12], [{size:'13'}, 13], [{}, 0], [{bytes:null,size:14}, 14], [{bytes:0,size:14}, 0]]) {
  const manifest = validate({version:1, kind:'epub-chapters', chapters:[{index:1,path:'1.html',...extra}]});
  assert.equal(chapterPrefetchSize(manifest.chapters[0]), expected);
}
const progressFor = (...metadata) => createChapterProgress(validate({ version: 1, kind: 'epub-chapters',
  chapters: metadata.map((extra, i) => ({ index: i + 1, path: `${i + 1}.html`, ...extra }))
}).chapters);
const progress = progressFor({ bytes: 10, size: 90 }, { bytes: null, size: '80' }, { bytes: 10 });
assert.deepEqual(progress.locate(0), { chapterIndex: 1, fraction: 0 });
assert.deepEqual(progress.locate(0.1), { chapterIndex: 2, fraction: 0 });
assert.deepEqual(progress.locate(0.5), { chapterIndex: 2, fraction: 0.5 });
assert.deepEqual(progress.locate(1), { chapterIndex: 3, fraction: 1 });
for (const fraction of [0, 0.05, 0.1, 0.5, 0.9, 0.98, 1]) {
  const target = progress.locate(fraction);
  assert.ok(Math.abs(progress.at(target.chapterIndex, target.fraction) - fraction) < 1e-12);
}
for (const incomplete of [{}, { bytes: 0, size: 90 }, { bytes: 1.5 }, {bytes: true}, {size: [12]}]) {
  const equal = progressFor({ bytes: 10 }, { bytes: 80 }, incomplete);
  assert.deepEqual(equal.locate(0.5), { chapterIndex: 2, fraction: 0.5 });
  assert.equal(equal.at(3, 0), 2 / 3);
}
const good = {path:'epub-search-index.json.gz', bytes:1, sha256:'a'.repeat(64)};
assert.equal(isChapterSearchIndex(good), true);
for (const sha256 of [null, 123, ['a'.repeat(64)], {toString:()=> 'a'.repeat(64)}, 'A'.repeat(64), 'a'.repeat(63)])
  assert.equal(isChapterSearchIndex({...good, sha256}), false);
assert.equal(chapterPrefetchSize({index:1,path:'1',bytes:Symbol()}), 0);

// Exercise the actual TOC fallback with unvalidated chapter metadata.
globalThis.VoiceOfMLReaderSecurity = sandbox.VoiceOfMLReaderSecurity;
globalThis.location = {href:'https://example.test/'};
globalThis.document = {createElement:()=>({style:{}, appendChild(){}, addEventListener(){}}), addEventListener(){}};
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
// Drive the actual click handler and trusted URL resolvers. Stub layout and
// speculative loading so the resolution counts don't depend on timing.
vm.runInNewContext(readFileSync(new URL('../../../static/reader/core/reader-contract.js', import.meta.url), 'utf8'), sandbox);
globalThis.VoiceOfMLReader = sandbox.VoiceOfMLReader;
const source = {};
Object.assign(source, createReaderSource(source));
const resolved = [], landings = [], articles = new Map();
let click;
globalThis.document.createElement = (tag) => {
  const node = {style:{}, dataset:{}, appendChild(){}, addEventListener(){}, setAttribute(){}, querySelectorAll:()=>[]};
  if (tag === 'article') node.querySelector = function (selector) { return [Number(this.dataset.chapter), selector]; };
  if (tag === 'div') Object.assign(node, {
    addEventListener(type, listener) { assert.equal(type, 'click'); click = listener; },
    querySelector: selector => articles.get(selector) || null,
    insertBefore(article) {
      if (article.className === 'reader-markdown reader-epub-chapter')
        articles.set(`.reader-epub-chapter[data-chapter="${article.dataset.chapter}"]`, article);
    }
  });
  return node;
};
globalThis.document.removeEventListener = globalThis.window.removeEventListener = () => {};
globalThis.IntersectionObserver.prototype.disconnect = () => {};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.CSS = {escape: value => value};
globalThis.VoiceOfMLReaderChapters.createChapterScheduler = ({create}) => ({
  load: index => create(index, new AbortController().signal, 'high'), prefetch(){}, dispose(){}
});
globalThis.VoiceOfMLReaderVirtual.createSectionVirtualizer = () => ({dispose(){}});
const linkContext = {
  ...context, ...source, status:{}, readerAbortController:new AbortController(),
  viewport:{addEventListener(){}, removeEventListener(){}}, readerRestorationEntry:{chapterIndex:4},
  trustedChapterUrl(path, base) { resolved.push(path); return source.trustedChapterUrl(path, base); },
  fetchReaderUrl: async () => new Response(''), parseChapterDocument: () => ({querySelectorAll:()=>[]}),
  chapterScrollAnchors:{preserve: change => change(), observe(){}, invalidate(){}, remember(){}, whenIdle(){}},
  getInitialReaderRestoration: async () => {}, awaitReader: promise => promise, setToc: () => [],
  beginReaderNavigation: () => 1, isReaderGenerationCurrent: () => true,
  alignReaderDestination: anchor => landings.push(anchor), holdReaderDestination(){},
  syncHeadingLocation(){}, updateProgressTools(){}, scheduleSave(){}, markReaderContentReady(){},
  reportNavigationError(error) { throw error; }
};
const format = createReaderChapterFormat(linkContext);
const chapterPath = index => `chapters/chapter-${String(index).padStart(4, '0')}.xhtml`;
const linkChapters = Array.from({length:64}, (_, i) => ({index:i + 1, path:chapterPath(i + 1)}));
linkChapters[1].path = 'chapters/invalid.xhtml'; // Valid manifest metadata, but not a trusted chapter URL.
linkChapters[2].path = 'chapters/chapter-000%34.xhtml'; // Same resolved URL as the restored chapter 4.
const paths = linkChapters.map(chapter => chapter.path);
async function openBook(identity) {
  const prefix = `chapters/ebook/epub/${identity.repeat(64)}/${'a'.repeat(16)}/`;
  linkContext.chapterManifestUrl = `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(prefix + 'chapter-manifest.json')}`;
  resolved.length = 0;
  articles.clear();
  await format.renderChapterManifest(new Response(JSON.stringify({version:1, kind:'epub-chapters', chapters:linkChapters})));
  assert.deepEqual(resolved, [chapterPath(4)], 'opening only resolves the loaded chapter path');
}
async function follow(href, chapterIndex, fragment) {
  const article = articles.get('.reader-epub-chapter[data-chapter="4"]');
  let prevented = false, error;
  const link = {closest:()=>article, getAttribute:()=>href, after: node => { error = node; }};
  landings.length = 0;
  await click({button:0, target:{closest:()=>link}, preventDefault(){ prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(error?.className, chapterIndex ? undefined : 'reader-chapter-link-error');
  assert.deepEqual(landings, chapterIndex ? [[chapterIndex, `[id="${fragment}"], [name="${fragment}"]`]] : []);
}

await openBook('b');
try {
  await follow('https://example.test/chapter-0004.xhtml#external');
  assert.equal(resolved.length, 1, 'a rejected reference does not start the scan');
  await follow('./chapter-0004.xhtml#%E7%9B%AE%E6%A0%87', 3, '目标');
  assert.deepEqual(resolved, [paths[3], ...paths.slice(0, 3)], 'stop at the first canonical match');
  await follow('chapter-0004.xhtml#again', 3, 'again');
  assert.equal(resolved.length, 4, 'repeated hit does not parse chapter paths again');
  await follow('chapter-0050.xhtml#late', 50, 'late');
  assert.deepEqual(resolved, [paths[3], ...paths.slice(0, 3), ...paths.slice(4, 50)], 'resume the prefix and reuse the fetch URL');
  await follow('chapter-0004.xhtml#first', 3, 'first');
  assert.equal(resolved.length, 50, 'the later duplicate did not replace the first match');
  await follow('chapter-0002.xhtml#missing');
  assert.deepEqual(resolved, [paths[3], ...paths.slice(0, 3), ...paths.slice(4)], 'a miss scans only the remaining suffix');
  await follow('chapter-0002.xhtml#missing');
  await follow('chapter-0099.xhtml#another-miss');
  assert.equal(resolved.length, paths.length, 'after exhaustion no miss parses another chapter path');
} finally { linkContext.chapterManifestCleanup(); }

await openBook('c');
try {
  await follow('chapter-0004.xhtml#new-book', 3, 'new-book');
  assert.deepEqual(resolved, [paths[3], ...paths.slice(0, 3)], 'a new manifest starts with a fresh cache and cursor');
} finally { linkContext.chapterManifestCleanup(); }
console.log('chapter metadata validation and prefetch sizes passed');
