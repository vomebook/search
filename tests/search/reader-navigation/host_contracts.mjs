import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';

const paths = ['search/reader-host/presentation/return-position.js', 'search/reader-host/application/host.js'];
function context(values = {}) {
  const c = vm.createContext({URL, URLSearchParams, ...values});
  for (const path of paths) vm.runInContext(fs.readFileSync('static/' + path, 'utf8'), c);
  return c;
}

test('reader host dependencies are composed, cached and loaded before the app', () => {
  const html = fs.readFileSync('static/index.html', 'utf8'), c = context();
  vm.runInContext(fs.readFileSync('static/reader-resources.js', 'utf8'), c);
  for (const path of paths) {
    assert.ok(APP_DEPENDENCIES.indexOf(path) > APP_DEPENDENCIES.indexOf('search/reader-host/application/navigation.js'));
    assert.ok(html.indexOf(path) > html.indexOf('search/reader-host/application/navigation.js'));
    assert.ok(html.indexOf(path) < html.indexOf('static/app.js'));
    assert.ok(!stripBundledScripts(html).includes(path));
    assert.ok(fs.readFileSync('static/sw.js', 'utf8').includes('/static/' + path));
    for (const site of ['github', 'huggingface']) assert.ok(c.VoiceOfMLReaderResources.buildFiles(site).includes(path));
    const source = fs.readFileSync('static/' + path, 'utf8');
    assert.doesNotMatch(source, /\bSTATE\b|\bVSCROLL\b|\bDOM\b|new Proxy/);
  }
});

test('return position owns scroll cancellation and retires queued route restores', () => {
  const frames = [], writes = [];
  const location = new URL('https://example.test/search/');
  const c = context({location, requestAnimationFrame: fn => frames.push(fn)});
  let view = {hasContainer:true, containerHeight:100, resultCount:5}, position, render;
  const deps = {readView:()=>view, getViewKey:()=> 'view', ensureHeights(){}, getOffset:i=>i*100,
    getTotalHeight:()=>500, setTop:top=>{writes.push(top);position.cancelOnScroll();}, getTop:()=>110,
    invalidateWindow(){}, renderVisible:()=>render?.(), updateTrack(){}};
  position = c.VoiceOfMLReaderReturn.create(deps);
  const saved = {route:location.href,viewKey:'view',index:1,offset:10,top:110,focus:null};
  position.setScroll(saved);
  position.restore();
  assert.deepEqual(writes,[110], 'synchronous scroll event cannot cancel the active restoration');
  view = {...view,resultCount:0};
  position.setScroll(saved);position.restore();
  position.invalidate();view.resultCount=5;
  while(frames.length) frames.shift()();
  assert.deepEqual(writes,[110], 'route invalidation retires callbacks already queued');
  position.cancelOnScroll();assert.equal(position.scroll,null);
  render=()=>writes.push('new renderer');
  position.setScroll(saved);position.restore();
  assert.equal(writes.at(-1),'new renderer','effects resolve the current host hook');
});

test('handoff requires the matching session token and yields to input ownership', () => {
  for (const mode of ['valid','missing-token','blocked-storage','input','new-route']) {
    const frames=[],listeners=new Map(),writes=[],focused=[];
    const location=new URL('https://example.test/search/');
    class Input { focus(options){focused.push(options);} setSelectionRange(...args){focused.push(args);} }
    const input=new Input(),body={};
    const saved={route:location.href,viewKey:'view',index:0,offset:3,top:3,
      focus:{id:'query',start:1,end:3,direction:'backward'}};
    const readerUrl='https://example.test/reader?nav=token';
    const stored=new Map([
      ['reader-navigation-restore',JSON.stringify({returnUrl:location.href,readerUrl})],
      ['reader-return:token',location.href]
    ]);
    if(mode==='missing-token') stored.delete('reader-return:token');
    const c=context({location,HTMLInputElement:Input,requestAnimationFrame:fn=>frames.push(fn),
      sessionStorage:{getItem(key){if(mode==='blocked-storage') throw Error('blocked');return stored.get(key);},removeItem:key=>stored.delete(key)},
      document:{body,activeElement:body,getElementById:()=>input,
        addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)}});
    let revision=1;
    const position=c.VoiceOfMLReaderReturn.create({
      readView:()=>({hasContainer:true,containerHeight:100,resultCount:1,total:1,loading:false,loadedPage:1,
        positionRestore:{key:'view',preview:true},routeRevision:revision}),
      hasResult:()=>true,getViewKey:()=> 'view',ensureHeights(){},getOffset:()=>0,getTotalHeight:()=>500,
      setTop:top=>writes.push(top),getTop:()=>3,invalidateWindow(){},renderVisible(){},updateTrack(){},
      handoffReady:saved=>position.ready(saved),restoreScroll:(rendered,top)=>position.restore(rendered,top)
    });
    position.restoreHandoff({saved:()=>({readerUrl,returnScroll:saved}),parse:raw=>new URL(raw)});
    if(mode==='input') listeners.get('input')();
    if(mode==='new-route') revision++;
    while(frames.length) frames.shift()();
    assert.equal(listeners.size,0,'interaction listeners are released');
    if(mode==='valid') {
      assert.deepEqual(writes,[3]);
      assert.equal(focused[0].preventScroll,true);
      assert.deepEqual(focused[1],[1,3,'backward']);
    } else {assert.deepEqual(writes,[]);assert.deepEqual(focused,[]);}
  }
});

test('host release is synchronous and disposal reentry keeps the newer reader', () => {
  for (const hashRoute of [false,true]) {
    const location = new URL('https://example.test' + (hashRoute ? '/search/' : '/'));
    const history = {state:null,replaceState(state, unused, url){this.state=state;location.href=url;}};
    const c = context({location,history});
    let scroll=null,host,onUnmount,focuses=0,restores=0;
    const position = {get scroll(){return scroll;},setScroll:value=>{scroll=value;}};
    const navigation = {parse:raw=>new URL(raw,location),mount:url=>({src:url.href,contentWindow:{}}),
      unmount(){onUnmount?.();return {isConnected:true,focus(){focuses++;}};},remember(){},
      accepts:event=>!!host.overlay && event.origin===location.origin && event.source===host.overlay.contentWindow};
    const deps = {hashRoute,position,createNavigation:()=>navigation,getViewKey:()=> 'view',
      captureScroll:()=>null,saveSnapshot:()=>null,restoreScroll:()=>restores++,
      openOverlay:(...args)=>host.openReaderOverlay(...args),closeOverlay:(...args)=>host.closeReaderOverlay(...args),
      reconcile:()=>host.reconcileSearchDestination(),routeChanged:()=>false,applyTheme(){throw Error('unexpected theme');}};
    host=c.VoiceOfMLReaderHost.create(deps);
    host.openReaderOverlay(new URL('/reader?id=old',location));
    const first=host.overlay;
    host.handleReaderMessage({origin:'https://other.test',source:first.contentWindow,data:{type:'voice-reader-theme',theme:'dark'}});
    host.handleReaderMessage({origin:location.origin,source:{},data:{type:'voice-reader-theme',theme:'dark'}});
    assert.equal(host.overlay,first);
    onUnmount=()=>{assert.equal(host.overlay,null);host.openReaderOverlay(new URL('/reader?id=new',location),false);};
    host.restoreReaderOverlay({voiceReaderOverlay:true,readerUrl:'/reader?id=stale'});
    assert.equal(new URL(host.overlay.src).searchParams.get('id'),'new');
    assert.equal(restores,0);assert.equal(focuses,0);
    onUnmount=null;host.closeReaderOverlay();
    assert.equal(host.overlay,null);assert.equal(restores,1);assert.equal(focuses,1);
  }
});
