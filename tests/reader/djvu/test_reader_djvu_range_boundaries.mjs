import assert from 'node:assert/strict';
import test from 'node:test';
import {openDjvuRange} from '../../../static/reader/pdf/reader-djvu-range.mjs';

test('reads reject invalid lengths and offsets without dispatching new windows', async () => {
  const bytes = Uint8Array.from({length: 70000}, (_, index) => index % 251);
  const requests = [];
  const range = await openDjvuRange({url:'https://test/source', signal:new AbortController().signal,
    windowBytes:65536, maxCacheBytes:131072, readBytes:async response=>new Uint8Array(await response.arrayBuffer()),
    fetchResponse:async (_url, options) => {
      requests.push(options.headers.Range);
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(first), end = Math.min(Number(last), bytes.length - 1);
      const body = bytes.slice(start, end + 1);
      return new Response(body, {status:206, headers:{ETag:'"stable"',
        'Content-Range':`bytes ${start}-${end}/${bytes.length}`, 'Content-Length':String(body.length)}});
    }});
  try {
    assert.equal(requests.length, 1);
    for (const [offset, length] of [[-1, 1], [0, 0], [0.5, 1], [0, 1.5], [0, 65537],
      [65535, 2], [bytes.length, 1], [bytes.length - 1, 2]]) {
      await assert.rejects(range.read(offset, length), /DJVU_RANGE_INVALID/, `${offset}:${length}`);
    }
    assert.equal(requests.length, 1, 'invalid reads must not dispatch');
    assert.deepEqual(await range.read(bytes.length - 1, 1), bytes.slice(-1));
    assert.equal(requests.length, 2);
  } finally { range.close(); }
});


test('Content-Range decimal coordinates are bounded and identity-pinned', async () => {
  const values = [
    ['bytes 0-15/16', true], ['bytes 00-00015/00016', true],
    ['bytes 0-15/15', false], ['bytes 1-15/16', false],
    ['bytes 0-16/16', false], ['bytes 0-15/17', false],
    ['bytes 0-15/9007199254740992', false], ['bytes 0-15/99999999999999999999999999', false],
    ['bytes -1-15/16', false], ['bytes 0-15/*', false], ['bytes 0-15/', false],
    ['bytes 0.0-15/16', false], ['bytes 0-15/16x', false], ['bytes 0-15/ 16', false]
  ];
  for (const [header, valid] of values) {
    let readCount = 0;
    const opening = openDjvuRange({url:'https://test/source',signal:new AbortController().signal,
      windowBytes:65536,maxCacheBytes:65536,
      readBytes:async response=>{readCount++;return new Uint8Array(await response.arrayBuffer());},
      fetchResponse:async()=>new Response(new Uint8Array(16), {status:206,headers:{
        ETag:'"stable"','Content-Range':header,'Content-Length':'16'}})});
    if (valid) {
      const range=await opening;
      try { assert.equal(range.total,16,header);assert.deepEqual(await range.read(0,1),new Uint8Array(1),header); }
      finally { range.close(); }
      assert.equal(readCount,1,header);
    } else {
      await assert.rejects(opening,/DJVU_RANGE_INVALID/,header);
      assert.equal(readCount,0,header);
    }
  }
});
