const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { test, run } = require("./test_harness");

const source = fs.readFileSync("static/index-worker.js", "utf8");
const app = fs.readFileSync("static/app.js", "utf8");
const records = [
  { Repo: "Repo/A", File: "alpha guide.txt", Extension: "txt", Folder: ["docs", "root"], Size: 100, HasTxt: true },
  { Repo: "Repo/A", File: "beta alpha.pdf", Extension: "pdf", Folder: ["docs", "child"], Size: 500, HasTxt: false },
  { Repo: "Repo/B", File: "beta notes.md", Extension: "md", Folder: ["archive"], Size: 50, HasTxt: true },
  { Repo: "Repo/B", File: "gamma.txt", Extension: "txt", Folder: ["alpha-folder", "nested"], Size: 200, HasTxt: false },
  { Repo: "Repo/C", File: "手机资料.txt", Extension: "txt", Folder: [], Size: 0, HasTxt: true },
  { Repo: "Repo/C", File: "delta.txt", Extension: "TXT", Folder: ["docs"], Size: 300, HasTxt: false },
  { Repo: "Repo/C", File: "手。机.txt", Extension: "txt", Folder: [], Size: "unknown", HasTxt: false },
  { Repo: "Repo/D", File: "same.txt", Extension: "txt", Folder: ["docs", "same"], Size: 100, HasTxt: false },
  { Repo: "Repo/D", File: "same.txt", Extension: "txt", Folder: ["other"], Size: 100, HasTxt: false },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function worker(options) {
  const settings = Object.assign({ init: true, build: true }, options || {});
  const listeners = {};
  const messages = [];
  const context = {
    console,
    self: {
      addEventListener(type, listener) { listeners[type] = listener; },
      postMessage(message) { messages.push(clone(message)); },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "static/index-worker.js" });
  function send(data) {
    const before = messages.length;
    listeners.message({ data });
    return messages.slice(before);
  }
  function search(params, id) {
    const requestId = id === undefined ? "request" : id;
    const sent = send({ type: "local-search", id: requestId, params: params || {} });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, "local-search-result");
    assert.strictEqual(sent[0].id, requestId);
    return sent[0].result;
  }
  if (settings.init) assert.deepStrictEqual(send({ type: "init-records", records: clone(records) }), [{ type: "records-ready" }]);
  if (settings.build) assert.deepStrictEqual(send({ type: "build-fulltext" }), [{ type: "fulltext-ready" }]);
  return { listeners, send, search };
}

function indices(params) {
  return worker().search(params).indices;
}

test("registers the message protocol listener", () => {
  assert.strictEqual(typeof worker({ init: false, build: false }).listeners.message, "function");
});
test("ignores unknown message types", () => {
  assert.deepStrictEqual(worker({ init: false, build: false }).send({ type: "unknown" }), []);
});
test("init-records acknowledges and supports unindexed empty-query paging", () => {
  const harness = worker({ build: false });
  assert.deepStrictEqual(harness.search({ q: "", page: 2, pageSize: 2 }, "before-index"), { indices: [2, 3], total: 9, page: 2, pageSize: 2 });
});
test("non-empty search before indexing returns no candidates", () => {
  assert.deepStrictEqual(worker({ build: false }).search({ q: "alpha" }).indices, []);
});
test("build-fulltext can receive records without prior init", () => {
  const harness = worker({ init: false, build: false });
  assert.deepStrictEqual(harness.send({ type: "build-fulltext", records: clone(records) }), [{ type: "fulltext-ready" }]);
  assert.deepStrictEqual(harness.search({ q: "gamma" }).indices, [3]);
});
test("rebuilding replaces the previous index", () => {
  const harness = worker();
  harness.send({ type: "build-fulltext", records: [{ Repo: "New", File: "omega.txt", Extension: "txt", Folder: [], Size: 1 }] });
  assert.deepStrictEqual(harness.search({ q: "alpha" }).indices, []);
  assert.deepStrictEqual(harness.search({ q: "omega" }).indices, [0]);
});
test("echoes independent request ids including stale ordering", () => {
  const harness = worker();
  assert.strictEqual(harness.search({ q: "alpha" }, 20).total, 3);
  assert.strictEqual(harness.search({ q: "beta" }, 19).total, 2);
});
test("normal multi-token search intersects candidates", () => {
  assert.deepStrictEqual(indices({ q: "alpha beta", exact: false }), [1]);
});
test("multi-token search returns empty when one token is absent", () => {
  assert.deepStrictEqual(indices({ q: "alpha impossible-token", exact: false }), []);
});
test("Latin tokens are case-insensitive", () => {
  assert.deepStrictEqual(indices({ q: "ALPHA", exact: false }), [0, 1, 3]);
});
test("Chinese adjacent pair finds normal filenames", () => {
  assert.deepStrictEqual(indices({ q: "手机", exact: false }), [4, 6]);
});
test("current tokenizer forms Chinese pairs across filename punctuation", () => {
  assert.ok(indices({ q: "手机", exact: false }).includes(6));
});
test("punctuated query takes literal path", () => {
  assert.deepStrictEqual(indices({ q: "手。机", exact: false }), [6]);
});
test("exact search matches a literal filename substring", () => {
  assert.deepStrictEqual(indices({ q: "alpha guide", exact: true }), [0]);
});
test("exact search remains case-insensitive", () => {
  assert.deepStrictEqual(indices({ q: "BETA NOTES", exact: true }), [2]);
});
test("star wildcard spans arbitrary filename text", () => {
  assert.deepStrictEqual(indices({ q: "alpha*.pdf", exact: true }), [1]);
});
test("question wildcard spans one filename character", () => {
  assert.deepStrictEqual(indices({ q: "beta notes.?d", exact: true }), [2]);
});
test("wildcards also search repository metadata", () => {
  assert.deepStrictEqual(indices({ q: "Repo/?", exact: true }), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});
test("fuzzy fallback includes filename and folder candidates", () => {
  assert.deepStrictEqual(indices({ q: "alhpa", exact: false }), [0, 1, 3]);
});
test("files-only fuzzy search excludes folder candidates", () => {
  assert.deepStrictEqual(indices({ q: "alhpa", exact: false, searchFolders: false }), [0, 1]);
});
test("searchFolders controls exact folder-only matches", () => {
  assert.deepStrictEqual(indices({ q: "alpha-folder", exact: true, searchFolders: true }), [3]);
  assert.deepStrictEqual(indices({ q: "alpha-folder", exact: true, searchFolders: false }), []);
});
test("repository filter uses exact repository values", () => {
  assert.deepStrictEqual(indices({ q: "", repos: ["Repo/B"] }), [2, 3]);
  assert.deepStrictEqual(indices({ q: "", repos: ["repo/b"] }), []);
});
test("empty repository and extension arrays do not filter", () => {
  assert.strictEqual(worker().search({ q: "", repos: [], extensions: [] }).total, records.length);
});
test("extension filter normalizes record values but expects normalized filter values", () => {
  assert.deepStrictEqual(indices({ q: "", extensions: ["txt"] }), [0, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(indices({ q: "", extensions: ["TXT"] }), []);
});
test("repository extension and size filters compose", () => {
  assert.deepStrictEqual(indices({ q: "", repos: ["Repo/A"], extensions: ["pdf"], minSize: 400, maxSize: 600 }), [1]);
});
test("positive numeric sizes honor inclusive bounds", () => {
  assert.deepStrictEqual(indices({ q: "", minSize: 100, maxSize: 200 }), [0, 3, 4, 6, 7, 8]);
});
test("zero and non-numeric sizes are exempt from bounds", () => {
  assert.deepStrictEqual(indices({ q: "", minSize: 1, maxSize: 10 }), [4, 6]);
});
test("prefix folder mode includes descendants", () => {
  assert.deepStrictEqual(indices({ q: "", folders: ["docs"], folderMatchMode: "prefix" }), [0, 1, 5, 7]);
});
test("exact folder mode excludes descendants", () => {
  assert.deepStrictEqual(indices({ q: "", folders: ["docs"], folderMatchMode: "exact" }), [5]);
});
test("folder paths normalize leading and trailing slashes", () => {
  assert.deepStrictEqual(indices({ q: "", folders: ["/docs/"], folderMatchMode: "exact" }), [5]);
});
test("root folder prefix and exact modes select root records", () => {
  assert.deepStrictEqual(indices({ q: "", folders: [""], folderMatchMode: "prefix" }), [4, 6]);
  assert.deepStrictEqual(indices({ q: "", folders: [""], folderMatchMode: "exact" }), [4, 6]);
});
test("mixed mode combines exact self and subtree selections", () => {
  assert.deepStrictEqual(indices({ q: "", folderMatchMode: "mixed", folderSelfs: ["archive"], folderSubtrees: ["docs"] }), [0, 1, 2, 5, 7]);
});
test("mixed mode ignores empty folder selections", () => {
  assert.strictEqual(worker().search({ q: "", folderMatchMode: "mixed", folderSelfs: [""], folderSubtrees: [""] }).total, records.length);
});
test("relevance score ranks filename before folder before repository", () => {
  assert.deepStrictEqual(indices({ q: "alpha", exact: false }), [0, 1, 3]);
});
test("relevance ties retain source order", () => {
  assert.deepStrictEqual(indices({ q: "same", exact: false }), [7, 8]);
});
test("name sorting follows current zh locale ordering and is stable", () => {
  const expected = records.map((record, index) => ({ record, index }))
    .sort((a, b) => a.record.File.localeCompare(b.record.File, "zh")).map((item) => item.index);
  assert.deepStrictEqual(indices({ q: "", sort: "name" }), expected);
  assert.ok(indices({ q: "", sort: "name" }).indexOf(7) < indices({ q: "", sort: "name" }).indexOf(8));
});
test("size sorting is descending and stable for ties", () => {
  assert.deepStrictEqual(indices({ q: "", sort: "size" }), [1, 5, 3, 0, 7, 8, 2, 4, 6]);
});
test("pagination reports exact total and middle page", () => {
  assert.deepStrictEqual(worker().search({ q: "", page: 2, pageSize: 3 }), { indices: [3, 4, 5], total: 9, page: 2, pageSize: 3 });
});
test("pagination first partial and beyond-last boundaries", () => {
  assert.deepStrictEqual(worker().search({ q: "", page: 1, pageSize: 4 }).indices, [0, 1, 2, 3]);
  assert.deepStrictEqual(worker().search({ q: "", page: 3, pageSize: 4 }).indices, [8]);
  assert.deepStrictEqual(worker().search({ q: "", page: 4, pageSize: 4 }).indices, []);
});
test("zero page and pageSize use current defaults", () => {
  const result = worker().search({ q: "", page: 0, pageSize: 0 });
  assert.strictEqual(result.page, 1);
  assert.strictEqual(result.pageSize, 100);
  assert.strictEqual(result.indices.length, records.length);
});
test("main thread retains Worker and fallback wiring contracts", () => {
  assert.match(app, /new Worker\("static\/index-worker\.js"\)/);
  assert.match(app, /type: "init-records"/);
  assert.match(app, /type: "build-fulltext"/);
  assert.match(app, /type: "local-search"/);
  assert.match(app, /API_BASE \+ "\/api\/search"/);
  assert.match(app, /getCachedSearchResponse/);
  assert.match(app, /API_FAILURE_THRESHOLD/);
  assert.match(app, /_initialActive/);
});

run("worker/search");
