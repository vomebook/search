import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { APP_DEPENDENCIES, stripBundledScripts } from '../../../scripts/build/compose_app.mjs';

const current = fs.readFileSync('static/app.js', 'utf8');
// The same literal contracts can also run against the exact pre-extraction host.
const source = process.env.ROUTING_BASELINE_SOURCE ? fs.readFileSync(process.env.ROUTING_BASELINE_SOURCE, 'utf8') : current;
const pages = current.includes('appliedRouteHash');
const modules = ['search/routing/domain/route.js', 'search/routing/application/router.js'];
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(route = '', overrides = {}) {
  const events = [];
  const location = new URL('https://example.test' + (pages ? '/search/#/' : '/') + route);
  const state = {mode:'repo',repo:'Test',repoFull:'VoiceOfML/Test',browserPath:'old',query:'hello +中',sort:'name',
    filterRepos:['VoiceOfML/A','VoiceOfML/B'],filterExtensions:['txt','epub'],filterFolderSelfs:['','a+b','a+b'],filterFolderSubtrees:['树/叶'],filterFolders:[],
    filterMinSize:1024,filterMaxSize:0,searchFolders:false,exact:false,useLocalMode:false,recordHistory:false,useMirrorLinks:false,
    leftSidebarOpen:false,rightSidebarOpen:true,isMobile:false,page:4,results:[{}],total:9,...overrides};
  const classes = new Set(['expanded-wide']);
  const dom = {sortSelect:{value:'name'},leftSidebar:{classList:{contains:value=>classes.has(value),toggle(value,on){if(on) classes.add(value);else classes.delete(value);}}}};
  for (const name of ['filterMinSize','filterMinUnit','filterMaxSize','filterMaxUnit','searchFoldersToggle','exactSearchToggle','localModeToggle','historyToggle','mirrorLinksToggle']) dom[name]={};
  const history = {state:{entry:7},replaceState(data,unused,url){events.push(['replace',data,url]);location.href=new URL(url,location).href;},
    pushState(data,unused,url){events.push(['push',data,url]);location.href=new URL(url,location).href;}};
  const c = vm.createContext({URLSearchParams,window:{location},location,history,STATE:state,DOM:dom,readerHost:{overlay:null},
    routeInitialized:false,appliedRouteHash:location.hash,appliedSearchRoute:location.pathname+location.search,routeNavigation:undefined,
    searchComposing:false,initialSearchDraft:false,routeRenderId:2,searchId:10,folderContentsCache:{clear(){}},API:{},
    fmtSizeUrl:value=>value===1024?'1KB':String(value),parseSizeStr:value=>value==='1KB'?1024:Number(value),bytesToDisplay:value=>({value:String(value),unit:'B'}),
    mergeFolderFilters:(a,b)=>[...new Set([...a,...b])],showToast:text=>events.push(['toast',text]),
    setSearchInputValue:value=>events.push(['input',value]),loadStoredExtensionFilters:()=>{events.push(['loadExt']);return ['pdf'];},
    saveStoredExtensionFilters:()=>events.push(['saveExt',plain(state)]),setExactSearchSectionVisible(){},
    updateSidebarVisibility(){},updateSidebarHeader(){},updateRandomTxtVisibility(){},
    setSidebarExpanded(value){dom.leftSidebar.classList.toggle('expanded-wide',value);},
    getSearchViewKey:()=>JSON.stringify([state.mode,state.repo,state.query,state.filterExtensions,state.filterFolderSelfs,state.filterFolderSubtrees]),
    saveSearchViewSnapshot:()=>events.push(['snapshot',state.query]),prepareRouteTransitionResults(){},
    searchInputController:{invalidateVisit:()=>events.push(['intent'])},cancelPendingSearchControls:()=>events.push(['controls']),
    readerReturnPosition:{invalidate:()=>events.push(['reader'])},cancelActiveSearch:()=>{events.push(['cancel']);return true;},
    cancelPositionRestore:()=>events.push(['position']),renderBrowser:(path,id)=>events.push(['browser',path,id]),
    retainFilterRenderingForRoute:id=>events.push(['retain',id]),searchWithInitialFallback:()=>events.push(['search']),
    renderSidebarAndFiltersDeferred:id=>events.push(['filters',id]),renderSidebar:id=>events.push(['sidebar',id]),renderFilters:id=>events.push(['filters',id]),
    persistSearchSession:()=>events.push(['persist']),
  });
  for (const file of modules) vm.runInContext(fs.readFileSync('static/'+file,'utf8'),c);
  for (const name of ['normalizeSearchSort','buildSearchURLParams','readRouteState','getRouteNavigation','syncStateToURL','syncURLToState']) {
    const match=source.match(new RegExp('^function '+name+'\\([^]*?^}', 'm'));
    // syncStateToURL is intentionally a one-line host adapter after extraction.
    const line=source.match(new RegExp('^function '+name+'\\([^\\n]*\\}$','m'));
    if(line || match) vm.runInContext((line || match)[0],c);
  }
  const router=source.match(/^const ROUTER = \{[^]*?^};/m);
  assert.ok(router);vm.runInContext(router[0]+'\nglobalThis.router=ROUTER;',c);
  c.router.updateUI=()=>events.push(['ui']);c.router.onModeChanged=()=>events.push(['mode']);
  return {c,state,dom,events,location,classes};
}

test('routing modules are in HTML, composition, resources, service worker and strict projects',()=>{
  const html=fs.readFileSync('static/index.html','utf8'),c=vm.createContext({});
  vm.runInContext(fs.readFileSync('static/reader-resources.js','utf8'),c);
  for(const path of modules){
    assert.ok(APP_DEPENDENCIES.includes(path));assert.ok(html.indexOf(path)<html.indexOf('static/app.js'));
    assert.ok(html.includes(path));assert.ok(!stripBundledScripts(html).includes(path));
    assert.ok(fs.readFileSync('static/sw.js','utf8').includes('/static/'+path));
    for(const site of ['github','huggingface']) assert.ok(c.VoiceOfMLReaderResources.buildFiles(site).includes(path));
    for(const config of ['check','strict','search-exact']) assert.ok(fs.readFileSync('config/types/jsconfig.'+config+'.json','utf8').includes(path));
    assert.doesNotMatch(fs.readFileSync('static/'+path,'utf8'),/\bSTATE\b|\bVSCROLL\b|\bDOM\b|new Proxy/);
  }
});

test('literal URL serialization preserves site ordering, encoding, size and navigation query policy',()=>{
  const f=fixture();
  const flags='search_folders=false&exact=0&'+(pages?'local=0&':'')+'history=0&mirror=0&sidebar=0&filters=1&wide=1';
  const params=pages?'q=hello+%2B%E4%B8%AD&ext=txt%2Cepub&sort=name&min_size=1024&max_size=0&'+flags
    :'q=hello+%2B%E4%B8%AD&min_size=1KB&max_size=0&ext=txt%2Cepub&history=0&mirror=0&sort=name&search_folders=false&exact=0&sidebar=0&filters=1&wide=1';
  assert.equal(f.c.buildSearchURLParams().toString(),params);
  f.c.router.navigate('repo','Test','a b/中');
  const nav=pages?'ext=txt%2Cepub&sort=name&min_size=1KB&max_size=0&'+flags:params;
  const suffix='&folder_self=&folder_self=a%2Bb&folder_self=a%2Bb&folder_subtree=%E6%A0%91%2F%E5%8F%B6&path=a+b%2F%E4%B8%AD';
  // HF navigate applies immediately; observe the actual pushed URL before application effects.
  assert.equal(pages?f.location.hash:f.events.find(e=>e[0]==='push')[2],(pages?'#/Test?':'/Test?')+nav+suffix);
  assert.equal(f.events.filter(e=>e[0]==='persist').length,pages?0:1);
});

test('navigate preserves raw repo segments and undefined versus empty folder semantics',()=>{
  for(const folder of [undefined,'','next']){
    const f=fixture();f.c.router.apply=()=>f.events.push(['apply']);
    f.c.router.navigate('repo','A%2FB',folder);
    const raw=pages?f.location.hash:f.events.find(e=>e[0]==='push')[2];
    assert.ok(raw.startsWith((pages?'#/':'/')+'A%2FB?'));
    const params=new URLSearchParams(raw.split('?')[1]);
    assert.equal(params.get('path'),folder===undefined?'old':folder || null);
    assert.equal(params.has('folder_self'),false);
    assert.deepEqual(f.events.map(e=>e[0]),pages?[]:['push','apply']);
  }
  const f=fixture();f.c.router.apply=()=>{};f.c.router.navigate('global');
  assert.equal(f.state.browserPath,pages?'':'old');
  assert.equal(f.events.some(e=>e[0]==='persist'),false);
});

test('parse and projection retain duplicate, empty, legacy and first/last parameter rules',()=>{
  const query='?q=first&q=last+%2B&repo=A&repo=Org%2FB&repo=&ext=pdf&ext=&sort=size&sort=unknown&folder=legacy&folder_self=&folder_self=x&folder_subtree=&folder_subtree=y&exact=0&exact=&local=0&history=0&mirror=0&search_folders=false&sidebar=0&filters=1&wide=1';
  const f=fixture('Test'+query,{mode:'repo',repo:'Test'});
  const parsed=plain(f.c.router.parse());assert.equal(parsed.repo,'Test');
  if(pages) assert.deepEqual(parsed.params.folder,['legacy']);
  f.c.router.apply();
  assert.equal(f.state.query,pages?'last +':'first');
  assert.deepEqual(plain(f.state.filterRepos),pages?['VoiceOfML/A','Org/B','VoiceOfML/']:['VoiceOfML/A','VoiceOfML/Org/B','VoiceOfML/']);
  assert.deepEqual(plain(f.state.filterExtensions),pages?[]:['pdf']);
  assert.equal(pages?f.state.sort:f.dom.sortSelect.value,pages?'relevance':'size');
  assert.deepEqual(plain(f.state.filterFolderSelfs),['','x']);
  assert.deepEqual(plain(f.state.filterFolderSubtrees),pages?['','y']:['y']);
  assert.equal(f.state.exact,pages);assert.equal(f.state.searchFolders,false);
  assert.equal(f.state.recordHistory,false);assert.equal(f.state.useMirrorLinks,false);
  assert.equal(f.state.leftSidebarOpen,false);assert.equal(f.state.rightSidebarOpen,true);
  if(pages) assert.equal(f.state.useLocalMode,false);
  assert.equal(f.classes.has('expanded-wide'),true);
});

test('initial-only saved extensions, Unicode limit, IME draft and default flags survive host commits',()=>{
  const f=fixture('Test?q='+encodeURIComponent('😀'.repeat(257)),{mode:'repo',repo:'Test'});
  f.c.searchComposing=true;f.c.router.apply();
  assert.equal(Array.from(f.state.query).length,256);assert.equal(f.state.query,'😀'.repeat(256));
  assert.deepEqual(plain(f.state.filterExtensions),['pdf']);
  assert.equal(f.events.some(e=>e[0]==='input'),false);assert.equal(f.events.filter(e=>e[0]==='loadExt').length,1);
  assert.equal(f.events.filter(e=>e[0]==='saveExt').length,0);
  for(const key of ['searchFolders','exact','recordHistory','useMirrorLinks','leftSidebarOpen']) assert.equal(f.state[key],true);
  assert.equal(f.state.rightSidebarOpen,false);
  f.c.router.apply();assert.deepEqual(plain(f.state.filterExtensions),[]);
  assert.equal(f.events.filter(e=>e[0]==='saveExt').length,1);
  const saved=f.events.find(e=>e[0]==='saveExt')[1];assert.equal(saved.query,'😀'.repeat(256));
});

test('same-view path-only navigation retains active work and geometry; changed views respect cancel reentry',()=>{
  const f=fixture('Test?q=hello&ext=txt',{mode:'repo',repo:'Test'});f.c.router.apply();f.events.length=0;
  f.state.page=7;
  if(pages) f.location.hash+='&path=next';else f.location.search+='&path=next';
  f.c.router.apply();
  for(const forbidden of ['intent','controls','reader','cancel','position','search']) assert.equal(f.events.some(e=>e[0]===forbidden),false,forbidden);
  assert.equal(f.state.page,7);assert.ok(f.events.some(e=>e[0]==='browser'));assert.ok(f.events.some(e=>e[0]==='retain'));
  assert.equal(f.events.at(-1)[0],'persist');
  f.events.length=0;f.c.router.apply(true);
  assert.equal(f.events.some(e=>e[0]==='position'),false);assert.ok(f.events.some(e=>e[0]==='retain'));
  for(const edge of ['cancel','position']){
    f.events.length=0;if(pages) f.location.hash+='&q=changed';else f.location.search='?q=changed';
    f.c.cancelActiveSearch=()=>{f.events.push(['cancel']);return edge!=='cancel';};
    f.c.cancelPositionRestore=()=>{f.events.push(['position']);f.c.searchId++;};
    f.c.router.apply();assert.equal(f.events.some(e=>e[0]==='persist'),false);assert.equal(f.events.some(e=>e[0]==='ui'),false);
  }
});

test('URL sync guards Reader and commits URL before persistence, including unchanged URLs',()=>{
  const f=fixture();f.c.readerHost.overlay={};f.c.syncStateToURL();assert.deepEqual(f.events,[]);
  f.c.readerHost.overlay=null;f.c.syncStateToURL();
  assert.equal(f.events[0][0],'replace');assert.deepEqual(f.events[0][1],{entry:7});assert.equal(f.events.at(-1)[0],'persist');
  assert.equal(pages?f.c.appliedRouteHash:f.c.appliedSearchRoute,pages?f.location.hash:f.location.pathname+f.location.search);
  f.events.length=0;f.c.syncStateToURL();assert.deepEqual(f.events.map(e=>e[0]),pages?['persist']:['replace','persist']);
  if(!pages){f.events.length=0;f.c.syncStateToURL(false);assert.deepEqual(f.events.map(e=>e[0]),['push','persist']);assert.equal(f.events[0][1],null);}
});
