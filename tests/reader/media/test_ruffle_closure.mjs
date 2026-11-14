import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkRuffleAssets } from '../../../scripts/build/check_reader_release.mjs';

const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
const files = resources.ruffleArchive.files;
for (const base of ['/static/', '/search/static/', './']) {
  const assets = resources.ruffleAssets(base);
  assert.deepEqual(assets, files.slice(0, 5).map(file => `${base}${resources.ruffleArchive.directory}/${file}`));
  assert.equal(new URL(assets[1], 'https://example.test/reader.html').pathname,
    new URL(files[1], new URL(assets[0], 'https://example.test/reader.html')).pathname);
}
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ruffle-gate-'));
try {
  assert.throws(() => checkRuffleAssets(output), /Ruffle asset missing/);
  if (process.env.RUFFLE_EXTRACTED_PACKAGE) {
    const dir = path.join(output, resources.ruffleArchive.directory);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) fs.copyFileSync(path.join(process.env.RUFFLE_EXTRACTED_PACKAGE, file), path.join(dir, file));
    checkRuffleAssets(output);
    fs.appendFileSync(path.join(dir, files[3]), 'corruption');
    assert.throws(() => checkRuffleAssets(output), /integrity mismatch/);
  }
} finally { fs.rmSync(output, { recursive: true, force: true }); }
console.log('Ruffle closure inventory and release gate OK');
