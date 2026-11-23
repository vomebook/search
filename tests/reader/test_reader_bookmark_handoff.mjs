import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderBookmarks } from '../../static/reader/ui/reader-bookmarks.mjs';

test('bookmark handoff only cleans matching navigation and preserves other state', () => {
  const opening = 'https://reader.example/read?book=a&bookmark=id&bookmark_source=source&nav=one#anchor';
  const params = new URL(opening).searchParams;
  const replacements = [];
  const saved = { readerUrl: opening.replace('nav=one', 'nav=two'), shareUrl: opening.replace('reader.example', 'other.example'), extra: 42 };
  globalThis.location = new URL(opening);
  globalThis.window = { location: globalThis.location, history: { state: { extra: 1 }, replaceState: (...args) => replacements.push(args) } };
  globalThis.sessionStorage = { getItem: () => JSON.stringify(saved), setItem: () => assert.fail('unmatched saved navigation must not be changed') };
  try {
    const bookmarks = createReaderBookmarks({ params, capability: { mode: 'markdown' }, isReaderOverlayFrame: () => false });
    bookmarks.consumeBookmarkHandoff({ id: 'wrong', url: 'source' });
    assert.equal(replacements.length, 0);
    bookmarks.consumeBookmarkHandoff({ id: 'id', url: 'source' });
    assert.equal(replacements.length, 1);
    assert.deepEqual(replacements[0][0], { extra: 1 });
    assert.equal(replacements[0][2], 'https://reader.example/read?book=a&nav=one');
    assert.equal(params.has('bookmark'), false);
    assert.equal(params.has('bookmark_source'), false);
  } finally {
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.sessionStorage;
  }
});
