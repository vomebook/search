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
