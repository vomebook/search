const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { self: {}, setTimeout, clearTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
sandbox.self = sandbox;
for (const file of ["reader/core/reader-contract.js", "reader/core/reader-runtime.js", "reader/formats/reader-format-adapters.js"]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../static", file), "utf8"), sandbox);

function testSnapshotOnlyWhenObserved() {
  let snapshots = 0;
  const runtime = sandbox.VoiceOfMLReaderRuntime.createReaderRuntime({initialState: {formats: {
    get pdf() { snapshots++; return {}; }
  }}});
  runtime.events.on('state:panel', () => assert.fail('unrelated event'));
  for (let page = 1; page <= 100; page++) runtime.update('document', {page});
  assert.strictEqual(runtime.state.document.page, 100);
  assert.strictEqual(snapshots, 0, 'no document observer');
  const received = [];
  const off = runtime.events.on('state:document', state => {
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.document));
    received.push(['specific', state.document.page]);
    runtime.events.on('state', next => received.push(['late', next.document.page]));
  });
  const wildcard = runtime.events.on('*', (state, kind) => received.push([kind, state.document.page]));
  runtime.update('document', {page: 101});
  assert.strictEqual(snapshots, 1);
  assert.deepStrictEqual(received, [['specific',101], ['state:document',101], ['late',101], ['state',101]]);
  off(); wildcard();
  runtime.events.dispose();
  runtime.update('document', {page: 102});
  assert.strictEqual(snapshots, 1);
  const emitted = [];
  const injected = sandbox.VoiceOfMLReaderRuntime.createReaderRuntime({events: {
    emit(type, state) { emitted.push([type, state.document.page]); }
  }});
  injected.update('document', {page: 9});
  assert.deepStrictEqual(emitted, [['state:document',9], ['state',9]]);
}

async function main() {
  testSnapshotOnlyWhenObserved();
  const events = [];
  const runtime = sandbox.VoiceOfMLReaderRuntime.createReaderRuntime();
  runtime.events.on("*", (_detail, type) => events.push(type));
  assert.strictEqual(runtime.update("source", { url: "book" }), true);
  assert.strictEqual(runtime.snapshot().source.url, "book");
  let documentEvent;
  runtime.events.on("state:document", (state) => { documentEvent = state; });
  assert.strictEqual(runtime.update("document", { page: 7, restorationReady: true }), true);
  assert.strictEqual(documentEvent.document.page, 7);
  assert.strictEqual(documentEvent.document.restorationReady, true);
  const delayed = runtime.schedule(() => { throw new Error("disposed timer fired"); }, 10000);
  runtime.cancel(delayed);
  assert.strictEqual(runtime.updateFormat("pdf", { activeRenders: 1 }), true);
  assert.strictEqual(runtime.snapshot().formats.pdf.activeRenders, 1);
  const original = sandbox.VoiceOfMLReader.capability("pdf");
  const negotiated = runtime.negotiate(original);
  assert.strictEqual(negotiated.extension, original.extension);
  assert.strictEqual(negotiated.mode, original.mode);
  assert.strictEqual(negotiated.readerMode, original.readerMode);
  assert.strictEqual(negotiated.article, original.article);
  assert.notStrictEqual(negotiated.features, original.features);
  assert.ok(Object.isFrozen(negotiated) && Object.isFrozen(negotiated.features));
  const capability = runtime.negotiate({ mode: "pdf", extension: "pdf" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(capability.features)), { toc: true, search: true, zoom: true, bookmarks: true, pagination: true, media: false });
  const first = runtime.nextGeneration("navigation");
  assert.strictEqual(runtime.currentGeneration("navigation"), first);
  assert.strictEqual(runtime.isCurrent("navigation", first), true);
  runtime.nextGeneration("navigation");
  assert.strictEqual(runtime.isCurrent("navigation", first), false);
  assert.strictEqual(runtime.currentGeneration("search"), 0);
  const pdfGeneration = runtime.nextGeneration("pdf");
  assert.strictEqual(runtime.currentGeneration("pdf"), pdfGeneration);
  assert.strictEqual(runtime.currentGeneration("navigation"), first + 1);
  assert.strictEqual(runtime.setStage("prepare"), true);
  runtime.fail("READER_PARSE");
  assert.strictEqual(runtime.state.lifecycle.phase, "failed");
  assert.ok(events.includes("state:source") && events.includes("capability") && events.includes("generation") && events.includes("error"));

  const calls = [];
  runtime.track(() => calls.push("first"));
  runtime.track({ dispose: () => calls.push("second") });
  runtime.dispose();
  assert.deepStrictEqual(calls, ["second", "first"]);
  assert.strictEqual(runtime.state.lifecycle.phase, "disposed");
  assert.strictEqual(runtime.currentGeneration("navigation"), first + 2);
  assert.strictEqual(runtime.currentGeneration("pdf"), pdfGeneration + 1);
  assert.strictEqual(runtime.update("source", { url: "late" }), false);
  assert.strictEqual(runtime.setPhase("ready"), false);

  const registry = sandbox.VoiceOfMLReaderAdapters.createAdapterRegistry();
  assert.throws(() => registry.register("bad", {}), /READER_ADAPTER_METHOD:bad:open/);
  let finishOpen;
  const trace = [];
  const adapter = registry.register("pdf", {
    open: () => new Promise((resolve) => { finishOpen = () => { trace.push("open"); resolve("prepared"); }; }),
    render: (value) => trace.push(`render:${value}`), navigate: (value) => trace.push(`navigate:${value}`),
    search: (value) => trace.push(`search:${value}`), progress: () => 42,
    restore: (value) => trace.push(`restore:${value}`), dispose: () => trace.push("dispose"),
  });
  assert.strictEqual(registry.activate("pdf"), adapter);
  const opening = adapter.open();
  adapter.navigate(3); adapter.search("term"); adapter.restore("position");
  finishOpen();
  await adapter.render(await opening);
  assert.strictEqual(adapter.progress(), 42);
  registry.dispose();
  assert.deepStrictEqual(trace, ["navigate:3", "search:term", "restore:position", "open", "render:prepared", "dispose"]);
  assert.throws(() => registry.register("pdf", adapter), /READER_ADAPTER_DUPLICATE/);
  console.log("reader runtime contracts passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
