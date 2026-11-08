// Capture the existing host renderer before replacing its HTML assembly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const source = fs.readFileSync(path.join(root,'static/app.js'),'utf8');
const match = source.match(/^function renderBrowserListItems\([^]*?^}/m);
assert.ok(match, 'host sidebar renderer must exist');
const space = fs.existsSync(path.join(root,'pyrightconfig.json'));

function fixture() {
  const calls=[];
  const c=vm.createContext({
    sidebarIconMarkup:key=>{calls.push(['icon',key]);return `<i>${key}</i>`;},
    escapeHTML:value=>{calls.push(['escape',value]);return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');},
    getFileIconType:value=>{calls.push(['type',value]);return value==='pdf'?'pdf-icon':'generic-icon';},
    formatSize:value=>{calls.push(['size',value]);return value?`${value}B`:'';},
    getBrowserFileName:file=>{calls.push(['name',file.name]);return file.name+'.'+file.ext;},
    getBrowserFileLink:(repo,folder,file)=>{calls.push(['link',repo,folder,file.name]);return `https://example.test/${repo}/${folder}/${file.name}`;},
    getBrowserReaderUrl:(file,repo,folder)=>{calls.push(['reader',repo,folder,file.name]);return file.ext==='pdf'?`reader:${file.name}`:'';},
    getBrowserFileReadUrl:(file,repo,folder)=>{calls.push(['reader',repo,folder,file.name]);return file.ext==='pdf'?`reader:${file.name}`:'';},
    restoreSidebarScroll:()=>calls.push(['restore']),
  });
  const modulePath=path.join(root,'static/search/presentation/sidebar-render.js');
  vm.runInContext(fs.readFileSync(modulePath,'utf8'),c,{filename:modulePath});
  vm.runInContext(match[0],c,{filename:'sidebar-host.js'});
  return {c,calls};
}

test('empty sidebar preserves original output and scroll restore timing',()=>{
  const {c,calls}=fixture();const list={innerHTML:'old'};
  c.renderBrowserListItems(list,{},'Repo','');
  assert.equal(list.innerHTML,'');assert.deepEqual(calls,[['icon','folder'],['restore']]);
});

test('folder and file markup preserve site-specific attributes, escaping and order',()=>{
  const {c,calls}=fixture();const list={innerHTML:''};
  const data={folders:[{name:'<目录&',path:'a"/b',count:3}],files:[
    {name:'a<b',ext:'pdf',size:12},{name:'raw&',ext:'zip',size:0}]};
  c.renderBrowserListItems(list,data,'Repo','folder');
  const html=list.innerHTML;
  assert.match(html,/aria-label="打开文件夹：&lt;目录&amp;"/);
  assert.match(html,/data-path="a&quot;\/b"/);
  assert.ok(html.indexOf('data-type="folder"')<html.indexOf('data-type="file"'));
  assert.match(html,/aria-label="打开阅读器：a&lt;b\.pdf"/);
  assert.match(html,/aria-label="下载文件：raw&amp;\.zip"/);
  assert.match(html,/data-download="1"/);
  assert.match(html,space?/data-read-url="reader:a&lt;b"/:/data-reader-url="reader:a&lt;b"/);
  assert.equal((html.match(/browser-size/g)||[]).length,1);
  assert.equal(calls.at(-1)[0],'restore');
  assert.deepEqual(calls.filter(x=>x[0]==='link').map(x=>x.slice(1)),[['Repo','folder','a<b'],['Repo','folder','raw&']]);
});

test('missing folder paths keep each site original serialization',()=>{
  const {c}=fixture();const list={innerHTML:''};
  c.renderBrowserListItems(list,{folders:[{name:'missing'}]},'R','');
  assert.match(list.innerHTML,space?/data-path="undefined"/:/data-path=""/);
});

test('exceptions before final assignment do not restore scroll or partially replace DOM',()=>{
  const {c,calls}=fixture();const list={innerHTML:'old'};
  c.getBrowserFileName=()=>{throw new Error('name failure');};
  assert.throws(()=>c.renderBrowserListItems(list,{folders:[],files:[{name:'x',ext:'pdf'}]},'R',''),/name failure/);
  assert.equal(list.innerHTML,'old');assert.equal(calls.some(x=>x[0]==='restore'),false);
});

test('DOM assignment exceptions prevent scroll restoration',()=>{
  const {c,calls}=fixture();const list={set innerHTML(_value){throw new Error('assignment failure');}};
  assert.throws(()=>c.renderBrowserListItems(list,{folders:[],files:[]},'R',''),/assignment failure/);
  assert.equal(calls.some(x=>x[0]==='restore'),false);
});
