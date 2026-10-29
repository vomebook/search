import assert from 'node:assert/strict';
import {validateReadingManifest, datasetPrimaryUrl} from '../static/reader/pdf/reader-v3.mjs';

globalThis.VoiceOfMLReader = {isBucketPath: path => typeof path === 'string' && path.startsWith('objects/')};
const source = 'a'.repeat(64), base = `objects/aa/${source}/`;
const bucketRef = file => ({bucket:'vomebook/pdf-pages-v2', path:base+'b'.repeat(16)+'/'+file,
  sha256:'c'.repeat(64), bytes:123, role:'runtime'});
const external = ext => ({kind:'dataset-source', repo:'VoiceOfML/books', path:`中文/book.${ext}`,
  revision:'d'.repeat(40), sha256:source, bytes:100, role:'runtime'});
const reading = ext => ({version:3, kind:'pdf-reading', source_sha256:source,
  source_key:`VoiceOfML/books\0中文/book.${ext}`, generation:'e'.repeat(64), page_count:1,
  primary:{kind:ext,status:'ready',resource:external(ext)},page_map:bucketRef('page-map.json.gz'),
  text_layer:null, preview:{page_count:1,status:'skipped',complete:false,ready_pages:0,partitions:[]},
  components:{document:'ready',preview:'skipped',text:'pending'}});

for (const ext of ['pdf','djvu']) {
  const value=reading(ext);
  assert.equal(validateReadingManifest(value,100),value);
  assert.equal(datasetPrimaryUrl(value.primary.resource),
    `https://huggingface.co/datasets/VoiceOfML/books/resolve/${'d'.repeat(40)}/%E4%B8%AD%E6%96%87/book.${ext}`);
  for (const mutation of [
    {repo:'Other/books'}, {repo:'VoiceOfML/../evil'}, {repo:'VoiceOfML/..'}, {revision:'main'}, {revision:'f'.repeat(39)},
    {path:'../book.'+ext}, {path:'中文/%2e%2e/book.'+ext}, {path:'/book.'+ext},
    {path:'中文/book.'+ext+'?x'}, {path:'中文/book.html'}, {role:'provenance'},
    {bytes:0}, {bytes:512*1024*1024+1}, {sha256:'f'.repeat(64)}, {bucket:'vomebook/pdf-pages-v2'},
    {path:'中文/\ud800.'+ext}
  ]) {
    const bad=reading(ext);Object.assign(bad.primary.resource,mutation);
    assert.throws(()=>validateReadingManifest(bad,100),/PDF_V3_INVALID/,JSON.stringify(mutation));
  }
  const wrongKey=reading(ext);wrongKey.source_key='VoiceOfML/books\0other.'+ext;
  assert.throws(()=>validateReadingManifest(wrongKey,100),/PDF_V3_INVALID/);
  const mismatch=reading(ext);mismatch.primary.kind=ext==='pdf'?'djvu':'pdf';
  assert.throws(()=>validateReadingManifest(mismatch,100),/PDF_V3_INVALID/);
}
const tooMany=reading('djvu');tooMany.page_count=tooMany.preview.page_count=10001;
assert.throws(()=>validateReadingManifest(tooMany,20000),/PDF_V3_INVALID/);
const uppercase=reading('pdf');uppercase.source_key='VoiceOfML/books\0中文/book.PDF';uppercase.primary.resource.path='中文/book.PDF';
assert.equal(validateReadingManifest(uppercase,100),uppercase);
console.log('fixed dataset primary validation and URL encoding passed');
