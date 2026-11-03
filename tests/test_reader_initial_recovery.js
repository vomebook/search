const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(process.env.READER_ROOT || path.join(__dirname, '..'),
  'static/reader/core/reader-request-manager.js');
const source = fs.readFileSync(filename, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(fetchImpl) {
  const timers = new Map();
  let id = 0;
  const root = {DOMException, Response, ReadableStream, AbortController,
    fetch: fetchImpl, setTimeout(callback, delay) {
      timers.set(++id, {callback, delay}); return id;
    }, clearTimeout(key) {timers.delete(key);}};
  root.self = root;
  vm.runInNewContext(source, root, {filename});
  return {manager: root.VoiceOfMLReaderRequests.createReaderRequestManager(), timers,
    stall() {
      const timer = [...timers.entries()].find(([, row]) => row.delay === 10000);
      assert.ok(timer, 'startup timer must exist');
      timers.delete(timer[0]); timer[1].callback();
    }};
}

async function main() {
  for (const stage of ['headers', 'body']) {
    const calls = [];
    let late, cancels = 0;
    const h = harness((url, init) => {
      calls.push({url, init});
      if (calls.length > 1) return Promise.resolve(new Response('complete replacement', {
        headers: {ETag: '"new"', 'Content-Length': '20'}}));
      if (stage === 'headers') return new Promise(resolve => {late = resolve;});
      return Promise.resolve(new Response(new ReadableStream({cancel() {cancels++;}}),
        {headers: {ETag: '"old"', 'Content-Length': '999'}}));
    });
    const responses = [h.manager.request('bucket-book', 120000), h.manager.request('bucket-book', 120000)];
    await tick();
    h.stall();
    const ready = await Promise.all(responses);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.signal.aborted, true);
    assert.equal(calls[1].init.cache, 'reload');
    assert.equal(ready[0].headers.get('ETag'), '"new"');
    assert.deepEqual(await Promise.all(ready.map(response => response.text())),
      ['complete replacement', 'complete replacement']);
    if (late) late(new Response(new ReadableStream({cancel() {cancels++;}})));
    await tick();
    assert.equal(cancels, 1);
    assert.equal(h.manager.activeCount, 0);
    assert.equal(h.timers.size, 0);
  }

  let calls = 0;
  const exhausted = harness(() => {calls++; return new Promise(() => {});});
  const failure = assert.rejects(exhausted.manager.request('stalled', 120000), {name: 'TimeoutError'});
  await tick(); exhausted.stall(); await tick();
  assert.equal([...exhausted.timers.values()].filter(row => row.delay === 10000).length, 0,
    'the final attempt retains the original total deadline for slow connections');
  [...exhausted.timers.values()].find(row => row.delay === 120000).callback(); await failure;
  assert.equal(calls, 2);
  assert.equal(exhausted.manager.pendingCount, 0);
  assert.equal(exhausted.timers.size, 0);

  let networkCalls = 0;
  const network = harness(() => ++networkCalls === 1 ? Promise.reject(new TypeError('network failure'))
    : Promise.resolve(new Response('recovered')));
  assert.equal(await (await network.manager.request('network', 120000)).text(), 'recovered');
  assert.equal(networkCalls, 2);

  const deadline = harness(() => new Promise(() => {}));
  const deadlineFailure = assert.rejects(deadline.manager.request('deadline', 120000), {name:'TimeoutError'});
  await tick();
  const totalTimer = [...deadline.timers.entries()].find(([, row]) => row.delay === 120000);
  deadline.stall(); await tick();
  assert.equal(deadline.timers.get(totalTimer[0]), totalTimer[1], 'retry cannot reset the whole-body deadline');
  totalTimer[1].callback(); await deadlineFailure;
  assert.equal(deadline.timers.size, 0);

  for (const where of ['headers', 'body', 'retry']) {
    let calls = 0, cancels = 0;
    const h = harness(() => {
      calls++;
      return where === 'body' ? Promise.resolve(new Response(new ReadableStream({cancel() {cancels++;}})))
        : new Promise(() => {});
    });
    const request = assert.rejects(h.manager.request('cancelled', 120000), {name: 'AbortError'});
    await tick();
    if (where === 'retry') {h.stall(); await tick();}
    h.manager.dispose(); await request; await tick();
    assert.equal(calls, where === 'retry' ? 2 : 1);
    assert.equal(cancels, where === 'body' ? 1 : 0);
    assert.equal(h.manager.activeCount, 0);
    assert.equal(h.timers.size, 0);
  }

  let streamController, callsAfterBytes = 0;
  const partial = harness(() => {
    callsAfterBytes++;
    return Promise.resolve(new Response(new ReadableStream({start(controller) {
      streamController = controller; controller.enqueue(new TextEncoder().encode('prefix'));
    }})));
  });
  const response = await partial.manager.request('partial', 120000);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'prefix');
  streamController.error(new TypeError('network disconnected'));
  await assert.rejects(reader.read(), {name: 'TypeError'});
  assert.equal(callsAfterBytes, 1, 'never replay a partially delivered unversioned body');
  assert.equal(partial.timers.size, 0);

  for (const mode of ['stall', 'disconnect']) {
    let calls = 0, held, cancelled = 0;
    const h = harness(() => {
      if (++calls > 1) return Promise.resolve(new Response('{"source":"replacement"}', {headers:{ETag:'"new"'}}));
      return Promise.resolve(new Response(new ReadableStream({
        start(control) {held=control;control.enqueue(new TextEncoder().encode('{"source":"old'));},
        cancel() {cancelled++;}
      }), {headers:{ETag:'"old"'}}));
    });
    let published = false;
    const waiting = h.manager.requestBuffered('metadata',120000,128).then(response => {
      published = true;return response;
    });
    await tick();
    assert.equal(published,false,'no partial metadata may reach the caller');
    if (mode === 'stall') h.stall();
    else held.error(new TypeError('body disconnected'));
    const response = await waiting;
    assert.deepEqual(await response.json(),{source:'replacement'});
    assert.equal(response.headers.get('ETag'),'"new"');
    assert.equal(calls,2);
    assert.equal(cancelled,mode === 'stall' ? 1 : 0);
    assert.equal(h.manager.activeCount,0);
    assert.equal(h.timers.size,0);
  }

  for (const declared of [true,false]) {
    let calls = 0, cancelled = 0;
    const h = harness(() => {
      calls++;
      return Promise.resolve(new Response(new ReadableStream({
        start(control) {control.enqueue(new Uint8Array(129)); control.enqueue(new Uint8Array(1));},
        pull(control) {control.close();},
        cancel() {cancelled++;}
      }),{headers:declared?{'Content-Length':'129'}:{}}));
    });
    await assert.rejects(h.manager.requestBuffered('oversized',120000,128),{code:'READER_RESOURCE_LIMIT'});
    await tick();
    assert.equal(calls,1,'resource-limit failures must not retry');
    assert.equal(cancelled,1);
    assert.equal(h.timers.size,0);
  }

  let finalControl, bufferedCalls = 0;
  const final = harness(() => {
    bufferedCalls++;
    return Promise.resolve(new Response(new ReadableStream({start(control) {
      if (bufferedCalls === 1) control.enqueue(new TextEncoder().encode('discard'));
      else finalControl=control;
    }})));
  });
  const finalRequest = final.manager.requestBuffered('slow-final',120000,128);
  await tick();final.stall();await tick();
  assert.equal([...final.timers.values()].some(row=>row.delay===10000),false);
  assert.equal([...final.timers.values()].filter(row=>row.delay===120000).length,1);
  finalControl.enqueue(new TextEncoder().encode('complete'));finalControl.close();
  assert.equal(await (await finalRequest).text(),'complete');
  assert.equal(final.timers.size,0);

  const overdue = harness(() => Promise.resolve(new Response(new ReadableStream({
    start(control) {control.enqueue(new TextEncoder().encode('partial'));}
  }))));
  const overdueFailure = assert.rejects(overdue.manager.requestBuffered('overdue',120000,128),{name:'TimeoutError'});
  await tick();
  const originalTotal = [...overdue.timers.entries()].find(([,row])=>row.delay===120000);
  overdue.stall();await tick();
  assert.equal(overdue.timers.get(originalTotal[0]),originalTotal[1]);
  originalTotal[1].callback();await overdueFailure;
  assert.equal(overdue.manager.activeCount,0);
  assert.equal(overdue.timers.size,0);

  const disposing = harness(() => Promise.resolve(new Response(new ReadableStream({
    start(control) {control.enqueue(new TextEncoder().encode('partial'));}
  }))));
  const disposedBody = assert.rejects(disposing.manager.requestBuffered('closed',120000,128),{name:'AbortError'});
  await tick();disposing.manager.dispose();await disposedBody;
  assert.equal(disposing.manager.activeCount,0);
  assert.equal(disposing.timers.size,0);

  let shapeCalls = 0;
  const shapes = harness(() => {shapeCalls++;return Promise.resolve(new Response('{invalid'));});
  const shaped = await shapes.manager.requestBuffered('invalid',120000,128);
  await assert.rejects(shaped.json(),{name:'SyntaxError'});
  assert.equal(shapeCalls,1,'JSON parsing remains caller-owned and cannot retry invalid JSON');

  let finishShared, sharedCalls = 0;
  const sharedBuffered = harness(() => {sharedCalls++;return new Promise(resolve=>{finishShared=resolve;});});
  const bufferedPair = [sharedBuffered.manager.requestBuffered('shared',120000,128),
    sharedBuffered.manager.requestBuffered('shared',120000,128)];
  await tick();finishShared(new Response('shared complete'));
  assert.deepEqual(await Promise.all((await Promise.all(bufferedPair)).map(response=>response.text())),
    ['shared complete','shared complete']);
  assert.equal(sharedCalls,1);
  assert.equal(sharedBuffered.timers.size,0);

  for (const status of [404, 503]) {
    let calls = 0;
    const h = harness(() => {calls++; return Promise.resolve(new Response('error', {status}));});
    const response = await h.manager.request('http-error', 120000);
    assert.equal(response.status, status);
    assert.equal(await response.text(), 'error');
    assert.equal(calls, 1, 'HTTP policy remains with the caller');
  }
  for (const init of [{method: 'HEAD'}, {headers: {Range: 'bytes=0-9'}},
    {headers: {'If-None-Match': '"old"'}}]) {
    const h = harness(() => Promise.resolve(new Response('unchanged')));
    assert.equal(await (await h.manager.request('special', 120000, init)).text(), 'unchanged');
    assert.equal(h.timers.size, 0);
  }
  console.log('reader initial response recovery contracts passed');
}
require('node:test')('reader initial response recovery', {timeout: 10000}, main);
