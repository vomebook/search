import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {createRequire} from 'node:module';
const space = fs.existsSync('pyrightconfig.json');
const app = fs.readFileSync('static/app.js', 'utf8');
const names = ['search/results/presentation/row.js', 'search/results/application/interactions.js'];
const turn = () => new Promise(resolve => setImmediate(resolve));
function installHost(c, names) {
  for (const name of names) {
    const match = app.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name); vm.runInContext(match[0], c);
  }
}
function node(dataset = {}, matches = {}) {
  return {dataset, handlers: {}, style: {}, classList: {add() {}, remove() {}, toggle() {}},
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    closest(selector) { return matches[selector] || null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, setAttribute(name, value) { this[name] = value; },
    cloneNode() { const copy = node({...this.dataset}); copy.innerHTML = this.innerHTML; copy.className = this.className; return copy; },
  };
}
function fixture() {
  const resultsList = node(), sidebarContent = node(), copied = [], downloads = [], navigated = [], warmed = [], rendered = [], toasts = [];
  const multiSelectToggle = {...node(), checked: true};
  const DOM = {resultsList, sidebarContent, multiSelectToggle, multiActionBar: node(), multiSelectedCount: node(),
    multiCopyLinks: node(), multiBatchDownload: node(), multiDeselect: node(), multiSelectAll: node()};
  const records = [{File: 'one', Extension: 'txt'}, undefined, {File: 'three', Extension: 'pdf'}];
  const c = vm.createContext({DOM, STATE: {results: records, repo: 'Repo', query: 'one', searchFolders: true, mode: 'global'},
    resultInteractions: null, resultRows: null, selectedIndices: {}, lastSelectedIndex: -1, resultSnapshots: {cloneTask: null},
    readerAssetController: {state: {assets: {}}},
    VSCROLL: {templateCache: new Map(), contentVersion: 7}, resultRowRecords: new WeakMap(),
    document: {createElement: () => node(), body: node(), hidden: false},
    window: {location: {hash: ''}}, history: {pushState(_a, _b, url) { navigated.push(url); }},
    navigator: {clipboard: {writeText(value) { copied.push(value); return Promise.resolve(); }}, onLine: true},
    showToast: value => toasts.push(value), getCopyableLink: link => 'copy:' + link,
    getRecordLink: rec => 'link:' + rec.File, getReaderLink: rec => 'reader:' + rec.File + ':' + rec.asset,
    getResultStableId: rec => `${rec.Repo || ''}\0${rec.File}.${rec.Extension}`,
    applyReaderAsset: rec => ({...rec, asset: c.asset}), buildRecordRelativePath: rec => rec.File,
    isReadableRecord: () => true, isDefaultReadableRecord: () => true,
    VoiceOfMLReader: {capability: () => ({mode: 'text'})}, asset: 'old',
    getFileIconType: () => 'file', ICONS: {file: '<svg></svg>'}, formatSize: () => '',
    escapeHTML: text => String(text ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch])),
    highlightText: text => c.escapeHTML(text), getRecordPath: rec => rec.File, getPreviewLink: path => 'preview:' + path,
    createResultWindowPlaceholder: index => ({placeholder: index}),
    downloadFile: (...args) => { downloads.push(args); return Promise.resolve(true); },
    startDownloadBatch: files => downloads.push(files), navigateToReader: url => navigated.push(url),
    ROUTER: {navigate: (...args) => navigated.push(args), apply: () => navigated.push('apply')},
    buildSearchURLParams: () => new URLSearchParams('q=one&folder_subtree=kept&min_size=2'),
    renderBrowser: (...args) => rendered.push(args), routeRenderId: 9,
    warmSelectedDownload: index => warmed.push(index), API: {_browserPending: new Map(), getContents: async () => ({})},
    resultWindow: null, restartResultWindow() {}, loadResultWindowPage() {},
    materializeSnapshotRange(task, start, end, selected) {
      assert.equal(selected, true); for (let i = start; i < end; i++) c.STATE.results[i] = task.snapshot.results[i];
    }, applySnapshotCloneHeights() { c.heightsApplied++; }, heightsApplied: 0,
  });
  for (const name of names) vm.runInContext(fs.readFileSync('static/' + name, 'utf8'), c);
  installHost(c, ['getResultRows', 'selectResultReaderAction', 'readerActionForRefresh', 'getResultInteractions', 'setupResultDelegation', 'updateSelectionUI', 'updateVisibleSelection', 'getSelectedFiles']);
  c.getResultInteractions().installSelection(); c.setupResultDelegation();
  async function click(host, target, shiftKey = false) {
    const event = {target, shiftKey, preventDefault() {}, stopPropagation() { this.stopped = true; }};
    for (const fn of host.handlers.click) await fn(event);
    await turn(); return event;
  }
  return {c, DOM, copied, downloads, navigated, warmed, rendered, toasts, click};
}

test('result modules are source, composition, resource and offline dependencies exactly once', () => {
  const html = fs.readFileSync('static/index.html', 'utf8');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  const sw = fs.readFileSync('static/sw.js', 'utf8');
  for (const name of names) {
    assert.equal(APP_DEPENDENCIES.filter(item => item === name).length, 1);
    assert.equal(html.split(name).length - 1, 1);
    assert.ok(html.indexOf(name) < html.lastIndexOf('app.js'));
    assert.ok(!stripBundledScripts(html).includes(name));
    for (const project of ['github', 'hf']) assert.equal(resources.buildFiles(project).filter(item => item === name).length, 1);
    assert.equal(sw.split('/static/' + name).length - 1, 1);
    assert.doesNotMatch(fs.readFileSync('static/' + name, 'utf8'), /\bSTATE\b|\bVSCROLL\b|refreshResultReaderActions|scheduleVirtualRender/);
  }
  assert.ok(app.indexOf('getResultInteractions().installSelection();') < app.lastIndexOf('setupResultDelegation();'));
});

test('row clone identity, live hooks, escaping, cache LRU and placeholders retain host integration', () => {
  const {c} = fixture(), rows = c.getResultRows();
  const rec = {File: 'a<&"', Extension: 'txt', Repo: 'VoiceOfML/R&', Folder: ['x"', 'y&']};
  const first = rows.createRow(rec, 1), second = rows.createRow(rec, 1);
  assert.notEqual(first, second); assert.equal(c.resultRowRecords.get(second), rec);
  assert.equal(second.dataset.index, '1'); assert.equal(second.dataset.contentVersion, '7');
  assert.equal(second.dataset.readerReturnKey, 'VoiceOfML/R&\0a<&".txt');
  assert.equal(second.role, 'listitem'); assert.equal(second.tabIndex, -1);
  assert.match(second.innerHTML, /a&lt;&amp;&quot;/); assert.match(second.innerHTML, /data-folder="x&quot;\/y&amp;"/);
  assert.match(second.innerHTML, /data-link="copy:link:a&lt;&amp;&quot;"/);
  assert.match(second.innerHTML, /reader:a&lt;&amp;&quot;:old/);
  c.highlightText = () => 'live-highlight'; c.asset = 'fresh';
  assert.match(rows.buildHTML(rec, 1), /live-highlight/); assert.match(rows.buildHTML(rec, 1), /:fresh/);
  for (let i = 2; i <= 240; i++) rows.createRow(rec, i);
  rows.createRow(rec, 1); rows.createRow(rec, 241);
  assert.equal(c.VSCROLL.templateCache.size, 240); assert.ok(c.VSCROLL.templateCache.has(1)); assert.ok(!c.VSCROLL.templateCache.has(2));
  c.VSCROLL.templateCache.clear(); c.VSCROLL.contentVersion++;
  assert.equal(rows.createRow(rec, 1).dataset.contentVersion, '8');
  assert.equal(rows.createRow(undefined, 999).placeholder, 999);
});

test('initial markup and asset refresh agree on the playable, native fallback and unavailable Reader actions', () => {
  const {c} = fixture(), rows = c.getResultRows(), links = [];
  const converted = {File: 'book', ReaderExtension: 'audio'};
  c.VoiceOfMLReader.capability = extension => ({mode: extension === 'audio' ? 'audio' : 'text'});
  c.isReadableRecord = rec => rec === converted;
  c.isDefaultReadableRecord = rec => rec.Extension === 'txt';
  c.getReaderLink = (...args) => { links.push(args); return 'reader.html'; };
  for (const [extension, enriched, label] of [
    ['bin', true, '在线播放'], ['txt', false, '在线阅读'], ['bin', false, ''],
  ]) {
    const original = {File: 'book', Extension: extension};
    c.applyReaderAsset = (_rec, _repo, _path, link) => {
      assert.equal(link, 'link:book');
      return enriched ? converted : original;
    };
    const expected = enriched ? converted : label ? original : null;
    links.length = 0;
    const refreshed = c.readerActionForRefresh(original);
    assert.equal(refreshed.record, expected);
    assert.equal(refreshed.label, label);
    assert.deepEqual(links, []); // Geometry checks must not build URLs.
    const html = rows.buildHTML(original, 0);
    if (label) {
      assert.ok(html.includes(`data-action="read" data-reader-url="reader.html">${label}</button>`));
      assert.deepEqual(links, [[expected, undefined, false]]);
    } else {
      assert.doesNotMatch(html, /data-action="read"/);
      assert.deepEqual(links, []);
    }
  }
});

test('deep breadcrumb builds each escaped path prefix once without slicing folders', () => {
  const {c} = fixture();
  const parts = ['', 'a&"', '', '目录', '<末>/'];
  let slices = 0;
  const folders = parts.slice();
  folders.slice = (...args) => { slices++; return parts.slice(...args); };
  const escape = c.escapeHTML, calls = [];
  c.escapeHTML = value => { calls.push(value); return escape(value); };
  c.highlightText = value => `<mark>${escape(value)}</mark>`;
  const html = c.getResultRows().buildHTML({File: 'book', Extension: 'txt', Repo: 'VoiceOfML/R', Folder: folders}, 0);
  const attrs = [...html.matchAll(/aria-label="筛选路径：([^"]*)" data-folder="([^"]*)"/g)];
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  assert.deepEqual(attrs.map(([, name, path]) => [name, path]), prefixes.map(value => [escape(value), escape(value)]));
  assert.ok(html.includes('<mark>&lt;末&gt;/</mark>'));
  assert.equal(slices, 0);
  for (const prefix of prefixes) assert.equal(calls.filter(value => value === prefix).length, 1, prefix);
});

test('result actions retain current Reader asset, clipboard failures and shared download button identity', async () => {
  const f = fixture(), {c, DOM, click} = f;
  const row = node(), record = {File: 'fresh'}; c.resultRowRecords.set(row, record);
  const button = node({action: 'read', readerUrl: 'stale'}, {'.result-item': row});
  button.focus = options => { assert.equal(options.preventScroll, true); button.focused = true; };
  button.closest = selector => selector === '[data-action]' ? button : selector === '.result-item' ? row : null;
  c.asset = 'new'; await click(DOM.resultsList, button);
  assert.equal(button.dataset.readerUrl, 'reader:fresh:new'); assert.equal(f.navigated.at(-1), 'reader:fresh:new');
  assert.equal(button.focused, true);
  button.dataset = {action: 'download', filename: 'name', link: 'url'}; await click(DOM.resultsList, button);
  assert.equal(f.downloads[0][2].button, button);
  button.dataset = {action: 'copy', link: 'copy-me'}; await click(DOM.resultsList, button);
  assert.equal(f.copied.at(-1), 'copy-me'); assert.equal(f.toasts.at(-1), '链接已复制');
  c.navigator.clipboard.writeText = () => Promise.reject(Error('denied')); await click(DOM.resultsList, button);
  assert.equal(f.toasts.at(-1), '复制失败');
});

test('single and bulk copy report an unavailable clipboard or synchronous failure', async () => {
  const f = fixture(), {c, DOM, click} = f;
  const button = node({action: 'copy', link: 'copy-me'});
  button.closest = selector => selector === '[data-action]' ? button : null;
  c.selectedIndices = {0: true};
  for (const clipboard of [undefined, {writeText() { throw new Error('disabled'); }}]) {
    c.navigator.clipboard = clipboard;
    f.toasts.length = 0;
    await click(DOM.resultsList, button);
    await click(DOM.multiCopyLinks, DOM.multiCopyLinks);
    assert.deepEqual(f.toasts, ['复制失败', '复制失败']);
    assert.deepEqual(f.copied, []);
  }
});

test('breadcrumb keyboard respects IME and native controls; route merges query and sidebar dataset differs by site', async () => {
  const f = fixture(), {c, DOM, click} = f;
  let activated = 0;
  const folder = node({repo: 'R /', folder: 'x/y'}); folder.click = () => activated++;
  folder.closest = selector => ['.path-folder', '.path-folder[role="button"]'].includes(selector) ? folder : null;
  const key = DOM.resultsList.handlers.keydown[0];
  for (const extra of [{isComposing: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}, {defaultPrevented: true}]) {
    key({target: folder, key: 'Enter', ...extra});
  }
  assert.equal(activated, 0);
  for (const value of ['Enter', ' ']) key({target: folder, key: value, preventDefault() {}, stopPropagation() {}});
  key({target: node(), key: 'Enter'}); assert.equal(activated, 2);
  await click(DOM.resultsList, folder);
  const route = space ? f.navigated[0] : c.window.location.hash;
  assert.match(route, /R%20%2F/); assert.match(route, /q=one/); assert.match(route, /folder_subtree=kept/); assert.match(route, /folder_subtree=x%2Fy/);
  if (space) assert.equal(f.navigated[1], 'apply');
  else { await click(DOM.resultsList, folder); assert.deepEqual(f.rendered[0], ['x/y', 9]); }
  const repoItem = node({repo: 'Test'}); repoItem.closest = selector => selector === '.repo-list-item' ? repoItem : null;
  await click(DOM.sidebarContent, repoItem); assert.deepEqual(f.navigated.at(-1), ['repo', 'Test']);
  const repoTag = node({repo: 'Tag'}); repoTag.closest = selector => selector === '.result-repo-tag' ? repoTag : null;
  await click(DOM.resultsList, repoTag); assert.deepEqual(f.navigated.at(-1), ['repo', 'Tag']);
  const folderItem = node({type: 'folder', path: 'docs'}); folderItem.closest = selector => selector === '.browser-item' ? folderItem : null;
  await click(DOM.sidebarContent, folderItem); assert.deepEqual(f.navigated.at(-1), ['repo', 'Repo', 'docs']);
  const browser = node({readerUrl: 'pages-reader', readUrl: 'hf-reader', link: 'download'});
  browser.closest = selector => selector === '.browser-item' ? browser : null;
  await click(DOM.sidebarContent, browser);
  assert.equal(f.navigated.at(-1), space ? 'hf-reader' : 'pages-reader');
  const action = node(); browser.querySelector = () => action;
  const target = node({}, {'.browser-item': browser, '.browser-action': action});
  await click(DOM.sidebarContent, target); assert.equal(f.downloads.at(-1)[2].button, action);
});

test('selection keeps sparse clone materialization, replacement state, ordering, copy and batch lifecycle', async () => {
  const f = fixture(), {c, DOM, click} = f;
  const saved = c.STATE.results.slice(); c.STATE.results = Array(3); c.resultSnapshots.cloneTask = {snapshot: {results: saved}};
  const checkbox = node({index: '0'}); checkbox.checked = true;
  checkbox.closest = selector => selector === '.result-checkbox' ? checkbox : null;
  await click(DOM.resultsList, checkbox); checkbox.dataset.index = '2'; await click(DOM.resultsList, checkbox, true);
  assert.deepEqual(Object.keys(c.selectedIndices), ['0', '2']);
  await click(DOM.multiCopyLinks, DOM.multiCopyLinks);
  assert.equal(f.copied.at(-1), 'copy:link:one\ncopy:link:three'); assert.equal(c.heightsApplied, 1);
  assert.equal(c.STATE.results[0], saved[0]); assert.equal(c.STATE.results[2], saved[2]);
  await click(DOM.multiBatchDownload, DOM.multiBatchDownload); assert.equal(f.downloads.at(-1).length, 2);
  await click(DOM.multiDeselect, DOM.multiDeselect); assert.deepEqual(Object.keys(c.selectedIndices), []);
  await click(DOM.multiSelectAll, DOM.multiSelectAll); assert.deepEqual(Object.keys(c.selectedIndices), ['0', '2']);
  await click(DOM.multiSelectAll, DOM.multiSelectAll); assert.deepEqual(Object.keys(c.selectedIndices), []);
  if (space) assert.deepEqual(f.warmed, [0, undefined, undefined]); else assert.deepEqual(f.warmed, []);
});
