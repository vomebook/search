import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const file = path.join(process.cwd(), 'static/search/domain/search-view-key.js');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(file, 'utf8'), context, {filename:file});
const resolveLazy = context.VoiceOfMLSearchViewKey.resolve;
const resolve = (state, surface, getSort, previous, same, encode) =>
  resolveLazy(() => ({state, surface, getSort}), () => previous, () => same, () => encode);

function state(extra = {}) {
  return {mode:'global', repoFull:'', query:'', filterMinSize:null, filterMaxSize:null,
    sort:'relevance', searchFolders:true, exact:true, pageSize:100,
    filterRepos:[], filterExtensions:[], filterFolderSelfs:[], filterFolderSubtrees:[], filterFolders:[],
    ...extra};
}
function same(current, saved) {
  if (!saved || current.length !== saved.length) return false;
  for (let i=0; i<current.length; i++) if (current[i] !== saved[i]) return false;
  return true;
}
const encode = value => JSON.stringify(value);

test('both site projections use exact field order, defaults and filtering', () => {
  const s = state({repoFull:'VoiceOfML/X', query:'query', filterRepos:['z','a'],
    filterExtensions:['txt','pdf'], filterFolderSubtrees:['z','a'], filterFolders:['legacy'], useLocalMode:false});
  const pages = resolve(s, 'pages', () => 'name', null, same, encode);
  const space = resolve(s, 'space', () => '', null, same, encode);
  assert.deepEqual(Object.keys(JSON.parse(pages.key)), ['mode','repo','query','repos','extensions','folders','plainFolders',
    'minSize','maxSize','sort','searchFolders','exact','useLocalMode','pageSize']);
  assert.deepEqual(JSON.parse(pages.key).repos, ['a','z']);
  assert.deepEqual(JSON.parse(pages.key).folders.subtree, ['a','z']);
  assert.deepEqual(JSON.parse(pages.key).plainFolders, []);
  assert.equal(JSON.parse(pages.key).useLocalMode, false);
  assert.equal(JSON.parse(space.key).sort, '');
  assert.equal('useLocalMode' in JSON.parse(space.key), false);
});

test('projection preserves per-site iterator and sparse-array copy behavior', () => {
  const repos=new Array(2);repos[1]='b';repos[Symbol.iterator]=function*(){yield 'iterated';};
  const s=state({filterRepos:repos});
  assert.deepEqual(JSON.parse(resolve(s,'pages',()=> 'relevance',null,same,encode).key).repos,['b',null]);
  assert.deepEqual(JSON.parse(resolve(s,'space',()=> 'relevance',null,same,encode).key).repos,['iterated']);
});

test('cache hits retain identity and invalidations never reuse stale snapshots', () => {
  const s = state({filterRepos:['a'], useLocalMode:true});
  let count=0; const serialize=value=>{count++;return encode(value);};
  const first=resolve(s,'pages',()=> 'relevance',null,same,serialize);
  assert.equal(resolve(s,'pages',()=> 'relevance',first,same,serialize),first);
  assert.equal(count,1);
  s.query='changed';const second=resolve(s,'pages',()=> 'relevance',first,same,serialize);
  assert.notEqual(second,first);assert.equal(count,2);
  s.filterRepos[0]='b';const third=resolve(s,'pages',()=> 'relevance',second,same,serialize);
  assert.notEqual(third,second);assert.equal(second.filters[0][0],'a');
  s.filterRepos.push('c');assert.notEqual(resolve(s,'pages',()=> 'relevance',third,same,serialize),third);
});

test('both explicit-folder paths hide legacy values and preserve identity', () => {
  for (const property of ['filterFolderSelfs','filterFolderSubtrees']) {
    const s=state({filterFolders:['legacy']});s[property]=['new'];
    const first=resolve(s,'space',()=> 'relevance',null,same,encode);
    assert.deepEqual(JSON.parse(first.key).plainFolders,[]);
    s.filterFolders[0]='updated';assert.equal(resolve(s,'space',()=> 'relevance',first,same,encode),first);
    s[property]=[];assert.deepEqual(JSON.parse(resolve(s,'space',()=> 'relevance',first,same,encode).key).plainFolders,['updated']);
  }
});

test('explicit callbacks preserve evaluation order and failures propagate', () => {
  const s=state();let sortReads=0;
  const getSort=()=>{sortReads++;return 'relevance';};
  const first=resolve(s,'space',getSort,null,same,encode);
  assert.equal(sortReads,2);
  assert.equal(resolve(s,'space',getSort,first,same,encode),first);
  assert.equal(sortReads,3);
  assert.throws(()=>resolve(s,'space',()=>{throw new Error('sort');},null,same,encode),/sort/);
  assert.throws(()=>resolve(s,'space',getSort,null,same,()=>{throw new Error('encoding');}),/encoding/);
  assert.throws(()=>resolve(s,'space',getSort,first,()=>{throw new Error('compare');},encode),/compare/);
});
