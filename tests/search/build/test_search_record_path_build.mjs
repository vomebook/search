import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {installPrecachePaths, shellScriptPaths} from '../../support/shell_assets.mjs';

const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
const html = readFileSync('static/index.html', 'utf8');
const worker = readFileSync('static/sw.js', 'utf8');
const staticBase = '/search/static/';
const required = [
  'search/catalog/domain/record-path.js',
  'search/results/presentation/highlight.js',
  'search/requests/infrastructure/response-cache.js',
  'search/catalog/domain/file-types.js',
  'search/requests/domain/response-validation.js',
  'search/results/domain/result-identity.js',
  'search/sidebar/domain/folder-selection.js',
  'search/results/virtual/domain/height-index.js',
  'search/shared/domain/stable-stringify.js',
  'search/positions/domain/view-key.js',
  'search/results/domain/recovery.js',
  'search/results/window/domain/page.js',
  'search/sidebar/presentation/markup.js',
];
const windowPage = 'search/results/window/domain/page.js';
const appScripts = [...APP_DEPENDENCIES, 'app.js'];
const scripts = shellScriptPaths(html, staticBase, {ordered: appScripts});
const bundled = shellScriptPaths(stripBundledScripts(html), staticBase, {ordered: ['app.js']});
// Select the release branch as the build does; this gate checks membership,
// while the build fixture checks hashed paths and the stamped integrity.
const integrityMarker = 'READER_SHELL_INTEGRITY = "development"';
assert.equal(worker.split(integrityMarker).length - 1, 1);
const releaseWorker = worker.replace(integrityMarker, 'READER_SHELL_INTEGRITY = "sha256-fixture"');
const releasePrecache = await installPrecachePaths(releaseWorker, resources, staticBase);
const devPrecache = await installPrecachePaths(worker, resources, staticBase);
const count = (files, target) => files.filter(file => file === target).length;
assert.deepEqual(bundled, ['app.js'], 'bundled shell must contain only the application script');
assert.equal(count(scripts, 'app.js'), 1);
assert.equal(count(releasePrecache, 'app.js'), 1);
// The development shell need not mirror the full bundle order, but every
// composed classic dependency must load once and execute before the host.
assert.equal(new Set(appScripts).size, appScripts.length, 'application composition must not duplicate scripts');
for (const name of APP_DEPENDENCIES) {
  const message = name === windowPage ? 'window page source script must be present once' : `${name} must load once`;
  assert.equal(count(scripts, name), 1, message);
  assert.ok(scripts.indexOf(name) < scripts.indexOf('app.js'), `${name} must load before app.js`);
}
for (const name of required) {
  assert.equal(count(APP_DEPENDENCIES, name), 1, `${name} must be composed once`);
  for (const project of ['github', 'hf']) {
    assert.equal(count(resources.buildFiles(project), name), 1,
      name === windowPage ? 'window page must be a build dependency' : `${name} missing or duplicated in ${project}`);
  }
}
for (const name of resources.searchHostFiles) {
  assert.ok(!releasePrecache.includes(name), `${name} must not be individually precached in production`);
}
for (const name of scripts) {
  assert.equal(count(devPrecache, name), 1, `${name} must be precached once in development`);
}
// The identity and window helpers consume the modules preceding them.
const ordered = [required[0], ...required.slice(5)];
for (let i = 1; i < ordered.length; i++) {
  assert.ok(scripts.indexOf(ordered[i - 1]) < scripts.indexOf(ordered[i]), `${ordered[i - 1]} must precede ${ordered[i]}`);
}
const sidebarMarkup = required.at(-1);
assert.ok(APP_DEPENDENCIES.indexOf(sidebarMarkup) < APP_DEPENDENCIES.indexOf('search/sidebar/application/filters.js'));
const directoryFiles = ['search/sidebar/infrastructure/scroll.js', 'search/sidebar/presentation/directory.js',
  'search/sidebar/application/directory.js'];
assert.ok(directoryFiles.every(name => APP_DEPENDENCIES.includes(name)));
assert.equal(APP_DEPENDENCIES.at(-1), directoryFiles.at(-1));
console.log('record path source and bundled shell/SW contracts preserved');
