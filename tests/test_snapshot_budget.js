const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { TextEncoder } = require("util");
const { test, run } = require("./test_harness");

function fixture(source) {
  const encoded = [];
  const c = {
    TextEncoder: class extends TextEncoder {
      encode(value) { encoded.push(value); return super.encode(value); }
    },
    STATE: { results: [], total: 0, _pageCache: {}, _loadedPage: 1 },
    DOM: { resultsContainer: {} }, VSCROLL: { heightCache: new Map(), estimatedHeight: 100 },
    searchSnapshotResultBudgets: new WeakMap(), searchSnapshotHeightValues: new WeakMap(),
    searchSnapshotSources: new WeakMap(), searchViewSnapshots: new Map(), searchPageMetadata: new WeakMap(),
    SEARCH_VIEW_SNAPSHOT_BYTES_MAX: 8 * 1024 * 1024, SEARCH_VIEW_SNAPSHOT_MAX: 8,
    SEARCH_VIEW_SNAPSHOT_VERSION: 1, measuredHeightRevision: 0, positionRestore: null,
    getReturnPositionTarget: () => null, getHeightMeasurementKey: () => "layout",
    saveSearchPosition: () => ({ index: 0, offset: 0 }), checkSearchPageAppend: () => true,
    getResultStableId: () => { throw Error("snapshot scanned result IDs"); },
  };
  vm.createContext(c);
  for (const name of ["cloneSearchResult", "cloneSearchPageCache", "trimSearchViewSnapshots",
    "getSearchSnapshotResultsBytes", "extendSearchSnapshotBudget", "captureSearchSnapshotHeights",
    "saveSearchViewSnapshot", "appendSearchResults"]) {
    const match = source.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
    assert(match, name);
    vm.runInContext(match[0], c);
  }
  function view(results) {
    c.STATE.results = results; c.STATE.total = results.length;
    c.displayedSearchView = {key:"query",results,total:results.length,loadedPage:1,
      revision:1,pageCache:{},resultBackend:"api"};
    return c.displayedSearchView;
  }
  return {c,encoded,view};
}

for (const project of ["github-Search", "huggingface-Search"]) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../", project, "static/app.js"), "utf8");
  test(project + " snapshot bytes equal UTF-8 JSON across page boundaries and sparse holes", () => {
    const {c} = fixture(source);
    for (const length of [0,1,99,100,101,201]) {
      const records = Array.from({length}, (_, i) => ({File:"\u6587\u5316-"+i,Folder:["\ud83d\udcd6"]}));
      assert.strictEqual(c.getSearchSnapshotResultsBytes(records), new TextEncoder().encode(JSON.stringify(records)).length);
      delete records[1]; delete records[100];
      c.searchSnapshotResultBudgets.delete(records);
      assert.strictEqual(c.getSearchSnapshotResultsBytes(records, true), new TextEncoder().encode(JSON.stringify(records)).length);
    }
  });
  test(project + " oversized snapshots skip cloning and remember rejection across height changes and appends", () => {
    const {c,encoded,view} = fixture(source);
    view([{File:"x".repeat(c.SEARCH_VIEW_SNAPSHOT_BYTES_MAX)}]);
    c.cloneSearchResult = () => { throw Error("oversized results cloned"); };
    assert.strictEqual(c.saveSearchViewSnapshot(), null);
    const calls = encoded.length;
    c.measuredHeightRevision++;
    assert.strictEqual(c.saveSearchViewSnapshot(), null);
    assert.strictEqual(encoded.length, calls);
    c.appendSearchResults(2,[{File:"new"}]);
    c.displayedSearchView.revision++;
    assert.strictEqual(c.saveSearchViewSnapshot(), null);
    assert.strictEqual(encoded.length, calls);
    assert.strictEqual(c.searchViewSnapshots.size, 0);
  });
  test(project + " appended page alone updates byte accounting and snapshots remain independent", () => {
    const {c,encoded,view} = fixture(source);
    const current = view(Array.from({length:100},(_,i)=>({File:"book-"+i,Folder:["docs"]})));
    const first = c.saveSearchViewSnapshot();
    encoded.length=0;
    c.appendSearchResults(2,[{File:"next",Folder:["new"]}]);
    assert.strictEqual(encoded.length,1);
    assert.strictEqual(JSON.parse(encoded[0]).length,1);
    current.revision++; current.loadedPage=2; current.total=101;
    const second = c.saveSearchViewSnapshot();
    assert.strictEqual(c.getSearchSnapshotResultsBytes(current.results), new TextEncoder().encode(JSON.stringify(current.results)).length);
    assert.strictEqual(first.results.length,100);
    assert.strictEqual(second.results.length,101);
    assert.notStrictEqual(first.results[0],second.results[0]);
    current.results[0].Folder.push("changed");
    assert.deepStrictEqual(Array.from(first.results[0].Folder),["docs"]);
    assert.deepStrictEqual(Array.from(second.results[0].Folder),["docs"]);
  });
  test(project + " height-only snapshots reuse results and unchanged measured entries without result scans", () => {
    const {c,encoded,view} = fixture(source);
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
    const {c,view} = fixture(source);
    const records = new Array(1000); records[950]={File:"old"};
    const current=view(records); current.window={pages:new Set([10]),count:1,generation:"g"};
    const first=c.saveSearchViewSnapshot();
    records[50]={File:"\u6587\u5316",Folder:["new"]};
    c.searchSnapshotResultBudgets.delete(records); current.revision++;
    const second=c.saveSearchViewSnapshot();
    assert.strictEqual(c.getSearchSnapshotResultsBytes(records,true),new TextEncoder().encode(JSON.stringify(records)).length);
    assert.strictEqual(50 in first.results,false);
    assert.strictEqual(second.results[50].File,"\u6587\u5316");
    assert.strictEqual(49 in second.results,false);
  });
}

run("search/snapshot-budget");
