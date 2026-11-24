import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const filename=path.join(process.cwd(),'static/search/sidebar/presentation/markup.js');
const c=vm.createContext({});
vm.runInContext(fs.readFileSync(filename,'utf8'),c,{filename});
const {browserMarkup}=c.VoiceOfMLSearchSidebarRender;
const ports={icon:value=>`<i>${value}</i>`,escape:value=>String(value),iconType:value=>String(value),
  formatSize:value=>value?`${value}B`:'',name:file=>`${file.name}.${file.ext}`,
  link:(repo,folder,file)=>`${repo}/${folder}/${file.name}`,reader:file=>file.ext==='pdf'?'reader':''};

test('the deployed surface preserves its folder and reader attributes',()=>{
  const data={folders:[{name:'folder'},{name:'present',path:'path',count:12}],files:[
    {name:'read',ext:'pdf',size:4},{name:'plain',ext:'txt',size:0}]};
  const html=browserMarkup(data,'repo','',ports);
  assert.match(html,/data-path=""/);
  assert.match(html,/data-reader-url="reader"/);
  assert.match(html,/data-filename="read.pdf" data-link=/);
  assert.equal((html.match(/browser-size/g)||[]).length,1);
});

test('null families and empty data leave no markup',()=>{
  assert.equal(browserMarkup({folders:null,files:null},'repo','p',ports),'');
  assert.equal(browserMarkup({},'repo','p',ports),'');
});

test('dynamic lists use the original surface iteration behavior',()=>{
  const items=[{name:'regular',path:'regular'}];items[Symbol.iterator]=function*(){yield {name:'iterator',path:'special'};};
  const html=browserMarkup({folders:items},'r','p',ports);
  assert.match(html,/regular/);assert.doesNotMatch(html,/iterator/);
});

test('input and injected presentation failures propagate',()=>{
  assert.throws(()=>browserMarkup(null,'r','p',ports),{name:'TypeError'});
  assert.throws(()=>browserMarkup({files:[{name:'x',ext:'pdf'}]},'r','p',{...ports,name(){throw new Error('name');}}),/name/);
  assert.throws(()=>browserMarkup({folders:[{name:'x'}]},'r','p',{...ports,escape(){throw new Error('escape');}}),/escape/);
});
