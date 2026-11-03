"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function checkRegistry() {
  const filename = path.resolve(__dirname, "../static/reader/formats/reader-format-adapters.js");
  const sandbox = {};
  sandbox.self = sandbox;
  const source = fs.readFileSync(filename, "utf8");
  vm.runInNewContext(source, sandbox, { filename });
  const fallback = {};
  vm.runInNewContext(source, fallback, { filename });
  assert.equal(typeof fallback.VoiceOfMLReaderAdapters.createAdapterRegistry, "function");
  const api = sandbox.VoiceOfMLReaderAdapters;
  assert.deepEqual(Array.from(api.METHODS), ["open", "render", "restore", "dispose"]);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(api.METHODS), true);

  const registry = api.createAdapterRegistry();
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(registry.active, null);
  assert.equal(registry.get("missing"), null);
  assert.equal(registry.dispose(), undefined);

  const calls = [];
  const methods = {
    open() { calls.push("open"); return "prepared"; },
    render(value) { calls.push(["render", value]); },
    restore(entry, generation) { calls.push(["restore", entry, generation]); },
    dispose() { calls.push("dispose"); return "released"; },
  };
  assert.throws(() => registry.register("", methods), /READER_ADAPTER_DUPLICATE/);
  for (const method of api.METHODS) {
    const incomplete = { ...methods };
    delete incomplete[method];
    assert.throws(() => registry.register("incomplete", incomplete),
      new RegExp(`READER_ADAPTER_METHOD:incomplete:${method}`));
  }
  const text = registry.register("text", methods);
  const html = registry.register("html", methods);
  assert.equal(Object.isFrozen(text), true);
  assert.equal(registry.get("text"), text);
  assert.deepEqual(Array.from(registry.modes), ["text", "html"]);
  assert.throws(() => registry.register("text", methods), /READER_ADAPTER_DUPLICATE:text/);
  assert.throws(() => registry.activate("missing"), /READER_ADAPTER_MISSING:missing/);
  assert.equal(registry.activate("text"), text);
  assert.equal(registry.active, text);
  const prepared = text.open();
  text.render(prepared);
  text.restore("saved", 4);
  assert.equal(registry.activate("html"), html);
  assert.equal(registry.dispose(), "released");
  assert.equal(registry.active, null);
  assert.equal(registry.dispose(), undefined);
  assert.deepEqual(calls, ["open", ["render", "prepared"], ["restore", "saved", 4], "dispose"]);
}
function runContracts() {
  checkRegistry();
  console.log("reader adapter registry contracts passed");
}
if (process.env.READER_V8_COVERAGE) require("node:test")("reader adapter registry", runContracts);
else runContracts();
