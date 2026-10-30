import assert from 'node:assert/strict';
import {openNativeDjvu} from '../static/reader/pdf/reader-djvu-loader.mjs';

globalThis.matchMedia=()=>({matches:false});
globalThis.VoiceOfMLReaderSecurity={LIMITS:{documentBytes:512*1024*1024},
  readText:async r=>r.text(),readBytes:async r=>new Uint8Array(await r.arrayBuffer())};
const original='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/book.djvu';
const revision='a'.repeat(40),pinned=original.replace('/main/',`/${revision}/`);
const context={sourceUrl:original,readerAbortController:new AbortController(),readerDownloadApiUrl:x=>x,
  readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
  fetchWithReaderTimeout:async(url,options)=>url.startsWith('/api/reader-source-revision')
    ? new Response(JSON.stringify({url:pinned,revision})) : new Response(new Uint8Array(32)),
  fetchReaderUrl:async()=>{throw new Error('FULL_SOURCE_FALLBACK_REACHED')},
  trackReaderResource(){},assertReaderActive(){}};
await assert.rejects(openNativeDjvu(context),/FULL_SOURCE_FALLBACK_REACHED/);
console.log('ignored Range falls back to full original, never page images');
