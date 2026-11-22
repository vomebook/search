const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { TextEncoder } = require("util");
const { test, run } = require("../support/test_harness");
const { searchTestProjects } = require("../support/search_test_projects");
const { installClassicSearchModules } = require("../support/classic_search_modules");

function fixture(source, root) {
  const encoded = [];
  const c = {
    TextEncoder: class extends TextEncoder {
      encode(value) { encoded.push(value); return super.encode(value); }
    },
    STATE: { results: [], total: 0, _pageCache: {}, _loadedPage: 1 },
    DOM: { resultsContainer: {} }, VSCROLL: { heightCache: new Map(), estimatedHeight: 100 },
    searchPageMetadata: new WeakMap(),
    measuredHeightRevision: 0, positionRestoration: {current: null},
    getReturnPositionTarget: () => null, getHeightMeasurementKey: () => "layout",
    saveSearchPosition: () => ({ index: 0, offset: 0 }), checkSearchPageAppend: () => true,
    getResultStableId: () => { throw Error("snapshot scanned result IDs"); },
  };
  vm.createContext(c);
  installClassicSearchModules(root, c);
  c.resultSnapshots = c.VoiceOfMLResultSnapshots.create({cloneResult: record => c.cloneSearchResult(record),
    materialized() {}, applyHeights() {}, isCurrent: () => true, completed() {}});
  // The two sites expose different host helpers; install the real ones when present.
  for (const name of ["getSearchPageMetadata", "searchPageIterable"]) {
    const helper = source.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
    if (helper) vm.runInContext(helper[0], c);
  }
  for (const name of ["cloneSearchResult",
    "extendSearchSnapshotBudget",
    "saveSearchViewSnapshot", "appendSearchResults"]) {
    const match = source.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
    assert(match, name);
    vm.runInContext(match[0], c);
  }
  function view(results) {
    c.STATE.results = results; c.STATE.total = results.length;
    c.resultSnapshots.publish({key:"query",results,total:results.length,loadedPage:1,pageCache:{},resultBackend:"api"}, 0);
    return c.resultSnapshots.displayed;
  }
  return {c,encoded,view};
}

for (const { name: project, root } of searchTestProjects()) {
  const source = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
  test(project + " snapshot bytes equal UTF-8 JSON across page boundaries and sparse holes", () => {
    const {c} = fixture(source, root);
    for (const length of [0,1,99,100,101,201]) {
      const records = Array.from({length}, (_, i) => ({File:"\u6587\u5316-"+i,Folder:["\ud83d\udcd6"]}));
      assert.strictEqual(c.resultSnapshots.budget.measure(records), new TextEncoder().encode(JSON.stringify(records)).length);
      delete records[1]; delete records[100];
      c.resultSnapshots.budget.invalidate(records);
      assert.strictEqual(c.resultSnapshots.budget.measure(records, true), new TextEncoder().encode(JSON.stringify(records)).length);
    }
  });
  test(project + " restore accounting includes the exact envelope and reserve at the eviction boundary", () => {
    const {c,encoded} = fixture(source, root);
    const [snapshot, older] = vm.runInContext(`(() => {
      const results = new Array(10000);
      results[1] = null;
      results[2] = undefined;
      results[5000] = {File: '书📚\\n"', Folder: ['路径'], size: Infinity};
      Object.defineProperty(results, '9999', {value: {File: '\\ud800'}});
      for (let i = 100; i < 297; i++) results[i] = {File: '批次 ' + i};
      results['01'] = {File: 'not an index'};
      results['4294967295'] = 'not an index';
      Object.defineProperty(results, 'extra', {get() { throw Error('ignored by array JSON'); }});
      return [{key: '查询', results, window: {pages: [1, 50], count: 201},
        pageCache: {1: [{File: '页'}]}, scroll: {index: 9999, offset: 8}, heightCache: [['行', {height: 40}]]},
        {key: 'older', results: []}];
    })()`, c);
    const store = c.resultSnapshots, cap = c.VoiceOfMLSnapshotPolicy.BYTES_MAX;
    const expected = value => new TextEncoder().encode(JSON.stringify(value)).length + 256;
    for (const delta of [-1, 0, 1]) {
      delete snapshot.bytes;
      snapshot.padding = '';
      snapshot.padding = 'x'.repeat(cap - expected(snapshot) + delta);
      store.put(older.key, older);
      store.putRestored(snapshot.key, snapshot);
      encoded.length = 0;
      store.trim();
      assert.strictEqual(snapshot.bytes, cap + delta);
      assert.strictEqual(store.snapshots.has(snapshot.key), delta <= 0);
      assert.strictEqual(store.snapshots.has(older.key), delta > 0);
      assert.strictEqual(store.budget.has(snapshot.results), false);
      assert(encoded.some(value => value.startsWith('{"key":"查询","results":[],')));
      assert(!encoded.some(value => value.includes('null,null,null,null')));
      store.remove(snapshot.key);
    }
  });
  test(project + " restore accounting ignores stale result budgets and preserves native JSON fallback", () => {
    const {c,encoded} = fixture(source, root);
    const store = c.resultSnapshots;
    const snapshot = vm.runInContext(`Object.hasOwn = undefined; ({key: 'restore', results: [, {File: 'old'}, ,]})`, c);
    const expected = value => new TextEncoder().encode(JSON.stringify(value)).length + 256;
    const prior = store.budget.measure(snapshot.results, true);
    snapshot.results[1] = {File: 'changed 📚'};
    store.putRestored(snapshot.key, snapshot);
    const bytes = expected(snapshot);
    store.trim();
    assert.strictEqual(snapshot.bytes, bytes);
    assert.strictEqual(store.budget.measure(snapshot.results, true), prior);
    store.budget.invalidate(snapshot.results);
    assert.strictEqual(store.budget.measure(snapshot.results, true), expected(snapshot.results) - 256);
    for (const target of ['getter', 'record toJSON', 'array toJSON', 'array prototype', 'envelope toJSON', 'ordinary put']) {
      const value = vm.runInContext(`(() => {
        const snapshot = {key: 'restore', results: [, {File: 'plain'}, ,]};
        switch (${JSON.stringify(target)}) {
          case 'getter': Object.defineProperty(snapshot.results[1], 'File', {enumerable: true, get() {return 'getter 📚';}}); break;
          case 'record toJSON': Object.defineProperty(snapshot.results[1], 'toJSON', {value: key => key.repeat(3)}); break;
          case 'array toJSON': snapshot.results.toJSON = key => [key]; break;
          case 'array prototype': Object.setPrototypeOf(snapshot.results, {0: 'inherited'}); break;
          case 'envelope toJSON': snapshot.toJSON = () => ({custom: true}); break;
        }
        return snapshot;
      })()`, c);
      const json = JSON.stringify(value);
      store[target === 'ordinary put' ? 'put' : 'putRestored'](value.key, value);
      encoded.length = 0;
      store.trim();
      assert.strictEqual(value.bytes, new TextEncoder().encode(json).length + 256, target);
      assert.deepStrictEqual(encoded, [json], target);
    }
  });
  test(project + " oversized snapshots skip cloning and remember rejection across height changes and appends", () => {
    const {c,encoded,view} = fixture(source, root);
    view([{File:"x".repeat(c.VoiceOfMLSnapshotPolicy.BYTES_MAX)}]);
    c.cloneSearchResult = () => { throw Error("oversized results cloned"); };
    assert.strictEqual(c.saveSearchViewSnapshot(), null);
    const calls = encoded.length;
    c.measuredHeightRevision++;
    assert.strictEqual(c.saveSearchViewSnapshot(), null);
    assert.strictEqual(encoded.length, calls);
    c.appendSearchResults(2,[{File:"new"}]);
    c.resultSnapshots.publish({...c.resultSnapshots.displayed, loadedPage:2}, 0);
    assert.strictEqual(c.saveSearchViewSnapshot(), null);
    assert.strictEqual(encoded.length, calls);
    assert.strictEqual(c.resultSnapshots.snapshots.size, 0);
  });
  test(project + " appended page alone updates byte accounting and snapshots remain independent", () => {
    const {c,encoded,view} = fixture(source, root);
    const current = view(Array.from({length:100},(_,i)=>({File:"book-"+i,Folder:["docs"]})));
    const first = c.saveSearchViewSnapshot();
    encoded.length=0;
    c.appendSearchResults(2,[{File:"next",Folder:["new"]}]);
    assert.strictEqual(encoded.length,1);
    assert.strictEqual(JSON.parse(encoded[0]).length,1);
    c.resultSnapshots.publish({...current,loadedPage:2,total:101},0);
    const second = c.saveSearchViewSnapshot();
    assert.strictEqual(c.resultSnapshots.budget.measure(current.results), new TextEncoder().encode(JSON.stringify(current.results)).length);
    assert.strictEqual(first.results.length,100);
    assert.strictEqual(second.results.length,101);
    assert.notStrictEqual(first.results[0],second.results[0]);
    current.results[0].Folder.push("changed");
    assert.deepStrictEqual(Array.from(first.results[0].Folder),["docs"]);
    assert.deepStrictEqual(Array.from(second.results[0].Folder),["docs"]);
  });
  test(project + " height-only snapshots reuse results and unchanged measured entries without result scans", () => {
    const {c,encoded,view} = fixture(source, root);
    view(Array.from({length:10000},(_,i)=>({File:"book-"+i})));
    c.VSCROLL.heightCache.set("a",{height:100,measurementKey:"layout"});
    c.VSCROLL.heightCache.set("b",{height:110,measurementKey:"layout"});
    const first=c.saveSearchViewSnapshot();
    encoded.length=0; c.measuredHeightRevision++;
    c.VSCROLL.heightCache.set("b",{height:120,measurementKey:"layout"});
    const second=c.saveSearchViewSnapshot();
    assert.strictEqual(second.results,first.results);
    assert.strictEqual(second.heightCache[0],first.heightCache[0]);
    assert.notStrictEqual(second.heightCache[1],first.heightCache[1]);
    assert.strictEqual(first.heightCache[1][1].height,110);
    assert.strictEqual(second.heightCache[1][1].height,120);
    assert.strictEqual(encoded.length,2); // One changed height and the small snapshot envelope.
    assert(second.bytes >= new TextEncoder().encode(JSON.stringify(second)).length);
  });
  test(project + " a filled sparse page invalidates old accounting without losing placeholders", () => {
    const {c,view} = fixture(source, root);
    const records = new Array(1000); records[950]={File:"old"};
    const current=view(records);
    const window={total:records.length,pages:new Set([10]),count:1,generation:"g"};
    c.resultSnapshots.publish({...current,window},0);
    const first=c.saveSearchViewSnapshot();
    records[50]={File:"\u6587\u5316",Folder:["new"]};
    c.resultSnapshots.budget.invalidate(records); c.resultSnapshots.clearDisplayed();
    c.resultSnapshots.publish({...current,window},0);
    const second=c.saveSearchViewSnapshot();
    assert.strictEqual(c.resultSnapshots.budget.measure(records,true),new TextEncoder().encode(JSON.stringify(records)).length);
    assert.strictEqual(50 in first.results,false);
    assert.strictEqual(second.results[50].File,"\u6587\u5316");
    assert.strictEqual(49 in second.results,false);
  });
}

run("search/snapshot-budget");
