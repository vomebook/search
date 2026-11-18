import assert from 'node:assert/strict';
import vm from 'node:vm';
import {html as html5, parse} from 'parse5';

const origin = 'https://shell.test';

// Count executable script elements, not matching strings in comments or prose.
export function shellScriptPaths(html, staticBase, {ordered = [], onScript} = {}) {
  const base = new URL(staticBase, origin);
  const documentUrl = new URL('../', base);
  const document = parse(html, {sourceCodeLocationInfo: Boolean(onScript)});
  let firstBase;
  function findBase(node) {
    if (node.namespaceURI === html5.NS.HTML && node.tagName === 'base' && firstBase === undefined) {
      firstBase = node.attrs.find(attr => attr.name === 'href')?.value;
    }
    for (const child of node.childNodes || []) findBase(child);
  }
  findBase(document);
  const resolutionBase = firstBase === undefined ? documentUrl : new URL(firstBase, documentUrl);
  const paths = [];
  const scheduling = [];
  function visit(node) {
    // SVG scripts use href, not the HTML script element's src attribute.
    if (node.namespaceURI === html5.NS.HTML && node.tagName === 'script') {
      const attrs = new Map(node.attrs.map(({name, value}) => [name, value]));
      const src = attrs.get('src');
      const type = (attrs.get('type') || '').trim().toLowerCase();
      if (src && !attrs.has('nomodule') && ['', 'text/javascript', 'application/javascript', 'module'].includes(type)) {
        const url = new URL(src, resolutionBase);
        const local = url.origin === base.origin && url.pathname.startsWith(base.pathname);
        const path = local ? url.pathname.slice(base.pathname.length) : url.href;
        paths.push(path);
        onScript?.(path, node.sourceCodeLocation);
        if (ordered.includes(path)) {
          assert.ok(type !== 'module' && !attrs.has('async'), `${path} must be an ordered classic script`);
          scheduling.push({path, deferred: attrs.has('defer')});
        }
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  // Blocking classic scripts run before deferred ones regardless of tag position.
  const deferred = scheduling.findIndex(script => script.deferred);
  if (deferred >= 0) assert.ok(scheduling.slice(deferred).every(script => script.deferred),
    'a blocking script would execute before a deferred dependency');
  return paths;
}

// Observe the real worker install in an empty cache with no browser or network.
export async function installPrecachePaths(source, resources, staticBase) {
  const base = new URL(staticBase, origin);
  // Both sites serve sw.js beside static/, not inside it. A service worker's
  // Request constructor and Cache.addAll resolve strings against that URL.
  const workerUrl = new URL('../sw.js', base);
  class WorkerRequest extends Request {
    constructor(input, init) {
      super(input instanceof Request ? input : new URL(input, workerUrl), init);
    }
  }
  const listeners = new Map(), requested = [];
  const cache = {match: async () => undefined, async addAll(inputs) {
    for (const input of inputs) requested.push(new URL(input instanceof Request ? input.url : input, workerUrl));
  }};
  const context = vm.createContext({
    URL, Request: WorkerRequest, location: workerUrl, importScripts() {}, VoiceOfMLReaderResources: resources,
    caches: {keys: async () => [], open: async () => cache},
    self: {location: workerUrl, addEventListener(name, fn) { listeners.set(name, fn); }, async skipWaiting() {}},
  });
  vm.runInContext(source, context, {timeout: 1000});
  assert.equal(typeof listeners.get('install'), 'function');
  let done;
  listeners.get('install')({waitUntil(promise) { done = promise; }});
  assert.ok(done && typeof done.then === 'function', 'install must register a lifetime');
  await done;
  return requested.filter(url => url.origin === base.origin && url.pathname.startsWith(base.pathname))
    .map(url => url.pathname.slice(base.pathname.length));
}
