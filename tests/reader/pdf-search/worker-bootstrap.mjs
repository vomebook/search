// Run the unchanged browser Worker inside a real Node Worker with local fixtures.
import { parentPort, workerData } from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.location = new URL('https://voiceofml-search.hf.space/static/worker.mjs');
globalThis.postMessage = message => parentPort.postMessage(message);
globalThis.fetch = async (url, options) => {
  parentPort.postMessage({ testFetch: String(url), testCredentials: options.credentials });
  const bytes = workerData.resources[String(url)];
  return bytes ? new Response(bytes) : new Response(null, { status: 404 });
};

await import(workerData.workerUrl);
parentPort.on('message', data => { void globalThis.onmessage({ data }); });
