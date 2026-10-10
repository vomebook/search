const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const {execFileSync} = require("child_process");
const {test, run} = require("./test_harness");

function install(source, context, names) {
  for (const name of names) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([^]*?^}", "m"));
    assert(match, "Missing function: " + name);
    vm.runInContext(match[0], context);
  }
}

function fixture(source) {
  let clock = 0, timerId = 0, scrollTop = 0;
  const timers = new Map(), calls = [], reads = [], appended = [], frames = [];
  const first = {File:"first"};
  const context = {
    STATE:{results:[first],total:801,pageSize:100,_loadedPage:1,_pageCache:{},hasMore:true,
      _resultBackend:"api",filterFolderSelfs:[],filterFolderSubtrees:[],useLocalMode:false},
    VSCROLL:{renderFrame:0,renderAfterScroll:false,isDraggingThumb:false},
    document:{hidden:false}, navigator:{onLine:true}, AbortController, DOMException,
    searchPrefetchAbortController:null, searchRequestId:1, pagingCheckTimer:null,
    pagingRetryAt:0, pagingFailures:0, positionRestore:null, readerOverlay:null,
    APPEND_REQUEST_TIMEOUT:5000, RECENT_SEARCH_PAGE_TTL:604800000,
    searchPageMetadata:new WeakMap([[first,{generation:"stable",total:801}]]),
    recentSearchPages:new Map(), searchResponseCache:new Map(),
    searchPositionDB:{objectStoreNames:{contains:()=>true},transaction:()=>({objectStore:()=>({
      get(){const request = {}; reads.push(request); return request;}
    })})},
    setTimeout(fn, delay){const id = ++timerId; timers.set(id,{fn,at:clock + delay}); return id;},
    clearTimeout(id){timers.delete(id);},
    requestAnimationFrame(fn){frames.push(fn); return frames.length;},
    getSearchViewKey:()=>context.queryKey || "query",
    stableSearchStringify:JSON.stringify,
    getCachedSearchResponse:()=>null,
    setCachedSearchResponse(){}, cacheRecentSearchPage(){},
    rememberSearchPageMetadata(data){context.searchPageMetadata.set(data.results[0],data);},
    validatePositionWindowPage(data, page, size, expected){
      assert.strictEqual(data.page,page); assert.strictEqual(data.page_size,size);
      if (expected) {assert.strictEqual(data.generation,expected.generation); assert.strictEqual(data.total,expected.total);}
    },
    fetchSearchPage(key, base, body, signal){
      return new Promise((resolve,reject)=>calls.push({page:body.page,at:clock,resolve,reject,signal}));
    },
    noteApiSuccess(){}, noteSearchApiFailure(){}, expireSearchRequests(){},
    getResultScrollTop:()=>scrollTop, getVirtualTotalHeight:()=>6000,
    isResultsAtBottom:()=>false,
    doSearch(){appended.push(context.STATE.page); context.STATE._loadedPage=context.STATE.page;},
    renderVisible(){clock += 8; return true;}, updateScrollTrack(){}, updateScrollThumb(){},
  };
  vm.createContext(context);
  install(source,context,["readRecentSearchPage","prefetchSearchPages","scheduleBottomLoad",
    "maybeLoadNextPage","scheduleVirtualRender"]);
  const flush = async () => {for (let i=0;i<16;i++) await Promise.resolve();};
  async function advance(to) {
    await flush();
    while (true) {
      const next = [...timers.entries()].filter(([,t])=>t.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) break;
      clock=next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    clock=to; await flush();
  }
  function data(page) {return {page,page_size:100,total:801,generation:"stable",
    results:Array.from({length:100},(_,i)=>({File:String((page-1)*100+i)}))};}
  return {context,calls,reads,appended,frames,advance,flush,data,
    setScroll(value){scrollTop=value;}, get clock(){return clock;},
    start(){context.prefetchSearchPages("/api/search",{q:"query",page:1,page_size:100});}};
}

for (const project of ["github-Search","huggingface-Search"]) {
  const root = path.resolve(__dirname,"../../",project);
  const source = fs.readFileSync(path.join(root,"static/app.js"),"utf8");
  test(project + " next-page disk wait is bounded without delaying farther cache reuse",async()=>{
    const f=fixture(source); f.start(); await f.advance(24); assert.strictEqual(f.calls.length,0);
    await f.advance(25); assert.deepStrictEqual(f.calls.map(c=>[c.page,c.at]),[[2,25]]);
    await f.advance(150); assert.deepStrictEqual(f.calls.map(c=>[c.page,c.at]),[[2,25],[3,150]]);
  });
  test(project + " memory-cached pages avoid transport",async()=>{
    const f=fixture(source);
    for (let page=2;page<=4;page++) f.context.recentSearchPages.set(JSON.stringify(["query",page]),{
      ...f.data(page),key:"query",savedAt:Date.now()});
    f.start(); await f.flush(); assert.strictEqual(f.calls.length,0);
    assert.deepStrictEqual(Object.keys(f.context.STATE._pageCache),["2","3","4"]);
  });
  test(project + " ready next page honors 5 percent without draining the buffer",async()=>{
    const f=fixture(source); f.context.searchPositionDB=null; f.start(); await f.flush();
    f.setScroll(299); f.calls[0].resolve(f.data(2)); await f.advance(0);
    assert.deepStrictEqual(f.appended,[]);
    f.setScroll(400); f.context.scheduleBottomLoad(0,2); await f.advance(0);
    assert.deepStrictEqual(f.appended,[2]);
    f.calls.find(c=>c.page===3).resolve(f.data(3)); await f.advance(0);
    assert.deepStrictEqual(f.appended,[2]);
    f.setScroll(450); f.context.scheduleBottomLoad(0,3); await f.advance(0);
    assert.deepStrictEqual(f.appended,[2,3]);
  });
  test(project + " later completion cannot replace the next-page timer",async()=>{
    const f=fixture(source); f.setScroll(400);
    f.context.scheduleBottomLoad(0,2); f.context.scheduleBottomLoad(0,3);
    await f.advance(0); assert.deepStrictEqual(f.appended,[2]);
  });
  test(project + " cancelled query ignores late disk and transport bodies",async()=>{
    const f=fixture(source); f.start(); await f.advance(150);
    f.context.searchPrefetchAbortController.abort(); f.context.queryKey="new-query";
    f.calls.forEach(c=>c.resolve(f.data(c.page)));
    f.reads.forEach((request,i)=>{request.result={...f.data(i+2),key:"query",savedAt:Date.now()};request.onsuccess();});
    await f.advance(151); assert.deepStrictEqual(Object.keys(f.context.STATE._pageCache),[]);
  });
  test(project + " scroll starts pagination before paint and coalesces events",()=>{
    const f=fixture(source); f.setScroll(400);
    f.context.scheduleVirtualRender(true); f.context.scheduleVirtualRender(true);
    assert.deepStrictEqual(f.appended,[2]); assert.strictEqual(f.frames.length,1);
    f.frames[0](); assert.deepStrictEqual(f.appended,[2]);
    f.context.VSCROLL.isDraggingThumb=true;
    f.context.scheduleVirtualRender(true); assert.deepStrictEqual(f.appended,[2]);
  });
  if (project === "github-Search") {
    for (const outcome of ["success","cancel","changed-generation","failure"]) {
      test("local lookahead joins demand and handles " + outcome,async()=>{
        const f=fixture(source), c=f.context;
        Object.assign(c,{resultWindow:null,apiAvailable:false,STATE:{...c.STATE,_resultBackend:"local",dataLoaded:true},
          getSearchApiBase:()=>"/api/search",buildCurrentSearchBody:()=>({}),buildLocalSearchParams:page=>({page,pageSize:100}),
          doSearchLocal:params=>new Promise((resolve,reject)=>f.calls.push({page:params.page,resolve,reject,signal:params.signal})),
          searchId:1,renderSearchPage(){},syncStateToURL(){},updateStatusBar(){},updatePagingStatus(){},
          finishPagingAttempt(){},console:{error(){}},
          applySearchPage(data){c.applied=data; c.STATE._loadedPage=data.page; c.STATE.hasMore=false; return true;}});
        install(source,c,["prefetchNextPage","prefetchLocalSearchPage","doSearchFallbackLocal"]);
        const task=c.prefetchNextPage(); c.prefetchNextPage(); assert.strictEqual(f.calls.length,1);
        c.doSearchFallbackLocal({page:2},true,1); assert.strictEqual(f.calls.length,1);
        if (outcome === "cancel") {c.searchId++; c.searchPrefetchAbortController.abort();}
        if (outcome === "failure") f.calls[0].reject(Error("held-worker-failure"));
        else f.calls[0].resolve({...f.data(2),generation:outcome === "changed-generation" ? "changed" : "stable"});
        await task.catch(()=>{}); await f.flush();
        if (outcome === "cancel" || outcome === "failure") assert.strictEqual(c.applied,undefined);
        else assert.strictEqual(c.applied.generation,outcome === "changed-generation" ? "changed" : "stable");
        if (outcome === "failure") {
          c.searchId=2; c.doSearchFallbackLocal({page:2},true,2);
          assert.strictEqual(f.calls.length,2);
          f.calls[1].resolve(f.data(2)); await f.flush();
          assert.strictEqual(c.applied.generation,"stable");
        }
        assert.strictEqual(c.STATE._resultBackend,"local");
      });
    }
  }
}

async function compare() {
  for (const project of ["github-Search","huggingface-Search"]) {
    const root=path.resolve(__dirname,"../../",project);
    const baseline=execFileSync("git",["-c","safe.directory="+root,"show",
      "refs/baselines/next-page-20261009:static/app.js"],{cwd:root,encoding:"utf8",maxBuffer:2*1024*1024});
    const current=fs.readFileSync(path.join(root,"static/app.js"),"utf8");
    const observations=[];
    for (const [version,source] of [["baseline",baseline],["current",current]]) {
      const f=fixture(source); f.start(); await f.advance(150);
      const render=fixture(source); render.setScroll(400); render.context.scheduleVirtualRender(true);
      const immediate=render.appended.length;
      if (!immediate) {await render.advance(16); render.frames[0]();}
      const ready=fixture(source); ready.setScroll(400); ready.context.scheduleBottomLoad(0,2); await ready.advance(0);
      observations.push({version,nextPageTransportStartMs:f.calls.find(c=>c.page===2).at,
        scrollRequestBeforeFrame:!!immediate,readyPageAppendsWithoutAnotherScroll:ready.appended.length});
    }
    console.log(JSON.stringify({project,fixture:"stalled IndexedDB; threshold crossed; not at bottom",observations}));
  }
}

if (process.argv.includes("--compare-baseline")) compare().catch(error=>{console.error(error);process.exitCode=1;});
else run("next-page-latency");
