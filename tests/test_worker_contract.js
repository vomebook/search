const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { test, run } = require("./test_harness");

const source = fs.readFileSync("static/index-worker.js", "utf8");
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

function makeWorker() {
  const listeners = {};
  const messages = [];
  const context = {
    console,
    Math,
    self: {
      addEventListener(type, listener) { listeners[type] = listener; },
      postMessage(message) { messages.push(clone(message)); },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "static/index-worker.js" });
  async function send(type, payload, options) {
    const settings = Object.assign({ protocol: PROTOCOL, id: "request" }, options || {});
    const before = messages.length;
    await listeners.message({ data: { protocol: settings.protocol, type, id: settings.id, payload: payload || {} } });
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

test("registers one versioned message protocol listener", () => {
  assert.strictEqual(typeof makeWorker().listeners.message, "function");
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
  assert.deepStrictEqual(metadata.txt, { available: true, count: 3, byRepo: { "Repo/A": 1, "Repo/B": 1, "Repo/C": 1 } });
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
test("normal multi-token search intersects candidates", async () => {
  assert.deepStrictEqual(await names({ q: "alpha beta", exact: false }), ["beta alpha"]);
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
  assert.match(app, /if \(node\.isRoot\) \{[\s\S]*?if \(node\.hasDirectFiles && !selfSet\.has\(node\.path\)\) return false/);
  assert.match(app, /if \(node\.hasDirectFiles\) selfSet\.add\(node\.path\)/);
  assert.match(app, /selfSet\.forEach\(function\(path\) \{ if \(!merged\.includes\(path\)\) merged\.push\(path\); \}\)/);
  assert.match(app, /var selfs = \(STATE\.filterFolderSelfs \|\| \[\]\)\.filter\(function\(path\) \{ return typeof path === "string"; \}\)/);
  assert.match(app, /if \(node\.hasDirectFiles\) selfPaths\.push\(node\.path\)/);
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
  assert.deepStrictEqual(await namesWithCorpus(rootRecords, { folders: [""], folderMatchMode: "prefix" }), ["root-file"]);
  assert.deepStrictEqual(await namesWithCorpus(rootRecords, { folders: ["child"], folderMatchMode: "prefix" }), ["nested-file", "deep-file"]);
  const mixed = await harness.worker.request("local-search", {
    folderMatchMode: "mixed", folderSelfs: [""], folderSubtrees: ["child"], page: 1, pageSize: 10,
  });
  assert.deepStrictEqual(mixed.records.map((record) => record.File), ["root-file", "nested-file", "deep-file"]);
  assert.strictEqual(mixed.total, 3);
  assert.strictEqual(mixed.ids.length, mixed.total);
});

async function namesWithCorpus(input, params) {
  const harness = await loaded(input);
  return (await harness.worker.request("local-search", params)).records.map((record) => record.File);
}
test("exact and wildcard searches cover file repository and folder metadata", async () => {
  assert.deepStrictEqual(await names({ q: "alpha guide", exact: true }), ["alpha guide"]);
  assert.deepStrictEqual(await names({ q: "alpha*", exact: true }), ["alpha guide", "beta alpha", "gamma"]);
  assert.strictEqual((await search({ q: "Repo/?", exact: true })).total, records.length);
  assert.deepStrictEqual(await names({ q: "alpha-folder", exact: true, searchFolders: false }), []);
});
test("repository extension and size filters compose", async () => {
  assert.deepStrictEqual(await names({ q: "", repos: ["Repo/A"], extensions: ["pdf"], minSize: 400, maxSize: 600 }), ["beta alpha"]);
  assert.deepStrictEqual(await names({ q: "", minSize: 1, maxSize: 10 }), ["手机资料", "手。机"]);
});
test("prefix exact root and mixed folder filters retain semantics", async () => {
  assert.deepStrictEqual(await names({ q: "", folders: ["docs"], folderMatchMode: "prefix" }), ["alpha guide", "beta alpha", "delta", "same"]);
  assert.deepStrictEqual(await names({ q: "", folders: ["docs"], folderMatchMode: "exact" }), ["delta"]);
  assert.deepStrictEqual(await names({ q: "", folders: [""], folderMatchMode: "prefix" }), ["手机资料", "手。机"]);
  assert.deepStrictEqual(await names({ q: "", folderMatchMode: "mixed", folderSelfs: ["archive"], folderSubtrees: ["docs"] }), ["alpha guide", "beta alpha", "beta notes", "delta", "same"]);
});
test("name size and relevance sorting retain stable order", async () => {
  const expectedName = records.slice().sort((a, b) => a.File.localeCompare(b.File, "zh")).map((r) => r.File);
  assert.deepStrictEqual(await names({ q: "", sort: "name" }), expectedName);
  assert.deepStrictEqual(await names({ q: "", sort: "size" }), ["beta alpha", "delta", "gamma", "alpha guide", "same", "same", "beta notes", "手机资料", "手。机"]);
  assert.deepStrictEqual(await names({ q: "alpha" }), ["alpha guide", "beta alpha", "gamma"]);
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
    .sort((a, b) => a.File.localeCompare(b.File, "zh")).map((record) => record.File);
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
test("random record and TXT requests honor repository filters", async () => {
  const { worker } = await loaded();
  let result = await worker.request("random-record", { repo: "Repo/B", randomValue: 0 });
  assert.strictEqual(result.record.Repo, "Repo/B");
  result = await worker.request("random-record", { repo: "Repo/B", txtOnly: true, randomValue: 0 });
  assert.strictEqual(result.record.File, "beta notes");
  result = await worker.request("random-record", { repo: "Repo/D", txtOnly: true });
  assert.strictEqual(result.record, null);
});
test("folder contents request returns only one directory", async () => {
  const { worker } = await loaded();
  const data = await worker.request("folder-contents", { repo: "Repo/A", path: "docs" });
  assert.deepStrictEqual(data.folders, [
    { name: "child", path: "docs/child", count: 1 },
    { name: "root", path: "docs/root", count: 1 },
  ]);
  assert.deepStrictEqual(data.files, []);
});
test("folder tree request preserves direct-file and child metadata", async () => {
  const { worker } = await loaded();
  const result = await worker.request("folder-tree", { repo: "Repo/C" });
  assert.strictEqual(result.tree[0].count, 3);
  assert.strictEqual(result.tree[0].hasDirectFiles, true);
  assert.strictEqual(result.tree[0].children[0].path, "docs");
});
test("main thread centralizes lifecycle and never sends or decodes the corpus", () => {
  assert.match(app, /const WORKER_PROTOCOL_VERSION = 1/);
  assert.match(app, /function corpusWorkerRequest/);
  assert.match(app, /function terminateCorpusWorker/);
  assert.match(app, /addEventListener\("messageerror"/);
  assert.match(app, /type: type, id: id, payload:/);
  assert.match(app, /corpusWorkerRequest\("load-corpus"/);
  assert.match(app, /corpusWorkerRequest\("local-search"/);
  assert.match(app, /API_BASE \+ "\/api\/search"/);
  assert.strictEqual(/\bRECORDS\b|decodeSearchPayload|init-records|build-fulltext/.test(app), false);
});

run("worker/search");
