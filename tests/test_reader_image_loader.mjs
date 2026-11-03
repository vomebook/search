import assert from "node:assert/strict";
import { createReaderImageLoader } from "../static/reader/formats/reader-image-loader.mjs";

const oldLocation = globalThis.location;
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
globalThis.location = new URL("https://reader.test/static/reader.html");
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });

function fixture() {
  const callbacks = new Set(), requests = [];
  const image = { src: "", naturalWidth: 0, complete: false, fetchPriority: "high", onload: null, onerror: null,
    removeAttribute(name) { if (name === "src") this.src = ""; } };
  const signal = new AbortController();
  let mode = "ok", readCount = 0;
  const loader = createReaderImageLoader({
    assertActive() { signal.signal.throwIfAborted(); },
    abortError: () => new DOMException("closed", "AbortError"),
    trackResource(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    async request(url, timeout, options) {
      requests.push({url, timeout, options});
      if (mode === "http-error") return new Response("unavailable", {status: 503});
      return new Response(new Uint8Array([1, 2, 3]), {headers: {"Content-Type": "image/png"}});
    },
    async readBytes(response) { readCount++; return new Uint8Array(await response.arrayBuffer()); },
    timeoutMs: 30
  });
  return { image, signal, loader, requests, callbacks, setMode(value) { mode = value; }, get readCount() { return readCount; } };
}

try {
  {
    const f = fixture(); f.image.complete = true; f.image.naturalWidth = 1;
    assert.equal(await f.loader.load(f.image, "/image.png", f.signal.signal), f.image);
    assert.equal(f.image.src, "/image.png");
    assert.equal(f.callbacks.size, 0);
    assert.equal(f.requests.length, 0);
  }
  {
    const f = fixture();
    const pending = f.loader.load(f.image, "blob:local-image", f.signal.signal);
    assert.equal(f.callbacks.size, 1);
    f.image.onerror();
    await assert.rejects(pending, /image load failed/);
    assert.equal(f.callbacks.size, 0);
    assert.equal(f.image.src, "");
    assert.equal(f.requests.length, 0);
  }
  {
    const f = fixture();
    const pending = f.loader.load(f.image, "blob:local-image", f.signal.signal);
    f.signal.abort(new DOMException("closed", "AbortError"));
    await assert.rejects(pending, {name: "AbortError"});
    assert.equal(f.callbacks.size, 0);
    assert.equal(f.requests.length, 0);
  }
  {
    const f = fixture(); f.setMode("http-error");
    await assert.rejects(f.loader.load(f.image, "https://assets.test/image.png", f.signal.signal,
      performance.now() + 1), {status: 503});
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.priority, "high");
    assert.equal(f.readCount, 0);
  }
  {
    // The existing fallback passes an own `signal` property even when no
    // signal was supplied; an options-shape refactor must not silently omit it.
    const f = fixture(); f.setMode("http-error");
    await assert.rejects(f.loader.load(f.image, "https://assets.test/image.png", undefined,
      performance.now() + 1), {status: 503});
    assert.equal(f.requests.length, 1);
    assert.equal(Object.hasOwn(f.requests[0].options, "signal"), true);
    assert.equal(f.requests[0].options.signal, undefined);
    assert.equal(f.requests[0].options.priority, "high");
    assert.equal(f.callbacks.size, 0);
  }
  {
    const f = fixture();
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    let revoked = "", fallbackStarted;
    const fallback = new Promise(resolve => { fallbackStarted = resolve; });
    URL.createObjectURL = () => "blob:reader-test";
    URL.revokeObjectURL = value => { revoked = value; };
    let source = f.image.src;
    Object.defineProperty(f.image, "src", {get: () => source, set(value) {
      source = value;
      if (value === "blob:reader-test") fallbackStarted();
    }});
    try {
      const pending = f.loader.load(f.image, "https://assets.test/image.png", f.signal.signal,
        performance.now() + 250);
      await fallback;
      f.image.complete = true; f.image.naturalWidth = 1; f.image.onload();
      assert.equal(await pending, f.image);
      assert.equal(f.readCount, 1);
      assert.equal(revoked, "blob:reader-test");
      assert.equal(f.callbacks.size, 0);
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  }
  console.log("Reader image loader: direct load, cleanup, cancellation, HTTP errors and bounded fallback passed");
} finally {
  if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else delete globalThis.navigator;
}
