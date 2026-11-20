// Exercise the repository's content-addressed build with a minimal asset graph.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
const cache = 'reader/pdf/reader-pdf-range-cache.mjs';
const hints = 'reader/pdf/reader-pdf-range-hints.mjs';
const network = 'reader/pdf/reader-pdf-network.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0,12);

test('PDF range dependencies are built before the network consumer and pinned for release', () => {
  const readerFiles = resources.readerFiles;
  for (const dependency of [cache,hints]) {
    assert.equal(readerFiles.filter(name=>name===dependency).length,1);
    assert.ok(readerFiles.indexOf(dependency)<readerFiles.indexOf(network));
  }
  assert.equal(readerFiles.filter(name=>name===network).length,1);
  for (const project of ['github','hf']) {
    const base = project==='github' ? '/search/static/' : '/static/';
    for (const dependency of [cache,hints]) {
      assert.ok(resources.buildFiles(project).includes(dependency));
      assert.ok(resources.runtimePaths(base).includes(base+dependency));
      assert.ok(resources.shellAssets(base).includes(base+dependency));
    }
  }

  const temp = mkdtempSync(join(tmpdir(),'pdf-cache-release-'));
  try {
    for (const project of ['github']) {
      const work = join(temp,project), source = join(work,'static');
      const output = project==='github' ? join(work,'site') : join(work,'out');
      const assets = project==='github' ? join(output,'static') : output;
      mkdirSync(source,{recursive:true}); mkdirSync(assets,{recursive:true});
      writeFileSync(join(source,'reader-resources.js'),readFileSync(join(root,'static/reader-resources.js')));
      const files = resources.buildFiles(project);
      for (const file of files) {
        const target=join(assets,file); mkdirSync(dirname(target),{recursive:true});
        const fixture=[cache,hints,network,'reader-resources.js','app.js','reader/pdf/pdf-worker-wrapper.mjs',
          'reader/pdf/reader-engine-preload.js','reader/pdf/reader-djvu-engine-worker.mjs'].includes(file)
          ? readFileSync(join(root,'static',file)) : Buffer.from('');
        writeFileSync(target,fixture);
      }
      writeFileSync(join(output,'index.html'),'<html></html>');
      writeFileSync(join(assets,'reader.html'),'<html></html>');
      writeFileSync(join(output,'sw.js'),'const CACHE_VERSION = "development"; const CURRENT_HASHED_ASSETS = [];');
      const script=resolve(root,'scripts/build/build_static_assets.mjs');
      const run=spawnSync(process.execPath,[script],{
        cwd:work,env:{...process.env,STATIC_OUTPUT_DIR:output},encoding:'utf8',timeout:15000
      });
      assert.ifError(run.error); assert.equal(run.status,0,run.stderr);
      const built = file => {
        const directory=dirname(file), name=file.split('/').at(-1), dot=name.lastIndexOf('.');
        const hashed=readdirSync(join(assets,directory)).find(entry=>entry.startsWith(name.slice(0,dot)+'.') && entry.endsWith(name.slice(dot)));
        assert.ok(hashed,'built '+file);
        return {path:(directory==='.'?'':directory+'/')+hashed,text:readFileSync(join(assets,directory,hashed),'utf8')};
      };
      const base=project==='github'?'/search/static/':'/static/';
      const app=built('app.js').text;
      const expression=app.match(/(?:var|const) engineAssets = ([^;]+);/)[1];
      assert.doesNotMatch(expression,/\.engineAssets\(|\?reader-v1/,'build must inline the suffix-free warming call');
      assert.ok(expression.includes('djvuSelectedAssets'),'build must preserve runtime architecture choice');
      const sw=readFileSync(join(output,'sw.js'),'utf8');
      assert.doesNotMatch(sw,/\/vendor\/(?:zip|LICENSE_zipjs)\./,'obsolete zip.js must not enter the release cache inventory');
      const inventory=built('reader-resources.js');
      const worker=built('reader/pdf/reader-djvu-engine-worker.mjs');
      assert.ok(worker.text.includes('../../'+inventory.path),'worker imports hashed shared selection');
      assert.ok(built('reader/pdf/reader-engine-preload.js').text.includes('./'+built('reader/pdf/pdf-worker-wrapper.mjs').path.split('/').at(-1)));
      for(const simd of [true,false]) {
        const context={WebAssembly:{validate:()=>simd}};vm.createContext(context);vm.runInContext(inventory.text,context);
        for(const extension of ['djvu','djv','pdf','epub','txt']) {
          context.extension=extension;
          const hrefs=Array.from(vm.runInContext(expression,context));
          if(extension==='djvu'||extension==='djv') {
            assert.equal(hrefs.length,1);assert.ok(hrefs[0].endsWith('/'+(simd?'simd128':'scalar')+'/djvu_rs_bg.wasm'));
            const demanded=worker.text.matchAll(/new URL\('([^']+djvu_rs_bg\.wasm)'/g);
            assert.ok([...demanded].some(match=>new URL(match[1],'https://site.test'+base+worker.path).pathname===hrefs[0]));
          } else if(extension==='pdf') {
            assert.ok(hrefs.includes(base+built('reader/pdf/pdf-worker-wrapper.mjs').path),'intent and Reader use hashed worker URL');
            assert.ok(hrefs.includes(base+'vendor/wasm/qcms_bg.wasm'),'ICC branch survives build');
          } else assert.deepEqual(hrefs,[]);
        }
      }
      const original=readFileSync(join(root,'static',network),'utf8');
      let rewritten=original;
      for (const dependency of [cache,hints]) {
        const name=dependency.split('/').at(-1), bytes=readFileSync(join(root,'static',dependency));
        const hashed=name.replace(/\.mjs$/,`.${digest(bytes)}.mjs`);
        assert.deepEqual(readFileSync(join(assets,'reader/pdf',hashed)),bytes);
        const updated=rewritten.replaceAll('./'+name,'./'+hashed);
        assert.notEqual(updated,rewritten);
        rewritten=updated;
        assert.match(sw,new RegExp(hashed.replaceAll('.','\\.')));
        assert.equal(files.filter(file=>file===dependency).length,1);
      }
      const networkName=`reader-pdf-network.${digest(rewritten)}.mjs`;
      assert.equal(readFileSync(join(assets,'reader/pdf',networkName),'utf8'),rewritten);
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
