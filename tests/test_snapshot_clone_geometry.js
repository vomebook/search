const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const {test, run} = require('./test_harness');

function fixture(source) {
  const results = new Array(5000);
  const records = Array.from({length:5000}, (_, i) => ({Id:String(i), File:'book-'+i, Extension:'txt', Folder:['docs']}));
  const task = {results, snapshot:{results:records}};
  const c = {
    STATE:{results}, VSCROLL:{heights:new Array(5000), heightTree:[], heightsDirty:true,
      sparseHeights:true, heightBase:100, estimatedHeight:100, heightCache:new Map(),
      measuredRowKeys:[], templateCache:new Map(), renderStart:3990, renderEnd:4025},
    searchPageMetadata:new WeakMap(), snapshotCloneTask:task, selectedIndices:{},
    top:400011, refreshes:0, writes:0, scheduleVirtualRender:()=>{},
    getResultStableId:record=>record.Id, getHeightMeasurementKey:()=>'layout',
    getRecordLink:record=>'link-'+record.Id,
  };
  c.getResultScrollTop=()=>c.top;
  c.setResultScrollTop=value=>{c.top=value;c.writes++;};
  c.refreshVirtualAfterAppend=update=>{assert.strictEqual(update,false);c.refreshes++;c.ensureHeightTree();};
  vm.createContext(c);
  for(const name of ['cloneSearchResult','ensureHeightTree','fenwickAdd','fenwickSum',
    'getVirtualOffset','findVirtualIndex','materializeSnapshotRange','applySnapshotCloneHeights','getSelectedFiles']) {
    const match=source.match(new RegExp('^function '+name+'\\([^]*?^}', 'm'));
    assert(match,name);vm.runInContext(match[0],c);
  }
  const cache=(index,height,measurementKey='layout')=>c.VSCROLL.heightCache.set(String(index),{height,measurementKey});
  const oracleOffset=index=>Array.from({length:index},(_,i)=>c.VSCROLL.heights[i] ?? 100).reduce((a,b)=>a+b,0);
  return {c,task,cache,oracleOffset};
}

for(const project of ['github-Search','huggingface-Search']) {
  const source=fs.readFileSync(path.resolve(__dirname,'../../',project,'static/app.js'),'utf8');
  test(project+' cached prefix heights keep the same row and offset with one batch compensation',()=>{
    const {c,task,cache,oracleOffset}=fixture(source);
    c.ensureHeightTree();const tree=c.VSCROLL.heightTree;
    cache(150,132);cache(200,160);
    c.materializeSnapshotRange(task,150,201,true);
    assert.strictEqual(c.top,400011);assert.strictEqual(c.refreshes,0);
    assert.strictEqual(task.heightAnchor.index,4000);assert.strictEqual(task.heightAnchor.offset,11);
    c.applySnapshotCloneHeights(task);
    assert.strictEqual(c.VSCROLL.heightTree,tree);
    assert.strictEqual(c.top,oracleOffset(4000)+11);
    assert.strictEqual(c.findVirtualIndex(c.top),4000);
    assert.strictEqual(c.refreshes,1);assert.strictEqual(c.writes,1);
    c.applySnapshotCloneHeights(task);assert.strictEqual(c.refreshes,1);
    task.results[150].Folder.push('changed');assert.deepStrictEqual(task.snapshot.results[150].Folder,['docs']);
  });
  test(project+' heights after the anchor do not move it and shrinking anchor rows clamp the offset',()=>{
    const {c,task,cache,oracleOffset}=fixture(source);
    cache(4500,200);c.materializeSnapshotRange(task,4500,4501);
    assert.strictEqual(c.top,400011);assert.strictEqual(c.writes,0);
    c.top=400080;cache(4000,50);c.materializeSnapshotRange(task,4000,4001);
    assert.strictEqual(c.top,oracleOffset(4000)+49);assert.strictEqual(c.findVirtualIndex(c.top),4000);
  });
  test(project+' file actions materialize complete selections and compensate cached heights once',()=>{
    const {c,cache,oracleOffset}=fixture(source);
    cache(150,132);cache(200,160);c.selectedIndices={150:true,200:true};
    const files=c.getSelectedFiles();
    assert.deepStrictEqual(Array.from(files,f=>[f.filename,f.link]),[['book-150.txt','link-150'],['book-200.txt','link-200']]);
    assert.strictEqual(c.top,oracleOffset(4000)+11);assert.strictEqual(c.refreshes,1);assert.strictEqual(c.writes,1);
  });
  test(project+' old layouts and cancelled result owners cannot change active geometry',()=>{
    const {c,task,cache}=fixture(source);
    cache(150,132,'old-layout');c.materializeSnapshotRange(task,150,151);
    assert.strictEqual(c.refreshes,0);assert.strictEqual(c.VSCROLL.heights[150],undefined);
    cache(200,160);c.STATE.results=[];task.heightAnchor={index:4000,offset:11};
    c.materializeSnapshotRange(task,200,201);
    assert.strictEqual(c.refreshes,0);assert.strictEqual(c.writes,0);assert.strictEqual(c.VSCROLL.heights[200],undefined);
  });
}
run('search/snapshot-clone-geometry');
