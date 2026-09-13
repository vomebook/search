const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync("static/reader-store.js", "utf8");
const channels = new Set();
class BroadcastChannel {
  constructor(name) { this.name = name; this.closed = false; channels.add(this); }
  postMessage(data) { for (const channel of channels) if (channel !== this && !channel.closed && channel.name === this.name) channel.onmessage?.({ data }); }
  close() { this.closed = true; channels.delete(this); }
}
function loadStore() { const sandbox = { self: {}, BroadcastChannel }; sandbox.self = sandbox; vm.runInNewContext(source, sandbox); return sandbox.VoiceOfMLReaderStore; }
const first = loadStore(), second = loadStore(), received = [];
second.subscribe((change) => received.push(change));
const sender = new BroadcastChannel("voiceofml-reader-store-v1");
sender.postMessage({ type: "bookmark", url: "book", id: "one" });
assert.deepStrictEqual(JSON.parse(JSON.stringify(received)), [{ type: "bookmark", url: "book", id: "one", remote: true }]);
second.dispose();
sender.postMessage({ type: "history", url: "book" });
assert.strictEqual(received.length, 1);
first.dispose(); sender.close();
console.log("reader store channel contracts passed");
