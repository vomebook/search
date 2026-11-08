// Exercise the real Worker module and client across a structured-clone boundary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createPdfBookSearch } from '../../../static/reader/search/reader-pdf-book-search.mjs';

const sourceSha = 'a'.repeat(64), generation = 'c'.repeat(64), textGeneration = 'd'.repeat(64);
const base = `objects/aa/${sourceSha}/bbbbbbbbbbbbbbbb`;
const url = path => `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${path}`;
const pack = value => gzipSync(JSON.stringify(value));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(partitioned) {
  const resources = {}, bookUrl = url(`${base}/text/book-text.json.gz`);
  const book = pack({version:2,kind:'pdf-book-text',complete:true,offset_unit:'unicode-codepoint',
    source_sha256:sourceSha,page_count:1,pages:[{page:1,text:'needle '.repeat(120),
      layout:{offset_unit:'unicode-codepoint'},text_spans:[]}]});
  resources[bookUrl] = book;
  const configuration = {url:bookUrl,bytes:book.length,sha256:sha256(book),pageCount:1,sourceSha};
  if (partitioned) {
    const partUrl = url(`${base}/text/search-000001-000001.json.gz`);
    const part = pack({version:1,kind:'pdf-search-text-partition',source_sha256:sourceSha,generation,
      offset_unit:'unicode-codepoint',start:1,end:1,
      pages:[{page:1,text:'needle '.repeat(120),text_generation:textGeneration}]});
    resources[partUrl] = part;
    Object.assign(configuration,{generation,partitions:[{start:1,end:1,url:partUrl,bytes:part.length,sha256:sha256(part)}]});
  }
  return {configuration,resources};
}

function installWorker(resources) {
  const previous = globalThis.Worker, instances = [];
  globalThis.Worker = class {
    constructor(workerUrl, options) {
      assert.equal(options.type,'module');
      this.fetches = [];
      this.worker = new NodeWorker(new URL('./worker-bootstrap.mjs',import.meta.url),
        {workerData:{workerUrl:workerUrl.href,resources}});
      this.worker.on('message', data => {
        if (data.testFetch) this.fetches.push({url:data.testFetch, credentials:data.testCredentials});
        else this.onmessage?.({data});
      });
      this.worker.on('error', () => this.onerror?.({preventDefault(){}}));
      instances.push(this);
    }
    postMessage(message) { this.worker.postMessage(message); }
    terminate() { return this.worker.terminate(); }
  };
  return {instances,restore(){globalThis.Worker=previous;}};
}

for (const partitioned of [false,true]) {
  test(`${partitioned ? 'partitioned' : 'book-text'} worker preserves search sessions across prefetch`,
    {timeout:10000}, async () => {
      const {configuration,resources} = fixture(partitioned), workers = installWorker(resources);
      let client;
      try {
        client = createPdfBookSearch(configuration);
        const before = await client.prefetch();
        assert.equal(before.ready,true);
        assert.equal(before.session,null);
        const first = await client.search('needle');
        assert.equal(first.total,120);
        assert.equal(first.results.length,50);
        assert.equal(typeof first.session,'number');
        assert.equal((await client.page(50)).offset,50);
        const after = await client.prefetch();
        assert.equal(after.ready,true);
        assert.equal(after.session,first.session);
        const page = await client.page(100);
        assert.equal(page.offset,100);
        assert.equal(page.results.length,20);
        assert.equal(page.session,first.session);
        if (partitioned) assert.equal(page.results[0].textGeneration,textGeneration);
        if (!partitioned) assert.equal(workers.instances[0].fetches.length,1);
        assert.ok(workers.instances[0].fetches.length > 0);
        assert.ok(workers.instances[0].fetches.every(request => request.credentials === 'omit'));

        client.cancel();
        assert.equal((await client.prefetch()).session,null);
        await assert.rejects(client.page(0),/取消或加载超时/);
        const again = await client.search('needle');
        assert.equal(again.total,120);
        assert.notEqual(again.session,first.session);
      } finally {
        client?.dispose();
        workers.restore();
      }
    });
}
