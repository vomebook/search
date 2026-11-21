const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');

function harness(original = false, globals = {}) {
  const root = path.join(__dirname, '../..');
  let source = original ? cp.execFileSync('git', ['-c', 'safe.directory=*', '-C', root, 'show', 'HEAD:static/tts-client.js'], { encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'static/tts-client.js'), 'utf8');
  // Expose the real closures, without a second response implementation.
  source = source.replace('  controls();\n  // readFrom:', '  globalThis.__ttsTest = { accept, request };\n  controls();\n  // readFrom:');
  const elements = new Map();
  const element = (value = 'off') => ({ value, hidden: false, textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector() { return null; }, append() {}, remove() {}, contains() { return false; } });
  const document = { body: element(), querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element({ '#speech-pitch': '0', '#speech-speed': '1' }[selector])); return elements.get(selector); }, addEventListener() {} };
  const context = vm.createContext({ document, window: { addEventListener() {} }, navigator: {}, Intl, AbortController, setTimeout, clearTimeout, MutationObserver: class { observe() {} }, performance, console, ...globals });
  vm.runInContext(source, context);
  return context;
}
function fixtures() {
  const id = 'a'.repeat(32);
  const part = { index: 0, start: 0, end: 2, audio_url: `/tts/audio/${id}/parts/0.mp3`, bytes: 12, pause_kind: 'comma', pause_after_seconds: 0.2 };
  const data = { id, state: 'ready', progress: { total_parts: 1, parts: [part] }, result: { pitch_semitones: 0 } };
  const job = { id: '', batch: { first: true, text: '你好', segment_ends: [2] }, parts: [] };
  return { data, job, value: { pitch: 0, snapshot: { id: 'document' } } };
}

test('unknown JSON validates fields and rejects malformed data without playing partial text', () => {
  const { __ttsTest: api } = harness();
  for (const mutate of [d => { d.progress.parts = {}; }, d => { d.progress.parts[0].end = '2'; }, d => { d.progress.total_parts = '1'; }, d => { d.result.pitch_semitones = {}; }, d => { d.id = {}; }]) {
    const { data, job, value } = fixtures(); mutate(data);
    assert.throws(() => api.accept(job, data, value));
    assert.equal(job.parts.length, 0);
  }
  const { data, job, value } = fixtures();
  data.first_audio = { bad: true }; // Optional inline transport falls back to the canonical GET.
  assert.doesNotThrow(() => api.accept(job, data, value));
  assert.equal(job.parts.length, 1);
});

test('response acceptance and terminal ordering match HEAD for malformed optional metadata', () => {
  const original = harness(true).__ttsTest, current = harness().__ttsTest;
  const cases = [
    d => { d.state = 'error'; d.error = { message: 'server failure' }; d.progress = { parts: 'bad' }; },
    d => { d.state = 'expired'; d.progress = { parts: 'bad' }; d.result = { pitch_semitones: {} }; },
    d => { d.state = 'running'; d.progress = { total_parts: 1 }; },
    d => { delete d.progress.parts[0].bytes; delete d.progress.parts[0].pause_kind; delete d.progress.parts[0].pause_after_seconds; },
    d => { d.progress.parts[0].bytes = 'broken'; d.progress.parts[0].pause_kind = 42; d.progress.parts[0].pause_after_seconds = '0.2'; },
    d => { d.first_audio = { malformed: true }; },
    d => { d.progress.parts[0].end = 1; },
    d => { d.id = 'bad'; d.state = 'error'; },
    d => { d.id = ['a'.repeat(32)]; },
    d => { d.id = 12345678901234567890123456789012; d.progress.parts[0].audio_url = `/tts/audio/${d.id}/parts/0.mp3`; },
    d => { d.state = { malformed: true }; },
    d => { delete d.state; },
    d => { d.state = ['ready']; }
  ];
  function run(api, mutate) {
    const { data, job, value } = fixtures(); mutate(data);
    try { api.accept(job, data, value); return { ok: true, job: JSON.stringify(job) }; }
    catch (error) { return { ok: false, message: error.message, status: error.status, job: JSON.stringify(job) }; }
  }
  for (const mutate of cases) assert.deepEqual(run(current, mutate), run(original, mutate));
});

test('HTTP error preserves server message, status, code and Retry-After', async () => {
  const context = harness();
  context.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '7' }, json: async () => ({ error: { message: '稍后重试', code: 'client_busy' } }) });
  await assert.rejects(context.__ttsTest.request('/test', {}, { controllers: new Set() }), e => e.message === '稍后重试' && e.status === 429 && e.code === 'client_busy' && e.retryAfter === 7);
  context.fetch = async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => { throw new SyntaxError('html'); } });
  await assert.rejects(context.__ttsTest.request('/test', {}, { controllers: new Set() }), e => e.message === '语音请求失败（502）' && e.status === 502);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const audioResponse = (size = 12) => ({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => new Blob([new Uint8Array(size)]) });

async function playingClips(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const players = [], requests = [];
  const { data } = fixtures();
  const url = index => `/tts/audio/${data.id}/parts/${index}.mp3`;
  data.progress.parts = Array.from({ length: 4 }, (_, index) => ({ ...data.progress.parts[0], index, start: index * 2, end: (index + 1) * 2, audio_url: url(index) }));
  data.progress.total_parts = data.progress.parts.length;
  const context = harness(false, {
    Date, performance: { now: () => Date.now() }, crypto,
    URL: { createObjectURL: () => 'blob:cached', revokeObjectURL() {} },
    Audio: class extends EventTarget {
      constructor() { super(); players.push(this); }
      paused = true;
      getAttribute(name) { assert.equal(name, 'src'); return this.src || null; }
      removeAttribute(name) { assert.equal(name, 'src'); delete this.src; }
      load() { this.paused = true; }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
    },
    fetch: (address, { method, signal }) => {
      if (method === 'POST') return Promise.resolve({ ok: true, json: async () => data });
      if (method === 'DELETE') return Promise.resolve({ ok: true });
      const part = data.progress.parts.find(part => address.endsWith(part.audio_url));
      assert.ok(part, `unexpected fetch: ${address}`);
      const pending = Promise.withResolvers();
      requests.push({ index: part.index, ...pending });
      signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
      return pending.promise;
    }
  });
  const speech = context.window.CCRDSpeech;
  t.after(() => speech.stop());
  speech.previewLoaded({ id: 'document', adapter: { text: '甲。乙。丙。丁。', done: true }, tools: { querySelector: () => true } });
  speech.readFrom(0, { exact: true });
  await turn();
  const [player] = players;
  assert.ok(player.src?.endsWith(url(0)));
  player.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(player.paused, false);
  const indices = () => requests.map(request => request.index);
  assert.deepEqual(indices(), [1, 2]); // Two held prefetches while clip 0 plays.
  return { speech, player, requests, indices, url };
}

for (const [name, fail] of [
  ['rejection', request => request.reject(new TypeError('offline'))],
  ['HTTP error', request => request.resolve({ ok: false, status: 503 })],
  ['non-audio response', request => request.resolve({ ok: true, headers: { get: () => 'text/html' } })],
  ['body read failure', request => request.resolve({ ...audioResponse(), blob: async () => { throw new TypeError('offline'); } })],
  ['wrong byte count', request => request.resolve(audioResponse(11))]
]) {
  test(`prefetch ${name} frees the slot without retrying or blocking foreground audio`, async t => {
    const { speech, player, requests, indices, url } = await playingClips(t);
    fail(requests[0]);
    await turn();
    assert.deepEqual(indices(), [1, 2, 3]); // The healthy lookahead can use the freed slot.
    assert.equal(player.paused, false);
    requests[1].resolve(audioResponse());
    await turn();
    assert.deepEqual(indices(), [1, 2, 3]); // Sibling completion must also respect cooldown.

    player.dispatchEvent(new Event('ended'));
    assert.ok(player.src.endsWith(url(1)), 'the missed clip uses its foreground URL during cooldown');
    player.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(player.paused, false);
    assert.equal(speech.state().position, 2);
    assert.equal(speech.state().playing, true);
    player.dispatchEvent(new Event('ended'));
    assert.equal(player.src, 'blob:cached'); // Valid prefetched audio is still used.
    assert.equal(speech.state().position, 4);
  });
}

test('prefetch retries on the playback pump after the cooldown', async t => {
  const { player, requests, indices } = await playingClips(t);
  requests[0].reject(new TypeError('offline'));
  requests[1].resolve(audioResponse());
  await turn();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(600);
    await turn();
    assert.deepEqual(indices(), [1, 2, 3]);
  }
  t.mock.timers.tick(600);
  await turn();
  assert.deepEqual(indices(), [1, 2, 3, 1]);
  requests[3].resolve(audioResponse());
  await turn();
  player.dispatchEvent(new Event('ended'));
  assert.equal(player.src, 'blob:cached');
});

test('pausing aborts held prefetches without starting a cooldown', async t => {
  const { speech, indices } = await playingClips(t);
  speech.pause();
  await turn();
  assert.deepEqual(indices(), [1, 2]);
  speech.readFrom(0, { exact: true });
  await turn();
  assert.deepEqual(indices(), [1, 2, 1, 2]);
});
