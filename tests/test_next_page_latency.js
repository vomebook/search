const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
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
    pagingRetryAt:0, pagingFailures:0, positionRestore:null, readerOverlay:null, snapshotCloneTask:null,
    APPEND_REQUEST_TIMEOUT:5000, RECENT_SEARCH_PAGE_TTL:604800000,
    searchPageMetadata:new WeakMap([[first,{generation:"stable",total:801}]]),
    recentSearchPages:new Map(), searchResponseCache:new Map(),
    pendingSearchCacheWrites:new Map(), searchResponseCacheIdentities:new WeakMap(),
    searchCacheWriteFrame:0, searchCacheWriteTimer:null, SEARCH_CACHE_TTL:60000,
    searchPositionDB:{objectStoreNames:{contains:()=>true},transaction:()=>({objectStore:()=>({
      get(){const request = {}; reads.push(request); return request;}
    })})},
    setTimeout(fn, delay){const id = ++timerId; timers.set(id,{fn,at:clock + delay}); return id;},
    clearTimeout(id){timers.delete(id);},
    requestAnimationFrame(fn){frames.push(fn); return frames.length;},
    cancelAnimationFrame(id){frames[id-1]=()=>{};},
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
    "maybeLoadNextPage","scheduleVirtualRender","cloneSearchData","getCachedSearchResponse",
    "setCachedSearchResponse","cancelPendingSearchCacheWrites","cancelSearchPrefetch"]);
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
  function sparseFixture() {
    const f=fixture(source), c=f.context;
    c.scheduleVirtualRender=()=>{};
    c.resultWindowCurrent=window=>!window.controller.signal.aborted;
    c.fetchPositionPageWithRecovery=(query,page,signal)=>c.fetchSearchPage('', '', {page}, signal);
    install(source,c,['requestResultWindowPage']);
    const window={key:'query',query:{pageSize:100},total:801,generation:'stable',
      controller:new AbortController(),pending:new Map(),failures:new Map()};
    return {...f,window};
  }
  test(project+' sparse demand starts after 25 ms and rejects late disk completion',async()=>{
    const f=sparseFixture(), task=f.context.requestResultWindowPage(f.window,2,false);
    await f.advance(24);assert.strictEqual(f.calls.length,0);
    await f.advance(25);assert.strictEqual(f.calls[0].at,25);
    const data=f.data(2);f.calls[0].resolve(data);assert.strictEqual(await task,data);
    f.reads[0].result={...f.data(2),key:'query',savedAt:Date.now()};f.reads[0].onsuccess();
    assert.strictEqual(f.window.pending.size,0);
  });
  test(project+' sparse promoted demand releases disk immediately and retains one promise',async()=>{
    const f=sparseFixture(), task=f.context.requestResultWindowPage(f.window,2,true);
    await f.advance(10);
    assert.strictEqual(f.context.requestResultWindowPage(f.window,2,false),task);
    await f.flush();assert.strictEqual(f.calls[0].at,10);
    for(let i=0;i<10;i++) assert.strictEqual(f.context.requestResultWindowPage(f.window,2,false),task);
    assert.strictEqual(f.calls.length,1);f.calls[0].resolve(f.data(2));await task;
  });
  test(project+' sparse cancellation clears disk waits without starting transport',async()=>{
    const f=sparseFixture(), task=f.context.requestResultWindowPage(f.window,2,true);
    await f.advance(10);f.window.controller.abort();assert.strictEqual(await task,null);
    await f.advance(150);assert.strictEqual(f.calls.length,0);assert.strictEqual(f.window.pending.size,0);
  });
  test(project+' repeated sparse demand preserves a fast disk hit',async()=>{
    const f=sparseFixture(),task=f.context.requestResultWindowPage(f.window,2,false);
    for(let i=0;i<10;i++) assert.strictEqual(f.context.requestResultWindowPage(f.window,2,false),task);
    assert.strictEqual(task.diskWait.signal.aborted,false);
    await f.advance(10);f.reads[0].result={...f.data(2),key:'query',savedAt:Date.now()};f.reads[0].onsuccess();
    await task;assert.strictEqual(f.calls.length,0);
  });
  test(project+' sparse fast disk reuse and three pending slots remain bounded',async()=>{
    const f=sparseFixture(), tasks=[];
    for(let page=2;page<=4;page++) tasks.push(f.context.requestResultWindowPage(f.window,page,true));
    assert.strictEqual(await f.context.requestResultWindowPage(f.window,5,false),null);
    for(let i=0;i<3;i++) {
      const data={...f.data(i+2),key:'query',savedAt:Date.now()};
      f.reads[i].result=data;f.reads[i].onsuccess();
    }
    await Promise.all(tasks);assert.strictEqual(f.calls.length,0);
  });
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
  test(project + " later page promotion ends disk wait and late disk data cannot replace transport",async()=>{
    const f=fixture(source); f.start(); await f.advance(25);
    f.context.STATE._loadedPage=2;
    f.context.prefetchSearchPages("/api/search",{q:"query",page:1,page_size:100});
    await f.flush();
    assert.strictEqual(f.calls.find(c=>c.page===3).at,25);
    assert.strictEqual(f.calls.filter(c=>c.page===3).length,1);
    const network=f.data(3); f.calls.find(c=>c.page===3).resolve(network); await f.flush();
    f.reads[1].result={...f.data(3),key:"query",savedAt:Date.now()}; f.reads[1].onsuccess();
    await f.advance(150);
    assert.strictEqual(f.context.STATE._pageCache[3],network.results);
    assert(f.context.searchPrefetchAbortController.active.size<=2);
  });
  test(project + " shared page caches only once after a frame and stays readable before maintenance",async()=>{
    const f=fixture(source), c=f.context, data=f.data(2), original=c.searchResponseCache.set;
    let writes=0;
    c.searchResponseCache.set=function(...args){writes++;return original.apply(this,args);};
    c.setCachedSearchResponse("page",data,true);
    c.setCachedSearchResponse("page",c.cloneSearchData(data),true);
    assert.strictEqual(writes,0);
    assert.strictEqual(c.getCachedSearchResponse("page").results[0],data.results[0]);
    const length=data.results.length;
    data.results.push({File:"appended-live-only"});
    assert.strictEqual(c.getCachedSearchResponse("page").results.length,length);
    assert.strictEqual(f.frames.length,1);
    f.frames[0](); assert.strictEqual(writes,0);
    await f.advance(0); assert.strictEqual(writes,1);
    c.setCachedSearchResponse("page",c.getCachedSearchResponse("page"),true);
    assert.strictEqual(writes,1); assert.strictEqual(f.frames.length,1);
    const changed={...f.data(2),results:[data.results[0],...f.data(2).results.slice(1)],anchor_index:77};
    c.setCachedSearchResponse("page",changed,true);
    f.frames[1]();await f.advance(0);
    assert.strictEqual(writes,2);assert.strictEqual(c.getCachedSearchResponse("page").anchor_index,77);
  });
  test(project + " deferred cache writes are bounded and cancelled before and after the frame",async()=>{
    for (const afterFrame of [false,true]) {
      const f=fixture(source),c=f.context;
      for(let page=2;page<=6;page++) c.setCachedSearchResponse(String(page),f.data(page),true);
      assert.strictEqual(c.pendingSearchCacheWrites.size,3);
      if(afterFrame) f.frames[0]();
      c.cancelSearchPrefetch();
      f.frames[0](); await f.advance(0);
      assert.strictEqual(c.pendingSearchCacheWrites.size,0);assert.strictEqual(c.searchResponseCache.size,0);
    }
  });
  test(project + " stale deferred cache writes cannot cross query boundaries",async()=>{
    const f=fixture(source),c=f.context;
    c.setCachedSearchResponse("page",f.data(2),true);
    c.queryKey="different";assert.strictEqual(c.getCachedSearchResponse("page"),null);
    f.frames[0]();await f.advance(0);assert.strictEqual(c.searchResponseCache.size,0);
  });
  test(project + " offscreen appends preserve window but near-boundary appends render",()=>{
    for(const near of [false,true]) {
      const f=fixture(source),c=f.context;
      Object.assign(c,{positionRestore:null,resultWindow:null,rememberDisplayedSearchView(){},
        DOM:{resultsContainer:{clientHeight:600},resultsList:{querySelector:()=>({})}},
        ensureVirtualHeights(len){c.VSCROLL.heights.length=len;},ensureHeightTree(){},
        fenwickSum:(_,n)=>n*60,getVirtualOffset:n=>n*60,
        layoutResultScrollSegment(){},resultScrollOrigin:0});
      c.STATE.results.length=300;c.VSCROLL.heights=new Array(200);c.VSCROLL.heightTree=[];
      c.VSCROLL.estimatedHeight=60;c.VSCROLL.renderStart=near?180:0;c.VSCROLL.renderEnd=near?200:30;
      f.setScroll(near?11400:0);
      install(source,c,["refreshVirtualAfterAppend"]);
      c.refreshVirtualAfterAppend();
      assert.strictEqual(f.frames.length,near?1:0);
      assert.strictEqual(c.VSCROLL.renderEnd,near?-1:30);
      assert.strictEqual(c.VSCROLL.heights.length,300);
    }
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

run("next-page-latency");
