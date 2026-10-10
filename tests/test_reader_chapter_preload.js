const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const contract = fs.readFileSync(path.join(root, 'static/reader-contract.js'), 'utf8');
const security = fs.readFileSync(path.join(root, 'static/reader-security.js'), 'utf8');
const source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + encodeURIComponent(
  'chapters/ebook/epub/' + 'a'.repeat(64) + '/' + 'b'.repeat(16) + '/chapter-manifest.json');

function fixture(url = source, pathname = '/static/reader.html', pendingBody = false) {
  const timers = new Map(), listeners = new Map(), calls = [];
  let body;
  const sandbox = {
    URL, URLSearchParams, AbortController, Response, TextEncoder, TextDecoder,
    location: {origin:'https://site.test', href:'https://site.test' + pathname, pathname,
      search:'?url=' + encodeURIComponent(url)},
    sessionStorage: {getItem:()=>null},
    setTimeout: fn => {const id=timers.size+1;timers.set(id,fn);return id;},
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    fetch: async (url, options) => {
      calls.push({url, options});
      if (!pendingBody) return new Response('{"version":1}');
      const stream = new ReadableStream({start:controller=>{body=controller;}});
      options.signal.addEventListener('abort',()=>body.error(options.signal.reason),{once:true});
      return new Response(stream);
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(security, sandbox);
  vm.runInContext(contract, sandbox);
  return {sandbox, timers, listeners, calls};
}

async function main() {
  for (const pathname of ['/static/reader.html', '/search/static/reader.html']) {
    const f=fixture(source,pathname);
    vm.runInContext(contract,f.sandbox);
    assert.strictEqual(f.calls.length,1,'classic/module loads share the preload');
    assert.strictEqual(f.calls[0].options.credentials,'omit');
    const result=await f.sandbox.__VOICE_READER_CHAPTER_PRELOAD__.manifest;
    assert.strictEqual(await result.text(),'{"version":1}');
    assert.strictEqual(f.timers.size,0);
    f.sandbox.__VOICE_READER_CHAPTER_PRELOAD__.dispose();
    assert.strictEqual(f.listeners.size,0);
  }
  for (const url of [source.replace('voiceofml-search.hf.space','evil.test'), source+'&path=extra',
    source+'&other=1',source+'#fragment',source.replace('chapter-manifest.json','chapter-0001.xhtml')]) {
    assert.strictEqual(fixture(url).calls.length,0,'invalid or non-manifest URL must not preload');
  }
  assert.strictEqual(fixture(source,'/search/').calls.length,0,'search page cannot preload a document');
  for (const event of ['voice-reader-dispose','pagehide','timeout']) {
    const f=fixture(source,'/static/reader.html',true), pending=f.sandbox.__VOICE_READER_CHAPTER_PRELOAD__.manifest;
    await Promise.resolve();
    if (event==='timeout') [...f.timers.values()][0]();
    else f.listeners.get(event)({persisted:false});
    await assert.rejects(pending,error=>error.name==='AbortError');
    assert.strictEqual(f.timers.size,0);
    f.sandbox.__VOICE_READER_CHAPTER_PRELOAD__.dispose();
    assert.strictEqual(f.listeners.size,0);
  }
  console.log('chapter manifest preload validation, reuse, body deadline and disposal passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
