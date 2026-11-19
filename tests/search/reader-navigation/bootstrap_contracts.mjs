import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { APP_DEPENDENCIES, stripBundledScripts } from '../../../scripts/build/compose_app.mjs';

const current = fs.readFileSync('static/app.js', 'utf8');
const source = process.env.BOOTSTRAP_BASELINE_SOURCE ? fs.readFileSync(process.env.BOOTSTRAP_BASELINE_SOURCE, 'utf8') : current;
const pages = current.includes('appliedRouteHash');
const modules = ['search/bootstrap/domain/initial-payload.js', 'search/bootstrap/application/controller.js'];
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const events = [], flights = [];
  const state = {page:1,query:'',sort:'relevance',searchFolders:true,exact:true,
    filterRepos:[],filterExtensions:[],filterFolders:[],filterFolderSelfs:[],filterFolderSubtrees:[],
    filterMinSize:null,filterMaxSize:null,mode:'repo',repo:'A /中',repoFull:'VoiceOfML/A /中',pageSize:50,results:[]};
  const location = {hash:'#/A'};
  let text = null;
  const c = vm.createContext({STATE:state,DOM:{sortSelect:{value:'relevance'},resultsLoading:{style:{}},resultsContainer:{scrollTop:900},
    resultsList:{innerHTML:'old',classList:{remove:x=>events.push(['remove',x])}},emptyState:{style:{}}},
    window:{location},appliedRouteHash:location.hash,readerHost:{overlay:null},INITIAL_BASE_URL:'/initial',
    embeddedInitialPayload:null, embeddedInitialAcquiredAt:Date.now(), SEARCH_CACHE_TTL:480000,
    cloneSearchData:data=>({...data,results:data.results.slice()}), getCachedSearchResponse:()=>null, searchResponseStore:{identities:new WeakMap()},
    searchIntentId:0,searchBootstrap:undefined,initialPayloadCache:new Map(),searchPageMetadata:new WeakMap(),
    document:{getElementById:()=>text === null ? null : {textContent:text}},
    getSearchViewKey:()=>JSON.stringify([state.mode,state.repo,state.query,state.page,state.filterExtensions]),
    cancelActiveSearch:()=>{events.push(['cancel']);return true;},resetPagingRecovery:()=>events.push(['recovery']),
    setSearchVisualLoading:v=>events.push(['loading',v]),getCurrentSearchCacheKey:()=> 'response',
    setCachedSearchResponse:(key,data)=>events.push(['cache',key,plain(data)]),
    resetVirtualScrollState:()=>events.push(['virtual']),clearResultsSkeleton:()=>events.push(['skeleton']),
    renderResults:()=>events.push(['render']),updateStatusBar:()=>events.push(['status']),updateLoadInfo:()=>events.push(['info']),
    syncStateToURL:value=>events.push(['sync',value]),persistSearchSession:()=>events.push(['persist']),
    prefetchNextPage:()=>events.push(['prefetch']),scheduleBackgroundLocalDataLoad:()=>events.push(['local']),
    doSearch:()=>events.push(['search']),fetchJsonWithTimeout:(url,timeout)=>new Promise((resolve,reject)=>flights.push({url,timeout,resolve,reject})),
  });
  for (const file of modules) vm.runInContext(fs.readFileSync('static/'+file,'utf8'),c);
  for(const name of ['readInitialSearchView','getSearchBootstrap','canUseInitialSearchPayload','readInitialSearchPayload',
    'getInitialPayloadUrl','applyInitialSearchPayload','commitInitialSearchPage','renderInitialSearchPage',
    'tryInitialSearchPayload','searchWithInitialFallbackFresh']) {
    const match=source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^}', 'm'));
    if(match) vm.runInContext(match[0],c);
  }
  const payload = (name='first') => ({repo:state.repoFull,total:2,results:[{File:name}]});
  return {c,state,events,flights,location,payload,inline(value){text=value;try{c.embeddedInitialPayload=JSON.parse(value);}catch{c.embeddedInitialPayload=null;}}};
}

test('bootstrap registration covers source, composed and offline entry points and strict projects',()=>{
  const html=fs.readFileSync('static/index.html','utf8'), c=vm.createContext({});
  vm.runInContext(fs.readFileSync('static/reader-resources.js','utf8'),c);
  for(const file of modules) {
    assert.ok(html.includes(file));assert.ok(html.indexOf(file)<html.indexOf('static/app.js'));
    assert.ok(APP_DEPENDENCIES.includes(file));assert.ok(!stripBundledScripts(html).includes(file));
    assert.ok(fs.readFileSync('static/sw.js','utf8').includes('/static/'+file));
    for(const site of ['github','huggingface']) assert.ok(c.VoiceOfMLReaderResources.buildFiles(site).includes(file));
    for(const config of ['check','strict','search-exact']) assert.ok(fs.readFileSync('config/types/jsconfig.'+config+'.json','utf8').includes(file));
    assert.doesNotMatch(fs.readFileSync('static/'+file,'utf8'),/\bSTATE\b|\bDOM\b|\bVSCROLL\b|new Proxy/);
  }
});

test('bootstrap eligibility uses actual page, every initial filter and site sort source',()=>{
  const changes={page:2,query:'x',searchFolders:false,exact:false,filterRepos:['r'],filterExtensions:['txt'],
    filterFolders:['a'],filterFolderSelfs:[''],filterFolderSubtrees:['a'],filterMinSize:0,filterMaxSize:0};
  for(const [key,value] of Object.entries(changes)) {const f=fixture();assert.equal(f.c.canUseInitialSearchPayload(),true);f.state[key]=value;assert.equal(f.c.canUseInitialSearchPayload(),false,key);}
  const f=fixture();f.state.page=0;assert.equal(f.c.canUseInitialSearchPayload(),true);
  f.state.browserPath='unrelated';assert.equal(f.c.canUseInitialSearchPayload(),true);
  if(pages) f.state.sort='name';else f.c.DOM.sortSelect.value='name';
  assert.equal(f.c.canUseInitialSearchPayload(),false);
  assert.equal(f.c.getInitialPayloadUrl(),(pages?'/initial':'/data/initial')+'/repos/A%20%2F%E4%B8%AD.json');
  f.state.mode='global';assert.equal(f.c.getInitialPayloadUrl(),(pages?'/initial':'/data/initial')+'/global.json');
});

test('bootstrap validates payload and mode before cancellation; cancellation reentry prevents commit',()=>{
  for(const data of [null,{}, {results:[],repo:'wrong'}]) {const f=fixture();assert.equal(f.c.applyInitialSearchPayload(data),false);assert.deepEqual(f.events,[]);}
  const f=fixture();f.state.mode='global';assert.equal(f.c.applyInitialSearchPayload(f.payload()),false);
  f.c.cancelActiveSearch=()=>{f.c.searchIntentId++;return true;};
  assert.equal(f.c.applyInitialSearchPayload({results:[],mode:'global'}),false);assert.equal(f.state.total,undefined);
});

test('bootstrap applies copied results, exact effect order and site metadata/route policy',()=>{
  for(const generation of [undefined,'','generation']) {
    const f=fixture(), data={...f.payload(),generation};
    assert.equal(f.c.applyInitialSearchPayload(data),true);assert.notEqual(f.state.results,data.results);
    assert.equal(f.state.results[0],data.results[0]);assert.equal(f.state.hasMore,true);
    assert.deepEqual(f.events.map(e=>e[0]),pages?['cancel','recovery','loading','cache','virtual','skeleton','render','status','info','sync','prefetch','local']
      :['cancel','recovery','remove','loading','cache','virtual','skeleton','render','status','info','sync','prefetch']);
    assert.equal(f.events.find(e=>e[0]==='sync')[1],pages?undefined:true);
    assert.equal(f.c.searchPageMetadata.has(data.results[0]),pages && !generation);
  }
  if(pages) for(const overlay of [null,{}]) {
    const f=fixture();f.location.hash='#/new';f.c.readerHost.overlay=overlay;
    f.c.applyInitialSearchPayload(f.payload());assert.equal(f.events.some(e=>e[0]==='sync'),false);
    assert.equal(f.events.some(e=>e[0]==='persist'),!overlay);
  }
});

test('bootstrap stale completion never writes cache, applies or falls back, including same-key new intent',async()=>{
  const f=fixture(), old=f.c.searchWithInitialFallbackFresh();
  const newer=f.c.searchWithInitialFallbackFresh();
  assert.equal(f.flights.length,2);assert.equal(f.flights[0].timeout,6000);
  f.flights[1].resolve(f.payload('new'));assert.equal(await newer,pages?true:undefined);
  f.flights[0].resolve(f.payload('old'));assert.equal(await old,pages?false:undefined);
  assert.equal(f.c.initialPayloadCache.get(f.flights[0].url).data.results[0].File,'new');
  assert.equal(f.state.results[0].File,'new');assert.equal(f.events.some(e=>e[0]==='search'),false);
  for(const change of [f=>f.state.query='new',f=>f.state.repo='B',f=>f.state.mode='global']) {
    const g=fixture(), pending=g.c.searchWithInitialFallbackFresh();change(g);g.flights[0].reject(new Error('late'));
    await pending;assert.equal(g.events.length,0);assert.equal(g.c.initialPayloadCache.size,0);
  }
});

test('bootstrap API fallback, cache hit and direct host hooks preserve site completion values',async()=>{
  const f=fixture();f.state.page=2;assert.equal(await f.c.searchWithInitialFallbackFresh(),pages?false:undefined);
  assert.deepEqual(f.events,[['search']]);
  const g=fixture();g.c.initialPayloadCache.set(g.c.getInitialPayloadUrl(),{data:g.payload(),time:Date.now()});
  assert.equal(await g.c.searchWithInitialFallbackFresh(),pages?true:undefined);assert.equal(g.flights.length,0);
  const h=fixture();h.c.canUseInitialSearchPayload=()=>false;
  assert.equal(await h.c.searchWithInitialFallbackFresh(),pages?false:undefined);assert.deepEqual(h.events,[['search']]);
  const j=fixture();j.c.getInitialPayloadUrl=()=>'/hook';j.c.applyInitialSearchPayload=()=>true;
  const pending=j.c.searchWithInitialFallbackFresh();
  if(!pages) {assert.equal(await pending,undefined);assert.equal(j.flights.length,0);}
  else {assert.equal(j.flights[0].url,'/hook');j.flights[0].resolve(j.payload());assert.equal(await pending,true);
    j.c.tryInitialSearchPayload=async()=>false;assert.equal(await j.c.searchWithInitialFallbackFresh(),false);assert.deepEqual(j.events,[['search']]);}
  const k=fixture(), failed=k.c.searchWithInitialFallbackFresh();k.flights[0].resolve(null);
  assert.equal(await failed,pages?false:undefined);assert.deepEqual(k.events,[['search']]);
});

test('fresh response wins over initial payload and cache hits do not renew acquisition time', async()=>{
  const f=fixture(), cached=f.payload('fresh');
  f.c.getCachedSearchResponse=()=>cached;
  f.c.searchResponseStore.identities.set(cached, {});
  f.c.initialPayloadCache.set(f.c.getInitialPayloadUrl(), {data:f.payload('stale'), time:1});
  f.inline(JSON.stringify(f.payload('inline')));
  await f.c.searchWithInitialFallbackFresh();
  assert.equal(f.state.results[0].File, 'fresh');
  assert.equal(f.flights.length, 0);
  assert.equal(f.events.some(event=>event[0]==='cache'), false);
  assert.equal(f.c.initialPayloadCache.size, 0);
  if (!pages) assert.equal(f.c.embeddedInitialPayload, null);
  const g=fixture();
  g.c.initialPayloadCache.set(g.c.getInitialPayloadUrl(), {data:g.payload(), time:123});
  let timestamp;
  g.c.setCachedSearchResponse=(_key,_page,_defer,acquiredAt)=>{timestamp=acquiredAt;};
  await g.c.searchWithInitialFallbackFresh();
  assert.equal(timestamp,123);
  if (!pages) {
    const h=fixture();h.inline(JSON.stringify(h.payload()));
    h.c.embeddedInitialAcquiredAt=Date.now()-h.c.SEARCH_CACHE_TTL;
    assert.equal(h.c.readInitialSearchPayload(),null);
  }
});

test('HF inline parsing and precedence preserve invalid JSON, wrong repo and uncached success',async()=>{
  if(pages) return;
  for(const text of [null,'','{','null','false','0']) {const f=fixture();f.inline(text);assert.equal(f.c.readInitialSearchPayload(),text==='false'?false:text==='0'?0:null);}
  const f=fixture();f.inline(JSON.stringify(f.payload('inline')));
  assert.equal(await f.c.searchWithInitialFallbackFresh(),undefined);assert.equal(f.flights.length,0);assert.equal(f.c.initialPayloadCache.size,0);
  assert.equal(f.state.results[0].File,'inline');
  const g=fixture();g.inline(JSON.stringify({results:[],repo:'other'}));const pending=g.c.searchWithInitialFallbackFresh();
  assert.equal(g.flights.length,1);g.flights[0].resolve(g.payload());await pending;
  const h=fixture();h.inline(JSON.stringify(h.payload()));h.c.readInitialSearchPayload=()=>null;
  const hook=h.c.searchWithInitialFallbackFresh();assert.equal(h.flights.length,1);h.flights[0].resolve(null);await hook;
  assert.deepEqual(h.events,[['search']]);
});
