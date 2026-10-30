import assert from 'node:assert/strict';
import {openDjvuRange} from '../static/reader/pdf/reader-djvu-range.mjs';

const data=Uint8Array.from({length:300000},(_,i)=>i%251), calls=[];
function transport({status=206,etag='"immutable"',mutate=null}={}) {
  return async (_url,options)=>{
    calls.push(options.headers.Range);
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range),start=+a,end=Math.min(+b,data.length-1);
    if(start>0)assert.match(options.headers['If-Range']||'',/^"[^"\r\n]+"$/);
    if(status===200)return new Response(data,{status:200});
    const value=mutate?.({start,end,etag}) || {start,end,etag};
    return new Response(data.slice(start,end+1),{status,headers:{'Content-Range':`bytes ${value.start}-${value.end}/${value.total||data.length}`,
      'Content-Length':String(end-start+1),'ETag':value.etag,'Content-Encoding':'identity'}});
  };
}
const readBytes=async(r,max)=>{const b=new Uint8Array(await r.arrayBuffer());if(b.length>max)throw Error('too big');return b};
const open=opts=>openDjvuRange({url:'https://test/source',signal:new AbortController().signal,windowBytes:65536,
  maxCacheBytes:131072,readBytes,...opts});
{
  const range=await open({fetchResponse:transport()});assert.equal(range.total,data.length);
  assert.deepEqual(await range.read(0,16),data.slice(0,16));
  const [a,b]=await Promise.all([range.read(65536,100),range.read(65536,100)]);
  assert.deepEqual(a,b);assert.equal(calls.filter(x=>x==='bytes=65536-131071').length,1);
  await range.read(131072,100);assert.ok(range.stats().retained<=131072);range.close();
  await assert.rejects(range.read(0,1),{name:'AbortError'});
}
{
  await assert.rejects(open({fetchResponse:transport({status:200})}),/DJVU_RANGE_UNSUPPORTED/);
}
for(const mutation of [v=>({...v,start:v.start+1}),v=>({...v,end:v.end-1})]){
  await assert.rejects(open({fetchResponse:transport({mutate:mutation})}),/DJVU_RANGE_INVALID/);
}
{
  let n=0;const range=await open({fetchResponse:transport({mutate:v=>({...v,total:++n===1?data.length:data.length+1})})});
  await assert.rejects(range.read(65536,100),/DJVU_SOURCE_CHANGED/);range.close();
}
for(const etag of ['', 'W/"weak"']) await assert.rejects(open({fetchResponse:transport({etag})}),/DJVU_RANGE_UNSUPPORTED/);
{
  let n=0;const range=await open({fetchResponse:transport({mutate:v=>({...v,etag:++n===1?'"first"':'"changed"'})})});
  await assert.rejects(range.read(65536,100),/DJVU_SOURCE_CHANGED/);
  await assert.rejects(range.read(0,16),/DJVU_SOURCE_CHANGED/);range.close();
}
{
  let n=0;const source=transport(),range=await open({fetchResponse:(...args)=>++n===1?source(...args):new Response(data)});
  await assert.rejects(range.read(65536,100),/DJVU_SOURCE_CHANGED/);range.close();
}
{
  let attempts=0;const source=transport();const range=await open({fetchResponse:async(...args)=>{
    if(++attempts===1)throw new TypeError('temporary network error');return source(...args);
  }});assert.equal(attempts,2);range.close();
}
{
  const controller=new AbortController();let started;
  const waiting=new Promise(resolve=>started=resolve);
  const opening=openDjvuRange({url:'https://test',signal:controller.signal,windowBytes:65536,maxCacheBytes:65536,readBytes,
    fetchResponse:(_url,options)=>new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});started();
    })});
  await waiting;controller.abort();await assert.rejects(opening,{name:'AbortError'});
}
console.log('DjVu range bounds, identity, retries, caching and cancellation passed');
