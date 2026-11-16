import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../..');

test('whole Pages app is checked in strict mode without changing shared projects', () => {
  const types = readdirSync(resolve(root, 'typings')).filter(name => /^search-.*\.d\.ts$/.test(name))
    .sort().map(name => `typings/${name}`);
  const args = ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--strict',
    '--target', 'esnext', '--module', 'esnext', '--moduleResolution', 'bundler', '--pretty', 'false',
    'static/app.js', 'typings/reader-globals.d.ts', ...types];
  const result = spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8'});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('app-owned types do not use any or TypeScript suppression directives', () => {
  for (const file of ['static/app.js', 'typings/search-app.d.ts', 'typings/search-corpus.d.ts']) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.doesNotMatch(source, /@ts-(?:ignore|nocheck|expect-error)\b/, file);
    assert.doesNotMatch(source, /(?:@type|@param|@returns|@typedef|\btype\s+\w+\s*=)[^\n]*\bany\b/, file);
  }
});
