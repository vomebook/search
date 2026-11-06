// Exercise the repository's content-addressed build with a minimal asset graph.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
const cache = 'reader/pdf/reader-pdf-range-cache.mjs';
const network = 'reader/pdf/reader-pdf-network.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0,12);

test('PDF range cache is built before its network consumer and pinned for release', () => {
  const readerFiles = resources.readerFiles;
  assert.equal(readerFiles.filter(name=>name===cache).length,1);
  assert.equal(readerFiles.filter(name=>name===network).length,1);
  assert.ok(readerFiles.indexOf(cache)<readerFiles.indexOf(network));
  for (const project of ['github','hf']) {
    const base = project==='github' ? '/search/static/' : '/static/';
    assert.ok(resources.buildFiles(project).includes(cache));
    assert.ok(resources.runtimePaths(base).includes(base+cache));
    assert.ok(resources.shellAssets(base).includes(base+cache));
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
        const fixture=file===cache||file===network ? readFileSync(join(root,'static',file)) : Buffer.from('');
        writeFileSync(target,fixture);
      }
      writeFileSync(join(output,'index.html'),'<html></html>');
      writeFileSync(join(assets,'reader.html'),'<html></html>');
      writeFileSync(join(output,'sw.js'),'const CURRENT_HASHED_ASSETS = [];');
      const script=resolve(root,'scripts/build/build_static_assets.mjs');
      const run=spawnSync(process.execPath,[script],{
        cwd:work,env:{...process.env,STATIC_OUTPUT_DIR:output},encoding:'utf8',timeout:15000
      });
      assert.ifError(run.error); assert.equal(run.status,0,run.stderr);
      const cacheBytes=readFileSync(join(root,'static',cache));
      const cacheName=`reader-pdf-range-cache.${digest(cacheBytes)}.mjs`;
      const cachePath=join(assets,'reader/pdf',cacheName);
      assert.deepEqual(readFileSync(cachePath),cacheBytes);
      const original=readFileSync(join(root,'static',network),'utf8');
      const rewritten=original.replaceAll('./reader-pdf-range-cache.mjs','./'+cacheName);
      assert.notEqual(rewritten,original);
      const networkName=`reader-pdf-network.${digest(rewritten)}.mjs`;
      assert.equal(readFileSync(join(assets,'reader/pdf',networkName),'utf8'),rewritten);
      assert.match(readFileSync(join(output,'sw.js'),'utf8'),new RegExp(cacheName.replaceAll('.','\\.')));
      assert.equal(files.filter(name=>name===cache).length,1);
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
