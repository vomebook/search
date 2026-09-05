const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { self: {}, setTimeout, clearTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
sandbox.self = sandbox;
for (const file of ["reader-runtime.js", "reader-format-adapters.js"]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static", file), "utf8"), sandbox);

async function main() {
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
