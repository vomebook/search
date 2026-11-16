const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');

function harness(original = false) {
  const root = path.join(__dirname, '../..');
  let source = original ? cp.execFileSync('git', ['-c', 'safe.directory=*', '-C', root, 'show', 'HEAD:static/tts-client.js'], { encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'static/tts-client.js'), 'utf8');
  // Expose the real closures, without a second response implementation.
  source = source.replace('  controls();\n  // readFrom:', '  globalThis.__ttsTest = { accept, request };\n  controls();\n  // readFrom:');
  const elements = new Map();
  const element = () => ({ value: 'off', hidden: false, textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector() { return null; } });
  const document = { body: element(), querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); }, addEventListener() {} };
  const context = vm.createContext({ document, window: { addEventListener() {} }, navigator: {}, Intl, AbortController, setTimeout, clearTimeout, MutationObserver: class { observe() {} }, performance, console });
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
