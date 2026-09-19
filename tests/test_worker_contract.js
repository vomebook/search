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

function makeWorker(workerSource = source, options = {}) {
  const listeners = {};
  const messages = [];
  const context = {
    ...options,
    console,
    Math,
    TextEncoder: require('util').TextEncoder,
    crypto: {subtle: {digest: async (_algorithm, bytes) => {
      const hash = require('crypto').createHash('sha256').update(bytes).digest();
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    }}},
    self: {
      addEventListener(type, listener) { listeners[type] = listener; },
      postMessage(message) { messages.push(clone(message)); },
    },
  };
  vm.createContext(context);
  vm.runInContext(workerSource, context, { filename: "static/index-worker.js" });
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

test("native Foliate books are eligible for repository-scoped random reading", async () => {
  for (const extension of ["mobi", "azw", "azw3", "fb2", "fbz"]) {
    const { worker, metadata } = await loaded([{ ...records[0], Extension: extension }]);
    assert.strictEqual(metadata.reader.count, 1);
    const record = await worker.request("random-record", { repo: "Repo/A", readerOnly: true });
    assert.strictEqual(record.record.Extension, extension);
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
  return { worker, tasks, tick };
}
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
  assert.strictEqual(vm.runInContext(`
    JSON.stringify(vocabSorted) === JSON.stringify(Object.keys(wordIndex).map(token => [token, wordIndex[token].length]).sort((a, b) => b[1] - a[1])) &&
    JSON.stringify(vocabSortedFilesOnly) === JSON.stringify(Object.keys(wordIndexFilesOnly).map(token => [token, wordIndexFilesOnly[token].length]).sort((a, b) => b[1] - a[1]))
  `, worker.context), true);
  for (const params of [{q: "alpha beta"}, {q: "alhpa"}, {q: "手机"}, {q: "alpha", searchFolders: false}]) {
    const warmed = await worker.request("local-search", params);
    const expected = await cold.worker.request("local-search", params);
    assert.deepStrictEqual(warmed.ids, expected.ids);
    assert.strictEqual(warmed.total, expected.total);
  }
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
  vm.runInContext('wildcardPatternToRegExp = () => { throw new Error("unexpected scan"); }; literalSearch = () => { throw new Error("unexpected scan"); };', worker.context);
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
test("snapshot identity survives Worker restarts but changes with content and search rules", async () => {
  const first = await loaded();
  const second = await loaded();
  const old = await first.worker.request('local-search', {sort: 'name'});
  const current = await second.worker.request('local-search', {sort: 'name'});
  assert.strictEqual(old.snapshot_generation, current.snapshot_generation);
  assert.deepStrictEqual(old.ids, current.ids);
  await second.worker.request('replace-corpus', {data: compact(records)});
  assert.strictEqual(old.snapshot_generation, (await second.worker.request('local-search', {})).snapshot_generation);
  const changed = makeWorker(source.replace('worker-search-v1', 'worker-search-v2'));
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
test("explicit sorts preserve collation and ties without computing relevance tokens", async () => {
  const input = ["book 中国", "book 重", "book Chong", "book chong", "book 10", "book 2", "book e\u0301", "book é", "book 重"]
    .map((File, i) => ({Repo: "Test", File, Folder: [String(i)], Extension: "txt", Size: i % 3, HasTxt: false}));
  const {worker} = await loaded(input);
  vm.runInContext('tokenize = () => {throw new Error("unneeded scoring tokens");};', worker.context);
  for (const sort of ["name", "size"]) {
    const compare = sort === "name" ? (a, b) => a.File.localeCompare(b.File, "zh") : (a, b) => b.Size - a.Size;
    const result = await worker.request("local-search", {q: "book", exact: true, sort});
    assert.deepStrictEqual(result.records, input.slice().sort(compare));
    assert.strictEqual(result.total, input.length);
  }
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
  const context = vm.createContext({ Set });
  vm.runInContext(app.slice(app.indexOf("function folderPathCovered("), app.indexOf("// Split covering ancestors")), context);
  const root = { path: "", isRoot: true, hasDirectFiles: true, children: [{ path: "child", hasDirectFiles: true }] };
  assert.strictEqual(context.folderSelectionState(root, new Set(["child"]), new Set()).full, false);
  assert.strictEqual(context.folderSelectionState(root, new Set(["child"]), new Set([""])).full, true);
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
