const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');
const {test,run}=require('./test_harness');

function install(source,c,names) {
  for(const name of names) {
    const match=source.match(new RegExp('^function '+name+'\\([^]*?^}', 'm'));
    assert(match,name);vm.runInContext(match[0],c);
  }
}

for(const project of ['github-Search','huggingface-Search']) {
  const source=fs.readFileSync(path.resolve(__dirname,'../../',project,'static/app.js'),'utf8');
  function keysFixture() {
    const c={STATE:{mode:'global',repoFull:'',query:'book',filterMinSize:null,filterMaxSize:null,
      sort:'relevance',searchFolders:true,exact:true,useLocalMode:true,pageSize:100,
      filterRepos:[],filterExtensions:[],filterFolderSelfs:[],filterFolderSubtrees:[],filterFolders:[]},
      DOM:{sortSelect:{value:'relevance'}},searchViewKeyMemo:null,encodes:0};
    c.stableSearchStringify=data=>{c.encodes++;return JSON.stringify(data)};
    vm.createContext(c);install(source,c,['sameSearchFilterValues','getSearchViewKey']);return c;
  }
  test(project+' unchanged view keys encode once and detect aliased in-place edits',()=>{
    const c=keysFixture(), aliases=Array.from({length:5000},(_,i)=>'docs/'+i);
    c.STATE.filterFolderSelfs=aliases;
    const first=c.getSearchViewKey();for(let i=0;i<100;i++) assert.strictEqual(c.getSearchViewKey(),first);
    assert.strictEqual(c.encodes,1);
    aliases[4999]='changed';assert.notStrictEqual(c.getSearchViewKey(),first);assert.strictEqual(c.encodes,2);
    aliases.push('extra');c.getSearchViewKey();assert.strictEqual(c.encodes,3);
    aliases.pop();c.getSearchViewKey();assert.strictEqual(c.encodes,4);
  });
  test(project+' every result-affecting option changes its view key and layout does not',()=>{
    const c=keysFixture();
    for(const [field,value] of Object.entries({mode:'repo',repoFull:'VoiceOfML/Test',query:'new',
      filterMinSize:0,filterMaxSize:1,searchFolders:false,exact:false,pageSize:50,
      filterRepos:['repo'],filterExtensions:['txt'],filterFolderSelfs:['a'],filterFolderSubtrees:['b']})) {
      const old=c.getSearchViewKey(),previous=c.STATE[field];c.STATE[field]=value;
      assert.notStrictEqual(c.getSearchViewKey(),old,field);c.STATE[field]=previous;
    }
    const old=c.getSearchViewKey();c.STATE.sort='name';c.DOM.sortSelect.value='name';
    assert.notStrictEqual(c.getSearchViewKey(),old);
    if(project==='github-Search') {const old=c.getSearchViewKey();c.STATE.useLocalMode=false;assert.notStrictEqual(c.getSearchViewKey(),old);}
    c.STATE.filterFolderSelfs=['a'];const mixed=c.getSearchViewKey();c.STATE.filterFolders=['ignored'];
    assert.strictEqual(c.getSearchViewKey(),mixed);
    c.STATE.filterFolderSelfs=[];const plain=c.getSearchViewKey();c.STATE.filterFolders[0]='other';
    assert.notStrictEqual(c.getSearchViewKey(),plain);
    const current=c.getSearchViewKey();c.STATE.isDark=true;c.STATE.leftSidebarOpen=false;c.STATE.page=2;
    assert.strictEqual(c.getSearchViewKey(),current);
  });
  test(project+' directory selection visits each node once including deep chains',()=>{
    const c=vm.createContext({STATE:{folderTree:[]},Set,Map});
    install(source,c,['folderPathCovered','createFolderSelectionLookup','normalizeFolderSelection']);
    let root={path:'r',hasChildren:false,hasDirectFiles:true,children:[]};
    for(let i=0;i<128;i++) root={path:'r'+i,hasChildren:true,hasDirectFiles:false,children:[root]};
    let reads=0;
    const count=node=>{
      const children=node.children;
      Object.defineProperty(node,'children',{get(){reads++;return children}});
      children.forEach(count);
    };
    count(root);c.STATE.folderTree=[root];
    const lookup=c.createFolderSelectionLookup([root],new Set(),new Set());
    assert.strictEqual(lookup.size,129);assert(reads<=129*5,reads);
    reads=0;c.normalizeFolderSelection(new Set(),new Set());assert(reads<=129*5,reads);
  });
  test(project+' folder merging preserves path order and duplicates without repeated array scans',()=>{
    const c=vm.createContext({Set});install(source,c,['mergeFolderFilters']);
    const selfs=['','a','a','__proto__','\u6587\u5316'],subtrees=['a','ab','ab','','constructor','\u6587\u5316'];
    const before=selfs.slice();
    selfs.indexOf=selfs.includes=()=>{throw Error('linear membership scan')};
    assert.deepStrictEqual(Array.from(c.mergeFolderFilters(selfs,subtrees)),
      ['', 'a','a','__proto__','\u6587\u5316','ab','ab','constructor']);
    assert.deepStrictEqual(selfs.slice(),before);
    assert.deepStrictEqual(Array.from(c.mergeFolderFilters(null,subtrees)),subtrees);
    assert.deepStrictEqual(Array.from(c.mergeFolderFilters(selfs,null)),before);
    assert.deepStrictEqual(Array.from(c.mergeFolderFilters(null,null)),[]);
  });
  test(project+' persisted folder projection retains root files and normalized membership',()=>{
    let searches=0,toasts=0;
    const c=vm.createContext({Set,Map,STATE:{folderTree:[]},
      updateFilterCancelButtons:()=>{},syncStateToURL:()=>{},scheduleFilterSearch:()=>{searches++},
      showToast:()=>{toasts++}});
    install(source,c,['mergeFolderFilters','folderPathCovered','createFolderSelectionLookup',
      'normalizeFolderSelection','persistFolderSelection']);
    c.persistFolderSelection(new Set(['a','a/b','ab','']),new Set(['','a','x']));
    assert.deepStrictEqual(Array.from(c.STATE.filterFolderSubtrees),['a','ab','']);
    assert.deepStrictEqual(Array.from(c.STATE.filterFolderSelfs),['','x']);
    assert.deepStrictEqual(Array.from(c.STATE.filterFolders),['','x','a','ab']);
    assert.strictEqual(searches,1);
    const existing=c.STATE.filterFolders;
    c.persistFolderSelection(new Set(Array.from({length:10001},(_,i)=>'p'+i)),new Set());
    assert.strictEqual(c.STATE.filterFolders,existing);assert.strictEqual(searches,1);assert.strictEqual(toasts,1);
  });
}
run('search/interaction-state');
