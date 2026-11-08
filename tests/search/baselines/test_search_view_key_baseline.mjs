// Contracts pinned against each site's original getSearchViewKey implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const space = fs.existsSync(path.join(root, 'Dockerfile'));
const extract = name => {
  const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, `missing host function ${name}`);
  return match[0];
};

function fixture() {
  const state = {mode:'global', repoFull:'', query:'q', filterMinSize:null, filterMaxSize:null,
    sort:'relevance', searchFolders:true, exact:true, useLocalMode:true, pageSize:100,
    filterRepos:[], filterExtensions:[], filterFolderSelfs:[], filterFolderSubtrees:[], filterFolders:[]};
  const c = vm.createContext({STATE:state, DOM:{sortSelect:{value:'relevance'}}, searchViewKeyMemo:null,
    encodes:0});
  c.stableSearchStringify = value => {c.encodes++; return JSON.stringify(value);};
  const modulePath = path.join(root, 'static/search/domain/search-view-key.js');
  vm.runInContext(fs.readFileSync(modulePath, 'utf8'), c, {filename: modulePath});
  for (const name of ['sameSearchFilterValues', 'getSearchViewKey']) vm.runInContext(extract(name), c);
  return c;
}

test('site key projection preserves native sorting and site-specific fields', () => {
  const c = fixture();
  Object.assign(c.STATE, {mode:'repo', repoFull:'VoiceOfML/A', query:'文化', filterRepos:['z','a'],
    filterExtensions:['txt','pdf'], filterFolderSelfs:['self'], filterFolderSubtrees:['sub'],
    filterFolders:['ignored'], filterMinSize:1, filterMaxSize:500, sort:'size', useLocalMode:false});
  c.DOM.sortSelect.value = 'date';
  const key = JSON.parse(c.getSearchViewKey());
  assert.deepEqual(key.repos, ['a','z']);
  assert.deepEqual(key.extensions, ['pdf','txt']);
  assert.deepEqual(key.folders, {self:['self'], subtree:['sub']});
  assert.deepEqual(key.plainFolders, []);
  assert.equal(key.mode, 'repo');
  assert.equal(key.query, '文化');
  assert.equal(key.sort, space ? 'date' : 'size');
  if (space) assert.equal('useLocalMode' in key, false);
  else assert.equal(key.useLocalMode, false);
  assert.equal(key.minSize, 1);
  assert.equal(key.maxSize, 500);
});

test('memo stays identical for unchanged inputs and invalidates aliased edits', () => {
  const c = fixture();
  c.STATE.filterRepos = ['first'];
  const first = c.getSearchViewKey(), memo = c.searchViewKeyMemo;
  assert.equal(c.getSearchViewKey(), first);
  assert.equal(c.searchViewKeyMemo, memo, 'cache hits retain the original memo object');
  assert.equal(c.encodes, 1);
  c.STATE.filterRepos[0] = 'second';
  assert.notEqual(c.getSearchViewKey(), first);
  assert.equal(c.encodes, 2);
  assert.notEqual(c.searchViewKeyMemo, memo);
  assert.equal(memo.filters[0][0], 'first');
});

test('explicit folders hide legacy folders without overwriting their state', () => {
  const c = fixture();
  c.STATE.filterFolders = ['one'];
  const plain = c.getSearchViewKey();
  assert.deepEqual(JSON.parse(plain).plainFolders, ['one']);
  c.STATE.filterFolderSelfs = ['self'];
  const mixed = c.getSearchViewKey(), memo = c.searchViewKeyMemo;
  c.STATE.filterFolders[0] = 'two';
  assert.equal(c.getSearchViewKey(), mixed);
  assert.equal(c.searchViewKeyMemo, memo);
  c.STATE.filterFolderSelfs = [];
  assert.deepEqual(JSON.parse(c.getSearchViewKey()).plainFolders, ['two']);
});

test('site-specific sort defaults and missing sort control retain original bytes', () => {
  const c = fixture();
  c.STATE.sort = '';
  c.DOM.sortSelect.value = '';
  assert.equal(JSON.parse(c.getSearchViewKey()).sort, space ? '' : 'relevance');
  c.DOM.sortSelect = null;
  c.STATE.sort = 'name';
  assert.equal(JSON.parse(c.getSearchViewKey()).sort, space ? 'relevance' : 'name');
});

test('sparse arrays and custom iterators keep each site copy semantics', () => {
  const c=fixture();
  const entries=new Array(2);
  entries[1]='b';
  entries[Symbol.iterator]=function* () {yield 'custom';};
  c.STATE.filterRepos=entries;
  assert.deepEqual(JSON.parse(c.getSearchViewKey()).repos, space ? ['custom'] : ['b',null]);
});

test('encoder failures do not replace a previously usable memo', () => {
  const c = fixture();
  const first = c.getSearchViewKey(), memo = c.searchViewKeyMemo;
  c.STATE.query = 'next';
  c.stableSearchStringify = () => {throw new Error('encoding failure');};
  assert.throws(() => c.getSearchViewKey(), {message:'encoding failure'});
  assert.equal(c.searchViewKeyMemo, memo);
  c.STATE.query = 'q';
  assert.equal(c.getSearchViewKey(), first);
});

test('a reentrant filter getter cannot make an old memo a hit', () => {
  const c=fixture();
  c.getSearchViewKey();
  let values=['new'];
  Object.defineProperty(c.STATE,'filterRepos',{get(){c.searchViewKeyMemo=null;return values;},set(next){values=next;}});
  assert.deepEqual(JSON.parse(c.getSearchViewKey()).repos,['new']);
  assert.equal(c.encodes,2);
  assert.ok(c.searchViewKeyMemo);
});

test('a comparator that clears memo still raises the original TypeError', () => {
  const c=fixture();c.getSearchViewKey();
  c.sameSearchFilterValues=()=>{c.searchViewKeyMemo=null;return true;};
  assert.throws(()=>c.getSearchViewKey(),{name:'TypeError'});
});

test('filter and scalar getters are observed in their original order', () => {
  const c = fixture(), reads = [];
  for (const key of ['mode','repoFull','query','filterMinSize','filterMaxSize','sort',
    'searchFolders','exact','useLocalMode','pageSize','filterRepos','filterExtensions',
    'filterFolderSelfs','filterFolderSubtrees','filterFolders']) {
    let value = c.STATE[key];
    Object.defineProperty(c.STATE, key, {get(){reads.push(key);return value;},set(next){value=next;}});
  }
  c.getSearchViewKey();
  const expected = space
    ? ['mode','repoFull','query','filterMinSize','filterMaxSize','searchFolders','exact','pageSize']
    : ['mode','repoFull','query','filterMinSize','filterMaxSize','sort','searchFolders','exact','useLocalMode','pageSize'];
  assert.deepEqual(reads.slice(0, expected.length), expected);
  assert.equal(reads.includes('filterFolders'), true);
});
