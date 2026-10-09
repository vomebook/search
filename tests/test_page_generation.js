const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const {test, run} = require("./test_harness");

for (const project of ["github-Search", "huggingface-Search"]) {
  test(project + " deep append touches only the new page and leaves retained snapshots independent", () => {
    const source = fs.readFileSync("../" + project + "/static/app.js", "utf8");
    const initial = Array.from({length:100000},(_,i)=>({File:String(i)}));
    const snapshot = initial.slice();
    const results = new Proxy(initial,{get(target,key,receiver){
      if (/^\d+$/.test(String(key))) throw Error("existing result reread during append");
      return Reflect.get(target,key,receiver);
    }});
    const context={STATE:{results,_pageCache:{},total:100500},searchPageMetadata:new WeakMap(),checkSearchPageAppend:()=>true};
    vm.createContext(context);
    vm.runInContext(source.match(/^function appendSearchResults\([^]*?^}/m)[0],context);
    context.page=Array.from({length:500},(_,i)=>({File:String(100000+i)}));
    vm.runInContext("appendSearchResults(201,page)",context);
    assert.strictEqual(context.STATE.results,results);
    assert.strictEqual(initial.length,100500);
    assert.strictEqual(initial[100499].File,"100499");
    assert.strictEqual(snapshot.length,100000);
    assert.strictEqual(snapshot[99999].File,"99999");
    assert.strictEqual(context.STATE.hasMore,false);
  });
  for (const cached of [false, true]) {
    test(project + (cached ? " deferred cache" : " foreground") + " append rejects updated generation before changing visible content", () => {
      const source = fs.readFileSync("../" + project + "/static/app.js", "utf8");
      const old = [{File:"old"}], next = [{File:"new"}];
      const metadata = new WeakMap([[old[0],{generation:"A",total:2}], [next[0],{generation:"B",total:2}]]);
      const context = {STATE:{results:old,total:2,_loadedPage:1,_pageCache:{2:next},_resultBackend:"api"},
        VSCROLL:{isDraggingThumb:true}, searchPageMetadata:metadata, searchResponseCache:new Map(),
        searchViewSnapshots:new Map(), getSearchViewKey:()=>"query", captureReaderReturnScroll:()=>({index:0,offset:12}),
        getResultStableId:r=>r.File, getReturnPositionTarget:()=>null, setReturnPositionTarget(){},
        rememberSearchPageMetadata(){}, tryRestoreSearchPosition(key,options){context.recovery={key,options};}};
      vm.createContext(context);
      for (const name of ["checkSearchPageAppend", "appendSearchResults", "deferSearchAppend", "applySearchPage"]) {
        vm.runInContext(source.match(new RegExp("^function " + name + "\\([^]*?^}", "m"))[0], context);
      }
      context.nextPage = {results:next,total:2,page:2,page_size:1,generation:"B"};
      assert.strictEqual(vm.runInContext(cached ? "appendSearchResults(2)" : "applySearchPage(nextPage,true)", context), false);
      assert.strictEqual(context.STATE.results, old);
      assert.strictEqual(context.STATE.total, 2);
      assert.strictEqual(context.STATE._loadedPage, 1);
      assert.strictEqual(context.recovery.options.position.anchorId, "old");
      assert.strictEqual(context.recovery.options.position.offset, 12);
      assert.strictEqual(context.STATE._deferredAppendWhileDragging, undefined);
      if (project === "github-Search") assert.strictEqual(context.recovery.options.backend,"api");
    });
  }
}
run("page-generation");
