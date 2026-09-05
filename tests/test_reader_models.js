const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(name, api, options) { const sandbox = { self: {}, DOMException }; sandbox.self = sandbox; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static", name), "utf8"), sandbox); return sandbox[api](options); }
function random(seed) { let value = seed >>> 0; return () => ((value = Math.imul(value, 1664525) + 1013904223 >>> 0) / 0x100000000); }

async function repositoryModel(seed) {
  const rand = random(seed), count = 17, present = new Map(), attempts = Array(count).fill(0);
  const repository = load("reader-chapter-repository.js", "VoiceOfMLReaderChapters", { count, find: (index) => present.get(index), create: async (index) => { attempts[index]++; if ((index + attempts[index] + seed) % 7 === 0) throw new Error("modeled failure"); return { index, attempt: attempts[index] }; }, commit: (index, value) => (present.set(index, value), value) }).createChapterRepository ? null : null;
}

function createRepository(options) { const sandbox = { self: {}, DOMException }; sandbox.self = sandbox; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-chapter-repository.js"), "utf8"), sandbox); return sandbox.VoiceOfMLReaderChapters.createChapterRepository(options); }

async function runRepositoryModel(seed) {
  const rand = random(seed), count = 17, present = new Map(), attempts = Array(count).fill(0);
  const repository = createRepository({ count, find: (index) => present.get(index), create: async (index) => { attempts[index]++; if ((index + attempts[index] + seed) % 7 === 0) throw new Error("modeled failure"); return { index, attempt: attempts[index] }; }, commit: (index, value) => (present.set(index, value), value) });
  for (let step = 0; step < 300; step++) {
    const index = Math.floor(rand() * count), operation = Math.floor(rand() * 3);
    if (operation === 0) { try { await repository.load(index); } catch (_) {} }
    else if (operation === 1) { present.delete(index); repository.release(index); }
    else { const first = repository.load(index), second = repository.load(index); if (repository.state(index).status === "loading") assert.strictEqual(first, second); try { await first; } catch (_) {} try { await second; } catch (_) {} }
    const state = repository.state(index);
    assert.ok(["idle", "loading", "ready", "error"].includes(state.status));
    assert.strictEqual(state.attempts, attempts[index]);
    if (state.status === "ready") assert.strictEqual(state.value.index, index);
  }
  repository.dispose();
  await assert.rejects(repository.load(0), (error) => error.name === "AbortError");
}

function runVirtualizerModel(seed) {
  const rand = random(seed);
  for (let round = 0; round < 120; round++) {
    const count = 10 + Math.floor(rand() * 40), limit = 3 + Math.floor(rand() * 10), center = Math.floor(rand() * count), removed = new Set(), nodes = Array.from({ length: count }, (_, index) => ({ index, height: 100 + index }));
    const sandbox = { self: {} }; sandbox.self = sandbox; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-section-virtualizer.js"), "utf8"), sandbox);
    const virtualizer = sandbox.VoiceOfMLReaderVirtual.createSectionVirtualizer({ limit, getLoaded: () => nodes.filter((node) => !removed.has(node.index)), getIndex: (node) => node.index, getHeight: (node) => node.height, virtualize: (_node, index) => removed.add(index), release: () => {}, preserve: (change) => change() });
    const result = virtualizer.trim(center), retained = nodes.filter((node) => !removed.has(node.index));
    assert.ok(retained.length <= limit); assert.ok(retained.some((node) => node.index === center)); assert.strictEqual(result.retained, retained.length);
  }
}

(async () => { for (const seed of [1, 7, 42, 20260903]) { await runRepositoryModel(seed); runVirtualizerModel(seed); } console.log("reader model contracts passed"); })().catch((error) => { console.error(error); process.exitCode = 1; });
