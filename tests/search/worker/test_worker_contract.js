const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { test, run } = require("../../support/test_harness");
// Run application lifecycle races through the existing CI Worker entrypoint.
require(require("path").resolve("tests/search/worker/test_app_worker_lifecycle.js"));

const source = fs.readFileSync("static/search/index-worker.js", "utf8");
const app = fs.readFileSync("static/app.js", "utf8");
const PROTOCOL = 1;
const records = [
  { Repo: "Repo/A", File: "alpha guide", Extension: "txt", Folder: ["docs", "root"], Size: 100, HasTxt: true },
  { Repo: "Repo/A", File: "beta alpha", Extension: "pdf", Folder: ["docs", "child"], Size: 500, HasTxt: false },
  { Repo: "Repo/B", File: "beta notes", Extension: "md", Folder: ["archive"], Size: 50, HasTxt: true },
  { Repo: "Repo/B", File: "gamma", Extension: "txt", Folder: ["alpha-folder", "nested"], Size: 200, HasTxt: false },
  { Repo: "Repo/C", File: "手机资料", Extension: "txt", Folder: [], Size: 0, HasTxt: true },
  { Repo: "Repo/C", File: "delta", Extension: "TXT", Folder: ["docs"], Size: 300, HasTxt: false },
  { Repo: "Repo/C", File: "手。机", Extension: "txt", Folder: [], Size: "unknown", HasTxt: false },
  { Repo: "Repo/D", File: "same", Extension: "txt", Folder: ["docs", "same"], Size: 100, HasTxt: false },
  { Repo: "Repo/D", File: "same", Extension: "txt", Folder: ["other"], Size: 100, HasTxt: false },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compact(input) {
  const repos = [];
  const folders = [];
  const repoMap = new Map();
  const folderMap = new Map();
  function index(map, values, value, key) {
    if (!map.has(key)) { map.set(key, values.length); values.push(value); }
    return map.get(key);
  }
  return {
    v: 2,
    rp: repos,
    fd: folders,
    rc: input.map((record) => [
      index(repoMap, repos, record.Repo, record.Repo), record.File, record.Extension,
      index(folderMap, folders, record.Folder.slice(), JSON.stringify(record.Folder)), record.Size, record.HasTxt ? 1 : 0,
    ]),
  };
}

function gzipWorker(options = {}, workerSource = source) {
  return makeWorker(workerSource, { ReadableStream, Response, TextDecoder, DecompressionStream, ...options });
}

function makeWorker(workerSource = source, options = {}) {
  const listeners = {};
  const messages = [];
  const context = {
    console,
    Math,
    TextEncoder: require('util').TextEncoder,
    crypto: {subtle: {digest: async (_algorithm, bytes) => {
      const hash = require('crypto').createHash('sha256').update(bytes).digest();
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    }}},
    ...options,
    self: {
      addEventListener(type, listener) { listeners[type] = listener; },
      postMessage(message) { messages.push(clone(message)); },
    },
  };
  vm.createContext(context);
  context.importScripts = url => {
    assert.ok(["./worker/domain/text.js", "./worker/domain/intersection.js"].includes(url));
    vm.runInContext(fs.readFileSync("static/search/" + url.slice(2), "utf8"), context, {filename: url});
  };
  vm.runInContext(workerSource, context, { filename: "static/search/index-worker.js" });
  async function send(type, payload, options) {
    const settings = Object.assign({ protocol: PROTOCOL, id: "request" }, options || {});
    const before = messages.length;
    const work = listeners.message({ data: { protocol: settings.protocol, type, id: settings.id, payload: payload || {} } });
    if (type === "local-search" && context.drive) {
      let settled = false;
      work.finally(() => { settled = true; });
      for (let i = 0; !settled && i < 10000; i++) { await Promise.resolve(); if (!settled) context.drive(); }
      assert(settled, "scheduled query did not settle");
    }
    await work;
    const sent = messages.slice(before);
    assert.strictEqual(sent.length, 1);
    return sent[0];
  }
  async function request(type, payload, options) {
    const response = await send(type, payload, options);
    assert.strictEqual(response.type, "response");
    assert.strictEqual(response.protocol, PROTOCOL);
    assert.strictEqual(response.id, options && options.id || "request");
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }
  return { listeners, messages, send, request, context };
}

async function loaded(input) {
  const worker = makeWorker();
  await worker.request("handshake");
  const metadata = await worker.request("replace-corpus", { data: compact(input || records) });
  return { worker, metadata };
}

async function search(params) {
  const harness = await loaded();
  return harness.worker.request("local-search", params || {});
}

async function names(params) {
  return (await search(params)).records.map((record) => record.File);
}

test('size filters distinguish zero from missing and unknown sizes', async () => {
  const {worker} = await loaded([
    {Repo: 'A', File: 'zero', Extension: 'txt', Folder: [], Size: 0},
    {Repo: 'A', File: 'one', Extension: 'txt', Folder: [], Size: 1},
    {Repo: 'A', File: 'missing', Extension: 'txt', Folder: []},
    {Repo: 'A', File: 'unknown', Extension: 'txt', Folder: [], Size: 'unknown'},
  ]);
  for (const [params, expected] of [
    [{minSize: 1}, ['one', 'missing', 'unknown']],
    [{maxSize: 0}, ['zero', 'missing', 'unknown']],
    [{minSize: 0, maxSize: 0}, ['zero', 'missing', 'unknown']],
  ]) {
    const result = await worker.request('local-search', params);
    assert.deepStrictEqual(result.records.map(record => record.File), expected);
  }
});

test('JSON corpus install preserves stable IDs, collisions, and snapshot stamps', async () => {
  const data = {v: 2, rp: ['Repo/A', {name: 'legacy'}, null],
    fd: [[], [''], ['', 'A'], ['A', '', 'B'], ['A/B'], ['A', 'B'], [null, 0, ['Nested']]],
    rc: [[0, 'same', '', 0, 1, 0], [0, 'same', '', 1, 1, 0],
      [0, 'same', '', 1, 1, 0], [0, 'same', '', 2, 1, 0],
      [0, 'same', '', 3, 1, 0], [0, 'same', '', 4, 1, 0],
      [0, 'same', '', 5, 1, 0], [1, {name: 'file'}, true, 6, 0, 0],
      [2, null, ['x', 'y'], 6, 0, 0], null]};
  const plain = makeWorker(), json = gzipWorker();
  await plain.request('replace-corpus', {data});
  json.context.fetch = async () => new Response(require('node:zlib').gzipSync(JSON.stringify(data)));
  await json.request('load-corpus', {url:'/corpus'});
  const params = {q: '', sort: 'relevance', pageSize: 20};
  const fromJSON = await json.request('local-search', params);
  const fromObject = await plain.request('local-search', params);
  assert.deepStrictEqual(fromJSON, fromObject);
  assert.strictEqual(fromJSON.ids.length, data.rc.length);
  assert.strictEqual(new Set(fromJSON.ids).size, fromJSON.ids.length);
  // [] and [""] share the occurrence counter, but not the path string.
  assert.ok(fromJSON.ids.includes('Repo/A\u001fsame/\u001f0'));
  assert.ok(fromJSON.ids.includes('Repo/A\u001f/same/\u001f1'));
  assert.ok(fromJSON.ids.includes('Repo/A\u001f/same/\u001f2'));
});

test("registers one versioned message protocol listener", () => {
  assert.strictEqual(typeof makeWorker().listeners.message, "function");
});

test("repository-scoped literal scans skip other records and preserve source-order ties", async () => {
  const input = Array.from({length:12}, (_, i) => ({...records[0],
    Repo: i % 3 === 0 ? "Repo/B" : "Repo/A", File:"same " + i}));
  const {worker} = await loaded(input);
  const before = await worker.request("local-search", {q:"same",exact:true,repos:["Repo/A"]});
  worker.context.skip = input.map((_,i)=>i).filter(i=>i%3===0);
  vm.runInContext('for (const i of skip) records[i] = new Proxy({}, {get(){throw Error("out-of-scope read");}}); searchOrderCache.clear();',worker.context);
  for (const q of ["same", "sa*e", "sa?e"]){
    const current = await worker.request("local-search",{q,exact:true,repos:["Repo/A","Repo/A"]});
    assert.deepStrictEqual(current.ids,before.ids);
    assert.strictEqual(current.total,8);
  }
  const full = await loaded(input);
  const result = await full.worker.request("local-search",{q:"same",exact:true,repos:["Repo/A","missing","Repo/B","Repo/A"]});
  assert.deepStrictEqual(result.records.map(r=>r.File), input.map(r=>r.File));
});

test("sorted posting intersection agrees with set intersection without changing fuzzy tie order", () => {
  const {context} = makeWorker();
  let seed=123;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let run=0;run<100;run++){
    context.lists=Array.from({length:1+random()%5},()=>Array.from({length:100},(_,i)=>i).filter(()=>random()%4===0));
    assert.strictEqual(vm.runInContext('JSON.stringify(intersectCandidateLists(lists,true)) === JSON.stringify(intersectCandidateLists(lists))',context),true);
  }
  for (const size of [511,512,513,5000]) {
    context.lists = Array.from({length:4}, () => Array.from({length:size*3}, (_,i)=>i).filter(() => random()%3 !== 0));
    assert.strictEqual(vm.runInContext('JSON.stringify(intersectCandidateLists(lists,true)) === JSON.stringify(intersectCandidateLists(lists))',context),true);
  }
  context.lists=[[9,2,7,1],[7,9,1]];
  assert.strictEqual(vm.runInContext('JSON.stringify(intersectCandidateLists(lists))',context),'[9,7,1]');
});

test("warm exact Chinese postings preserve full-scan results, ties, filters and anchors", async () => {
  const input = Array.from({length: 600}, (_, i) => ({...records[0],
    Repo: i % 29 === 0 ? "Repo/手机" : i % 2 ? "Repo/A" : "Repo/B",
    File: i % 31 === 0 ? "手机笔记" : i % 37 === 0 ? "目录手机" : `资料${i}`,
    Folder: i % 41 === 0 ? ["手机", "目录"] : ["其他"],
    Extension: i % 43 === 0 ? "手机" : i % 3 === 0 ? "pdf" : "txt", Size:i % 9}));
  const {worker} = await loaded(input);
  vm.runInContext('buildFulltext(); globalThis.indexedCandidates = indexedExactCandidates;',worker.context);
  for (const q of ["手机", "手机*", "手?机", "手*机", "手机.txt", "手机 资料", "不存在"]) {
    for (const repos of [null, ["Repo/A"], ["Repo/手机", "Repo/B", "Repo/B"]]) {
      for (const searchFolders of [true,false]) for (const sort of ["relevance","name","size"]) {
        const params = {q,exact:true,repos,searchFolders,sort,extensions:["pdf","txt","手机"],
          page:2,pageSize:7,anchorId:"Repo/手机\\0其他/资料29.txt"};
        vm.runInContext('indexedExactCandidates = indexedCandidates; searchOrderCache.clear();',worker.context);
        const accelerated = await worker.request("local-search", params);
        vm.runInContext('indexedExactCandidates = () => null; searchOrderCache.clear();',worker.context);
        const full = await worker.request("local-search", params);
        assert.deepStrictEqual(accelerated,full,JSON.stringify(params));
      }
    }
  }
  vm.runInContext('indexedExactCandidates = indexedCandidates;',worker.context);
});

test("later exact CJK seeds preserve every term, full IDs, ties and cached anchor pages", async () => {
  const input = Array.from({length:600}, (_, i) => ({...records[0], File:`book notes ${i}`, Folder:[]}));
  for (const [i, file, folder, repo, extension] of [
    [0,"book 手机记",["one"]], [1,"book 手机记",["two"]],
    [2,"手机记",[]], [3,"book 手机",[]], [4,"book 机记",[]],
    [5,"book file",[],"Repo/手机记"], [6,"book file",["手机记"]],
    [7,"book 手机记",["other"],"Repo/A","pdf"],
  ]) Object.assign(input[i], {File:file,Folder:folder,Repo:repo || "Repo/A",Extension:extension || "txt"});
  const {worker} = await loaded(input);
  const orders = [];
  for (const sort of ["relevance","name","size"]) for (const searchFolders of [true,false]) {
    for (const repos of [null,["Repo/A"],["Repo/手机记","Repo/A","Repo/手机记"]]) {
      const params = {q:"book 手机记",exact:true,sort,searchFolders,repos,extensions:["txt"],
        pageSize:20,anchorId:"Repo/A\0two/book 手机记.txt"};
      const cold = await worker.request("local-search", params);
      const metadataHits = repos?.length === 1 ? [] : [input[5]];
      if (searchFolders) metadataHits.unshift(input[6]);
      if (metadataHits.length === 2 && sort !== "relevance") metadataHits.reverse();
      const fileHits = [input[0],input[1]];
      const expected = sort === "relevance" ? [...fileHits,...metadataHits] : [...metadataHits,...fileHits];
      assert.deepStrictEqual(cold.records,expected);
      assert.strictEqual(cold.total, expected.length);
      assert.strictEqual(cold.anchor_index, expected.indexOf(input[1]));
      orders.push({params,cold});
    }
  }
  assert(vm.runInContext('wordIndex === null && fulltextBuild === null',worker.context));
  vm.runInContext('buildFulltext(); buildNameOrders(); buildSizeOrders(); searchOrderCache.clear();',worker.context);
  for (const {params,cold} of orders) {
    for (const q of [params.q,"手机记 book"]) {
      assert.deepStrictEqual(await worker.request("local-search", {...params,q}),cold);
    }
    vm.runInContext(`globalThis.savedFields = getRecordSearchFields;
      getRecordSearchFields = () => {throw Error('cached exact page rescanned')};`,worker.context);
    const page = await worker.request("local-search", {...params,page:2,pageSize:1});
    assert.deepStrictEqual(page.ids,cold.ids.slice(1,2));
    assert.strictEqual(page.total,cold.total);
    assert.strictEqual(page.anchor_index,cold.anchor_index);
    vm.runInContext('getRecordSearchFields = savedFields;',worker.context);
  }
});

test("exact AND lookahead bounds probes and keeps no-benefit dispatch paths unchanged", async () => {
  const count = 10000;
  const input = Array.from({length:count}, (_, i) => ({...records[0], Folder:[],
    File:i === 0 ? "book 宽广 手机" : i < 4300 ? "book 宽广" : "book"}));
  const {worker} = await loaded(input);
  vm.runInContext(`buildFulltext();
    const originalCandidates = indexedExactCandidates, originalFields = getRecordSearchFields;
    let probes = [], scans = 0;
    indexedExactCandidates = (term, ...args) => {probes.push(term); return originalCandidates(term, ...args)};
    getRecordSearchFields = record => {scans++; return originalFields(record)};`,worker.context);
  for (const [q, exact, total, terms, scans] of [
    ["book 手机",true,1,["book","手机"],2],
    ["book 手机.txt",false,1,["book","手机.txt"],2],
    ["book 宽广 手机",true,1,["book","宽广","手机"],3],
    ["book 宽广 宽广 手机",true,1,["book","宽广","手机"],4],
    ["手机 book",true,1,["手机"],2],
    ["宽广 手机",true,1,["宽广"],8600],
    ["book 手机 资料",true,0,["book","手机"],3],
    ["book 资料",true,0,["book","资料"],0],
    ["book 宽广",true,4300,["book","宽广"],count * 2],
    ["absent notes",true,0,["absent"],count],
    ["absent " + "宽广 ".repeat(80) + "手机",true,0,["absent"],count],
    ["absent " + "资料".repeat(124),true,0,["absent"],count],
    ["资料".repeat(124) + " book",true,0,["资料".repeat(124)],0],
    ["book 手机*",true,1,["book"],count * 2],
    ["book 手机*" + "*".repeat(32),true,1,[],count],
    ["手",false,1,[],count],
  ]) {
    vm.runInContext('searchOrderCache.clear(); probes = []; scans = 0;',worker.context);
    assert.strictEqual((await worker.request("local-search",{q,exact,sort:"name"})).total,total,q);
    assert.deepStrictEqual(JSON.parse(vm.runInContext('JSON.stringify(probes)',worker.context)),terms,q);
    assert.strictEqual(vm.runInContext('scans',worker.context),scans,q);
  }
});

test("fuzzy search keeps literal fallback and complete fuzzy postings with indexed scope", async () => {
  const input = Array.from({length:500}, (_, i) => ({...records[0],
    Repo:i % 91 === 0 ? "Repo/手机" : i % 2 ? "Repo/A" : "Repo/B",
    File:i % 53 === 0 ? "手机 guide" : i % 67 === 0 ? "手册 alpha" : `资料${i}`,
    Folder:i % 79 === 0 ? ["手机", "其他"] : ["guide"], Extension:i % 3 ? "txt" : "pdf"}));
  const {worker} = await loaded(input);
  vm.runInContext('buildFulltext();globalThis.savedIndexedCandidates=indexedExactCandidates',worker.context);
  for (const q of ["手机", "手机 guide", "手机 alpa", "手册 alpha", "手机 不存在", "不存在", "repo 手机"]) {
    for (const repos of [null,["Repo/A"],["Repo/B","Repo/手机"]]) {
      for (const searchFolders of [true,false]) for (const sort of ["relevance","name","size"]) {
        const params={q,repos,searchFolders,sort,extensions:["txt","pdf"],page:2,pageSize:5};
        vm.runInContext('indexedExactCandidates=savedIndexedCandidates;searchOrderCache.clear()',worker.context);
        const accelerated=await worker.request("local-search",params);
        vm.runInContext('indexedExactCandidates=()=>null;searchOrderCache.clear()',worker.context);
        const full=await worker.request("local-search",params);
        assert.deepStrictEqual(accelerated,full,JSON.stringify(params));
      }
    }
  }
});

test("exact search borrows its scope without copying or reordering shared indices", async () => {
  const input = Array.from({length: 500}, (_, i) => ({...records[0],
    Repo: i % 2 ? "Repo/A" : "Repo/B", File: i === 123 || i === 125 ? "手机" : `other ${i}`,
    Folder: [String(i)], Size: i + 1}));
  const {worker} = await loaded(input);
  const scopeCopies = vm.runInContext(`(() => {
    let copies = 0;
    for (const scope of [recordIndices, ...Object.values(repoRecordIndices)]) {
      Object.defineProperty(scope, "slice", {value(...args) {
        if (!args.length) copies++;
        return Array.prototype.slice.apply(this, args);
      }});
      Object.freeze(scope);
    }
    return () => copies;
  })()`, worker.context);
  const params = {q: "手机", exact: true, sort: "name", page: 2, pageSize: 1, anchorId: "Repo/A\x00125/手机.txt"};
  const reposList = [null, ["Repo/A"]];
  const cold = [];
  for (const repos of reposList) {
    const result = await worker.request("local-search", {...params, repos});
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.anchor_index, 1);
    assert.deepStrictEqual(result.records, [input[125]]);
    cold.push(result);
  }
  vm.runInContext("buildFulltext(); searchOrderCache.clear();", worker.context);
  for (const [i, repos] of reposList.entries()) {
    assert.deepStrictEqual(await worker.request("local-search", {...params, repos}), cold[i]);
  }
  assert.strictEqual(scopeCopies(), 0, "selective uncached queries must not clone their complete starting scope");
  // With no narrowing term and with sorting enabled, the final order still
  // needs its own array. The frozen global and repository scopes must survive.
  const sorted = await worker.request("local-search", {q:"*", exact:true, sort:"size", pageSize:1});
  assert.deepStrictEqual(sorted.records, [input[499]]);
  for (const repos of [null, ["Repo/A"]]) {
    const original = await worker.request("local-search", {q:"*", exact:true, repos, pageSize:2});
    assert.deepStrictEqual(original.records, repos ? [input[1], input[3]] : [input[0], input[1]]);
  }
});

test("warm exact preselection bounds work and falls back for uncovered extension and cold indexes", async () => {
  const input = Array.from({length: 500}, (_, i) => ({...records[0],Repo:"Repo/A",
    File:i === 123 ? "手机" : `unrelated ${i}`,Folder:[],Extension:"txt"}));
  const {worker} = await loaded(input);
  assert.strictEqual((await worker.request("local-search",{q:"手机",exact:true})).total,1);
  vm.runInContext('buildFulltext(); searchOrderCache.clear(); globalThis.beforeFields = getRecordSearchFields; globalThis.scans = 0; getRecordSearchFields = record => {scans++; return beforeFields(record)};',worker.context);
  assert.strictEqual((await worker.request("local-search",{q:"手机",exact:true})).total,1);
  assert(vm.runInContext('scans < 10',worker.context));
  const asRepo = await loaded(input.map((record,i)=>({...record,Repo:i%80===0?"Repo/手机":"Repo/B",File:`other ${i}`})));
  vm.runInContext('buildFulltext()',asRepo.worker.context);
  assert.strictEqual((await asRepo.worker.request("local-search",{q:"手机",exact:true})).total,7);
  const asFolder = await loaded(input.map((record,i)=>({...record,File:`other ${i}`,Folder:i===0?["手机"]:[]})));
  vm.runInContext('buildFulltext()',asFolder.worker.context);
  assert.strictEqual((await asFolder.worker.request("local-search",{q:"手机",exact:true})).total,1);
  assert.strictEqual((await asFolder.worker.request("local-search",{q:"手机",exact:true,searchFolders:false})).total,0);
  const extension = await loaded(input.map((record,i)=>({...record,File:`other ${i}`,Extension:i===0?"手机":"txt"})));
  vm.runInContext('buildFulltext()',extension.worker.context);
  for (const q of ["手机","other 手机","手机 other"]) {
    const result = await extension.worker.request("local-search",{q,exact:true,searchFolders:false});
    assert.deepStrictEqual(result.ids,["Repo/A\u001fother 0/手机\u001f0"]);
  }
  assert.strictEqual(vm.runInContext('indexedExactCandidates("手机",{},records.length)',extension.worker.context),null);
  // Unusual extension values retain the full-scan coercion/error path rather
  // than relying on an index built for ordinary string metadata.
  const unusual = makeWorker();
  await unusual.request("replace-corpus", {data:{v:2,rp:["R"],fd:[[]],rc:[[0,"book plain","txt",0,1,0],[0,"book",["手机"],0,1,0]]}});
  vm.runInContext('buildFulltext()',unusual.context);
  assert.strictEqual(vm.runInContext('indexedExactCandidates("手机",{},records.length)',unusual.context),null);
  assert.deepStrictEqual((await unusual.request("local-search",{q:"book 手机",exact:true})).ids,["R\u001fbook/手机\u001f0"]);
});

test("inherited object names remain ordinary tokens and repository keys", async () => {
  const input = ["constructor", "__proto__", "toString", "hasOwnProperty"].map(name => ({
    ...records[0], Repo: name, File: name, Extension: "constructor", Folder: [name],
  }));
  const {worker, metadata} = await loaded(input);
  assert.strictEqual(metadata.count, input.length);
  for (const record of input) {
    const result = await worker.request("local-search", {q: record.File, repos: [record.Repo], searchFolders: false});
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.records[0].File, record.File);
    assert.strictEqual((await worker.request("folder-contents", {repo: record.Repo, path: record.Repo})).files.length, 1);
    assert.strictEqual((await worker.request("local-search", {repos: [record.Repo], sort: "name"})).total, 1);
  }
  const plain = await loaded([records[0]]);
  assert.strictEqual((await plain.worker.request("local-search", {q: "constructor"})).total, 0);
  assert.strictEqual((await plain.worker.request("local-search", {repos: ["__proto__"]})).total, 0);
});

// Small independent oracle: try each substring start and expand each star
// only up to the next line terminator. Literal equality uses legacy /i.
function questionGlobReference(pattern, text) {
  const chars = Array.from(text);
  const esc = ch => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = Array.from(pattern, ch => ch === "*" || ch === "?" ? ch : new RegExp(`^${esc(ch)}$`, "i"));
  const dot = pos => pos < chars.length && !/[\n\r\u2028\u2029]/.test(chars[pos]);
  function matches(tokenIndex, pos) {
    if (tokenIndex === tokens.length) return true;
    const token = tokens[tokenIndex];
    if (token === "*") {
      do {
        if (matches(tokenIndex + 1, pos)) return true;
      } while (dot(pos++));
      return false;
    }
    return (token === "?" ? dot(pos) : pos < chars.length && token.test(chars[pos])) && matches(tokenIndex + 1, pos + 1);
  }
  return chars.some((_, pos) => matches(0, pos));
}

test("bounded wildcards preserve literal case and line-terminator semantics", () => {
  const { context } = makeWorker();
  const alphabet = ["a", "A", "?", "*", "\n", "\r", "\u2028", "\u2029", ".", "[", "İ", "ı", "ſ", "K", "Σ", "σ", "ς", "ß", "😀", "\ud83d", "\ude00"];
  // Kelvin/long-s one-literal globs intentionally follow Python IGNORECASE.
  const special = pattern => /^[*]*[Kſ][*]*$/.test(pattern) && pattern.includes('*');
  let seed = 17;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const string = n => Array.from({length: random(n)}, () => alphabet[random(alphabet.length)]).join("");
  const pairs = alphabet.flatMap(text => alphabet.map(pattern => [text, pattern]));
  for (let i = 0; i < 1500; i++) pairs.push([string(20), string(7) + "*"]);
  for (const [text, pattern] of pairs) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const expected = pattern.includes("?") ? questionGlobReference(pattern, text)
      : new RegExp(escaped.replace(/\*/g, ".*"), special(pattern) ? "iu" : "i").test(text);
    assert.strictEqual(context.compileWildcardMatcher(pattern).test(text), expected, JSON.stringify([text, pattern]));
  }
  vm.runInContext('if (compileWildcardMatcher("*a".repeat(100)+"b").test("a".repeat(120))) throw new Error("bad match");', context, {timeout: 1000});
});

test("boundary-only wildcard scans preserve literal matching and bounded work", () => {
  const { context } = makeWorker();
  for (const pattern of ["a*", "*a", "*a*", "**a***"]) {
    assert.strictEqual(context.compileWildcardMatcher(pattern).test("x\nA\ny"), true, pattern);
    assert.strictEqual(context.compileWildcardMatcher(pattern).test("xyz"), false, pattern);
  }
  for (const pattern of ["*", "**", "*****"]) {
    assert.strictEqual(context.compileWildcardMatcher(pattern).test(""), true);
    assert.strictEqual(context.compileWildcardMatcher(pattern).test("\n"), true);
  }
  for (const pattern of ["*İ*", "*ı*", "*ſ*", "*K*"]) {
    const expression = new RegExp(pattern.replace(/\*/g, ".*"), /[Kſ]/.test(pattern) ? "iu" : "i");
    for (const text of ["i", "I", "s", "S", "k", "K", "İıſK"]) {
      assert.strictEqual(context.compileWildcardMatcher(pattern).test(text), expression.test(text), JSON.stringify([pattern, text]));
    }
  }
  assert.strictEqual(context.compileWildcardMatcher("*[.\\]*").test("x[.\\]y"), true);
  assert.strictEqual(context.compileWildcardMatcher("*[.\\]*").test("xyz"), false);
  assert.strictEqual(context.compileWildcardMatcher("*ab*").test("a\nb"), false);
  assert.strictEqual(context.compileWildcardMatcher("a*b").test("a\nb"), false);
  let conversions = 0;
  const converted = {toString() { conversions++; return "a*b"; }};
  assert.strictEqual(context.compileWildcardMatcher(converted).test("axb"), true);
  assert.strictEqual(conversions, 1);
  vm.runInContext('if (compileWildcardMatcher("*"+"a".repeat(127)+"b*").test("a".repeat(20000))) throw Error("bad match");', context, {timeout: 1000});
});

test("boundary question-star matching stays on the bounded fixed-width path", () => {
  const {context}=makeWorker();
  const patterns=["?*.pdf","??**PDF","???*İ","a*?","K**??","*?*.pdf*","*.pdf*?*","?*\n","\n*?","?*😀"];
  const alphabet=["a",".","\n","\r","\u2028","\u2029","İ","i","K","k","😀","\ud800","\udc00"];
  const texts=["",...alphabet,...alphabet.flatMap(a=>alphabet.map(b=>a+b)),"a.pdf","A.PDF","a\n.pdf","😀.pdf","a😀"];
  for (const pattern of patterns) {
    const matcher = context.compileWildcardMatcher(pattern);
    for (const text of texts) assert.strictEqual(matcher.test(text), questionGlobReference(pattern, text), JSON.stringify([pattern, text]));
  }
  vm.runInContext(`
    Uint8Array = function() { throw Error('unexpected DP for boundary wildcard'); };
    const matcher = compileWildcardMatcher('?'.repeat(100) + '*z');
    if (!matcher.test('a'.repeat(100) + 'z') || !matcher.test('😀'.repeat(100) + 'z')) throw Error('missing match');
    if (matcher.test('a'.repeat(20000)) || matcher.test('😀'.repeat(20000))) throw Error('bad match');
  `, context, {timeout: 1000});
});
test("Kelvin and long-s boundary globs match Python Unicode case folding", async () => {
  const input = [
    {...records[0],Repo:'Repo/A',File:'book',Folder:[]},
    {...records[0],Repo:'Repo/A',File:'loss',Folder:[]},
    {...records[0],Repo:'Repo/B',File:'book',Folder:[]},
  ];
  for (const [q,expected] of [['K*',['book']],['*K',['book']],['**ſ**',['loss']]]) {
    const result=await namesWithCorpus(input,{q,exact:true,repos:['Repo/A'],searchFolders:false});
    assert.deepStrictEqual(result,expected,q);
  }
  assert.deepStrictEqual(await namesWithCorpus(input,{q:'K',exact:true,repos:['Repo/A'],searchFolders:false}),['book']);
  assert.deepStrictEqual(await namesWithCorpus(input,{q:'ſ',exact:true,repos:['Repo/A'],searchFolders:false}),[]);
  assert.deepStrictEqual(await namesWithCorpus(input,{q:'ſ*',exact:false,repos:['Repo/A'],searchFolders:false}),['loss']);
});

test("ordered interior stars preserve overlapping literals and line boundaries", () => {
  const {context} = makeWorker();
  const cases = [
    ["a*b", "BA", false], ["a*b", "bAaB", true],
    ["ab*bc", "abc", false], ["ab*bc", "abbc", true],
    ["a**b*c", "axbxxc", true], ["*a*b*", "xaBY", true],
    ["a*b", "a\nb", false], ["a*b", "a\na--b", true],
    ["a*b", "a\rb", false], ["a*b", "a\u2028b", false],
    ["a*b", "a\u2029b", false], ["a*b", "a😀b", true],
    ["a*\nb", "a--\nb", true], ["a?*b", "a\nb", false],
    ["中*文", "中\n文", false], ["İ*K", "i--k", false],
    ["开?*终", "开📚终", true], ["开*?终", "开📚终", true],
    ["开??*终", "开📚终", false], ["开?*?终", "开📚书终", true],
    ["开?*?终", "开📚终", false], ["开?*终", "开📚\u2028终", false],
    ["开?*📚终", "开a📚终", true], ["开?*\udcda终", "开a📚终", false],
    ["K?*终", "k📚终", false], ["𐐀?*终", "𐐨📚终", false],
  ];
  for (const [pattern, text, expected] of cases) {
    const matcher = context.compileWildcardMatcher(pattern);
    assert.strictEqual(matcher.test(text), expected, JSON.stringify([pattern, text]));
    assert.strictEqual(matcher.test(text), expected, "repeated " + JSON.stringify([pattern, text]));
  }
  vm.runInContext('if (compileWildcardMatcher("*a".repeat(100)+"*b").test("a".repeat(20000))) throw Error("bad match");', context, {timeout: 1000});
  // Both mandatory literals are present, so the DP must reject without
  // backtracking over the many ways stars could divide the first line.
  vm.runInContext(`
    if (compileWildcardMatcher('a?*'.repeat(60) + 'z').test('a📚'.repeat(10000) + '\\nz')) throw Error('crossed a line terminator');
  `, context, {timeout: 1000});
});

test("mixed wildcard runs preserve dot semantics with linear bounded scans", () => {
  const {context} = makeWorker();
  for (const pattern of ["??", "*?", "?*", "*?*", "?*?", "**??***?*"]) {
    const matcher = context.compileWildcardMatcher(pattern);
    const regex = new RegExp(pattern.replace(/\*/g, ".*").replace(/\?/g, "."), "u");
    for (const text of ["", "a", "abc", "😀", "\ud800", "\udc00", "a\nb", "a\rb", "a\u2028b", "a\u2029b", "ab\ncd"]) {
      assert.strictEqual(matcher.test(text), regex.test(text), JSON.stringify([pattern, text]));
      assert.strictEqual(matcher.test(text), regex.test(text), "repeat " + JSON.stringify([pattern, text]));
    }
  }
  vm.runInContext(`(() => {
    const matcher = compileWildcardMatcher('?*'.repeat(512));
    if (matcher.test(('a'.repeat(511)+'\\n').repeat(1000))) throw Error('crossed a line terminator');
    if (matcher.test('😀'.repeat(511))) throw Error('counted UTF-16 units');
    if (!matcher.test('😀'.repeat(512))) throw Error('wrong code-point width');
  })()`, context, {timeout: 1000});
});

test("question-only wildcard consumes code points and preserves legacy case and dot rules", () => {
  const {context} = makeWorker();
  for (const [pattern, text, expected] of [
    ["a?b", "xaAbx", true], ["a?b", "a\nb", false],
    ["a?b", "a\rb", false], ["a?b", "a\u2028b", false],
    ["a?b", "a\u2029b", false], ["a?b", "a\u0085b", true],
    ["İ?K", "i📚k", false], ["K?", "k📚", false], ["ſ?", "s📚", false],
    ["Σ?", "ς📚", true], ["𐐀?", "𐐨📚", false],
    ["[.?]", "x[.z]y", true], ["[.?]", "x[z.]y", false],
    ["开?终", "开📚终", true], ["开??终", "开📚终", false],
    ["开?终", "开e\u0301终", false], ["开??终", "开e\u0301终", true],
    ["开?终", "开\ud83d终", true], ["开?终", "开\udcda终", true],
    ["?终", "📚终", true], ["??终", "📚终", false],
    ["开?", "开📚", true], ["开??", "开📚", false],
    ["开?\udcda", "开📚", false], ["\ud83d?终", "📚终", false],
    ["开?终", "开\udcda终📚", true], ["\ud83d?终", "📚\ud83da终", true],
    ["😀?", "😀📚", true], ["??", "😀", false],
    ["?", "\n", false], ["???", "ab", false],
  ]) {
    const matcher = context.compileWildcardMatcher(pattern);
    assert.strictEqual(matcher.test(text), expected, JSON.stringify([pattern,text]));
    assert.strictEqual(matcher.test(text), expected, "repeat " + JSON.stringify([pattern,text]));
  }
  vm.runInContext('if (compileWildcardMatcher("a".repeat(254)+"?b").test("a".repeat(20000))) throw Error("bad match")',context,{timeout:1000});
});

test("question-only long fields skip the full scan if a required literal is absent", () => {
  const {context} = makeWorker();
  const check = vm.runInContext(`(() => {
    const original = RegExp.prototype.test;
    let full = 0;
    RegExp.prototype.test = function(text) { if (this.source.length > 100) full++; return original.call(this,text); };
    try {
      const matcher = compileWildcardMatcher('a' + '?'.repeat(126) + 'z');
      const absent = matcher.test('a'.repeat(4097));
      const afterAbsent = full;
      const present = matcher.test('a'.repeat(4097)+'z');
      const afterPresent = full;
      const short = matcher.test('a'.repeat(4096));
      return {absent,afterAbsent,present,afterPresent,short,afterShort:full};
    } finally { RegExp.prototype.test = original; }
  })()`,context);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(check)), {absent:false,afterAbsent:0,present:true,afterPresent:1,short:false,afterShort:2});
  assert.strictEqual(context.compileWildcardMatcher('???').test('x'.repeat(4097)), true);
  assert.strictEqual(context.compileWildcardMatcher('a?b').test('x'.repeat(4097) + 'a\nb'), false);
});

test("question globs match Unicode code points in file, repo and folder fields", async () => {
  const {worker} = await loaded([
    {...records[0], File:"开📚终"},
    {...records[0], File:"开ab终"},
    {...records[0], Repo:"Repo/开📚终", File:"repo match"},
    {...records[0], Folder:["开📚终"], File:"folder match"},
    {...records[0], File:"开📚\n终"},
  ]);
  for (const exact of [true, false]) {
    for (const [q, searchFolders, expected] of [
      ["开?终", true, ["开📚终", "folder match", "repo match"]],
      ["开??终", true, ["开ab终"]],
      ["开?*终", false, ["开📚终", "开ab终", "repo match"]],
      ["开?*?终", true, ["开ab终"]],
      ["开?终*.TXT", true, ["开📚终"]],
    ]) {
      const result = await worker.request("local-search", {q, exact, searchFolders});
      assert.deepStrictEqual(result.records.map(record => record.File), expected, q);
      assert.strictEqual(result.total, expected.length, q);
    }
  }
});

test("wildcard search returns complete IDs for repeated-star patterns", async () => {
  const {worker} = await loaded([{...records[0], File: "a".repeat(120)}, {...records[1], File: "b"}]);
  assert.deepStrictEqual((await worker.request("local-search", {q:"*a".repeat(10)+"a", exact:true})).records.map(r=>r.File), ["a".repeat(120)]);
  assert.strictEqual((await worker.request("local-search", {q:"*a".repeat(10)+"b", exact:true})).total, 0);
});

const chapterOnlyBooks = ["epub", "mobi", "azw", "azw3", "fb2", "fbz"];

test("bare ebooks are downloadable but not counted or sampled for random reading", async () => {
  const input = chapterOnlyBooks.map(Extension => ({ ...records[0], Extension }));
  const { worker, metadata } = await loaded(input);
  assert.deepStrictEqual(metadata.reader, { available: false, count: 0, byRepo: {} });
  for (const repo of ["", "Repo/A"]) {
    const result = await worker.request("random-record", { repo, readerOnly: true, randomValue: 0 });
    assert.strictEqual(result.record, null);
    assert.strictEqual(result.id, null);
  }
  const download = await worker.request("random-record", { repo: "Repo/A", randomValue: 0 });
  assert.strictEqual(download.record.Extension, "epub");
});
test("local random reader counts match the native sampling range globally and by repository", async () => {
  const native = ["pdf", "djvu", "html", "htm", "txt", "md", "markdown", "vcf", "ini",
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "mp3", "mp4", "wav", "m4a", "flac",
    "mov", "mpga", "wma", "ape", "amr", "swf"];
  const input = native.concat(chapterOnlyBooks, ["caj", "kdh", "ps", "docx", "tif", "tiff"]).map((extension, i) => ({
    ...records[0], Repo: i % 2 ? "Repo/B" : "Repo/A", File: "book" + i, Extension: extension.toUpperCase(),
  }));
  const {worker, metadata} = await loaded(input);
  assert.strictEqual(metadata.reader.available, true);
  assert.strictEqual(metadata.reader.count, native.length);
  // Keep file-format support aligned with the Reader's own public contract.
  const readerContext = {self:{}};
  vm.createContext(readerContext);
  vm.runInContext(fs.readFileSync('static/reader/core/reader-contract.js', 'utf8'), readerContext);
  const reader = readerContext.self.VoiceOfMLReader;
  for (const extension of native) assert.strictEqual(reader.capability(extension).article, true, extension);
  for (const extension of chapterOnlyBooks.concat(["caj", "kdh", "ps", "docx"])) {
    assert.strictEqual(reader.capability(extension).article, false, extension);
  }
  for (const repo of ["", "Repo/A", "Repo/B"]) {
    const expected = input.slice(0, native.length).filter(record => !repo || record.Repo === repo);
    const count = repo ? metadata.reader.byRepo[repo] : metadata.reader.count;
    assert.strictEqual(count, expected.length, repo);
    for (let i = 0; i < count; i++) {
      const found = await worker.request("random-record", { repo, readerOnly: true, randomValue: (i + .5) / count });
      assert.deepStrictEqual(found.record, expected[i]);
    }
  }
});
function scheduledWorker(options = {}) {
  const tasks = new Map();
  let nextId = 0;
  const worker = makeWorker(source, Object.assign({
    setTimeout(fn, delay) { const id = ++nextId; tasks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
  }, options));
  function tick() {
    const [id, task] = tasks.entries().next().value;
    tasks.delete(id);
    task.fn();
  }
  worker.context.drive = () => { if (tasks.size) tick(); };
  return { worker, tasks, tick };
}

test("demanded indexing yields to metadata and cancellation without discarding partial progress", async () => {
  const {worker, tasks, tick} = scheduledWorker({navigator: {deviceMemory: 2}});
  await worker.request("replace-corpus", {data: compact(Array.from({length: 1200}, () => records[0]))});
  while (tasks.size) tick();
  const pending = worker.listeners.message({data:{protocol:1, type:"local-search", id:"slow", payload:{q:"alpha"}}});
  await Promise.resolve();
  assert(vm.runInContext("fulltextBuild.next > 0 && fulltextBuild.next < records.length", worker.context));
  const metadata = await worker.request("metadata");
  assert.strictEqual(metadata.count, 1200);
  await worker.request("cancel-search", {requestId:"slow"}, {id:"cancel"});
  tick(); await pending;
  const response = worker.messages.find(message => message.id === "slow");
  assert.strictEqual(response.error.code, "SEARCH_CANCELLED");
  assert(vm.runInContext("fulltextBuild !== null && searchJobs.size === 0", worker.context));
  assert.strictEqual((await worker.request("local-search", {q:"alpha"})).total, 1200);
});

test("single-character cold search agrees with a warmed index without building one", async () => {
  const input = [
    {Repo:"Repo/x",File:"plain",Extension:"pdf",Folder:["alpha"],Size:1,HasTxt:false},
    {Repo:"Repo/B",File:"alpha",Extension:"xtx",Folder:[],Size:2,HasTxt:false},
    {Repo:"Repo/B",File:"axle",Extension:"txt",Folder:["x"],Size:3,HasTxt:false},
    {Repo:"Repo/C",File:"𠮷猫",Extension:"txt",Folder:[],Size:4,HasTxt:false},
    {Repo:"Repo/C",File:"İ",Extension:"txt",Folder:[],Size:5,HasTxt:false},
    {Repo:"Repo/B",File:"手。机",Extension:"txt",Folder:[],Size:6,HasTxt:false},
  ];
  const cold = await loaded(input), warm = await loaded(input);
  vm.runInContext('buildFulltext()', warm.worker.context);
  for (const q of ['x', 'X', 'a', '猫', '𠮷', 'İ', '。']) {
    for (const filters of [{}, {searchFolders:false}, {repos:['Repo/B']},
      {repos:['Repo/B'],extensions:['txt'],sort:'name'}, {folders:['x'],folderMatchMode:'exact'}]) {
      const params={q,exact:false,page:1,pageSize:2,...filters};
      for (const page of [1,2]) {
        const a=await cold.worker.request('local-search',{...params,page});
        const b=await warm.worker.request('local-search',{...params,page});
        assert.deepStrictEqual(a.ids,b.ids,JSON.stringify({q,filters,page}));
        assert.strictEqual(a.total,b.total,JSON.stringify({q,filters}));
      }
    }
  }
  assert.strictEqual(vm.runInContext('wordIndex === null && fulltextBuild === null',cold.worker.context),true);
});

test("single-character scans preserve all indexed results for varied fields and filters", async () => {
  const values=['a','A','x','X','猫','手','机','😀','𠮷','İ','ı','K','ſ','。','.', 'ß','Σ','ς','/','-',' '];
  let seed=19;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const word=()=>Array.from({length:1+random(7)},()=>values[random(values.length)]).join('');
  const input=Array.from({length:96},(_,i)=>({Repo:i%3?'Repo/A':'Repo/B',File:word(),Extension:word(),
    Folder:[word(),word()],Size:i+1,HasTxt:false}));
  const cold=await loaded(input),warm=await loaded(input);
  vm.runInContext('buildFulltext()',warm.worker.context);
  for(const q of values.filter(value=>value.trim())) for(const filters of [
    {},{searchFolders:false},{repos:['Repo/A'],extensions:['txt']},{sort:'name'},
    {folderMatchMode:'mixed',folderSelfs:[input[0].Folder.join('/')]},
  ]){
    const params={q,exact:false,pageSize:7,...filters};
    const first=await cold.worker.request('local-search',params);
    const second=await warm.worker.request('local-search',params);
    assert.deepStrictEqual(first.ids,second.ids,JSON.stringify(params));
    assert.strictEqual(first.total,second.total,JSON.stringify(params));
  }
  assert(vm.runInContext('wordIndex === null && fulltextBuild === null',cold.worker.context));
});

test("cached single-character pages skip rescans without weakening eviction or generation checks", async () => {
  const input=Array.from({length:1200},(_,i)=>({...records[0],File:'alpha '+i}));
  const {worker}=await loaded(input);
  const params={q:'a',exact:false,pageSize:17};
  const first=await worker.request('local-search',params);
  const completeFirstPage=await worker.request('local-search',{...params,pageSize:500});
  vm.runInContext(`globalThis.savedPrepareChar = prepareSingleCharacter;
    globalThis.savedPrepareIndex = prepareSearchIndex;
    prepareSingleCharacter = () => {throw Error('cached page rescanned')};
    prepareSearchIndex = () => {throw Error('cached page rebuilt index')};`,worker.context);
  const later=await worker.request('local-search',{...params,page:2,pageSize:23});
  assert.strictEqual(later.total,first.total);
  assert.deepStrictEqual(later.ids,completeFirstPage.ids.slice(23,46));
  assert.strictEqual(later.snapshot_generation,first.snapshot_generation);
  vm.runInContext('prepareSingleCharacter = savedPrepareChar; prepareSearchIndex = savedPrepareIndex',worker.context);
  const paged=await worker.request('local-search',{...params,page:1,pageSize:500});
  const anchor = 'Repo/A\0docs/root/alpha 1199.txt';
  vm.runInContext(`globalThis.savedFields = getRecordSearchFields;
    getRecordSearchFields = () => {throw Error('cache miss rescanned')};`,worker.context);
  const position=await worker.request('local-search',{...params,page:3,pageSize:1,anchorId:anchor});
  assert.strictEqual(position.anchor_index,1199);
  assert.strictEqual(paged.total,1200);
  const key=vm.runInContext('searchOrderKey({q:"a",exact:false,pageSize:17})',worker.context);
  worker.context.cachedParams={...params,page:2};
  assert.strictEqual(vm.runInContext(`searchOrderKey(cachedParams) === ${JSON.stringify(key)}`,worker.context),true);
  await assert.rejects(() => vm.runInContext('dispatch("local-search", cachedParams, {generation, cancelled:true})',worker.context),
    error => error.code === 'SEARCH_CANCELLED');
  await assert.rejects(() => vm.runInContext('dispatch("local-search", cachedParams, {generation:generation-1, cancelled:false})',worker.context),
    error => error.code === 'CORPUS_REPLACED');
  const missing=await worker.send('local-search',{...params,searchFolders:false},{id:'changed'});
  assert.strictEqual(missing.error.message,'cache miss rescanned');
  vm.runInContext('getRecordSearchFields = savedFields',worker.context);
  for (let i=0;i<8;i++) await worker.request('local-search',{q:'z'+i,exact:true});
  assert.strictEqual(vm.runInContext(`searchOrderCache.has(${JSON.stringify(key)})`,worker.context),false);
  vm.runInContext('getRecordSearchFields = () => {throw Error("evicted page rescanned")}',worker.context);
  assert.strictEqual((await worker.send('local-search',params)).error.message,'evicted page rescanned');
  vm.runInContext('getRecordSearchFields = savedFields',worker.context);
  await worker.request('replace-corpus',{data:compact([{...records[0],File:'another'}])});
  const replacement=await worker.request('local-search',params);
  assert.strictEqual(replacement.total,1);
  assert.notStrictEqual(replacement.snapshot_generation,first.snapshot_generation);
});

test("cached orders return without an asynchronous preparation window", async () => {
  const {worker}=await loaded(Array.from({length:1200},(_,i)=>({...records[0],File:'alpha '+i})));
  const params={q:'a',exact:false,pageSize:5};
  await worker.request('local-search',params);
  const pending=worker.listeners.message({data:{protocol:1,type:'local-search',id:'cached-now',payload:{...params,page:2}}});
  await Promise.resolve();
  const message=worker.messages.find(item=>item.id==='cached-now');
  assert(message && message.ok, 'cached result must be published without a preparatory scan');
  assert.strictEqual(message.result.total,1200);
  await pending;
});

test("single-character scans yield, cancel and reject old corpus generations", async () => {
  const {worker,tasks,tick}=scheduledWorker({navigator:{deviceMemory:2}});
  const input=Array.from({length:1200},(_,i)=>({...records[0],File:'alpha '+i}));
  await worker.request('replace-corpus',{data:compact(input)});
  while(tasks.size) tick();
  const work=worker.listeners.message({data:{protocol:1,type:'local-search',id:'char',payload:{q:'a'}}});
  await Promise.resolve();
  assert.strictEqual((await worker.request('metadata')).count,1200);
  await worker.request('cancel-search',{requestId:'char'},{id:'cancel-char'});
  while(tasks.size){tick();await Promise.resolve();}
  await work;
  assert.strictEqual(worker.messages.find(message=>message.id==='char').error.code,'SEARCH_CANCELLED');
  assert(vm.runInContext('wordIndex === null && fulltextBuild === null',worker.context));
  const pending=worker.listeners.message({data:{protocol:1,type:'local-search',id:'old-char',payload:{q:'a'}}});
  await Promise.resolve();
  await worker.request('replace-corpus',{data:compact([records[4]])},{id:'replace-char'});
  while(tasks.size){tick();await Promise.resolve();}
  await pending;
  assert.strictEqual(worker.messages.find(message=>message.id==='old-char').error.code,'CORPUS_REPLACED');
  assert.strictEqual((await worker.request('local-search',{q:'手'})).total,1);
});

test("long wildcard search yields to metadata and cancellation", async () => {
  const {worker, tasks, tick} = scheduledWorker({navigator:{deviceMemory:2}});
  await worker.request("replace-corpus", {data:compact(Array.from({length:1200},()=>records[0]))});
  while (tasks.size) tick();
  const pending = worker.listeners.message({data:{protocol:1,type:"local-search",id:"wildcard",payload:{q:"a?*".repeat(20),exact:true}}});
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual((await worker.request("metadata")).count, 1200);
  await worker.request("cancel-search", {requestId:"wildcard"}, {id:"cancel-wildcard"});
  while (tasks.size) { tick(); await Promise.resolve(); }
  await pending;
  assert.strictEqual(worker.messages.find(message=>message.id==="wildcard").error.code,"SEARCH_CANCELLED");
});

test("yielded multi-term wildcards preserve ordinary matching and order", async () => {
  const prefix = "alpha " + "ax".repeat(10);
  const input = [
    {...records[0], File: prefix + "开📚终"},
    {...records[0], File: prefix + "开📚📚终"},
    {...records[0], File: prefix + "开书终"},
    {...records[1], File: "beta"},
  ];
  const {worker} = await loaded(input);
  const q = "alpha " + "a?*".repeat(10) + "开?终";
  const expected = vm.runInContext(`searchLocal({q:${JSON.stringify(q)},exact:true,pageSize:5}).ids`, worker.context);
  vm.runInContext('searchOrderCache.clear()', worker.context);
  const result = await worker.request('local-search', {q,exact:true,pageSize:5});
  assert.deepStrictEqual(result.records.map(record => record.File), [input[0].File, input[2].File]);
  assert.deepStrictEqual(result.ids, Array.from(expected));
});

test("query limit counts Unicode code points", async () => {
  const {worker} = await loaded();
  assert.strictEqual((await worker.send("local-search", {q:"😀".repeat(257),exact:true})).error.code, "QUERY_TOO_LONG");
  assert.strictEqual((await worker.send("local-search", {q:"😀".repeat(256),exact:true})).ok, true);
});

test("corpus replacement invalidates a yielded foreground query", async () => {
  const {worker, tasks, tick} = scheduledWorker({navigator:{deviceMemory:2}});
  await worker.request("replace-corpus", {data:compact(Array.from({length:700},()=>records[0]))});
  while (tasks.size) tick();
  const pending = worker.listeners.message({data:{protocol:1,type:"local-search",id:"old",payload:{q:"alpha"}}});
  await Promise.resolve();
  await worker.request("replace-corpus", {data:compact([records[4]])}, {id:"replace"});
  while (tasks.size) { tick(); await Promise.resolve(); }
  await pending;
  assert.strictEqual(worker.messages.find(message=>message.id==="old").error.code,"CORPUS_REPLACED");
  assert.strictEqual((await worker.request("local-search",{q:"手机"})).total,1);
});

test("speculative sort preparation defers while demand indexing is active", async () => {
  const {worker, tasks, tick} = scheduledWorker({navigator:{deviceMemory:2}});
  await worker.request("replace-corpus", {data:compact(Array.from({length:700},()=>records[0]))});
  const pending = worker.listeners.message({data:{protocol:1,type:"local-search",id:"demand",payload:{q:"alpha"}}});
  await Promise.resolve();
  tick();
  assert(vm.runInContext("!nameOrderReady && !sizeOrderReady && sortBuildTimer !== null",worker.context));
  await worker.request("cancel-search",{requestId:"demand"},{id:"cancel"});
  tick(); await pending;
  while(tasks.size) tick();
  assert(vm.runInContext("nameOrderReady && !sizeOrderReady",worker.context));
  await worker.request("local-search", {sort:"size"});
  assert(vm.runInContext("sizeOrderReady",worker.context));
});
test("background indexing yields, publishes complete indexes and preserves cold search results", async () => {
  const input = Array.from({length: 400}, (_, i) => Object.assign({}, records[i % records.length]));
  const cold = await loaded(input);
  const { worker, tasks, tick } = scheduledWorker();
  await worker.request("replace-corpus", {data: compact(input)});
  tick(); // Existing sort preparation.
  tick(); // Only one word-index slice.
  assert.strictEqual(vm.runInContext("wordIndex === null && fulltextBuild.next > 0 && fulltextBuild.next <= FULLTEXT_BATCH_RECORDS", worker.context), true);
  assert.strictEqual((await worker.request("metadata")).count, input.length);
  assert.strictEqual((await worker.request("local-search", {q: "手*机", exact: true})).total,
    (await cold.worker.request("local-search", {q: "手*机", exact: true})).total);
  while (tasks.size) tick();
  assert.strictEqual(vm.runInContext("wordIndex !== null && fulltextBuild === null", worker.context), true);
  for (const params of [{q: "alpha beta"}, {q: "alhpa"}, {q: "手机"}, {q: "alpha", searchFolders: false}]) {
    const warmed = await worker.request("local-search", params);
    const expected = await cold.worker.request("local-search", params);
    assert.deepStrictEqual(warmed.ids, expected.ids);
    assert.strictEqual(warmed.total, expected.total);
  }
});
test("shared token parts preserve complete postings and length buckets with bounded folder reuse", async () => {
  const input = Array.from({length: 600}, (_, i) => ({...records[0],
    File: ["A123文化B", "文化 beta 123", "İ手机", "alpha alpha", "文。化", ""][i % 6],
    Folder: ["目录 alpha " + (i % 80), "手机 Beta 123"]}));
  input[1].Folder = ["z".repeat(70000)];
  function referenceTokens(text) {
    const lower = String(text || "").toLowerCase(), tokens = lower.match(/[a-z0-9]+/g) || [];
    for (const run of lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []) {
      for (const char of run) tokens.push(char);
      for (let i = 0; i < run.length - 1; i++) tokens.push(run[i] + run[i + 1]);
    }
    return Array.from(new Set(tokens));
  }
  const expected = {all: {}, files: {}};
  input.forEach((r, i) => {
    for (const token of referenceTokens([r.File || ""].concat(r.Folder).join(" "))) {
      if (!expected.all[token]) expected.all[token] = [];
      expected.all[token].push(i);
    }
    for (const token of referenceTokens(r.File)) {
      if (!expected.files[token]) expected.files[token] = [];
      expected.files[token].push(i);
    }
  });
  const {worker} = await loaded(input);
  vm.runInContext("advanceFulltext(500, Infinity)", worker.context);
  assert.strictEqual(vm.runInContext("fulltextBuild.folderTokens.size <= 64 && fulltextBuild.folderUnits <= 65536", worker.context), true);
  assert.strictEqual(vm.runInContext('fulltextBuild.folderTokens.has("z".repeat(70000))', worker.context), false);
  vm.runInContext("buildFulltext()", worker.context);
  const actual = JSON.parse(vm.runInContext(`JSON.stringify({
    all: Object.fromEntries(Object.entries(wordIndex).map(([key, value]) => [key, Array.from(value)])),
    files: Object.fromEntries(Object.entries(wordIndexFilesOnly).map(([key, value]) => [key, Array.from(value)]))
  })`, worker.context));
  assert.strictEqual(vm.runInContext('Object.values(wordIndex).every(value => value instanceof Uint32Array)', worker.context), true);
  for (const name of ["all", "files"]) {
    assert.deepStrictEqual(Object.entries(actual[name]), Object.entries(expected[name]));
    const buckets = Object.groupBy(Object.keys(expected[name]), token => token.length);
    const variable = name === "all" ? "vocabByLength" : "vocabByLengthFilesOnly";
    const published = JSON.parse(vm.runInContext(`JSON.stringify(Object.fromEntries(${variable}))`, worker.context));
    assert.deepStrictEqual(published, {...buckets});
  }
  assert.strictEqual(vm.runInContext("fulltextBuild === null", worker.context), true);
});
test("length buckets honor deadlines and work caps and never publish across generations", async () => {
  const input = Array.from({length: 5000}, (_, i) => ({...records[0], File: `unique${i}`}));
  const worker = makeWorker(source, {Date: {now: () => 0}});
  await worker.request("replace-corpus", {data:compact(input)});
  vm.runInContext("advanceFulltext(records.length, 0)", worker.context);
  assert(vm.runInContext("fulltextBuild.next === 1 && wordIndex === null", worker.context));
  vm.runInContext("advanceFulltext(records.length, 1)", worker.context);
  assert(vm.runInContext(`wordIndex === null && wordIndexFilesOnly === null &&
    vocabByLength.size === 0 && vocabByLengthFilesOnly.size === 0 &&
    fulltextBuild.allVocab.next === 4096 && fulltextBuild.filesVocab === undefined`, worker.context));
  vm.runInContext("advanceFulltext(records.length, 0)", worker.context);
  assert(vm.runInContext("fulltextBuild.allVocab.next === 4096", worker.context));
  vm.runInContext("advanceFulltext(records.length, 1)", worker.context);
  assert(vm.runInContext("fulltextBuild.filesVocab.next === 4096 && wordIndex === null", worker.context));
  await worker.request("replace-corpus", {data:compact([{...records[0], File:"unique", Folder:[]}])});
  assert(vm.runInContext("fulltextBuild === null && vocabByLength.size === 0 && vocabByLengthFilesOnly.size === 0", worker.context));
  assert.strictEqual((await worker.request("local-search", {q:"uniqux"})).total, 1);
  assert(vm.runInContext(`wordIndex !== null && wordIndexFilesOnly !== null && fulltextBuild === null &&
    vocabByLength.size === 1 && vocabByLengthFilesOnly.size === 1 &&
    vocabByLength.get(6).join() === "unique" && vocabByLengthFilesOnly.get(6).join() === "unique"`, worker.context));
  await worker.request("replace-corpus", {data:compact([])});
  assert(vm.runInContext("wordIndex === null && vocabByLength.size === 0 && vocabByLengthFilesOnly.size === 0", worker.context));
});
test("posting compaction yields before atomic publication and resumes after cancellation", async () => {
  const input = Array.from({length: 5000}, (_, i) => ({...records[0], File: `unique${i}`}));
  const {worker, tasks, tick} = scheduledWorker({navigator:{deviceMemory:2}});
  await worker.request("replace-corpus", {data:compact(input)});
  while (tasks.size) tick();
  // Prepare through vocabulary construction; leave conversion to the same
  // demanded, yielding path used by a real Worker search.
  vm.runInContext(`globalThis.savedCompaction = advancePostingCompaction;
    advancePostingCompaction = () => false; advanceFulltext(records.length, Infinity);
    advancePostingCompaction = savedCompaction;`, worker.context);
  const pending = worker.listeners.message({data:{protocol:1,type:"local-search",id:"compact",payload:{q:"unique1"}}});
  await Promise.resolve();
  assert(vm.runInContext(`wordIndex === null && wordIndexFilesOnly === null &&
    fulltextBuild.allCompaction.next > 0 && fulltextBuild.allCompaction.next < fulltextBuild.allCompaction.keys.length`, worker.context));
  assert.strictEqual((await worker.request("metadata")).count, input.length);
  await worker.request("cancel-search", {requestId:"compact"}, {id:"cancel-compact"});
  while (tasks.size) { tick(); await Promise.resolve(); }
  await pending;
  assert.strictEqual(worker.messages.find(message=>message.id==="compact").error.code, "SEARCH_CANCELLED");
  assert(vm.runInContext("wordIndex === null && fulltextBuild !== null", worker.context));
  const result = await worker.request("local-search", {q:"unique1"});
  const expected = await (await loaded(input)).worker.request("local-search", {q:"unique1"});
  assert.deepStrictEqual(result.ids, expected.ids);
  assert.strictEqual(result.total, expected.total);
  assert(vm.runInContext("wordIndex !== null && wordIndexFilesOnly !== null && fulltextBuild === null", worker.context));
});
test("file-only compaction reuses equal postings but converts differing postings", async () => {
  const input = [{...records[0],File:"unique shared",Folder:[]},
    {...records[1],File:"unique",Folder:[]}, {...records[2],File:"other",Folder:["shared"]}];
  const {worker}=await loaded(input);
  vm.runInContext(`globalThis.realCompact=advancePostingCompaction;
    advancePostingCompaction=()=>false;advanceFulltext(records.length,Infinity);advancePostingCompaction=realCompact;
    realCompact(fulltextBuild.all,fulltextBuild.allCompaction,Infinity);
    fulltextBuild.filesCompaction={keys:fulltextBuild.filesVocab.keys,next:0};
    globalThis.originalFrom=Uint32Array.from;globalThis.conversions=0;
    Uint32Array.from=function(value){conversions++;return originalFrom.call(Uint32Array,value)};
    realCompact(fulltextBuild.files,fulltextBuild.filesCompaction,Infinity,fulltextBuild.all);
    Uint32Array.from=originalFrom;`,worker.context);
  assert(vm.runInContext('fulltextBuild.files.unique === fulltextBuild.all.unique',worker.context));
  assert(vm.runInContext('fulltextBuild.files.shared !== fulltextBuild.all.shared',worker.context));
  assert(vm.runInContext('conversions > 0 && conversions < fulltextBuild.filesVocab.keys.length',worker.context));
  vm.runInContext('buildFulltext()',worker.context);
  assert.strictEqual((await worker.request("local-search",{q:"unique",searchFolders:false})).total,2);
});
test("file-only compaction yields and resumes with shared postings", async () => {
  const input=Array.from({length:5000},(_,i)=>({...records[0],File:`unique${i} shared`,Folder:[]}));
  input.push({...records[1],File:"other",Folder:["shared"]});
  const {worker,tasks,tick}=scheduledWorker({navigator:{deviceMemory:2}});
  await worker.request("replace-corpus",{data:compact(input)});
  while(tasks.size) tick();
  vm.runInContext(`globalThis.realCompact=advancePostingCompaction;advancePostingCompaction=()=>false;
    advanceFulltext(records.length,Infinity);advancePostingCompaction=realCompact;
    realCompact(fulltextBuild.all,fulltextBuild.allCompaction,Infinity);
    fulltextBuild.filesCompaction={keys:fulltextBuild.filesVocab.keys,next:0}`,worker.context);
  const pending=worker.listeners.message({data:{protocol:1,type:"local-search",id:"file-compact",payload:{q:"unique1"}}});
  await Promise.resolve();
  assert(vm.runInContext('wordIndex === null && fulltextBuild.filesCompaction.next > 0 && fulltextBuild.filesCompaction.next < fulltextBuild.filesCompaction.keys.length',worker.context));
  assert.strictEqual((await worker.request("metadata")).count,input.length);
  await worker.request("cancel-search",{requestId:"file-compact"},{id:"cancel-file-compact"});
  while(tasks.size){tick();await Promise.resolve()}
  await pending;
  assert.strictEqual(worker.messages.find(message=>message.id==="file-compact").error.code,"SEARCH_CANCELLED");
  const result=await worker.request("local-search",{q:"unique1",searchFolders:false});
  assert.strictEqual(result.total,1111); // literal substring unique1, unique10…unique1999
  assert(vm.runInContext('wordIndexFilesOnly.unique1 === wordIndex.unique1',worker.context));
});
test("partially shared file postings resume after a conversion failure", async () => {
  const input=[{...records[0],File:"unique shared",Folder:[]},
    {...records[1],File:"unique",Folder:[]},{...records[2],File:"other",Folder:["shared"]}];
  const {worker}=await loaded(input);
  vm.runInContext(`globalThis.realCompact=advancePostingCompaction;advancePostingCompaction=()=>false;
    advanceFulltext(records.length,Infinity);advancePostingCompaction=realCompact;
    realCompact(fulltextBuild.all,fulltextBuild.allCompaction,Infinity);
    fulltextBuild.filesCompaction={keys:["unique","shared","other"],next:0};
    globalThis.originalFrom=Uint32Array.from;Uint32Array.from=()=>{throw Error("file conversion failed")}`,worker.context);
  assert.throws(()=>vm.runInContext('advanceFulltext(records.length,Infinity)',worker.context),/file conversion failed/);
  assert(vm.runInContext('wordIndex === null && wordIndexFilesOnly === null && fulltextBuild.filesCompaction.next === 1 && fulltextBuild.files.unique === fulltextBuild.all.unique',worker.context));
  vm.runInContext('Uint32Array.from=originalFrom;buildFulltext()',worker.context);
  assert.strictEqual((await worker.request("local-search",{q:"shared",searchFolders:false})).total,1);
});
test("posting compaction resumes after a conversion failure without publishing partial indexes", async () => {
  const {worker} = await loaded(records);
  vm.runInContext(`globalThis.originalCompact = advancePostingCompaction;
    advancePostingCompaction = () => false; advanceFulltext(records.length, Infinity);
    advancePostingCompaction = originalCompact;
    globalThis.originalFrom = Uint32Array.from;
    Uint32Array.from = () => { throw Error("conversion failed"); };`, worker.context);
  assert.throws(() => vm.runInContext("advanceFulltext(records.length, Infinity)", worker.context), /conversion failed/);
  assert(vm.runInContext("wordIndex === null && wordIndexFilesOnly === null && fulltextBuild.allCompaction.next === 0", worker.context));
  vm.runInContext("Uint32Array.from = originalFrom; buildFulltext()", worker.context);
  assert.strictEqual((await worker.request("local-search", {q:"alpha"})).total, 3);
});
test("corpus replacement invalidates partial posting compaction", async () => {
  const {worker, tasks, tick} = scheduledWorker({navigator:{deviceMemory:2}});
  await worker.request("replace-corpus", {data:compact(Array.from({length:5000}, (_, i) => ({...records[0],File:`unique${i}`})))});
  while (tasks.size) tick();
  vm.runInContext(`globalThis.savedCompaction = advancePostingCompaction;
    advancePostingCompaction = () => false; advanceFulltext(records.length, Infinity);
    advancePostingCompaction = savedCompaction;`, worker.context);
  const pending = worker.listeners.message({data:{protocol:1,type:"local-search",id:"old-compaction",payload:{q:"unique1"}}});
  await Promise.resolve();
  assert(vm.runInContext("fulltextBuild.allCompaction.next > 0 && wordIndex === null",worker.context));
  await worker.request("replace-corpus", {data:compact([records[4]])}, {id:"new-corpus"});
  while (tasks.size) { tick(); await Promise.resolve(); }
  await pending;
  assert.strictEqual(worker.messages.find(message=>message.id==="old-compaction").error.code, "CORPUS_REPLACED");
  assert.strictEqual((await worker.request("local-search", {q:"手机"})).total, 1);
});
test("foreground indexing resumes partial work and clears the scheduled continuation", async () => {
  const input = Array.from({length: 400}, (_, i) => Object.assign({}, records[i % records.length]));
  const { worker, tasks, tick } = scheduledWorker();
  await worker.request("replace-corpus", {data: compact(input)});
  tick(); tick();
  vm.runInContext("globalThis.partialIndex = fulltextBuild.all", worker.context);
  const result = await worker.request("local-search", {q: "alpha"});
  const expected = await (await loaded(input)).worker.request("local-search", {q: "alpha"});
  assert.deepStrictEqual(result.ids, expected.ids);
  assert.strictEqual(result.total, expected.total);
  assert.strictEqual(vm.runInContext("wordIndex === partialIndex && fulltextBuild === null", worker.context), true);
  assert.strictEqual(tasks.size, 0);
});
test("corpus replacement cancels partial indexing and stale callbacks cannot alter new work", async () => {
  const { worker, tasks, tick } = scheduledWorker();
  await worker.request("replace-corpus", {data: compact(Array.from({length: 400}, () => records[0]))});
  tick(); tick();
  const stale = tasks.values().next().value.fn;
  await worker.request("replace-corpus", {data: compact([records[4]])});
  stale();
  while (tasks.size) tick();
  assert.strictEqual((await worker.request("local-search", {q: "alpha"})).total, 0);
  assert.strictEqual((await worker.request("local-search", {q: "手机"})).total, 1);
});
test("reported low-memory devices retain on-demand word indexing", async () => {
  const { worker, tasks, tick } = scheduledWorker({navigator: {deviceMemory: 2}});
  await worker.request("replace-corpus", {data: compact(records)});
  while (tasks.size) tick();
  assert.strictEqual(vm.runInContext("wordIndex === null && fulltextBuild === null", worker.context), true);
  assert.strictEqual((await worker.request("local-search", {q: "alpha"})).total, 3);
});
test("failed speculative construction leaves the Worker available for a demanded retry", async () => {
  const { worker, tasks, tick } = scheduledWorker();
  await worker.request("replace-corpus", {data: compact(records)});
  tick();
  vm.runInContext('globalThis.originalAdvance = advanceFulltext; advanceFulltext = () => { throw new Error("speculation failed"); };', worker.context);
  tick();
  assert.strictEqual(tasks.size, 0);
  assert.strictEqual((await worker.request("metadata")).count, records.length);
  vm.runInContext('advanceFulltext = originalAdvance;', worker.context);
  assert.strictEqual((await worker.request("local-search", {q: "alpha"})).total, 3);
});
test("directory indexes reuse only their repository and are bounded and replaced with the corpus", async () => {
  const { worker } = await loaded();
  const first = await worker.request("folder-contents", {repo: "Repo/A", path: "docs"});
  assert.deepStrictEqual(first.folders, [
    {name: "child", path: "docs/child", count: 1}, {name: "root", path: "docs/root", count: 1},
  ]);
  vm.runInContext('repoRecordIndices["Repo/A"] = new Proxy([], {get() {throw new Error("repeated repository scan");}})', worker.context);
  assert.deepStrictEqual(await worker.request("folder-contents", {repo: "Repo/A", path: "docs"}), first);
  assert.strictEqual((await worker.request("folder-tree", {repo: "Repo/A"})).tree[0].count, 2);
  await worker.request("folder-tree", {repo: "missing"});
  assert.strictEqual(vm.runInContext("directoryIndexes.size", worker.context), 1);
  const many = Array.from({length: 6}, (_, i) => Object.assign({}, records[0], {Repo: "R/" + i}));
  await worker.request("replace-corpus", {data: compact(many)});
  assert.strictEqual(vm.runInContext("directoryIndexes.size", worker.context), 0);
  for (const record of many) await worker.request("folder-tree", {repo: record.Repo});
  assert.strictEqual(vm.runInContext("directoryIndexes.size", worker.context), 4);
  assert.deepStrictEqual((await worker.request("folder-contents", {repo: "R/0", path: "docs/root"})).files.map(file => file.name), ["alpha guide"]);
});
test("cached pages bypass matching and locate anchors in the complete filtered order", async () => {
  const { worker } = await loaded();
  const first = await worker.request("local-search", {q: "alpha", exact: false, pageSize: 1});
  vm.runInContext('compileWildcardMatcher = () => { throw new Error("unexpected scan"); }; literalSearch = () => { throw new Error("unexpected scan"); };', worker.context);
  const later = await worker.request("local-search", {q: "alpha", exact: false, pageSize: 1, page: 2,
    anchorId: "Repo/A\0docs/child/beta alpha.pdf"});
  assert.strictEqual(later.anchor_index, 1);
  assert.strictEqual(later.records[0].File, "beta alpha");
  assert.strictEqual(later.snapshot_generation, first.snapshot_generation);
  const missing = await worker.request("local-search", {q: "alpha", exact: false, pageSize: 1,
    anchorId: "Repo/B\0archive/beta notes.md"});
  assert.strictEqual(missing.anchor_index, -1);
});
test("same-count corpus replacement changes snapshot identity and relocates anchors", async () => {
  const { worker } = await loaded();
  const params = {pageSize: 1, anchorId: "Repo/A\0docs/root/alpha guide.txt"};
  const old = await worker.request("local-search", params);
  await worker.request("replace-corpus", {data: compact(records.slice().reverse())});
  const current = await worker.request("local-search", params);
  assert.strictEqual(old.total, current.total);
  assert.notStrictEqual(old.snapshot_generation, current.snapshot_generation);
  assert.strictEqual(current.anchor_index, records.length - 1);
});
test("anchor skips other repositories and preserves first duplicate and raw keys", async () => {
  const {worker} = await loaded();
  vm.runInContext(`
    records = [
      {Repo:"Other", get File() {throw Error("unrelated path read");}},
      {Repo:"Target/child", get File() {throw Error("repository boundary missed");}},
      {Repo:"Target", File:"book", Folder:["docs"], Extension:"pdf"},
      {Repo:"Target", File:"book", Folder:["docs"], Extension:"pdf"},
      {Repo:"", File:"bare", Folder:[], Extension:""},
      {Repo:"Target\\0nested", File:"book", Folder:[], Extension:"pdf"}
    ];
  `, worker.context);
  assert.strictEqual(vm.runInContext('findSearchAnchor([0,1,3,2], "Target\\0docs/book.pdf")', worker.context), 2);
  assert.strictEqual(vm.runInContext('findSearchAnchor([4], "\\0bare")', worker.context), 0);
  assert.strictEqual(vm.runInContext('findSearchAnchor([5], "Target\\0nested\\0book.pdf")', worker.context), 0);
  assert.strictEqual(vm.runInContext('findSearchAnchor([0,1], "missing")', worker.context), -1);
});

test("anchor reuse skips scans across pages, retains missing anchors and bounds both cache levels", async () => {
  const {worker}=await loaded();
  const params={q:"alpha",pageSize:1,anchorId:"Repo/A\0docs/child/beta alpha.pdf"};
  assert.strictEqual((await worker.request("local-search",params)).anchor_index,1);
  vm.runInContext('globalThis.originalFind = Array.prototype.findIndex; Array.prototype.findIndex = () => {throw Error("anchor rescanned")}',worker.context);
  assert.strictEqual((await worker.request("local-search",{...params,page:2,pageSize:2})).anchor_index,1);
  vm.runInContext('Array.prototype.findIndex = originalFind',worker.context);
  for(let i=0;i<12;i++) assert.strictEqual((await worker.request("local-search",{...params,anchorId:"missing-"+i})).anchor_index,-1);
  assert.strictEqual(vm.runInContext('[...searchAnchorCache.values()][0].size',worker.context),8);
  vm.runInContext('Array.prototype.findIndex = () => {throw Error("missing anchor rescanned")}',worker.context);
  assert.strictEqual((await worker.request("local-search",{...params,anchorId:"missing-11",page:3})).anchor_index,-1);
  vm.runInContext('Array.prototype.findIndex = originalFind',worker.context);
  for(let i=0;i<12;i++) await worker.request("local-search",{q:"alpha",minSize:i,anchorId:params.anchorId});
  assert.strictEqual(vm.runInContext('searchAnchorCache.size',worker.context),8);
  const before=vm.runInContext('[...searchAnchorCache.values()].reduce((sum,cache)=>sum+cache.size,0)',worker.context);
  await worker.request("local-search",{q:"alpha",minSize:11,anchorId:"x".repeat(4097)});
  assert.strictEqual(vm.runInContext('[...searchAnchorCache.values()].reduce((sum,cache)=>sum+cache.size,0)',worker.context),before);
});
test("snapshot identity survives Worker restarts but changes with content and search rules", async () => {
  const first = await loaded();
  const second = await loaded();
  const old = await first.worker.request('local-search', {sort: 'name'});
  const current = await second.worker.request('local-search', {sort: 'name'});
  assert.strictEqual(old.snapshot_generation, current.snapshot_generation);
  assert.deepStrictEqual(old.ids, current.ids);
  await second.worker.request('replace-corpus', {data: compact(records)});
  assert.strictEqual(old.snapshot_generation, (await second.worker.request('local-search', {})).snapshot_generation);
  const changed = makeWorker(source.replace(/worker-search-v\d+/, 'worker-search-test'));
  await changed.request('replace-corpus', {data: compact(records)});
  assert.notStrictEqual(old.snapshot_generation, (await changed.request('local-search', {})).snapshot_generation);
  const resized = records.map(record => Object.assign({}, record, {Size: 1}));
  await second.worker.request('replace-corpus', {data: compact(resized)});
  assert.notStrictEqual(old.snapshot_generation, (await second.worker.request('local-search', {})).snapshot_generation);
});
test("random reader selection uses supported original extensions", async () => {
  const harness = await loaded([
    { Repo: "Repo/A", File: "scan", Extension: "pdf", Folder: [], Size: 1, HasTxt: false },
    { Repo: "Repo/A", File: "page", Extension: "html", Folder: [], Size: 1, HasTxt: false },
    { Repo: "Repo/A", File: "archive", Extension: "zip", Folder: [], Size: 1, HasTxt: true },
  ]);
  const result = await harness.worker.request("random-record", { readerOnly: true, randomValue: 0.99 });
  assert.strictEqual(result.record.File, "page");
  assert.strictEqual(harness.metadata.reader.count, 2);
});
test("handshake confirms the protocol version", async () => {
  assert.deepStrictEqual(await makeWorker().request("handshake"), { protocol: PROTOCOL });
});
test("protocol mismatch fails cleanly", async () => {
  const response = await makeWorker().send("handshake", {}, { protocol: 999, id: "skew" });
  assert.strictEqual(response.id, "skew");
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.error.code, "PROTOCOL_MISMATCH");
  assert.match(response.error.message, /Refresh required/);
});
test("unknown and pre-load requests return structured errors", async () => {
  const worker = makeWorker();
  let response = await worker.send("local-search", {});
  assert.strictEqual(response.error.code, "CORPUS_NOT_READY");
  response = await worker.send("unknown", {});
  assert.strictEqual(response.error.code, "CORPUS_NOT_READY");
});
test("injectable compact-v2 payload loads without network and returns bounded metadata", async () => {
  const { metadata } = await loaded();
  assert.strictEqual(metadata.state, "corpus-ready");
  assert.strictEqual(metadata.count, records.length);
  assert.deepStrictEqual(metadata.repos, [
    { name: "Repo/A", count: 2 }, { name: "Repo/B", count: 2 },
    { name: "Repo/C", count: 3 }, { name: "Repo/D", count: 2 },
  ]);
  assert.deepStrictEqual(metadata.extensions, [
    { name: "md", count: 1 }, { name: "pdf", count: 1 }, { name: "txt", count: 7 },
  ]);
  assert.deepStrictEqual(metadata.extensionsByRepo["Repo/A"], [{ name: "pdf", count: 1 }, { name: "txt", count: 1 }]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(metadata, "txt"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(metadata, "records"), false);
});
test("invalid compact generation is rejected", async () => {
  const response = await makeWorker().send("replace-corpus", { data: { v: 1, records: [] } });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.error.code, "UNSUPPORTED_CORPUS");
});
test("legacy full-record corpus is rejected", async () => {
  const response = await makeWorker().send("replace-corpus", { data: records });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.error.code, "UNSUPPORTED_CORPUS");
});
test("generation replacement clears records and lazily built indexes", async () => {
  const { worker, metadata } = await loaded();
  await worker.request("local-search", { q: "alpha" });
  const next = await worker.request("replace-corpus", { data: compact([{ Repo: "New", File: "omega", Extension: "txt", Folder: [], Size: 1, HasTxt: false }]) });
  assert.strictEqual(next.generation, metadata.generation + 1);
  assert.deepStrictEqual((await worker.request("local-search", { q: "alpha" })).records, []);
  assert.deepStrictEqual((await worker.request("local-search", { q: "omega" })).records.map((r) => r.File), ["omega"]);
});
test("local result contains records and stable ids rather than corpus indices", async () => {
  const first = await search({ q: "", page: 1, pageSize: 2 });
  const second = await search({ q: "", page: 1, pageSize: 2 });
  assert.deepStrictEqual(first.records, records.slice(0, 2));
  assert.strictEqual(first.ids.length, 2);
  assert.deepStrictEqual(first.ids, second.ids);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(first, "indices"), false);
});
test("page records are capped while total remains exact", async () => {
  const result = await search({ q: "", page: 1, pageSize: 9999 });
  assert.strictEqual(result.pageSize, 500);
  assert.strictEqual(result.total, records.length);
  assert.strictEqual(result.records.length, records.length);
});
test("complete filenames and extension-boundary wildcards match in either mode", async () => {
  const input = [{...records[0], File:"目录", Extension:"txt"}, {...records[1], File:"alpha", Extension:"pdf"}];
  for (const exact of [true, false]) for (const [q, expected] of [["目录.txt", "目录"], ["*.pdf", "alpha"], ["alpha*pdf", "alpha"]]) {
    assert.deepStrictEqual(await namesWithCorpus(input, {q, exact}), [expected]);
  }
});
test("fuzzy candidates retain selected repository and other terms after 200 matches", async () => {
  const input = Array.from({length:220}, (_, i) => ({...records[0], Repo:"Repo/A", File:"alp " + i}));
  input.push({...records[0], Repo:"Repo/B", File:"alpha omega"});
  for (const q of ["alpa", "alpa omega"]) {
    assert.deepStrictEqual(await namesWithCorpus(input, {q, repos:["Repo/B"]}), ["alpha omega"]);
  }
});
test("only in-scope literal hits and exact postings suppress fuzzy expansion", async () => {
  const target = {...records[0], Repo:"Repo/A", File:"alpha omega", Extension:"pdf", Folder:["docs"], Size:50};
  const decoys = [{...target, File:"alpha"}, {...target, File:"omega"}];
  for (const [filters, outside] of [
    [{extensions:["PDF"]}, {Extension:"txt"}],
    [{repos:["Repo/A"]}, {Repo:"Repo/B"}],
    [{folders:["docs"]}, {Folder:["docs-other"]}],
    [{folders:["docs"], folderMatchMode:"exact"}, {Folder:["docs", "child"]}],
    [{folderMatchMode:"mixed", folderSelfs:["docs"]}, {Folder:["docs", "child"]}],
    [{folderMatchMode:"mixed", folderSubtrees:["docs"]}, {Folder:["docs-other"]}],
    [{minSize:50}, {Size:49}],
    [{maxSize:50}, {Size:51}],
  ]) for (const file of ["alpa omega", "xalpax omega"]) {
    const blocker = {...target, ...outside, File:file};
    const {worker} = await loaded([blocker, target, ...decoys]);
    for (const searchFolders of [true, false]) {
      for (const [q, expected] of [["alpa", [target, decoys[0]]], ["alpa omega", [target]], ["omega alpa", [target]]]) {
        const params = {q, searchFolders, ...filters};
        assert.deepStrictEqual((await worker.request("local-search", params)).records, expected, JSON.stringify(params));
        assert.strictEqual((await worker.request("local-search", {...params, exact:true})).total, 0);
      }
      assert.deepStrictEqual((await worker.request("local-search", {q:"alpa", searchFolders})).records, [blocker]);
      assert.deepStrictEqual((await worker.request("local-search", {q:"alpa omega", searchFolders})).records,
        file === "alpa omega" ? [blocker] : [blocker, target]);
    }
  }
});

test("fuzzy length buckets deduplicate postings and preserve full ID order despite changed traversal", async () => {
  const input = Array.from({length:900}, (_, i) => ({...records[0],
    File:["za zaz", "za", "zaz", "z", "zb", "ZB"][i % 6], Folder:[]}));
  const {worker} = await loaded(input);
  vm.runInContext(`buildFulltext();
    globalThis.originalIntersect = intersectCandidateLists;
    intersectCandidateLists = (lists, sorted) => {
      if (!sorted) globalThis.firstProbe = Array.from(lists[0]);
      return originalIntersect(lists, sorted);
    };`, worker.context);
  // The old frequency traversal starts with za/zaz (300 each), not z (150).
  const legacy = Array.from(vm.runInContext(`Array.from(new Set(Object.keys(wordIndex)
    .sort((a, b) => wordIndex[b].length - wordIndex[a].length)
    .filter(word => editDistance("zz", word, 1) <= 1)
    .flatMap(word => Array.from(wordIndex[word]))))`, worker.context));
  for (const searchFolders of [true, false]) for (const sort of ["relevance", "name", "size"]) {
    const params = {searchFolders, sort, pageSize:500};
    const orderedIds = async q => {
      const first = await worker.request("local-search", {...params, q});
      const second = await worker.request("local-search", {...params, q, page:2,
        anchorId:"Repo/A\0" + "z.txt"});
      assert.strictEqual(first.total, 900);
      assert.strictEqual(second.total, 900);
      return {ids:first.ids.concat(second.ids), anchor:second.anchor_index};
    };
    // All matches have zero relevance and equal size, and case variants and
    // duplicates expose stable name ties and distinguish IDs from filenames.
    assert.deepStrictEqual(await orderedIds("zz"), await orderedIds(""));
    const observed = Array.from(worker.context.firstProbe);
    assert.notDeepStrictEqual(observed, legacy, "fixture must exercise a real traversal change");
    assert.deepStrictEqual(observed.sort((a, b) => a - b), legacy.slice().sort((a, b) => a - b));
  }
});
test("non-exact results include literal filename and repository hits", async () => {
  const input = [{...records[0], Repo:"Repo/A", File:"Marxist"}];
  assert.deepStrictEqual(await namesWithCorpus(input, {q:"marx"}), ["Marxist"]);
  assert.deepStrictEqual(await namesWithCorpus(input, {q:"repo", searchFolders:false}), ["Marxist"]);
});

test('gzip fingerprints use the validated source bytes, not re-encoded text or gzip bytes', async () => {
  const {gzipSync} = require('node:zlib');
  const {createHash, webcrypto} = require('node:crypto');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const navigator = {userAgent:'test-runtime'};
  const encoded = [];
  const worker = gzipWorker({navigator, crypto:webcrypto, TextEncoder: class extends TextEncoder {
    encode(text) { encoded.push(text); return super.encode(text); }
  }});
  const version = vm.runInContext('SEARCH_SEMANTICS_VERSION', worker.context);
  const stamp = plain => `worker:${hash(version + navigator.userAgent)}:${hash(plain)}`;
  const data = compact([{...records[0], File:'中📚\ufeff'}]);
  const plain = JSON.stringify(data);
  const canonical = stamp(plain);
  for (const [raw, level, expected] of [
    [plain, 0, canonical], [plain, 9, canonical], ['\ufeff' + plain, 6, canonical],
    [plain + '\n', 6, stamp(plain + '\n')],
    [plain.replace('\ufeff', '\\ufeff'), 6, stamp(plain.replace('\ufeff', '\\ufeff'))],
  ]) {
    encoded.length = 0;
    worker.context.fetch = async () => new Response(gzipSync(raw, {level}));
    await worker.request('load-corpus', {url:'/corpus'});
    const page = await worker.request('local-search', {q:''});
    assert.strictEqual(page.snapshot_generation, expected);
    assert.strictEqual(page.records[0].File, '中📚\ufeff');
    assert.deepStrictEqual(encoded, [version + navigator.userAgent]);
  }
  encoded.length = 0;
  await worker.request('replace-corpus', {data});
  assert.strictEqual((await worker.request('local-search', {q:''})).snapshot_generation, canonical);
  assert.deepStrictEqual(encoded, [plain, version + navigator.userAgent]);
});

test('gzip decode, digest, parse, and install failures leave the published corpus unchanged', async () => {
  const {gzipSync} = require('node:zlib');
  const worker = gzipWorker();
  const original = JSON.stringify(compact(records));
  worker.context.fetch = async () => new Response(gzipSync(original));
  await worker.request('load-corpus', {url:'/corpus'});
  const params = {q:'alpha', exact:true};
  const before = await worker.request('local-search', params);
  const metadata = await worker.request('metadata');
  const digest = worker.context.crypto.subtle.digest;
  for (const [gzip, rejectDigest, expectedDigests, code] of [
    [gzipSync(Buffer.concat([Buffer.from(original), Buffer.from([0xe4, 0xb8])])), false, 0, 'ERR_ENCODING_INVALID_ENCODED_DATA'],
    [gzipSync('\ufeff\ufeff' + original), false, 2, 'WORKER_ERROR'],
    [gzipSync(original).subarray(0, -1), false, 0, 'Z_BUF_ERROR'],
    [gzipSync(original), true, 1, 'WORKER_ERROR'],
    [gzipSync('{"v":1}'), false, 2, 'UNSUPPORTED_CORPUS'],
    [gzipSync('{"v":2,"rp":[{"toString":null,"valueOf":null}],"fd":[[]],"rc":[[0,"new","txt",0,1,0]]}'), false, 2, 'WORKER_ERROR'],
  ]) {
    let digestCalls = 0;
    worker.context.fetch = async () => new Response(gzip);
    worker.context.crypto.subtle.digest = (...args) => {
      digestCalls++;
      return rejectDigest ? Promise.reject(new Error('digest failed')) : digest(...args);
    };
    await assert.rejects(worker.request('load-corpus', {url:'/corpus'}), {code});
    assert.deepStrictEqual(await worker.request('metadata'), metadata);
    assert.deepStrictEqual(await worker.request('local-search', params), before);
    assert.strictEqual(digestCalls, expectedDigests);
  }
});

test('gzip and replace-corpus keep the per-worker generation fallback without fingerprint support', async () => {
  const {gzipSync} = require('node:zlib');
  const data = compact(records);
  for (const opts of [{crypto:undefined}, {crypto:{}}, {TextEncoder:undefined}]) {
    const worker = gzipWorker(opts);
    worker.context.fetch = async () => new Response(gzipSync('\ufeff' + JSON.stringify(data)));
    await worker.request('load-corpus', {url:'/corpus'});
    const first = await worker.request('local-search', {q:''});
    assert.match(first.snapshot_generation, /^worker:[^:]+:1$/);
    await worker.request('replace-corpus', {data});
    const second = await worker.request('local-search', {q:''});
    assert.deepStrictEqual(second, {...first, generation:2, snapshot_generation:first.snapshot_generation.slice(0, -1) + '2'});
  }
});

test('corpus stream enforces inclusive compressed and expanded byte limits', async () => {
  const {gzipSync} = require('node:zlib');
  const stream = bytes => new ReadableStream({start(controller) {
    controller.enqueue(bytes.subarray(0, 2));
    controller.enqueue(bytes.subarray(2));
    controller.close();
  }});
  const tiny = gzipWorker({}, source.replace('32 * 1024 * 1024', '80').replace('256 * 1024 * 1024', '128'));
  const plain = '{"v":2,"rp":["r"],"fd":[[]],"rc":[[0,"f","txt",0,0,0]]}';
  const padded = count => '\ufeff' + plain.padEnd(count - 3);
  async function load(gzip, declaredLength) {
    tiny.context.fetch = async () => new Response(stream(gzip), {headers: declaredLength ? {'content-length':declaredLength} : {}});
    return tiny.request('load-corpus', {url:'/corpus'});
  }
  const compressedBoundary = gzipSync(plain.padEnd(80 - 23), {level:0});
  assert.strictEqual(compressedBoundary.length, 80);
  assert.strictEqual((await load(compressedBoundary)).count, 1);
  assert.strictEqual((await load(gzipSync(padded(128)))).count, 1);
  const before = await tiny.request('local-search', {q:''});
  await assert.rejects(load(gzipSync(plain.padEnd(81 - 23), {level:0})), {code:'CORPUS_TOO_LARGE'});
  await assert.rejects(load(compressedBoundary, '81'), {code:'CORPUS_TOO_LARGE'});
  await assert.rejects(load(gzipSync(padded(129))), {code:'CORPUS_TOO_LARGE'});
  assert.deepStrictEqual(await tiny.request('local-search', {q:''}), before);
});

test("large fuzzy posting does not exceed the engine argument limit", async () => {
  const {worker} = await loaded([{...records[0], File:'alpha'}]);
  vm.runInContext(`records = Array.from({length: 200000}, () => records[0]);
    recordIds = Array.from({length: records.length}, (_,i) => String(i));
    recordIndices = Array.from({length: records.length}, (_,i) => i);
    wordIndex = {alpha: recordIndices}; vocabByLength = new Map([[5, ['alpha']]]);
    wordIndexFilesOnly = wordIndex; vocabByLengthFilesOnly = vocabByLength;`, worker.context);
  const result = await worker.request('local-search', {q:'alphx', pageSize:1});
  assert.strictEqual(result.total, 200000);
  assert.strictEqual(result.records.length, 1);
});

test("ASCII separator queries retain literal and fuzzy matches without changing explicit exact mode", async () => {
  const fuzzy = [
    {...records[0], Repo:'Repo/A', File:'alpha guide', Folder:[]},
    {...records[0], Repo:'Repo/A', File:'alpha', Folder:['guide']},
    {...records[0], Repo:'Repo/B', File:'alpha guide', Folder:[]},
  ];
  for (const separator of ['-', '_', '.']) {
    const q='alpha'+separator+'guied';
    const files=await namesWithCorpus(fuzzy,{q,exact:false,repos:['Repo/A'],searchFolders:false});
    assert.deepStrictEqual(files,['alpha guide'],q);
    const all=await namesWithCorpus(fuzzy,{q,exact:false,repos:['Repo/A']});
    assert.deepStrictEqual(all,['alpha guide','alpha'],q);
  }
  const literal=[...fuzzy,{...records[0],Repo:'Repo/A',File:'alpha-guied',Folder:[]}];
  assert.deepStrictEqual(await namesWithCorpus(literal,{q:'alpha-guied',exact:false,repos:['Repo/A']}),['alpha-guied']);
  assert.deepStrictEqual(await namesWithCorpus(literal,{q:'alpha-guied',exact:true,repos:['Repo/A']}),['alpha-guied']);
  assert.deepStrictEqual(await namesWithCorpus(literal,{q:'alpha.guied',exact:true}),[]);
  assert.deepStrictEqual(await namesWithCorpus(fuzzy,{q:'alpha*guide',exact:false,searchFolders:false}),['alpha guide','alpha guide']);
  assert.deepStrictEqual(await namesWithCorpus(fuzzy,{q:'alpha-guied guide',exact:false}),[]);
});

test("mixed repository literal and fuzzy filename terms intersect per term", async () => {
  const record = {...records[0], Repo:"VoiceOfML/Archive", File:"alpha guide", Folder:[]};
  const {worker} = await loaded([record]);
  for (const q of ["archive guide", "guied", "archive guied", "guied archive"]) {
    const result = await worker.request("local-search", {q, exact:false});
    assert.strictEqual(result.total, 1, q);
    assert.deepStrictEqual(result.records, [record], q);
  }
  assert.strictEqual((await worker.request("local-search", {q:"archive guied", exact:true})).total, 0);
});

test("mixed literal and fuzzy terms preserve field flags and record filters", async () => {
  const input = [
    {...records[0], Repo:"VoiceOfML/Archive", File:"alpha guide", Folder:[]},
    {...records[0], Repo:"Repo/B", File:"archivist guide", Folder:[]},
    {...records[0], Repo:"Repo/B", File:"guide", Folder:["archive"]},
    {...records[0], Repo:"Repo/B", File:"guide", Extension:"archive", Folder:[]},
    {...records[0], Repo:"VoiceOfML/Archive", File:"alpha", Folder:["guide"]},
    {...records[0], Repo:"VoiceOfML/Archive", File:"unrelated", Folder:[]},
    {...records[0], Repo:"Repo/B", File:"guide", Folder:[]},
  ];
  for (const warm of [false, true]) {
    const {worker} = await loaded(input);
    if (warm) vm.runInContext('buildFulltext()', worker.context);
    for (const q of ["archiv guied", "guied archiv", "archiv guied archiv"]) {
      for (const [filters, expected] of [
        [{}, [0, 1, 2, 3, 4]],
        [{searchFolders:false}, [0, 1, 3]],
        [{repos:["VoiceOfML/Archive", "VoiceOfML/Archive"]}, [0, 4]],
        [{repos:["missing"]}, []],
        [{extensions:["archive"]}, [3]],
        [{folders:["archive"], folderMatchMode:"exact"}, [2]],
        [{folderSelfs:["guide"], folderMatchMode:"mixed"}, [4]],
        [{minSize:101}, []],
        [{exact:true}, []],
      ]) {
        const result = await worker.request("local-search", {q, exact:false, ...filters});
        assert.strictEqual(result.total, expected.length, JSON.stringify({q, warm, filters}));
        assert.deepStrictEqual(result.records.map(record => input.findIndex(item =>
          JSON.stringify(item) === JSON.stringify(record))).sort((a, b) => a - b), expected, JSON.stringify({q, warm, filters}));
      }
    }
    // A CJK term has several index tokens, but its literal match is one branch.
    await worker.request("replace-corpus", {data:compact([
      {...input[0], Repo:"VoiceOfML/手机资料"},
      {...input[1], File:"手机 guide"},
    ])});
    assert.strictEqual((await worker.request("local-search", {q:"手机资料 guied"})).total, 1);
  }
});

test("mixed terms keep complete candidates, ranking ties, pages and anchors", async () => {
  const input = Array.from({length:220}, (_, i) => ({...records[0], Repo:"Repo/A", File:"guide " + i, Folder:[]}));
  input.push(
    {...records[0], Repo:"VoiceOfML/Archive", File:"alpha guide", Folder:[], Size:20},
    {...records[0], Repo:"VoiceOfML/Archive", File:"beta guide", Folder:[], Size:30},
    {...records[0], Repo:"VoiceOfML/Archive", File:"archive guied", Folder:[], Size:10},
    {...records[0], Repo:"VoiceOfML/Archive", File:"alpha guide", Folder:["other"], Size:20},
  );
  const {worker} = await loaded(input);
  for (const q of ["archive guied", "guied archive"]) {
    for (const [sort, indices] of [
      ["relevance", [222, 220, 221, 223]],
      ["name", [220, 223, 222, 221]],
      ["size", [221, 220, 223, 222]],
    ]) {
      const params = {q, exact:false, repos:["VoiceOfML/Archive"], sort};
      // An exact guied posting suppresses fuzzy expansion as before.
      const exactToken = await worker.request("local-search", params);
      assert.deepStrictEqual(exactToken.records, [input[222]]);
      await worker.request("replace-corpus", {data:compact(input.map((record, i) =>
        i === 222 ? {...record, File:"archive guide"} : record))});
      const full = await worker.request("local-search", params);
      assert.strictEqual(full.total, 4, q + " " + sort);
      assert.deepStrictEqual(full.records.map(record => record.File), indices.map(i => i === 222 ? "archive guide" : input[i].File));
      const page = await worker.request("local-search", {...params, page:2, pageSize:2,
        anchorId:"VoiceOfML/Archive\0other/alpha guide.txt"});
      assert.deepStrictEqual(page.ids, full.ids.slice(2, 4));
      assert.strictEqual(page.total, 4);
      assert.strictEqual(page.anchor_index, indices.indexOf(223));
      await worker.request("replace-corpus", {data:compact(input)});
    }
  }
});

test("missing tokens visit only eligible length buckets, once per normalized term", async () => {
  const input = [
    {...records[0], File:"guide xyz 1234567 12345678 ab", Folder:[]},
    {...records[0], File:"other", Folder:["guide defg"]},
    {...records[0], File:"手册 机", Folder:[]},
    {...records[0], File:"手 机", Folder:[]},
    ...Array.from({length:64}, (_, i) => ({...records[0], File:`unrelated${i}`, Folder:[]})),
  ];
  const {worker} = await loaded(input);
  vm.runInContext(`buildFulltext();
    globalThis.fuzzyChecks = [];
    globalThis.originalCouldBeFuzzy = couldBeFuzzy;
    couldBeFuzzy = (...args) => { fuzzyChecks.push(args.slice(0, 2)); return originalCouldBeFuzzy(...args); };`, worker.context);
  for (const searchFolders of [true, false]) {
    const params = {searchFolders};
    const check = async (q, token, words, expectedRecords, flags = {}) => {
      vm.runInContext('searchOrderCache.clear(); fuzzyChecks = [];', worker.context);
      const result = await worker.request("local-search", {...params, q, ...flags});
      assert.deepStrictEqual(result.records, expectedRecords, q);
      assert.deepStrictEqual(clone(worker.context.fuzzyChecks).sort(), words.map(word => [token, word]).sort(), q);
      return result;
    };
    const eligible = ["guide", "xyz", "1234567", "other", ...(searchFolders ? ["defg"] : [])];
    const matches = input.slice(0, searchFolders ? 2 : 1);
    const single = await check("guied", "guied", eligible, matches);
    const repeated = Array.from({length:30}, (_, i) => i % 2 ? "GUIED" : "guied").join("\t ");
    assert.deepStrictEqual(await check(repeated, "guied", eligible, matches), single);
    await check("手机", "手机", ["ab", "手册"], [input[2]]);
    await check("囧 囧", "囧", [], []); // Zero edit budget even on the indexed path.
    await check("guide", "guide", [], matches); // Exact posting.
    await check("guid", "guid", [], matches); // Single-term literal hit.
    await check("guied", "guied", [], [], {exact:true});
    await check("guid*", "guid*", [], matches);
  }
});

test("deduplicated terms retain the original multi-term fuzzy expansion", async () => {
  const input = [
    {...records[0], File:"xguiedx", Folder:[]},
    {...records[0], File:"guide", Folder:[]},
    {...records[0], File:"other", Folder:["guide"]},
  ];
  const {worker} = await loaded(input);
  for (const searchFolders of [true, false]) {
    const params = {exact:false, searchFolders};
    const single = await worker.request("local-search", {...params, q:"guied"});
    assert.deepStrictEqual(single.records, [input[0]], "single-term literal hit suppresses missing-token expansion");
    for (const count of [2, 30]) {
      const q = Array.from({length:count}, (_, i) => i % 2 ? "GUIED" : "guied").join(" ");
      const repeated = await worker.request("local-search", {...params, q});
      assert.deepStrictEqual(repeated.records, searchFolders ? input : input.slice(0, 2));
      assert.strictEqual(repeated.total, searchFolders ? 3 : 2);
    }
  }
});

test("normal multi-token search intersects candidates", async () => {
  assert.deepStrictEqual(await names({ q: "alpha beta", exact: false }), ["beta alpha"]);
});

test("exact mode treats whitespace as independent AND terms", async () => {
  assert.deepStrictEqual(await names({ q: "alpha guide", exact: true }), ["alpha guide"]);
  assert.deepStrictEqual(await names({ q: "guide alpha", exact: true }), ["alpha guide"]);
  assert.deepStrictEqual(await names({ q: "alpha missing", exact: true }), []);
  assert.deepStrictEqual(await names({ q: "alpha* guide", exact: true }), ["alpha guide"]);
});
test("precomputed name keys match the original comparator and remain generation-local", async () => {
  const alphabet = ["手机", "ABC", "abc", "重", "😀", "🀄", "𠮷", "\ue000", "\ud800", "\udfff",
    "aΣ", "Aς", "é", "e\u0301", ""];
  const input = Array.from({length:600},(_,i)=>({...records[0],
    Repo:i%2?"Repo/A":"Repo/B",File:alphabet[(i*19)%alphabet.length]+(i%7===0?"x":"")}));
  const {worker}=await loaded(input);
  const expected=JSON.parse(vm.runInContext('JSON.stringify(recordIndices.slice().sort(compareRecordName))',worker.context));
  vm.runInContext('buildNameOrders()',worker.context);
  assert.deepStrictEqual(JSON.parse(vm.runInContext('JSON.stringify(sortedByName)',worker.context)),expected);
  for (const repo of ["Repo/A","Repo/B"]) {
    worker.context.currentRepo=repo;
    assert.deepStrictEqual(JSON.parse(vm.runInContext('JSON.stringify(repoSortedByName[currentRepo])',worker.context)),
      expected.filter(index=>input[index].Repo===repo));
  }
  const replacement = [{...records[0],File:"b"},{...records[0],File:"a"}];
  await worker.request("replace-corpus",{data:compact(replacement)});
  assert.deepStrictEqual((await worker.request("local-search",{sort:"name"})).records.map(record=>record.File),["a","b"]);
});
test("unusual filename metadata retains the original name comparator", async () => {
  const worker=makeWorker();
  await worker.request("replace-corpus",{data:{v:2,rp:["Repo/A"],fd:[[]],rc:[[0,42,"txt",0,1,0],[0,"1","txt",0,2,0]]}});
  vm.runInContext(`globalThis.originalNameCompare=compareRecordName;globalThis.comparisons=0;
    compareRecordName=(a,b)=>{comparisons++;return originalNameCompare(a,b)};`,worker.context);
  assert.strictEqual((await worker.request("local-search",{sort:"name"})).total,2);
  assert(vm.runInContext('comparisons > 0',worker.context));
});
test("explicit sorts preserve collation and ties without computing relevance tokens", async () => {
  const input = ["book 中国", "book 重", "book Chong", "book chong", "book 10", "book 2", "book e\u0301", "book é", "book 重"]
    .map((File, i) => ({Repo: "Test", File, Folder: [String(i)], Extension: "txt", Size: i % 3, HasTxt: false}));
  const {worker} = await loaded(input);
  vm.runInContext('tokenize = () => {throw new Error("unneeded scoring tokens");};', worker.context);
  for (const sort of ["name", "size"]) {
    const byName = (a, b) => a.File.toLowerCase() < b.File.toLowerCase() ? -1 : a.File.toLowerCase() > b.File.toLowerCase() ? 1 : 0;
    const compare = sort === "name" ? byName : (a, b) => b.Size - a.Size || byName(a, b);
    const result = await worker.request("local-search", {q: "book", exact: true, sort});
    assert.deepStrictEqual(result.records, input.slice().sort(compare));
    assert.strictEqual(result.total, input.length);
  }
});
test("short fuzzy terms use a length-sensitive edit budget", async () => {
  const input = ['猫', '狗', 'ab', 'ac', 'cd', 'abx', 'apple', 'ample'].map(File => ({
    ...records[0], Repo:'Repo/Animals', File, Folder:[],
  }));
  assert.deepStrictEqual(await namesWithCorpus(input, {q:'灬', exact:false}), []);
  assert.deepStrictEqual(await namesWithCorpus(input, {q:'囧', exact:false}), []);
  assert.deepStrictEqual(await namesWithCorpus(input, {q:'ad', exact:false}), ['ab','ac','cd']);
  assert.deepStrictEqual(await namesWithCorpus(input, {q:'aplpe', exact:false}), ['apple','ample']);
  assert.strictEqual((await search({q:'手',exact:false})).total, 2);
});
test("normal search is case-insensitive and retains fuzzy behavior", async () => {
  assert.deepStrictEqual(await names({ q: "ALPHA", exact: false }), ["alpha guide", "beta alpha", "gamma"]);
  assert.deepStrictEqual(await names({ q: "alhpa", exact: false }), ["alpha guide", "beta alpha", "gamma"]);
});
test("files-only fuzzy excludes folder-only candidates", async () => {
  assert.deepStrictEqual(await names({ q: "alhpa", exact: false, searchFolders: false }), ["alpha guide", "beta alpha"]);
});
test("Chinese multi-character queries require adjacent Chinese pairs", async () => {
  const result = await search({ q: "手机", exact: false, page: 1, pageSize: 10 });
  assert.deepStrictEqual(result.records.map((record) => record.File), ["手机资料"]);
  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.ids.length, result.total);
  assert.deepStrictEqual(await names({ q: "手。机", exact: false }), ["手。机"]);
  assert.deepStrictEqual(await names({ q: "手", exact: false }), ["手机资料", "手。机"]);
  assert.deepStrictEqual(await names({ q: "机", exact: false }), ["手机资料", "手。机"]);
  assert.deepStrictEqual(await namesWithCorpus([
    { Repo: "Repo/Chinese", File: "手。机", Extension: "txt", Folder: [], Size: 1, HasTxt: false },
  ], { q: "手机", exact: false }), []);
});

test("main-thread root select-all represents and persists direct root files with the empty self path", () => {
  const context = vm.createContext({ Set, STATE:{folderTree:[], filterRepos:[], filterExtensions:[]},
    updateFilterCancelButtons(){}, scheduleFilterSearch(){}, showToast(){throw Error("unexpected limit");} });
  vm.runInContext(fs.readFileSync("static/search/sidebar/domain/folder-selection.js", "utf8"), context);
  const treeSource = fs.readFileSync("static/search/sidebar/presentation/folder-tree.js", "utf8");
  require('../../support/sidebar_fixture').installSidebarTree(process.cwd(), context);
  context.folderSelectionState = context.VoiceOfMLSearchFolderSelection.folderSelectionState;
  const root = { path: "", isRoot: true, hasDirectFiles: true, children: [{ path: "child", hasDirectFiles: true }] };
  assert.strictEqual(context.folderSelectionState(root, new Set(["child"]), new Set()).full, false);
  assert.strictEqual(context.folderSelectionState(root, new Set(["child"]), new Set([""])).full, true);
  assert.match(treeSource, /if \(node\.hasDirectFiles\) selfSet\.add\(node\.path\)/);
  for (const name of ["mergeFolderFilters", "buildLocalSearchParams"]) {
    const fn = app.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
    assert(fn, name); vm.runInContext(fn[0], context);
  }
  context.STATE.folderTree = [root];
  const subtrees = new Set(), selfs = new Set();
  context.setNodeSubtreeSelection(root, true, subtrees, selfs);
  context.persistFolderSelection(subtrees, selfs);
  assert.deepStrictEqual(Array.from(context.STATE.filterFolderSelfs), [""]);
  assert.deepStrictEqual(Array.from(context.STATE.filterFolderSubtrees), ["child"]);
  const params = context.buildLocalSearchParams(1);
  assert.strictEqual(params.folderMatchMode, "mixed");
  assert.deepStrictEqual(Array.from(params.folders), ["", "child"]);
  assert.match(treeSource, /function getFolderSelfSet\(\) \{\s*return new Set\(deps\.readView\(\)\.selfs \|\| \[\]\);/);
  assert.match(treeSource, /if \(node\.hasDirectFiles\) selfPaths\.push\(node\.path\)/);
});

test("root folder selection includes direct files alongside child directories", async () => {
  const rootRecords = [
    { Repo: "Repo/Tree", File: "root-file", Extension: "txt", Folder: [], Size: 1, HasTxt: true },
    { Repo: "Repo/Tree", File: "nested-file", Extension: "txt", Folder: ["child"], Size: 2, HasTxt: false },
    { Repo: "Repo/Tree", File: "deep-file", Extension: "txt", Folder: ["child", "deep"], Size: 3, HasTxt: false },
  ];
  const harness = await loaded(rootRecords);
  const tree = await harness.worker.request("folder-tree", { repo: "Repo/Tree" });
  assert.deepStrictEqual(tree.tree[0], {
    name: "Tree", path: "", children: [{
      name: "child", path: "child", children: [{
        name: "deep", path: "child/deep", children: [], count: 1,
        hasDirectFiles: true, hasChildren: false, showSelfToggle: false,
      }], count: 2, hasDirectFiles: true, hasChildren: true, showSelfToggle: true,
    }], count: 3, isRoot: true, hasDirectFiles: true, hasChildren: true, showSelfToggle: false,
  });
  assert.deepStrictEqual(await namesWithCorpus(rootRecords, { folders: [""], folderMatchMode: "prefix" }), ["root-file", "nested-file", "deep-file"]);
  assert.deepStrictEqual(await namesWithCorpus(rootRecords, { folders: ["child"], folderMatchMode: "prefix" }), ["nested-file", "deep-file"]);
  const mixed = await harness.worker.request("local-search", {
    folderMatchMode: "mixed", folderSelfs: [""], folderSubtrees: ["child"], page: 1, pageSize: 10,
  });
  assert.deepStrictEqual(mixed.records.map((record) => record.File), ["root-file", "nested-file", "deep-file"]);
  assert.strictEqual(mixed.total, 3);
  assert.strictEqual(mixed.ids.length, mixed.total);
});

function observeFolderSearch(worker) {
  vm.runInContext(`
    globalThis.folderWork = {ids: 0, predicates: 0, builds: 0};
    const originalBuildFilter = buildRecordFilter, originalGetDirectoryIndex = getDirectoryIndex;
    buildRecordFilter = (...args) => {
      const test = originalBuildFilter(...args);
      return test ? index => { folderWork.predicates++; return test(index); } : test;
    };
    getDirectoryIndex = repo => {
      if (!directoryIndexes.has(repo)) folderWork.builds++;
      return originalGetDirectoryIndex(repo);
    };
  `, worker.context);
  return async params => {
    vm.runInContext('folderWork.ids = folderWork.predicates = folderWork.builds = 0;', worker.context);
    const result = await worker.request('local-search', params);
    return {result, work: JSON.parse(vm.runInContext('JSON.stringify(folderWork)', worker.context))};
  };
}

test('warm narrow mixed folder search retains scan pages and avoids scope walks or cache touches', async () => {
  const repo = 'Repo/Tree';
  const selected = [['narrow', 'leaf'], [], ['narrow'], ['narrow', 'leaf'], ['include'], ['narrowish']];
  const input = Array.from({length: 8300}, (_, i) => ({...records[0],
    Repo: i >= 8192 ? 'Other' : repo,
    File: i % 4 ? 'Tie' : 'tie', Extension: i % 3 ? 'txt' : 'pdf', Size: i % 4,
    Folder: i % 257 < selected.length ? selected[i % 257] : ['bulk', String(i % 32)],
  }));
  const {worker} = await loaded(input);
  const searchWithWork = observeFolderSearch(worker);
  const base = {q: '', repos: [repo], folderMatchMode: 'mixed', folders: ['ignored'],
    folderSelfs: ['/include/', '', 'narrow/leaf', 'include'], folderSubtrees: ['narrow', '/narrow/leaf/'],
    extensions: ['TXT'], minSize: 2, maxSize: 3, pageSize: 13,
    anchorId: `${repo}\0narrow/leaf/Tie.txt`};
  const variants = [
    ...['relevance', 'name', 'size'].map(sort => ({...base, sort})),
    {...base, folderSelfs: ['narrow'], folderSubtrees: [], extensions: null},
    {...base, folderSelfs: ['missing'], folderSubtrees: ['missing/leaf']},
    {...base, folderSelfs: ['narrow'], folderSubtrees: ['bulk']},
    {...base, folderSelfs: ['bulk/0', 'bulk/1', 'bulk/2', 'bulk/3', 'bulk/4', 'bulk/5', 'bulk/6', 'bulk/7', 'bulk/8'], folderSubtrees: []},
    {...base, folderSubtrees: ['']},
    {...base, repos: [repo, 'Other', repo]},
    {...base, repos: null},
    {...base, q: '*', exact: true},
  ];
  const cold = [];
  for (const params of variants) cold.push(await searchWithWork(params));
  assert.ok(cold.every(({work}) => !work.builds && !work.ids));
  assert.deepStrictEqual(cold.map(({work}) => work.predicates), [...Array(8).fill(8192), 8300, 8300, 8192]);
  assert.ok(cold[0].result.anchor_index >= 0);
  assert.strictEqual(cold[4].result.total, 0);
  assert.strictEqual(vm.runInContext('directoryIndexes.size', worker.context), 0);
  await worker.request('folder-tree', {repo});
  await worker.request('folder-tree', {repo: 'Other'});
  vm.runInContext(`
    searchOrderCache.clear();
    for (const ids of Object.values(directoryIndexes.get('Repo/Tree').files)) {
      ids[Symbol.iterator] = function* () {
        for (let i = 0; i < this.length; i++) { folderWork.ids++; yield this[i]; }
      };
    }
  `, worker.context);
  for (const [i, params] of variants.entries()) {
    const warm = await searchWithWork(params);
    assert.deepStrictEqual(warm.result, cold[i].result, JSON.stringify(params));
    const eligible = [160, 160, 160, 32, 0][i];
    assert.deepStrictEqual(warm.work, {ids: eligible ?? 0, predicates: eligible ?? cold[i].work.predicates, builds: 0});
  }
  assert.strictEqual(vm.runInContext('Array.from(directoryIndexes.keys()).join()', worker.context), 'Repo/Tree,Other');
  const page = {...base, sort: 'size', page: 2, anchorId: `${repo}\0missing.txt`};
  vm.runInContext(`searchOrderCache.clear();
    // A narrow search must not walk or copy the scope, even before filtering.
    const scopedIndices = repoRecordIndices['Repo/Tree'];
    repoRecordIndices['Repo/Tree'] = new Proxy(scopedIndices, {get(target, key) {
      if (key !== 'length') throw Error('scope read');
      return target.length;
    }});
  `, worker.context);
  const first = await searchWithWork({...base, sort: 'size'});
  const warmPage = await searchWithWork(page);
  assert.deepStrictEqual(first.work, {ids: 160, predicates: 160, builds: 0});
  assert.deepStrictEqual(warmPage.work, {ids: 0, predicates: 0, builds: 0});
  vm.runInContext(`searchOrderCache.clear(); directoryIndexes.clear();
    repoRecordIndices['Repo/Tree'] = scopedIndices;`, worker.context);
  assert.deepStrictEqual(warmPage.result, (await searchWithWork(page)).result);

  await worker.request('folder-tree', {repo});
  await worker.request('replace-corpus', {data: compact(input.slice().reverse().map(record => ({...record, Folder: []})))});
  assert.strictEqual(vm.runInContext('directoryIndexes.size', worker.context), 0);
  const next = await searchWithWork(base);
  assert.deepStrictEqual(next.work, {ids: 0, predicates: 8192, builds: 0});
  assert.strictEqual(next.result.generation, cold[0].result.generation + 1);
  assert.notStrictEqual(next.result.snapshot_generation, cold[0].result.snapshot_generation);
  assert.strictEqual(next.result.anchor_index, -1);
  assert.ok(next.result.total > cold[0].result.total);
});

test('warm mixed paths are case-sensitive and rebuilt from the replacement corpus', async () => {
  const repo = 'Repo/A';
  const input = Array.from({length: 64}, (_, i) => ({...records[0], Repo: repo, File: `Row ${i}`,
    Folder: [['Docs'], ['Docs', 'Leaf'], ['Docs', 'leaf'], ['docs'], ['docs', 'Leaf']][i] || ['bulk'],
  }));
  // An unrelated repository cannot disqualify a canonical directory.
  input.push({...records[0], Repo: 'Repo/Other', Folder: ['embedded/slash']});
  const worker = makeWorker();
  vm.runInContext('Object.hasOwn = undefined;', worker.context);
  const searchWithWork = observeFolderSearch(worker);
  const search = {q: '', repos: [repo], folderMatchMode: 'mixed', folderSelfs: ['Docs'], folderSubtrees: ['docs/Leaf']};
  async function verify(rows, files) {
    await worker.request('replace-corpus', {data: compact(rows)});
    assert.strictEqual(vm.runInContext('directoryIndexes.size', worker.context), 0);
    const cold = await searchWithWork(search);
    assert.deepStrictEqual(cold.work, {ids: 0, predicates: 64, builds: 0});
    await worker.request('folder-tree', {repo});
    vm.runInContext(`searchOrderCache.clear();
      for (const ids of Object.values(directoryIndexes.get('Repo/A').files)) {
        ids[Symbol.iterator] = function* () {
          for (let i = 0; i < this.length; i++) { folderWork.ids++; yield this[i]; }
        };
      }`, worker.context);
    const warm = await searchWithWork(search);
    assert.deepStrictEqual(warm.result, cold.result);
    assert.deepStrictEqual(warm.result.records.map(record => record.File), files);
    assert.deepStrictEqual(warm.work, {ids: files.length, predicates: files.length, builds: 0});
  }
  await verify(input, ['Row 0', 'Row 4']);
  await verify(input.map((record, i) => i === 0 ? {...record, Folder: ['docs']} :
    i === 2 ? {...record, Folder: ['Docs']} : record), ['Row 2', 'Row 4']);
});

test('mixed folder narrowing bounds subtree traversal and preflights broad direct buckets', async () => {
  const {context} = makeWorker();
  const result = vm.runInContext(`(() => {
    const noIds = {length: 4097, [Symbol.iterator]() { throw Error('broad IDs walked'); }};
    const tooManyChildren = {length: 4097, [Symbol.iterator]() { throw Error('broad tree walked'); }};
    const directory = {files: {wide: noIds}, nodes: {wide: {count: 1, children: tooManyChildren}}};
    const direct = warmFolderCandidates(directory, buildFilterSets({folderSelfs: ['wide']}), 20000);
    const subtree = warmFolderCandidates(directory, buildFilterSets({folderSubtrees: ['wide']}), 20000);
    return direct === null && subtree === null;
  })()`, context);
  assert.strictEqual(result, true);
});

test('warm mixed folder search scans tiny and noncanonical directory scopes', async () => {
  for (const folder of [[], ['', 'target'], ['target/part'], ['other']]) {
    const size = folder.length ? 32 : 3;
    const input = Array.from({length: size}, (_, i) => ({...records[0], Folder: i ? folder : ['target', 'part']}));
    const data = compact(input);
    if (folder[0] === 'other') data.fd[1].slice = null;
    const worker = makeWorker();
    await worker.request('replace-corpus', {data});
    const base = {repos: ['Repo/A'], folderMatchMode: 'mixed', folderSelfs: ['target/part']};
    const cold = await worker.request('local-search', base);
    const searchWithWork = observeFolderSearch(worker);
    await worker.request('folder-tree', {repo: 'Repo/A'});
    vm.runInContext('searchOrderCache.clear();', worker.context);
    assert.deepStrictEqual(await searchWithWork(base), {
      result: cold, work: {ids: 0, predicates: size, builds: 0},
    });
    if (folder[0] === 'other') {
      const result = await worker.send('local-search', {...base, folderSubtrees: ['target']});
      assert.strictEqual(result.ok, false);
      assert.match(result.error.message, /slice/);
    } else if (folder[0] === '') {
      // The directory indexes ['', 'target'] at 'target'; the predicate
      // instead sees '/target', and the leading slash is cleaned in requests.
      assert.strictEqual((await searchWithWork({...base, folderSelfs: [], folderSubtrees: ['target']})).result.total, 1);
    }
  }
});

async function namesWithCorpus(input, params) {
  const harness = await loaded(input);
  return (await harness.worker.request("local-search", params)).records.map((record) => record.File);
}
test("exact and wildcard searches cover file repository and folder metadata", async () => {
  assert.deepStrictEqual(await names({ q: "alpha guide", exact: true }), ["alpha guide"]);
  assert.deepStrictEqual(await names({ q: "alpha*", exact: true }), ["alpha guide", "beta alpha", "gamma"]);
  assert.strictEqual((await search({ q: "***", exact: true })).total, records.length);
  assert.strictEqual((await search({ q: "Repo/?", exact: true })).total, records.length);
  assert.deepStrictEqual(await names({ q: "alpha-folder", exact: true, searchFolders: false }), []);
});
test("repository extension and size filters compose", async () => {
  assert.deepStrictEqual(await names({ q: "", repos: ["Repo/A"], extensions: ["pdf"], minSize: 400, maxSize: 600 }), ["beta alpha"]);
  assert.deepStrictEqual(await names({ q: "", minSize: 1, maxSize: 10 }), ["手。机"]);
});
test("prefix exact root and mixed folder filters retain semantics", async () => {
  assert.deepStrictEqual(await names({ q: "", folders: ["docs"], folderMatchMode: "prefix" }), ["alpha guide", "beta alpha", "delta", "same"]);
  assert.deepStrictEqual(await names({ q: "", folders: ["docs"], folderMatchMode: "exact" }), ["delta"]);
  assert.deepStrictEqual(await names({ q: "", folders: [""], folderMatchMode: "prefix" }), records.map(record => record.File));
  assert.deepStrictEqual(await names({ q: "", folderMatchMode: "mixed", folderSelfs: ["archive"], folderSubtrees: ["docs"] }), ["alpha guide", "beta alpha", "beta notes", "delta", "same"]);
});
test("mixed direct-only search skips ancestor construction but retains component boundaries", async () => {
  const input = [
    { Repo: "R", File: "component", Extension: "txt", Folder: ["a/b", "c"], Size: 1, HasTxt: false },
    { Repo: "R", File: "nested", Extension: "txt", Folder: ["a", "b", "c"], Size: 1, HasTxt: false },
    { Repo: "R", File: "empty", Extension: "txt", Folder: ["a", "", "c"], Size: 1, HasTxt: false },
    { Repo: "R", File: "root", Extension: "txt", Folder: [], Size: 1, HasTxt: false },
  ];
  assert.deepStrictEqual(await namesWithCorpus(input, { folderMatchMode: "mixed", folderSelfs: ["a/b/c"] }),
    ["component", "nested"]);
  assert.deepStrictEqual(await namesWithCorpus(input, { folderMatchMode: "mixed", folderSubtrees: ["a"] }),
    ["nested", "empty"]);
  assert.deepStrictEqual(await namesWithCorpus(input, { folderMatchMode: "mixed", folderSelfs: [""], folderSubtrees: ["a//c"] }),
    ["empty", "root"]);
  const { worker } = await loaded(input);
  const filtered = vm.runInContext(`(() => {
    const folders = ["a", "b"];
    folders.slice = () => { throw new Error("unneeded subtree prefix"); };
    const filters = buildFilterSets({ folderSelfs: ["a/c"], folderSubtrees: [] });
    return matchesFolderFilters(folders, "a/b", { folderMatchMode: "mixed" }, filters);
  })()`, worker.context);
  assert.strictEqual(filtered, false);
});
test("name size and relevance sorting retain stable order", async () => {
  const expectedName = records.slice().sort((a, b) => a.File.toLowerCase() < b.File.toLowerCase() ? -1 : a.File.toLowerCase() > b.File.toLowerCase() ? 1 : 0).map((r) => r.File);
  assert.deepStrictEqual(await names({ q: "", sort: "name" }), expectedName);
  assert.deepStrictEqual(await names({ q: "", sort: "size" }), ["beta alpha", "delta", "gamma", "alpha guide", "same", "same", "beta notes", "手。机", "手机资料"]);
  assert.deepStrictEqual(await names({ q: "alpha" }), ["alpha guide", "beta alpha", "gamma"]);
});
test("broad relevance ranks by the same field weights without sorting scored objects", async () => {
  const cases = [
    ["R", "guide", "pdf", "books"],
    ["repo.pdf", "guide", "txt", "folder"],
    ["R", "guide", "txt", "archive.pdf"],
    ["repo-pdf", "guide", "pdf", "notes-pdf"],
    ["R", "guide.pdf-index", "txt", "book"],
    ["ignored", "guide", "txt", "book"],
  ];
  const input = Array.from({length: 1800}, (_, i) => {
    const [Repo, name, Extension, folder] = cases[i % cases.length];
    return {Repo, File: `${name} ${i}`, Extension, Folder: [folder], Size: i + 1, HasTxt: false};
  });
  const {worker} = await loaded(input);
  vm.runInContext(`{
    const sort = Array.prototype.sort;
    Array.prototype.sort = function (...args) {
      if (typeof this[0]?.score === "number") throw Error("broad query comparison-sorted scored objects");
      return sort.apply(this, args);
    };
  }`, worker.context);
  for (const [q, re, tokens] of [
    ["*.pdf", /\.pdf/i, ["pdf"]],
    ["?*.pdf", /.\.pdf/i, ["pdf"]],
    ["*.pdf guide*", /\.pdf/i, ["pdf", "guide"]],
  ]) for (const searchFolders of [true, false]) {
    const expected = input.flatMap(record => {
      const fields = [`${record.File}.${record.Extension}`, record.Repo, searchFolders ? record.Folder.join("/") : ""];
      if (!fields.some(field => re.test(field))) return [];
      const score = tokens.reduce((sum, token) => sum + fields.reduce((n, field, i) =>
        n + (field.includes(token) ? [3, 1, 2][i] : 0), 0), 0);
      return [{record, score}];
    }).sort((a, b) => b.score - a.score).map(item => item.record);
    const target = expected[701];
    const params = {q, exact: true, searchFolders, pageSize: 400,
      anchorId: `${target.Repo}\0${target.Folder.join("/")}/${target.File}.${target.Extension}`};
    const actual = [];
    for (let page = 1; page <= Math.ceil(expected.length / params.pageSize); page++) {
      const result = await worker.request("local-search", {...params, page});
      assert.strictEqual(result.total, expected.length);
      assert.strictEqual(result.anchor_index, 701);
      actual.push(...result.records);
    }
    assert.deepStrictEqual(actual, expected);
  }
});
test("paging reports exact totals and boundaries", async () => {
  const middle = await search({ q: "", page: 2, pageSize: 3 });
  assert.deepStrictEqual(middle.records, records.slice(3, 6));
  assert.strictEqual(middle.total, 9);
  assert.strictEqual((await search({ q: "", page: 4, pageSize: 3 })).records.length, 0);
});
test("empty global and single-repository searches bypass record filtering", async () => {
  const { worker } = await loaded();
  worker.context.applyFilters = function() { throw new Error("fast path scanned records"); };
  assert.deepStrictEqual((await worker.request("local-search", { q: "", page: 2, pageSize: 2 })).records, records.slice(2, 4));
  assert.deepStrictEqual((await worker.request("local-search", { q: "", repos: ["Repo/B"] })).records.map((record) => record.File), ["beta notes", "gamma"]);
  const expectedRepoName = records.filter((record) => record.Repo === "Repo/C")
    .sort((a, b) => a.File.toLowerCase() < b.File.toLowerCase() ? -1 : a.File.toLowerCase() > b.File.toLowerCase() ? 1 : 0).map((record) => record.File);
  assert.deepStrictEqual((await worker.request("local-search", { q: "", repos: ["Repo/C"], sort: "name" })).records.map((record) => record.File), expectedRepoName);
  assert.deepStrictEqual((await worker.request("local-search", { q: "", repos: ["Repo/A"], sort: "size" })).records.map((record) => record.File), ["beta alpha", "alpha guide"]);
});
test("empty searches with record filters retain the general filtering path", async () => {
  const { worker } = await loaded();
  const original = worker.context.applyFilters;
  let calls = 0;
  worker.context.applyFilters = function(indices, params) { calls++; return original(indices, params); };
  const result = await worker.request("local-search", { q: "", repos: ["Repo/A"], extensions: ["pdf"] });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(result.records.map((record) => record.File), ["beta alpha"]);
});
test("filtered empty search scopes one string repository without global scan", async () => {
  const {worker} = await loaded();
  vm.runInContext('globalThis.allIndices = recordIndices; recordIndices = new Proxy(allIndices, {get(){throw Error("global scan")}});',worker.context);
  const params = {q:"",repos:["Repo/C"],extensions:["txt"],pageSize:2,anchorId:"Repo/C\0docs/delta.TXT"};
  const first = await worker.request("local-search",params);
  assert.deepStrictEqual(first.records.map(record => record.File), ["手机资料","delta"]);
  assert.strictEqual(first.total,3);
  assert.strictEqual(first.anchor_index,1);
  assert.deepStrictEqual((await worker.request("local-search",{...params,page:2})).records.map(record => record.File), ["手。机"]);
  assert.strictEqual((await worker.request("local-search",{q:"",repos:["missing"],extensions:["txt"]})).total,0);
  vm.runInContext('recordIndices = allIndices; searchOrderCache.clear();',worker.context);
  const multiple = await worker.request("local-search",{q:"",repos:["Repo/A","Repo/C"],extensions:["pdf","txt"]});
  assert.deepStrictEqual(multiple.records.map(record => record.File), ["alpha guide","beta alpha","手机资料","delta","手。机"]);
  const empty = await worker.request("local-search",{q:"",repos:[""],extensions:["txt"]});
  assert.strictEqual(empty.total,0);
});
test("filtered empty relevance skips scoring while preserving pages and anchors", async () => {
  const {worker} = await loaded();
  worker.context.tokenize = () => { throw new Error("empty query should not score records"); };
  const params = {q:"", extensions:["txt"], pageSize:2, anchorId:"Repo/C\0docs/delta.TXT"};
  const first = await worker.request("local-search", params);
  assert.strictEqual(first.total, 7);
  assert.deepStrictEqual(first.records.map(record => record.File), ["alpha guide", "gamma"]);
  assert.strictEqual(first.anchor_index, 3);
  const second = await worker.request("local-search", {...params, page:2});
  assert.deepStrictEqual(second.records.map(record => record.File), ["手机资料", "delta"]);
  assert.strictEqual(second.anchor_index, 3);
  const sorted = await worker.request("local-search", {...params, sort:"size", pageSize:10});
  assert.deepStrictEqual(sorted.records.map(record => record.File), ["delta", "gamma", "alpha guide", "same", "same", "手。机", "手机资料"]);
  const controls = await worker.request("local-search", {q:"", folderMatchMode:"mixed", folderSelfs:[""], folderSubtrees:["docs"], pageSize:20});
  assert.deepStrictEqual(controls.records.map(record => record.File), ["alpha guide", "beta alpha", "手机资料", "delta", "手。机", "same"]);
  await worker.request("replace-corpus", {data:compact(records.slice().reverse())});
  const replaced = await worker.request("local-search", {...params, page:1});
  assert.deepStrictEqual(replaced.records.map(record => record.File), ["same", "same"]);
  assert.strictEqual(replaced.anchor_index, 3);
  assert.notStrictEqual(replaced.snapshot_generation, first.snapshot_generation);
});
test("wildcard-only queries preserve stable zero-score order without field reads", async () => {
  const {worker} = await loaded();
  const params = {q:"*",exact:true,extensions:["txt"],pageSize:2,anchorId:"Repo/C\0docs/delta.TXT"};
  worker.context.getRecordSearchFields = () => { throw new Error("unexpected score field access"); };
  const first = await worker.request("local-search",params);
  assert.strictEqual(first.total,7);
  assert.deepStrictEqual(first.records.map(record => record.File),["alpha guide","gamma"]);
  assert.strictEqual(first.anchor_index,3);
  const next = await worker.request("local-search",{...params,page:2});
  assert.deepStrictEqual(next.records.map(record => record.File),["手机资料","delta"]);
  assert.strictEqual(next.anchor_index,3);
  const sorted = await worker.request("local-search",{...params,sort:"size",pageSize:10});
  assert.deepStrictEqual(sorted.records.map(record => record.File),["delta","gamma","alpha guide","same","same","手。机","手机资料"]);
  await worker.request("replace-corpus",{data:compact(records.slice().reverse())});
  const replaced = await worker.request("local-search",params);
  assert.deepStrictEqual(replaced.records.map(record => record.File),["same","same"]);
  assert.notStrictEqual(replaced.snapshot_generation,first.snapshot_generation);
});
test("mixed wildcard repo proof skips only demonstrably matching string corpora", async () => {
  const input = [
    {...records[0], Repo:"AA", File:"first", Folder:["docs"], Size:1},
    {...records[0], Repo:"BB", File:"second", Folder:["docs"], Size:2},
    {...records[0], Repo:"AA", File:"third", Folder:["other"], Size:3},
  ];
  const {worker} = await loaded(input);
  vm.runInContext('globalThis.originalFields = getRecordSearchFields; getRecordSearchFields = () => { throw Error("unexpected field scan"); };', worker.context);
  const result = await worker.request("local-search",{q:"?*?",exact:true,pageSize:2,anchorId:"BB\0docs/second.txt"});
  assert.strictEqual(result.total,3);
  assert.deepStrictEqual(result.records.map(record => record.File),["first","second"]);
  assert.strictEqual(result.anchor_index,1);
  assert.deepStrictEqual((await worker.request("local-search",{q:"?*?",exact:true,pageSize:2,page:2})).records.map(record=>record.File),["third"]);
  assert.deepStrictEqual((await worker.request("local-search",{q:"?*?",exact:true,repos:["AA"],extensions:["txt"],sort:"size"})).records.map(record=>record.File),["third","first"]);
  vm.runInContext('getRecordSearchFields = originalFields; searchOrderCache.clear();', worker.context);
  assert.deepStrictEqual((await worker.request("local-search",{q:"?*? first",exact:true})).records.map(record=>record.File),["first"]);
  assert.deepStrictEqual((await worker.request("local-search",{q:"first ?*?",exact:true})).records.map(record=>record.File),["first"]);

  // An empty, line-broken or one-code-point repo cannot prove a match;
  // filenames may still match, including their extension.
  const fallback = [
    {...records[0], Repo:"", File:"abc", Folder:[]},
    {...records[0], Repo:"A\nB", File:"z", Folder:[]},
    {...records[0], Repo:"\u2028", File:"", Folder:[]},
    {...records[0], Repo:"😀", File:"", Extension:"", Folder:[]},
    {...records[0], Repo:"😀📚", File:"", Extension:"", Folder:[]},
  ];
  await worker.request("replace-corpus",{data:compact(fallback)});
  vm.runInContext('globalThis.scans = 0; getRecordSearchFields = record => {scans++; return originalFields(record);};',worker.context);
  assert.deepStrictEqual((await worker.request("local-search",{q:"?*?",exact:true})).records.map(record=>record.Repo),["","A\nB","\u2028","😀📚"]);
  assert.strictEqual(vm.runInContext('scans',worker.context),fallback.length);
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
  vm.runInContext('getRecordSearchFields = originalFields;',worker.context);

  // JSON-compatible non-string repo values must retain the old scan path,
  // because object-key coercion and search-field coercion are not identical.
  const malformed = {v:2,rp:[0,false,null,42,{x:1}],fd:[[]],rc:[
    [0,"abc","txt",0,1,0], [1,"","txt",0,1,0], [2,"","txt",0,1,0],
    [3,"","txt",0,1,0], [4,"","txt",0,1,0],
  ]};
  await worker.request("replace-corpus",{data:malformed});
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),false);
  vm.runInContext('globalThis.scans = 0; getRecordSearchFields = record => {scans++; return originalFields(record);};',worker.context);
  const malformedResult = await worker.request("local-search",{q:"?*?",exact:true,pageSize:10});
  assert.strictEqual(malformedResult.total,5);
  assert.ok(vm.runInContext('scans > 0',worker.context));
  vm.runInContext('getRecordSearchFields = originalFields;',worker.context);
  // Preserve field coercion for unusual filenames and folder components too;
  // skipping a match term must not suppress its legacy field access/errors.
  for (const unusual of [
    {v:2,rp:["AA"],fd:[[]],rc:[[0,42,"txt",0,1,0]]},
    {v:2,rp:["AA"],fd:[[42]],rc:[[0,"file","txt",0,1,0]]},
  ]) {
    await worker.request("replace-corpus",{data:unusual});
    assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),false);
    vm.runInContext('scans = 0; getRecordSearchFields = record => {scans++; return originalFields(record);};',worker.context);
    assert.strictEqual((await worker.request("local-search",{q:"?*?",exact:true})).total,1);
    assert.strictEqual(vm.runInContext('scans',worker.context),1);
    vm.runInContext('getRecordSearchFields = originalFields;',worker.context);
  }
  const folder = ["docs"];
  folder.some = null; // A structured-cloned array can shadow its inherited method.
  await worker.request("replace-corpus",{data:{v:2,rp:["AA"],fd:[folder],rc:[[0,"file","txt",0,1,0]]}});
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
  assert.strictEqual((await worker.request("local-search",{q:"?*?",exact:true})).total,1);
  await worker.request("replace-corpus",{data:compact(input)});
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
});
test("a failed corpus replacement never publishes a partial repo proof", async () => {
  const {worker} = await loaded([{...records[0], Repo:"AA"}]);
  const before = await worker.request('local-search', {q:'alpha', exact:true});
  const folderBefore = await worker.request('folder-tree', {repo:'AA'});
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
  const invalid = {v:2, rp:["BB", "CC"], fd:[[], [{toString:null, valueOf:null}]], rc:[
    [0,"first","txt",0,1,0], [1,"second","txt",1,1,0],
  ]};
  const response = await worker.send("replace-corpus", {data:invalid});
  assert.strictEqual(response.ok,false);
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
  const after = await worker.request('local-search', {q:'alpha', exact:true});
  assert.deepStrictEqual(after, before);
  const browse = await worker.request('local-search', {});
  assert.strictEqual(browse.total, 1);
  assert.strictEqual(browse.records[0].Repo, 'AA');
  assert.strictEqual((await worker.request('metadata')).generation, before.generation);
  assert.deepStrictEqual(await worker.request('folder-tree', {repo:'AA'}), folderBefore);
  await worker.request("replace-corpus",{data:compact([{...records[0], Repo:"DD"}])});
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
});
test("empty exact scope does not repeatedly prove universal wildcard terms", async () => {
  const {worker} = await loaded([{...records[0], Repo:"AA"}]);
  vm.runInContext(`globalThis.matcherCalls = 0;
    globalThis.originalMatcher = compileWildcardMatcher;
    compileWildcardMatcher = term => { matcherCalls++; return originalMatcher(term); };
    repoRecordIndices = new Proxy(repoRecordIndices, {ownKeys() { throw Error("unneeded repo proof"); }});`, worker.context);
  const result = await worker.request("local-search",{q:"?*? ?*? ?*?",exact:true,repos:["missing"]});
  assert.strictEqual(result.total,0);
  assert.strictEqual(vm.runInContext('matcherCalls',worker.context),1);
});
test("small scopes scan records instead of proving every repository", async () => {
  const input = Array.from({length:100}, (_, i) => ({...records[0], Repo:`Repo/${i}`, File:`file${i}`}));
  const {worker} = await loaded(input);
  vm.runInContext(`globalThis.scans = 0; globalThis.originalFields = getRecordSearchFields;
    getRecordSearchFields = record => { scans++; return originalFields(record); };
    repoRecordIndices = new Proxy(repoRecordIndices, {ownKeys() { throw Error("unneeded repo proof"); }});`, worker.context);
  const result = await worker.request("local-search",{q:"?*?",exact:true,repos:["Repo/0"]});
  assert.strictEqual(result.total,1);
  assert.strictEqual(result.records[0].File,"file0");
  assert.strictEqual(vm.runInContext('scans',worker.context),1);
});
test("dense repository sorting can reuse prepared stable orders", async () => {
  const input = Array.from({length:36}, (_, index) => ({...records[0],
    Repo:"Repo/A", File:["a", "A", "中", "b"][index % 4], Extension:index % 7 ? "pdf" : "txt",
    Size:[100, 0, -1, "unknown"][index % 4], Folder:["f" + index]}));
  for (const sort of ["name", "size"]) {
    const {worker} = await loaded(input);
    const params = {q:"",repos:["Repo/A"],extensions:["pdf"],sort,pageSize:100};
    const cold = await worker.request("local-search", params);
    await worker.request("local-search", {q:"",repos:["Repo/A"],sort});
    vm.runInContext('searchOrderCache.clear();', worker.context);
    worker.context[sort === "name" ? "compareRecordName" : "compareRecordSize"] = () => { throw Error("re-sorted"); };
    const warm = await worker.request("local-search", params);
    assert.deepStrictEqual(warm.ids, cold.ids);
    assert.strictEqual(warm.total, cold.total);
  }
});
test("dense exact single-repo name searches reuse prepared stable order", async () => {
  const input = Array.from({length:60}, (_, index) => ({...records[0],
    Repo:index < 50 ? "Repo/A" : "Repo/B", File:["a", "A", "中", "a"][index % 4],
    Extension:index % 9 ? "pdf" : "txt", Size:[1, 0, -1, "unknown"][index % 4], Folder:["same"]}));
  const {worker} = await loaded(input);
  const params = {q:"?*?",exact:true,repos:["Repo/A"],extensions:["pdf"],sort:"name",pageSize:7};
  const cold = await worker.request("local-search",{...params,pageSize:100});
  const anchor = "Repo/A\0same/" + cold.records[10].File + "." + cold.records[10].Extension;
  const expected = await worker.request("local-search",{...params,page:2,anchorId:anchor});
  await worker.request("local-search",{q:"",repos:["Repo/A"],sort:"name"});
  vm.runInContext('searchOrderCache.clear();', worker.context);
  worker.context.compareRecordName = () => { throw Error("re-sorted"); };
  const warm = await worker.request("local-search",{...params,page:2,anchorId:anchor});
  assert.deepStrictEqual(warm.ids,expected.ids);
  assert.strictEqual(warm.total,expected.total);
  assert.strictEqual(warm.anchor_index,expected.anchor_index);
});
test("searched name sort reuse preserves fallback for unusual or sparse scopes", async () => {
  const input = Array.from({length:30}, (_, index) => ({...records[0],
    Repo:index < 25 ? "Repo/A" : "Repo/B", File:index < 22 ? "same" : "other",
    Extension:index % 6 ? "pdf" : "txt", Folder:["f" + index]}));
  const {worker} = await loaded(input);
  await worker.request("local-search",{q:"",repos:["Repo/A"],sort:"name"});
  vm.runInContext('globalThis.originalCompare = compareRecordName; globalThis.compares = 0; compareRecordName = (a,b) => { compares++; return originalCompare(a,b); };',worker.context);
  const controls = [
    {q:"same",exact:true,repos:["Repo/A"],extensions:["txt"]},
    {q:"same",exact:true,repos:["Repo/A","Repo/B"]},
    {q:"same",exact:true,repos:["Repo/A","Repo/A"]},
    {q:"same",exact:true,repos:[""]},
    {q:"same",exact:false,repos:["Repo/A"]},
  ];
  for (const params of controls) {
    vm.runInContext('compares = 0;',worker.context);
    await worker.request("local-search",{...params,sort:"name"});
    if (params.repos[0] !== "") assert(vm.runInContext('compares > 0',worker.context));
  }
  await worker.request("replace-corpus",{data:compact(input.slice().reverse())});
  assert.strictEqual(vm.runInContext('nameOrderReady',worker.context),false);
  vm.runInContext('compares = 0;',worker.context);
  await worker.request("local-search",{q:"same",exact:true,repos:["Repo/A"],sort:"name"});
  assert(vm.runInContext('compares > 0',worker.context));
});
test("searched name order reuse preserves malformed and failed replacement fallback", async () => {
  const input = Array.from({length:30}, (_, index) => ({...records[0],
    Repo:"Repo/A", File:["a", "A", "中"][index % 3], Extension:"txt", Folder:[]}));
  const {worker} = await loaded(input);
  const params = {q:"?*?",exact:true,repos:["Repo/A"],sort:"name",pageSize:100};
  const before = await worker.request("local-search",params);
  await worker.request("local-search",{q:"",repos:["Repo/A"],sort:"name"});
  const invalid = {v:2,rp:["Repo/A"],fd:[[], [{toString:null, valueOf:null}]],rc:[
    [0,"a","txt",0,1,0],[0,"b","txt",1,1,0],
  ]};
  assert.strictEqual((await worker.send("replace-corpus",{data:invalid})).ok,false);
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),true);
  const preserved = await worker.request("local-search",params);
  assert.deepStrictEqual(preserved.ids,before.ids);
  assert.strictEqual(preserved.snapshot_generation,before.snapshot_generation);
  await worker.request("replace-corpus",{data:compact(input)});
  assert.strictEqual(vm.runInContext('nameOrderReady',worker.context),false);
  const restored = await worker.request("local-search",params);
  assert.deepStrictEqual(restored.ids,before.ids);

  const malformed = {v:2,rp:["Repo/A"],fd:[[]],rc:Array.from({length:30},(_,index)=>
    [0,index === 0 ? 42 : "file" + index,"txt",0,1,0])};
  await worker.request("replace-corpus",{data:malformed});
  assert.strictEqual(vm.runInContext('repoWildcardProofSafe',worker.context),false);
  await worker.request("local-search",{q:"",repos:["Repo/A"],sort:"name"});
  vm.runInContext('globalThis.originalCompare = compareRecordName; globalThis.compares = 0; compareRecordName = (a,b) => {compares++; return originalCompare(a,b);};',worker.context);
  assert.strictEqual((await worker.request("local-search",params)).total,30);
  assert(vm.runInContext('compares > 0',worker.context));
});
test("implicit literal searches reuse only a ready dense repository name order", async () => {
  const input = Array.from({length:30}, (_, index) => ({...records[0],
    Repo:"Repo/A", File:index % 2 ? "alpha" : "ALPHA", Folder:[]}));
  const {worker} = await loaded(input);
  const params = {q:"a*",exact:false,repos:["Repo/A"],sort:"name",pageSize:10};
  const cold = await worker.request("local-search",params);
  await worker.request("local-search",{q:"",repos:["Repo/A"],sort:"name"});
  vm.runInContext('searchOrderCache.clear(); compareRecordName = () => { throw Error("re-sorted"); };',worker.context);
  const warm = await worker.request("local-search",params);
  assert.strictEqual(warm.total,cold.total);
  assert.deepStrictEqual(warm.ids,cold.ids);
});
test("ASCII fuzzy searches never take the dense exact-order shortcut", async () => {
  const input=Array.from({length:30},(_,i)=>({...records[0],Repo:'Repo/A',File:i%2?'alpha guide':'alpha other'}));
  const {worker}=await loaded(input);
  await worker.request('local-search',{q:'',repos:['Repo/A'],sort:'name'});
  vm.runInContext(`globalThis.beforeCompare=compareRecordName; globalThis.compares=0;
    compareRecordName=(a,b)=>{compares++;return beforeCompare(a,b);}`,worker.context);
  const result=await worker.request('local-search',{q:'alpha-guied',exact:false,repos:['Repo/A'],sort:'name'});
  assert.strictEqual(result.total,15);
  assert(vm.runInContext('compares > 0',worker.context));
});
test("searched name order reuse respects the exact temporary set cap", async () => {
  for (const count of [65536,65537]) {
    const input = Array.from({length:count}, (_, index) => ({...records[0],
      Repo:"Repo/A", File:"file-" + String(count - index).padStart(6,"0"), Folder:[]}));
    const {worker} = await loaded(input);
    const browse = await worker.request("local-search",{q:"",repos:["Repo/A"],sort:"name",pageSize:20});
    vm.runInContext('globalThis.originalCompare = compareRecordName; globalThis.compares = 0; compareRecordName = (a,b) => { compares++; return originalCompare(a,b); };',worker.context);
    const result = await worker.request("local-search",{q:"?*?",exact:true,repos:["Repo/A"],sort:"name",pageSize:20});
    assert.strictEqual(result.total,count);
    assert.deepStrictEqual(result.ids,browse.ids);
    if (count === 65536) assert.strictEqual(vm.runInContext('compares',worker.context),0);
    else assert(vm.runInContext('compares > 0',worker.context));
  }
});
test("prepared sort reuse falls back for sparse, multi-repository and searched results", async () => {
  const input = Array.from({length:30}, (_, index) => ({...records[0],
    Repo:index < 25 ? "Repo/A" : "Repo/B", File:"same " + (index % 4),
    Extension:index % 6 ? "pdf" : "txt", Folder:["f" + index]}));
  const {worker} = await loaded(input);
  await worker.request("local-search", {q:"",repos:["Repo/A"],sort:"name"});
  vm.runInContext('globalThis.originalNameCompare = compareRecordName; globalThis.sortComparisons = 0; compareRecordName = (a,b) => {sortComparisons++; return originalNameCompare(a,b)};',worker.context);
  const sparse = await worker.request("local-search", {q:"",repos:["Repo/A"],extensions:["txt"],sort:"name"});
  assert.strictEqual(sparse.total, 5);
  assert(vm.runInContext('sortComparisons > 0',worker.context));
  vm.runInContext('sortComparisons = 0;',worker.context);
  const multiple = await worker.request("local-search", {q:"",repos:["Repo/A","Repo/B"],extensions:["pdf"],sort:"name"});
  assert.strictEqual(multiple.total, 25);
  assert(vm.runInContext('sortComparisons > 0',worker.context));
  vm.runInContext('sortComparisons = 0;',worker.context);
  const searched = await worker.request("local-search", {q:"same",exact:true,repos:["Repo/A"],extensions:["pdf"],sort:"name"});
  assert.strictEqual(searched.total, 20);
  assert.strictEqual(vm.runInContext('sortComparisons',worker.context),0);
});
test("dense sort reuse caps its temporary index set", async () => {
  const input = Array.from({length:65537}, (_, index) => ({...records[0],
    Repo:"Repo/A", File:"same " + index, Extension:"pdf", Folder:[]}));
  const {worker} = await loaded(input);
  await worker.request("local-search", {q:"",repos:["Repo/A"],sort:"size"});
  vm.runInContext('globalThis.usedSort = false; globalThis.originalSizeCompare = compareRecordSize; compareRecordSize = (a,b) => {usedSort = true; return originalSizeCompare(a,b)};',worker.context);
  const result = await worker.request("local-search", {q:"",repos:["Repo/A"],extensions:["pdf"],sort:"size",pageSize:1});
  assert.strictEqual(result.total, 65537);
  assert.strictEqual(vm.runInContext('usedSort',worker.context), true);
});
test("NaN randomValue uses the normal random fallback rather than returning missing fields", async () => {
  const {worker} = await loaded();
  const original = Math.random;
  try {
    Math.random = () => 0;
    const result = await worker.request("random-record", {repo:"Repo/B", randomValue:NaN});
    assert.strictEqual(result.record.File, "beta notes");
    assert.strictEqual(typeof result.id, "string");
    const reader = await worker.request("random-record", {repo:"Repo/B", readerOnly:true, randomValue:NaN});
    assert.strictEqual(reader.record.File, "beta notes");
    assert.strictEqual(typeof reader.id, "string");
    const empty = await worker.request("random-record", {repo:"missing", randomValue:NaN});
    assert.strictEqual(empty.record, null);
    assert.strictEqual(empty.id, null);
  } finally { Math.random = original; }
});

test("random record and reader requests honor repository filters", async () => {
  const { worker } = await loaded();
  let result = await worker.request("random-record", { repo: "Repo/B", randomValue: 0 });
  assert.strictEqual(result.record.Repo, "Repo/B");
  result = await worker.request("random-record", { repo: "Repo/B", readerOnly: true, randomValue: 0 });
  assert.strictEqual(result.record.File, "beta notes");
  result = await worker.request("random-record", { repo: "Missing", readerOnly: true });
  assert.strictEqual(result.record, null);
  const retired = await worker.send("random-record", { repo: "Repo/B", txtOnly: true });
  assert.strictEqual(retired.ok, false);
  assert.strictEqual(retired.error.code, "LEGACY_TXT_RETIRED");
});
test("folder contents request returns only one directory", async () => {
  const { worker } = await loaded();
  const data = await worker.request("folder-contents", { repo: "Repo/A", path: "docs" });
  assert.deepStrictEqual(data.folders, [
    { name: "child", path: "docs/child", count: 1 },
    { name: "root", path: "docs/root", count: 1 },
  ]);
  assert.deepStrictEqual(data.files, []);
  const direct = await worker.request("folder-contents", { repo: "Repo/A", path: "docs/root" });
  assert.deepStrictEqual(direct.files, [{ name: "alpha guide", ext: "txt", size: 100 }]);
});
test("folder tree request preserves direct-file and child metadata", async () => {
  const { worker } = await loaded();
  const result = await worker.request("folder-tree", { repo: "Repo/C" });
  assert.strictEqual(result.tree[0].count, 3);
  assert.strictEqual(result.tree[0].hasDirectFiles, true);
  assert.strictEqual(result.tree[0].children[0].path, "docs");
});
test("untrusted corpus fields and protocol failures retain their legacy outcomes", async () => {
  const worker = makeWorker();
  for (const data of [null, 1, {}, {v:2, rp:[], fd:[], rc:"bad"}]) {
    const response = await worker.send("replace-corpus", {data});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, data === null || data === 1 ? "INVALID_CORPUS" : "UNSUPPORTED_CORPUS");
  }
  const data = {v:2, rp:[27], fd:[[1, null, "dir"]], rc:[[0, 42, {ext:1}, 0, {size:3}, 1]]};
  const result = await worker.request("replace-corpus", {data});
  assert.strictEqual(result.count, 1);
  const page = await worker.request("local-search", {q:"42", exact:true});
  assert.deepStrictEqual(page.records[0], {Repo:27, File:42, Extension:{ext:1}, Folder:[1,null,"dir"], Size:{size:3}, HasTxt:true});
  const folder = await worker.send("folder-contents", {repo:27});
  assert.strictEqual(folder.ok, false);
  assert.strictEqual(folder.error.code, "WORKER_ERROR");
  for (const payload of [{repos: {length:1}}, {folders: {length:1}}, {folderSelfs: 17}]) {
    const response = await worker.send("local-search", {q:"42", exact:true, ...payload});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, "WORKER_ERROR");
  }
  const rawCases = [null, 1, "message", {protocol:1, id:"x", type:"cancel-search", payload:{requestId:"missing"}},
    {protocol:1, id:0, type:"local-search", payload:{q:42, repos:42}},
    {protocol:1, id:"x", type:"unknown", payload:17}];
  for (const raw of rawCases) {
    const before = worker.messages.length;
    await worker.listeners.message({data:raw});
    const response = worker.messages[before];
    assert.strictEqual(response.protocol, 1);
    if (!raw || raw.protocol !== 1) assert.strictEqual(response.error.code, "PROTOCOL_MISMATCH");
    else if (raw.type === "cancel-search") assert.deepStrictEqual(response.result, {cancelled:false});
    else if (raw.type === "unknown") assert.strictEqual(response.error.code, "UNKNOWN_REQUEST");
    else assert.strictEqual(response.ok, true);
  }
  assert.strictEqual((await worker.send("unknown", {})).error.code, "UNKNOWN_REQUEST");
  assert.strictEqual((await worker.send("handshake", {}, {protocol:9})).error.code, "PROTOCOL_MISMATCH");
});

test("wildcard DP numeric conversion matches the original typed-array coercion", () => {
  const {context} = makeWorker();
  const prior = source.replace("Number(current[j] || (dot && previous[j + 1]))", "(current[j] || (dot && previous[j + 1]))")
    .replace('Number(previous[j] && (tokens[j] === "?" ? dot : mask[j]))', '(previous[j] && (tokens[j] === "?" ? dot : mask[j]))');
  const old = makeWorker(prior).context;
  let seed = 123;
  const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
  const alphabet = ["a", "b", "*", "?", "\n", "K", "😀"];
  for (let i = 0; i < 2000; i++) {
    const pattern = Array.from({length: 1 + random(16)}, () => alphabet[random(alphabet.length)]).join("");
    const text = Array.from({length: random(22)}, () => alphabet[random(alphabet.length)]).join("");
    context.pattern = old.pattern = pattern;
    context.text = old.text = text;
    assert.strictEqual(vm.runInContext('compileWildcardMatcher(pattern).test(text)', context),
      vm.runInContext('compileWildcardMatcher(pattern).test(text)', old), JSON.stringify({pattern,text}));
  }
});

test("main thread centralizes lifecycle and never sends or decodes the corpus", () => {
  assert.match(app, /const WORKER_PROTOCOL_VERSION = 1/);
  assert.match(app, /function corpusWorkerRequest/);
  const client = fs.readFileSync('static/search/corpus/application/client.js', 'utf8');
  assert.match(app, /getCorpusClient\(\)\.request\(type, payload, timeoutMs, signal\)/);
  assert.match(client, /function terminateCorpusWorker/);
  assert.match(client, /addEventListener\("messageerror"/);
  assert.match(client, /type: type, id: id, payload:/);
  assert.strictEqual(/\bRECORDS\b|decodeSearchPayload|init-records|build-fulltext/.test(client), false);
  assert.match(app, /corpusWorkerRequest\("load-corpus"/);
  assert.match(app, /corpusWorkerRequest\("local-search"/);
  assert.match(app, /API_BASE \+ "\/api\/search"/);
  assert.strictEqual(/\bRECORDS\b|decodeSearchPayload|init-records|build-fulltext/.test(app), false);
});

run("worker/search");
