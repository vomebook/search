const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const {test, run} = require("../../support/test_harness");
const {searchTestProjects} = require("../../support/search_test_projects");
const {installClassicSearchModules} = require("../../support/classic_search_modules");

function executionFixture(root, pages) {
  const calls = [], effects = [];
  const view = {searchId:1,intent:1,requestId:1,page:2,_loadedPage:1,loadedPage:1,_pendingPage:0,
    _resultBackend:"api",_initialActive:false,_deferredAppendWhileDragging:false,
    dataLoaded:true,useLocalMode:false,resultCount:1,apiAvailable:true,isLoading:true};
  const context = vm.createContext({console:{error(){},warn(){}},AbortController});
  installClassicSearchModules(root, context);
  const request = () => new Promise((resolve,reject)=>calls.push({resolve,reject}));
  const deps = {readView:()=>({...view}),update:patch=>Object.assign(view,patch),signal:()=>new AbortController().signal,
    setLocalMode:value=>{view.useLocalMode=value;effects.push(['mode',value]);},clearPrefetch:()=>effects.push('clear-prefetch'),
    pendingLocal:()=>false,loadLocal:()=>{effects.push('load-local');return request();},searchLocal:()=>{effects.push('local');return request();},
    searchAPI:()=>{effects.push('api');return request();},search:request,
    retry:()=>effects.push('retry'),applyPage:()=>{effects.push('apply');return true;},
    clearUnavailableResults:()=>effects.push('clear-results'),renderUnavailable:value=>effects.push(['unavailable',value]),
    renderPage:()=>effects.push('render'),visualLoading:()=>effects.push('visual'),prefetch:()=>effects.push('prefetch'),
    warmConnection:()=>effects.push('warm'),syncURL:()=>effects.push('url'),notify:()=>effects.push('toast'),
    updateStatus:()=>effects.push('status'),finishPaging:(ok,error)=>effects.push(['finish',ok,error?.message]),
    updatePaging:()=>effects.push('paging'),hideLoading:()=>effects.push('hide'),
    finishPresentation:()=>effects.push('presentation'),updateLoadInfo:()=>effects.push('load-info')};
  const service=context.VoiceOfMLSearchExecution.create(deps);
  return {view,calls,effects,deps,service,context,
    start(append=true,recovery=false){return pages ? service.execute({page:view.page},append,view.searchId,view.intent)
      : service.execute({page:view.page,page_size:1},append,recovery,view.requestId);},
    async flush(){for(let i=0;i<20;i++) await Promise.resolve();}};
}

for (const {name: project, root} of searchTestProjects()) {
  const pages = project === 'github-Search';
  for (const outcome of ['success','failure','abort']) {
    for (const identity of pages ? ['searchId','intent'] : ['requestId']) {
      test(project + ` stale ${outcome} cannot render or settle newer ${identity}`, async () => {
        const f=executionFixture(root,pages);f.start();
        f.view[identity]++;f.view._pendingPage=9;f.view.isLoading=true;f.view.resultsSkeletonActive=true;
        const effects=f.effects.length;
        if(outcome==='success') f.calls[0].resolve(pages ? true : {results:[{}],total:2,page:2});
        else f.calls[0].reject(Object.assign(Error('held failure'),{name:outcome==='abort'?'AbortError':'Error'}));
        await f.flush();
        assert.strictEqual(f.effects.length,effects);
        assert.strictEqual(f.view._pendingPage,9);assert.strictEqual(f.view.isLoading,true);
        assert.strictEqual(f.view.resultsSkeletonActive,true);
      });
    }
  }
  test(project + ' deferred append completion does not claim paging success', async () => {
    const f=executionFixture(root,pages);f.start();
    f.view._deferredAppendWhileDragging=true;f.deps.applyPage=()=>false;
    f.calls[0].resolve(pages ? true : {results:[{}],total:2,page:2});await f.flush();
    assert(!f.effects.includes('render'));assert(!f.effects.some(e=>Array.isArray(e)&&e[0]==='finish'));
    assert.strictEqual(f.view._pendingPage,0);assert.strictEqual(f.view.isLoading,false);
  });
  test(project + ' current abort rolls append back and skips failure recovery', async () => {
    const f=executionFixture(root,pages);f.start();f.calls[0].reject(Object.assign(Error('abort'),{name:'AbortError'}));
    await f.flush();assert.strictEqual(f.view.page,1);assert.strictEqual(f.view.isLoading,false);
    assert(!f.effects.includes('toast'));assert(!f.effects.some(e=>Array.isArray(e)&&e[0]==='finish'));
  });
  if(pages) {
    test(project + ' append backend and initial continuity override changed mode preferences', () => {
      const f=executionFixture(root,true), policy=f.context.VoiceOfMLSearchExecutionPolicy;
      for(const apiAvailable of [false,true]) for(const useLocalMode of [false,true]) {
        Object.assign(f.view,{apiAvailable,useLocalMode,_resultBackend:'local'});
        assert.strictEqual(policy.backend(f.view,true,null),'local');
        f.view._resultBackend='api';
        assert.strictEqual(policy.backend(f.view,true,'mixed'),apiAvailable?'api':'unavailable');
      }
      Object.assign(f.view,{apiAvailable:true,useLocalMode:true,_resultBackend:null,_initialActive:true,dataLoaded:false});
      assert.strictEqual(policy.backend(f.view,true,null),'api');
      assert.strictEqual(policy.backend(f.view,true,'mixed'),'local');
    });
    test(project + ' mixed Worker failure cannot escape to API; plain failure reentry keeps newer state', async () => {
      for(const mixed of [false,true]) {
        const f=executionFixture(root,true);f.view._resultBackend='local';f.view.useLocalMode=true;
        f.deps.retry=()=>{f.effects.push('retry');f.view.searchId++;f.view.isLoading=true;f.view._pendingPage=9;};
        f.service.execute({page:1,folderMatchMode:mixed?'mixed':null},false,1,1);
        f.calls[0].reject(Error('worker failed'));await f.flush();
        assert.strictEqual(f.view.dataLoaded,false);
        assert.strictEqual(f.effects.includes('retry'),!mixed);
        assert.strictEqual(f.view.isLoading,!mixed);
        if(!mixed) assert.strictEqual(f.view._pendingPage,9);
        else assert(f.effects.some(e=>Array.isArray(e)&&e[0]==='unavailable'&&!e[1]));
      }
    });
    test(project + ' API fallback reentry cannot be cleared by the preceding finally', async () => {
      const f=executionFixture(root,true);f.start(false);f.calls[0].reject(Error('API_TIMEOUT'));await f.flush();
      assert(f.effects.includes('load-local'));
      f.deps.retry=()=>{f.view.searchId++;f.view.intent++;f.view._pendingPage=9;f.view.isLoading=true;};
      f.calls[1].resolve(true);await f.flush();
      assert.strictEqual(f.view.useLocalMode,true);assert.strictEqual(f.view.isLoading,true);assert.strictEqual(f.view._pendingPage,9);
    });
    test(project + ' stale Worker success and failure cannot apply or settle replacement', async () => {
      for(const failure of [false,true]) {
        const f=executionFixture(root,true);f.view._resultBackend='local';f.start();f.view.searchId++;
        f.view._pendingPage=9;const effects=f.effects.length;
        if(failure) f.calls[0].reject(Error('worker failed'));else f.calls[0].resolve({results:[{}],total:2});
        await f.flush();assert.strictEqual(f.effects.length,effects);assert.strictEqual(f.view.isLoading,true);assert.strictEqual(f.view._pendingPage,9);
      }
    });
  } else {
    test(project + ' first-page recovery failure uses paging feedback without duplicate toast', async () => {
      const f=executionFixture(root,false);f.start(false,true);f.calls[0].reject(Error('offline'));await f.flush();
      assert.strictEqual(f.view.hasMore,true);assert(!f.effects.includes('toast'));
      assert(f.effects.some(e=>Array.isArray(e)&&e[0]==='finish'&&!e[1]&&e[2]==='offline'));
    });
  }
  function pagingFixture() {
    const context = vm.createContext({});
    for (const file of ["domain/paging-policy.js", "application/paging-controller.js", "presentation/paging-status.js"]) {
      vm.runInContext(fs.readFileSync(path.join(root, "static/search/results", file), "utf8"), context);
    }
    let now = 0, id = 0;
    const timers = new Map(), cancelled = [], appends = [];
    const view = {generation:1, loadedPage:1, page:1, resultCount:100, hasMore:true, loading:false,
      suspended:false, inactive:false, dragging:false, scrollTop:5400, loadedHeight:6000, viewportHeight:600};
    const deps = {policy:context.VoiceOfMLPagingPolicy, readView:()=>({...view}), expireRequests(){}, onState(){},
      clock:{now:()=>now, setTimeout(fn,delay){timers.set(++id,{fn,at:now+delay});return id;},
        clearTimeout(key){if(timers.has(key)) cancelled.push(timers.get(key).fn);timers.delete(key);}},
      append(page,top){appends.push(page);view.loadedPage=page;view.appendScrollTop=top;}};
    const controller = context.VoiceOfMLPagingController.create(deps);
    return {context,controller,deps,view,timers,cancelled,appends,
      advance(time){now=time;for(const [key,timer] of [...timers]) if(timer.at<=now){timers.delete(key);timer.fn();}}};
  }
  test(project + " paging waits 750ms, stops after two failures, and retries the missing page", () => {
    const f=pagingFixture(), c=f.controller;
    c.finish(false);f.advance(749);assert.deepStrictEqual(f.appends,[]);
    f.advance(750);assert.deepStrictEqual(f.appends,[2]);
    f.view.loadedPage=1;c.finish(false);f.advance(1500);
    c.maybeLoad(false,true);assert.deepStrictEqual(f.appends,[2]);
    assert.strictEqual(c.readRecovery().failures,2);
    c.retry();assert.deepStrictEqual(f.appends,[2,2]);
    c.finish(true);assert.strictEqual(c.readRecovery().retryAt,0);
    c.finish(false,true);assert.strictEqual(c.readRecovery().failures,2);assert.strictEqual(f.timers.size,0);
  });
  test(project + " paging respects all load guards and bottom tolerance", () => {
    for(const guard of ["suspended","inactive","dragging","loading"]){
      const f=pagingFixture();f.view[guard]=true;f.controller.maybeLoad(false,true);
      assert.deepStrictEqual(f.appends,[],guard);
    }
    const f=pagingFixture();f.view.hasMore=false;f.controller.retry();assert.deepStrictEqual(f.appends,[]);
    f.view.hasMore=true;f.view.scrollTop=5395;f.controller.maybeLoad(true);assert.deepStrictEqual(f.appends,[]);
    f.view.scrollTop=5396;f.controller.maybeLoad(true);assert.deepStrictEqual(f.appends,[2]);
    f.view.resultCount=0;assert.strictEqual(f.context.VoiceOfMLPagingPolicy.isAtBottom(f.view),false);
    f.view.resultCount=100;f.view.viewportHeight=0;assert.strictEqual(f.context.VoiceOfMLPagingPolicy.isAtBottom(f.view),false);
  });
  test(project + " touch recovery honors retry time and expiry completion schedules one recovery", () => {
    const f=pagingFixture();f.controller.finish(false);f.controller.finish(false);
    f.advance(749);f.controller.retryBottom();f.advance(749);assert.deepStrictEqual(f.appends,[]);
    f.advance(750);f.controller.retryBottom();f.advance(750);assert.deepStrictEqual(f.appends,[2]);
    const g=pagingFixture();let expired=false;
    g.deps.expireRequests=()=>{if(!expired){expired=true;g.controller.finish(false);}};
    g.controller.maybeLoad();assert.deepStrictEqual(g.appends,[]);assert.strictEqual(g.timers.size,1);
    g.advance(750);assert.deepStrictEqual(g.appends,[2]);
  });
  test(project + " cancelled callbacks and old generations cannot append or cancel replacement checks", () => {
    const f=pagingFixture();f.controller.schedule();f.controller.reset();f.controller.schedule();
    f.cancelled[0]();assert.strictEqual(f.timers.size,1);f.advance(0);assert.deepStrictEqual(f.appends,[2]);
    f.controller.schedule();f.view.generation++;f.advance(0);assert.deepStrictEqual(f.appends,[2]);
    f.controller.schedule();f.controller.dispose();for(const callback of f.cancelled) callback();
    f.controller.retry();assert.deepStrictEqual(f.appends,[2]);assert.strictEqual(f.timers.size,0);
  });
  test(project + " recovery projection is detached and synchronous callbacks cannot revive retired work", () => {
    const f=pagingFixture();f.deps.onState=state=>{state.failures=99;};
    f.controller.finish(false);assert.strictEqual(f.controller.readRecovery().failures,1);
    const projection=f.controller.readRecovery();projection.failures=0;
    assert.strictEqual(f.controller.readRecovery().failures,1);
    f.deps.onState=()=>f.controller.reset();f.controller.finish(false);assert.strictEqual(f.timers.size,0);
    for(const method of ["maybeLoad","schedule","finish","retryBottom","retry"]){
      const g=pagingFixture();g.deps.readView=()=>{g.controller.dispose();return {...g.view};};
      g.controller[method](false);g.advance(1000);assert.deepStrictEqual(g.appends,[],method);assert.strictEqual(g.timers.size,0,method);
    }
    const g=pagingFixture();g.deps.expireRequests=()=>g.controller.maybeLoad();
    g.controller.maybeLoad();assert.deepStrictEqual(g.appends,[2]);
    for(const action of [f=>f.controller.dispose(), f=>{f.view.generation++;}]){
      const h=pagingFixture();h.deps.onState=()=>action(h);h.controller.finish(false);
      h.advance(750);assert.deepStrictEqual(h.appends,[]);assert.strictEqual(h.timers.size,0);
    }
    const h=pagingFixture();h.deps.readView=()=>{h.controller.maybeLoad();return {...h.view};};
    h.controller.maybeLoad();assert.deepStrictEqual(h.appends,[2]);
  });
  test(project + " retry presentation preserves the site's hidden label and footer visibility", () => {
    const f=pagingFixture();let button=null, retry=null;
    const host={style:{display:"none"},appendChild(value){button=value;},ownerDocument:{
      getElementById:()=>button,createElement:()=>({setAttribute(){},addEventListener(type,fn){retry=fn;}})}};
    const revealHost=project === "huggingface-Search";
    const status=f.context.VoiceOfMLPagingStatus.create({getHost:()=>host,revealHost,retry:()=>f.controller.retry()});
    status.render(f.view,{failures:0,retryAt:0});assert.strictEqual(button.hidden,true);
    assert.strictEqual(button.textContent,revealHost?"":"加载失败，重试");assert.strictEqual(host.style.display,"none");
    status.render(f.view,{failures:2,retryAt:0});assert.strictEqual(button.hidden,false);
    assert.strictEqual(host.style.display,revealHost?"":"none");retry();assert.deepStrictEqual(f.appends,[2]);
    f.view.loading=true;f.view.page=3;status.render(f.view,{failures:2,retryAt:0});assert.strictEqual(button.disabled,true);
  });
  test(project + " deep append touches only the new page and leaves retained snapshots independent", () => {
    const source = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
    const initial = Array.from({length:100000},(_,i)=>({File:String(i)}));
    const snapshot = initial.slice();
    const results = new Proxy(initial,{get(target,key,receiver){
      if (/^\d+$/.test(String(key))) throw Error("existing result reread during append");
      return Reflect.get(target,key,receiver);
    }});
    const context={STATE:{results,_pageCache:{},total:100500},searchPageMetadata:new WeakMap(),
      checkSearchPageAppend:()=>true};
    vm.createContext(context);
    for (const file of ['domain/copy-budget.js','application/store.js'])
      vm.runInContext(fs.readFileSync(path.join(root,'static/search/results/snapshots',file),'utf8'),context);
    context.resultSnapshots=context.VoiceOfMLResultSnapshots.create({cloneResult:r=>r});
    vm.runInContext(source.match(/^function appendSearchResults\([^]*?^}/m)[0],context);
    vm.runInContext(source.match(/^function extendSearchSnapshotBudget\([^]*?^}/m)[0],context);
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
      const source = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
      const old = [{File:"old"}], next = [{File:"new"}];
      const metadata = new WeakMap([[old[0],{generation:"A",total:2}], [next[0],{generation:"B",total:2}]]);
      const context = {STATE:{results:old,total:2,_loadedPage:1,_pageCache:{2:next},_resultBackend:"api"},
        VSCROLL:{isDraggingThumb:true}, searchPageMetadata:metadata, searchResponseCache:new Map(),
        resultSnapshots:{remove(){}}, getSearchViewKey:()=>"query", captureReaderReturnScroll:()=>({index:0,offset:12}),
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
