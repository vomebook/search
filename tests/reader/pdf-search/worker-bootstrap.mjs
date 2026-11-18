// Run the unchanged browser Worker inside a real Node Worker with local fixtures.
import { parentPort, workerData } from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.location = new URL('https://voiceofml-search.hf.space/static/worker.mjs');
globalThis.postMessage = message => parentPort.postMessage(message);
if (workerData.stepClock) {
  let time = 0;
  Object.defineProperty(globalThis.performance, 'now', {value:() => (time += 10)});
}
const counts = new Map();
globalThis.fetch = async (url, options) => {
  const address = String(url), attempt = (counts.get(address) || 0) + 1;
  counts.set(address, attempt);
  parentPort.postMessage({ testFetch: address, testCredentials: options.credentials, attempt });
  const fixture = workerData.resources[address];
  const reply = Array.isArray(fixture) ? fixture[Math.min(attempt, fixture.length) - 1] : fixture;
  if (reply?.hold) {
    await new Promise((_, reject) => {
      const cancel = () => {
        parentPort.postMessage({ testAbort: address, attempt });
        reject(options.signal.reason);
      };
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener('abort', cancel, {once:true});
    });
  }
  if (reply?.status) return new Response(null, {status:reply.status});
  return reply ? new Response(reply) : new Response(null, { status: 404 });
};

await import(workerData.workerUrl);
parentPort.on('message', data => { void globalThis.onmessage({ data }); });
