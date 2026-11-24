import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createReaderPdfSearch} from '../../../static/reader/pdf/reader-pdf-search.mjs';

function fixture(texts) {
  const publications = [];
  const reads = [];
  const context = {
    pdfDocument: {numPages: texts.length},
    fullSearchEscape: text => text,
    normalizePdfSearchText: text => text,
    isReaderGenerationCurrent: () => true,
    fullSearchSession: {},
    loadPdfSearchText: async (_pdf, page) => {
      reads.push(page);
      return texts[page - 1];
    },
    fullSearchSnippet: (text, start, length) => text.slice(start, start + length),
    content: {querySelector: () => null},
    highlightPdfText() {},
    waitForReader: async () => {},
    publishPdfSearchProgress(_generation, groups, total, _pattern, results, scanned, pages) {
      publications.push({total, scanned, pages, groups: groups.map(({page, count}) => [page, count]), results: [...results]});
      return true;
    },
    readerAbortController: new AbortController(),
    syncCapabilityControls() {},
  };
  return {context, publications, reads, search: createReaderPdfSearch(context).fullSearchPdfMatches};
}

test('native PDF publishes final search progress once with the complete first page', async () => {
  for (const pages of [1, 8, 9]) {
    const texts = Array.from({length: pages}, (_, index) => index === 0 ? 'needle '.repeat(50) : 'needle');
    const f = fixture(texts);
    const hits = await f.search('needle', 1);
    const scanned = pages === 1 ? [1] : pages === 8 ? [1, 8] : [1, 8, 9];
    assert.deepEqual(f.publications.map(record => record.scanned), scanned);
    const last = f.publications.at(-1);
    assert.equal(last.total, 49 + pages);
    assert.equal(last.pages, pages);
    assert.deepEqual(last.groups, texts.map((_, index) => [index + 1, index === 0 ? 50 : 1]));
    assert.deepEqual(last.results, hits);
    assert.equal(hits.length, 50);
    assert.equal(f.reads.length, pages);
  }
});

test('native PDF distinguishes a completed no-match search from absent text', async () => {
  const noHit = fixture(['known text']);
  assert.deepEqual(await noHit.search('needle', 1), []);
  assert.deepEqual(noHit.publications.map(({total, scanned}) => [total, scanned]), [[0, 1]]);

  const noText = fixture([' ']);
  await assert.rejects(noText.search('needle', 1), {code: 'READER_NO_SEARCHABLE_TEXT'});
  assert.equal(noText.context.pdfDocument.readerNoSearchableText, true);
  assert.equal(noText.publications.length, 1);
});

test('native PDF does not publish twice after cancellation during the final yield', async () => {
  const f = fixture(['needle']);
  let current = true;
  f.context.isReaderGenerationCurrent = () => current;
  f.context.waitForReader = async () => { current = false; };
  const originalPublish = f.context.publishPdfSearchProgress;
  let attempts = 0;
  f.context.publishPdfSearchProgress = (...args) => {
    attempts++;
    if (!current) return false;
    return originalPublish(...args);
  };
  await f.search('needle', 1);
  assert.equal(attempts, 1);
  assert.equal(f.publications.length, 1);
});
