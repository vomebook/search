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
        const fixture=[cache,hints,network].includes(file) ? readFileSync(join(root,'static',file)) : Buffer.from('');
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
      const original=readFileSync(join(root,'static',network),'utf8');
      let rewritten=original;
      for (const dependency of [cache,hints]) {
        const name=dependency.split('/').at(-1), bytes=readFileSync(join(root,'static',dependency));
        const hashed=name.replace(/\.mjs$/,`.${digest(bytes)}.mjs`);
        assert.deepEqual(readFileSync(join(assets,'reader/pdf',hashed)),bytes);
        const updated=rewritten.replaceAll('./'+name,'./'+hashed);
        assert.notEqual(updated,rewritten);
        rewritten=updated;
        assert.match(readFileSync(join(output,'sw.js'),'utf8'),new RegExp(hashed.replaceAll('.','\\.')));
        assert.equal(files.filter(file=>file===dependency).length,1);
      }
      const networkName=`reader-pdf-network.${digest(rewritten)}.mjs`;
      assert.equal(readFileSync(join(assets,'reader/pdf',networkName),'utf8'),rewritten);
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
