// Compare the actual deployed host against the extracted presentation rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const source = fs.readFileSync(path.join(root,'tests/search/baselines/sidebar-original-render.js.fixture'),'utf8');
assert.match(source, /^function renderBrowserListItems\(/);
const moduleFile = path.join(root,'static/search/presentation/sidebar-render.js');
const moduleSource = fs.readFileSync(moduleFile,'utf8');
const site = fs.existsSync(path.join(root,'pyrightconfig.json')) ? 'space' : 'pages';
const expected = {pages:'c90eee4738d5b1613907a8cdde405ede412c179514b378322cf1233d62133ab3',
  space:'cb7c29abee3a115bd178dd12da7e5f72a5f23f1a3badd3e7ccaabf739bd7a12f'};
assert.equal(createHash('sha256').update(source).digest('hex'),expected[site], 'reviewed original renderer changed');

function run(candidate, makeData) {
  const trace=[];
  const c=vm.createContext({
    sidebarIconMarkup:key=>{trace.push(['icon',key]);return `<i>${key}</i>`;},
    escapeHTML:value=>{trace.push(['escape',value]);return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');},
    getFileIconType:value=>{trace.push(['type',value]);return value==='pdf'?'pdf-icon':'generic-icon';},
    formatSize:value=>{trace.push(['size',value]);return value?`${value}B`:'';},
    getBrowserFileName:file=>{trace.push(['name',file.name]);return file.name+'.'+file.ext;},
    getBrowserFileLink:(repo,folder,file)=>{trace.push(['link',repo,folder,file.name]);return `https://x.test/${repo}/${folder}/${file.name}`;},
    getBrowserReaderUrl:(file,repo,folder)=>{trace.push(['reader',repo,folder,file.name]);return file.ext==='pdf'?`reader:${file.name}`:'';},
    getBrowserFileReadUrl:(file,repo,folder)=>{trace.push(['reader',repo,folder,file.name]);return file.ext==='pdf'?`reader:${file.name}`:'';},
    restoreSidebarScroll:()=>trace.push(['restore']),
  });
  vm.runInContext(source,c,{filename:'original-sidebar-host.js'});
  if(candidate) vm.runInContext(moduleSource,c,{filename:moduleFile});
  const data=makeData(trace,c),list={innerHTML:'old'};
  let error=null;
  try {
    if (!candidate) c.renderBrowserListItems(list,data,'Repo','folder');
    else {
      const ports={icon:key=>c.sidebarIconMarkup(key),escape:value=>c.escapeHTML(value),iconType:value=>c.getFileIconType(value),
        formatSize:value=>c.formatSize(value),name:file=>c.getBrowserFileName(file),link:(...args)=>c.getBrowserFileLink(...args),
        reader:(...args)=>site==='pages'?c.getBrowserReaderUrl(...args):c.getBrowserFileReadUrl(...args)};
      list.innerHTML=c.VoiceOfMLSearchSidebarRender.browserMarkup(data,'Repo','folder',site,ports);
      c.restoreSidebarScroll();
    }
  } catch (failure) {error={name:failure.name,message:failure.message};}
  return {html:list.innerHTML,trace,error};
}

function compare(makeData) {
  assert.deepEqual(run(true,makeData),run(false,makeData));
}

test('empty, folder and file markup remains byte-identical to each host',()=>{
  compare(()=>({}));
  compare(()=>({folders:[{name:'<目录&',path:'a"/b',count:3},{name:'missing'}],
    files:[{name:'a<b',ext:'pdf',size:12},{name:'raw&',ext:'zip',size:0}]}));
});

test('repository callback rebinding is observed on later rows',()=>{
  compare((_trace,c)=>{
    const original=c.getBrowserFileLink;
    c.getBrowserFileLink=(...args)=>{const result=original(...args);c.getBrowserFileLink=()=> 'new-link';return result;};
    return {files:[{name:'first',ext:'pdf'},{name:'second',ext:'txt'}]};
  });
});

test('array getters and site-specific iterator semantics remain unchanged',()=>{
  compare(trace=>{
    const folders=[{name:'f',path:'x',count:1}],files=[{name:'z',ext:'pdf',size:1}];
    return {get folders(){trace.push(['get-folders']);return folders;},get files(){trace.push(['get-files']);return files;}};
  });
  compare(()=>{
    const folders=[{name:'normal',path:'normal'}];
    folders[Symbol.iterator]=function*(){yield {name:'iterated',path:'other'};};
    return {folders};
  });
});

test('object-valued escaped labels preserve coercion and callback order',()=>{
  compare((trace,c)=>{
    const original=c.escapeHTML;
    c.escapeHTML=value=>value==='abc.pdf'
      ? (trace.push(['escape-label']), {toString(){trace.push(['coerce-label']);return 'LABEL';}})
      : original(value);
    return {files:[{name:'abc',ext:'pdf'}]};
  });
});

test('exceptions leave the original DOM intact and do not restore scroll',()=>{
  compare((_trace,c)=>{c.getBrowserFileName=()=>{throw new Error('name failed');};return {files:[{name:'x'}]};});
});
