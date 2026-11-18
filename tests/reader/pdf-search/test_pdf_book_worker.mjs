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

function installWorker(resources, {stepClock = false} = {}) {
  const previous = globalThis.Worker, instances = [];
  globalThis.Worker = class {
    constructor(workerUrl, options) {
      assert.equal(options.type,'module');
      this.fetches = [];
      this.aborts = [];
      this.messages = [];
      this.worker = new NodeWorker(new URL('./worker-bootstrap.mjs',import.meta.url),
        {workerData:{workerUrl:workerUrl.href,resources,stepClock}});
      this.worker.on('message', data => {
        if (data.testFetch) {
          this.fetches.push({url:data.testFetch, credentials:data.testCredentials, attempt:data.attempt});
          this.onFetch?.(data);
        } else if (data.testAbort) this.aborts.push(data);
        else {
          this.messages.push(data);
          this.onmessage?.({data});
        }
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

for (const partitioned of [false,true]) {
  test(`${partitioned ? 'partition' : 'book-text'} failure is not cached and a later search refetches`,
    {timeout:10000}, async () => {
      const {configuration,resources} = fixture(partitioned);
      const target = partitioned ? configuration.partitions[0].url : configuration.url;
      const valid = resources[target], corrupt = Buffer.from(valid);
      corrupt[corrupt.length-1] ^= 1; // keep the expected length but break integrity
      resources[target] = [corrupt, valid];
      const workers = installWorker(resources);
      let client;
      try {
        client = createPdfBookSearch(configuration);
        const worker = workers.instances[0], progress = [];
        await assert.rejects(client.search('needle', value => progress.push(value)), /PDF_OCR_HASH_MISMATCH/);
        assert.deepEqual(progress, []);
        await assert.rejects(client.page(50), /取消或加载超时/);
        assert.deepEqual(worker.fetches.map(({url,attempt}) => [url,attempt]), [[target,1]]);
        const recovered = await client.search('needle');
        assert.equal(recovered.total, 120);
        assert.deepEqual(worker.fetches.map(({url,attempt}) => [url,attempt]), [[target,1],[target,2]]);
        const page = await client.page(50);
        assert.equal(page.session, recovered.session);
        assert.equal(page.offset, 50);
        assert.equal(page.results.length, 50);
      } finally {client?.dispose();workers.restore();}
    });
}

test('legacy compaction yields without changing the final page and UTF-16 hit offsets',
  {timeout:10000}, async () => {
    const {configuration,resources} = fixture(false);
    // Cross two 16-page compaction slices without depending on CPU speed.
    const pages = Array.from({length:33}, (_,i) => ({page:i+1,text:i===32 ? '😀 needle' : '',
      layout:{offset_unit:'unicode-codepoint'},text_spans:[]}));
    const bytes = pack({version:2,kind:'pdf-book-text',complete:true,offset_unit:'unicode-codepoint',
      source_sha256:sourceSha,page_count:pages.length,pages});
    Object.assign(configuration,{pageCount:pages.length,bytes:bytes.length,sha256:sha256(bytes)});
    resources[configuration.url] = bytes;
    const workers = installWorker(resources,{stepClock:true});
    let client;
    try {
      client = createPdfBookSearch(configuration);
      assert.equal((await client.prefetch()).ready, true);
      const result = await client.search('needle');
      assert.equal(result.total, 1);
      assert.deepEqual(result.results.map(({page,start,length}) => [page,start,length]), [[33,3,6]]);
      assert.equal(workers.instances[0].fetches.length, 1);
    } finally {client?.dispose();workers.restore();}
  });

test('lookahead failure never publishes the failed partition and retry reloads both parts',
  {timeout:10000}, async () => {
    const {configuration,resources} = fixture(true);
    const first = configuration.partitions[0].url;
    const second = url(`${base}/text/search-000002-000002.json.gz`);
    const bytes = pack({version:1,kind:'pdf-search-text-partition',source_sha256:sourceSha,generation,
      offset_unit:'unicode-codepoint',start:2,end:2,
      pages:[{page:2,text:'needle '.repeat(10),text_generation:textGeneration}]});
    configuration.pageCount = 2;
    configuration.partitions.push({start:2,end:2,url:second,bytes:bytes.length,sha256:sha256(bytes)});
    resources[second] = [{status:503}, bytes];
    const workers = installWorker(resources);
    let client;
    try {
      client = createPdfBookSearch(configuration);
      const worker = workers.instances[0], progress = [];
      await assert.rejects(client.search('needle', value => progress.push(value)), /HTTP 503/);
      assert.deepEqual(progress.map(({scanned,total}) => [scanned,total]), [[1,120]]);
      assert.ok(progress.every(update => update.results.every(hit => hit.page === 1)));
      await assert.rejects(client.page(50), /取消或加载超时/);
      assert.deepEqual(worker.fetches.map(({url,attempt}) => [url,attempt]), [[first,1],[second,1]]);
      const recovered = await client.search('needle');
      assert.equal(recovered.total, 130);
      assert.equal(recovered.complete, true);
      assert.deepEqual(worker.fetches.map(({url,attempt}) => [url,attempt]), [[first,1],[second,1],[first,2],[second,2]]);
      const crossing = await client.page(100);
      assert.equal(crossing.session, recovered.session);
      assert.deepEqual(crossing.results.map(hit => hit.page), [...Array(20).fill(1), ...Array(10).fill(2)]);
      assert.ok(crossing.results.every(hit => hit.textGeneration === textGeneration));
    } finally {client?.dispose();workers.restore();}
  });

test('replacing a partition search aborts the old fetch without aborting the new page session',
  {timeout:10000}, async () => {
    const {configuration,resources} = fixture(true);
    const target = configuration.partitions[0].url;
    resources[target] = [{hold:true}, resources[target]];
    const workers = installWorker(resources);
    let client;
    try {
      client = createPdfBookSearch(configuration);
      const worker = workers.instances[0], started = Promise.withResolvers(), oldProgress = [];
      worker.onFetch = data => {if (data.testFetch === target && data.attempt === 1) started.resolve();};
      const old = client.search('needle', value => oldProgress.push(value));
      const oldRejected = assert.rejects(old, {name:'AbortError'});
      await started.promise;
      const current = await client.search('needle');
      await oldRejected;
      assert.equal(current.total, 120);
      assert.deepEqual(oldProgress, []);
      assert.deepEqual(worker.aborts.map(({testAbort,attempt}) => [testAbort,attempt]), [[target,1]]);
      assert.equal(workers.instances.length, 1);
      assert.deepEqual(worker.fetches.map(({url,attempt}) => [url,attempt]), [[target,1],[target,2]]);
      assert.equal(worker.messages.some(message => message.id === 1), false);
      const page = await client.page(100);
      assert.equal(page.session, current.session);
      assert.equal(page.results.length, 20);
      assert.equal(page.results[0].textGeneration, textGeneration);
    } finally {client?.dispose();workers.restore();}
  });
