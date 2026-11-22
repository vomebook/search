import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {installPrecachePaths, shellScriptPaths} from '../../support/shell_assets.mjs';

const modules = ['search/results/snapshots/domain/copy-budget.js', 'search/results/snapshots/application/store.js'];
test('shell order checks see executable scripts, not commented or inert tags', () => {
  const base = '/search/static/';
  const html = `<template><script src="static/app.js"></script></template>
    <!-- <script src="static/app.js"></script> -->
    <script type="application/json" src="static/ignored.js"></script>
    <script defer
      src='static/${modules[0]}?version=2'></script><script src="static/app.js"></script>`;
  assert.deepEqual(shellScriptPaths(html, base), [modules[0], 'app.js']);
  assert.deepEqual(shellScriptPaths(html + '<script src="static/app.js"></script>', base),
    [modules[0], 'app.js', 'app.js']);
});
test('snapshot modules are composed once across shell, worker and reader resources', async () => {
  const read = name => readFileSync(new URL('../../../' + name, import.meta.url), 'utf8');
  const html = read('static/index.html'), worker = read('static/sw.js');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  const staticBase = '/search/static/';
  const scripts = shellScriptPaths(html, staticBase);
  const bundled = shellScriptPaths(stripBundledScripts(html), staticBase);
  const precache = await installPrecachePaths(worker, resources, staticBase);
  assert.equal(scripts.filter(path => path === 'app.js').length, 1);
  for (const name of modules) {
    assert.equal(APP_DEPENDENCIES.filter(path => path === name).length, 1);
    assert.equal(scripts.filter(path => path === name).length, 1, name);
    assert.ok(scripts.indexOf(name) < scripts.indexOf('app.js'), name);
    assert.ok(!bundled.includes(name), name);
    assert.equal(precache.filter(path => path === name).length, 1, name);
    for (const site of ['github', 'hf']) assert.equal(resources.buildFiles(site).filter(path => path === name).length, 1);
  }
});
function fixture() {
  let id = 0, completed = 0, current = true;
  const timers = new Map(), frames = new Map();
  const context = vm.createContext({TextEncoder, performance:{now:()=>0},
    setTimeout(fn){timers.set(++id,fn);return id;}, clearTimeout(id){timers.delete(id);},
    requestAnimationFrame(fn){frames.set(++id,fn);return id;}, cancelAnimationFrame(id){frames.delete(id);}});
  for (const file of modules) vm.runInContext(readFileSync(new URL('../../../static/' + file, import.meta.url), 'utf8'), context);
  const store = context.VoiceOfMLResultSnapshots.create({cloneResult:context.VoiceOfMLSnapshotPolicy.cloneResult,
    measurementKey:()=>"layout",materialized(){},applyHeights(){},isCurrent:()=>current,completed(){completed++;}});
  const view = {key:'query',revision:1,results:Array.from({length:5000},(_,i)=>({File:String(i),Folder:['docs']})),
    total:5000,loadedPage:50,pageCache:{}};
  const geometry = {revision:0,measurementKey:'layout',estimatedHeight:100,heightCache:new Map()};
  const save = () => store.save(view,{index:4000,offset:11},geometry);
  const tick = queue => {const [key,fn] = queue.entries().next().value;queue.delete(key);fn();};
  return {store,view,geometry,save,timers,frames,tick,completed:()=>completed,retire:()=>{current=false;}};
}
test('clone prioritizes the neighborhood and cancellation never publishes partial results', () => {
  const f=fixture(), snapshot=f.save(), source=f.store.source(snapshot);
  const results=f.store.restoreResults(snapshot,'query',100,true,false);
  assert.equal(Object.keys(results).length,600);
  assert.ok(results[0] && results[4000] && results[4299]);assert.equal(100 in results,false);
  results[4000].Folder.push('changed');assert.deepEqual(Array.from(snapshot.results[4000].Folder),['docs']);
  f.view.results=results;f.view.revision++;
  assert.equal(f.save(),snapshot);assert.equal(f.store.source(snapshot),source);
  f.store.startClone();f.tick(f.frames);f.tick(f.timers);
  const count=Object.keys(results).length, late=[...f.timers.values()][0];
  f.store.cancelClone();late();
  assert.equal(f.store.cloneTask,null);assert.equal(f.completed(),0);
  assert.equal(Object.keys(results).length,count);assert.equal(f.save(),snapshot);
  assert.equal(Object.keys(snapshot.results).length,5000);
});
test('completed sparse clones preserve holes, release ownership and retain byte accounting', () => {
  const f=fixture();delete f.view.results[2500];
  f.view.window={generation:'g',pages:new Set([1,40]),count:4999};
  const snapshot=f.save(), results=f.store.restoreResults(snapshot,'query',100,true,false);
  f.store.startClone();f.tick(f.frames);
  while(f.timers.size) f.tick(f.timers);
  assert.equal(f.completed(),1);assert.equal(f.store.cloneTask,null);
  assert.equal(2500 in results,false);assert.equal(Object.keys(results).length,4999);
  assert.equal(f.store.budget.measure(results,true),f.store.source(snapshot).resultsBytes);
  f.view.results=results;f.view.revision++;
  assert.notEqual(f.save(),snapshot);
});
test('snapshot retention uses byte bounds and access order without changing source identity', () => {
  const f=fixture();f.view.results=[{File:'small'}];
  const first=f.save(), source=f.store.source(first);
  for(let i=0;i<19;i++){f.view.key=String(i);f.save();}
  f.view.key='query';assert.equal(f.save(),first);assert.equal(f.store.source(first),source);
  f.view.key='last';f.save();assert.equal(f.store.snapshots.size,20);
  assert.equal(f.store.snapshots.has('0'),false);assert.equal(f.store.snapshots.has('query'),true);
  f.store.put('oversize',{bytes:8*1024*1024+1});f.store.trim();
  assert.equal(f.store.snapshots.has('oversize'),false);assert.equal(f.store.snapshots.get('query'),first);
});

test('displayed ownership follows array identity and a monotonic revision, not query alone', () => {
  const {store,view} = fixture();
  store.publish(view,100);
  const initial = store.displayed;
  assert.equal(store.owns(view.key,view.results),true);
  store.publish(view,100);
  assert.equal(store.displayed.revision,initial.revision);
  view.results = view.results.slice();
  assert.equal(store.owns(view.key,view.results),false);
  store.publish(view,100);
  assert.ok(store.displayed.revision > initial.revision);
  store.clearDisplayed();
  store.publish({...view,loadedPage:0},100);
  assert.equal(store.displayed,null);
  store.publish(view,100);
  assert.ok(store.displayed.revision > initial.revision);
});

test('displayed capture retains protected snapshots and rejects synchronous same-key replacement', () => {
  const {store,view,geometry} = fixture();
  store.publish(view,100);
  const capture = {ready:true, protected:()=>false, position:()=>({index:10,offset:4}), geometry:()=>geometry};
  const saved = store.saveDisplayed(undefined,capture);
  const fail = () => assert.fail('capture must not execute');
  assert.equal(store.saveDisplayed(view.key,{...capture,protected:()=>true,position:fail}),saved);
  assert.equal(store.saveDisplayed('wrong-key',{...capture,position:fail}),null);
  assert.equal(store.saveDisplayed(view.key,{...capture,position:()=>{
    store.publish({...view,results:view.results.slice()},100);
    return {index:99,offset:1};
  },geometry:fail}),null);
  assert.equal(store.snapshots.get(view.key),saved);
  assert.equal(saved.scroll.index,10);
  assert.equal(store.changedSince(saved,view.key,0,1),false);
  store.publish({...view,window:{preview:true,total:view.total,count:1,pages:new Set()}},100);
  assert.equal(store.saveDisplayed(view.key,{...capture,protected:()=>true,position:fail}),null);
  assert.equal(store.snapshots.has(view.key),false);
});

test('restore selection discards invalid windows and prepares detached rows and page cache', () => {
  const {store,view,geometry} = fixture();
  view.results = [{File:'old',Folder:['one']}, , {File:'third'}];
  view.total = 1000;
  view.loadedPage = 2;
  view.pageCache = {2:[{File:'cached',Folder:['two']}]};
  view.window = {generation:'g',total:1000,pages:new Set([1]),count:2};
  store.publish(view,100);
  const saved = store.saveDisplayed(view.key,{ready:true,protected:()=>false,position:()=>null,geometry:()=>geometry});
  assert.equal(store.selectRestore(view.key).snapshot,saved);
  assert.equal(store.changedSince(saved,view.key,3,2),false);
  assert.equal(store.changedSince(saved,view.key,4,2),true);
  const restored = store.prepareRestore(saved,100,true,false);
  assert.notEqual(restored.results,saved.results);
  assert.equal(1 in restored.results,false);
  restored.results[0].Folder.push('changed');
  restored.pageCache[2][0].Folder.push('changed');
  assert.deepEqual(Array.from(saved.results[0].Folder),['one']);
  assert.deepEqual(Array.from(saved.pageCache[2][0].Folder),['two']);
  saved.window.invalid = true;
  assert.equal(store.selectRestore(view.key).invalid,saved);
  assert.equal(store.snapshots.has(view.key),false);
  store.put(view.key,{...saved,version:0,window:null});
  assert.equal(store.selectRestore(view.key).snapshot,null);
});
