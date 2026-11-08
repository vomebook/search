import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const filename=path.join(process.cwd(),'static/search/presentation/sidebar-render.js');
const c=vm.createContext({});
vm.runInContext(fs.readFileSync(filename,'utf8'),c,{filename});
const {browserMarkup}=c.VoiceOfMLSearchSidebarRender;
const ports={icon:value=>`<i>${value}</i>`,escape:value=>String(value),iconType:value=>String(value),
  formatSize:value=>value?`${value}B`:'',name:file=>`${file.name}.${file.ext}`,
  link:(repo,folder,file)=>`${repo}/${folder}/${file.name}`,reader:file=>file.ext==='pdf'?'reader':''};

test('both surfaces preserve folder and reader attribute distinctions',()=>{
  const data={folders:[{name:'folder'},{name:'present',path:'path',count:12}],files:[
    {name:'read',ext:'pdf',size:4},{name:'plain',ext:'txt',size:0}]};
  const pages=browserMarkup(data,'repo','', 'pages',ports), space=browserMarkup(data,'repo','', 'space',ports);
  assert.match(pages,/data-path=""/);assert.match(space,/data-path="undefined"/);
  assert.match(pages,/data-reader-url="reader"/);assert.match(space,/data-read-url="reader"/);
  assert.match(pages,/data-filename="read.pdf" data-link=/);assert.match(space,/data-link="repo\/\/read" data-filename=/);
  assert.equal((pages.match(/browser-size/g)||[]).length,1);
});

test('null families and empty data leave no markup',()=>{
  for(const surface of ['pages','space']) {
    assert.equal(browserMarkup({folders:null,files:null},'repo','p',surface,ports),'');
    assert.equal(browserMarkup({},'repo','p',surface,ports),'');
  }
});

test('dynamic lists use the original surface iteration behavior',()=>{
  const items=[{name:'regular',path:'regular'}];items[Symbol.iterator]=function*(){yield {name:'iterator',path:'special'};};
  const pages=browserMarkup({folders:items},'r','p','pages',ports),space=browserMarkup({folders:items},'r','p','space',ports);
  assert.match(pages,/regular/);assert.doesNotMatch(pages,/iterator/);
  assert.match(space,/iterator/);assert.doesNotMatch(space,/regular/);
});

test('input and injected presentation failures propagate',()=>{
  assert.throws(()=>browserMarkup(null,'r','p','pages',ports),{name:'TypeError'});
  for(const surface of ['pages','space']) {
    assert.throws(()=>browserMarkup({files:[{name:'x',ext:'pdf'}]},'r','p',surface,{...ports,name(){throw new Error('name');}}),/name/);
    assert.throws(()=>browserMarkup({folders:[{name:'x'}]},'r','p',surface,{...ports,escape(){throw new Error('escape');}}),/escape/);
  }
});
