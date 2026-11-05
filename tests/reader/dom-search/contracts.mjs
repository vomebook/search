/* global document, NodeFilter */
// Browser-only contracts for the real DOM-search module; all data is synthetic.
import {createReaderDomSearch, fullSearchEscape, fullSearchPageOffset, fullSearchSnippet}
  from '../../../static/reader/search/reader-dom-search.mjs';

function ensure(value, label) {
  if (!value) throw new Error(label);
}

function fixture(yieldTask = () => Promise.resolve()) {
  const root = document.createElement('div'), entries = [], publications = [];
  document.body.append(root);
  let searchGeneration = 1, navigationGeneration = 1, handler = null, disposed = 0;
  const runtime = {
    events: {on(name, callback) {
      ensure(name === 'generation' && !handler, 'generation subscription');
      handler = callback;
      return () => { disposed++; handler = null; };
    }},
    currentGeneration(name) { return name === 'search' ? searchGeneration : navigationGeneration; }
  };
  const search = createReaderDomSearch({content: root, runtime,
    isCurrent: (name, generation) => generation === runtime.currentGeneration(name),
    yieldTask, getTocEntries: () => entries, unwrapRoot: value => value,
    publishPage: (value, loader, progressive) => publications.push({value, loader, progressive})});
  return {root, entries, publications, search,
    get generation() { return searchGeneration; }, get navigation() { return navigationGeneration; },
    nextNavigation() { navigationGeneration++; },
    cancel() { searchGeneration++; handler({name: 'search'}); },
    finish() {
      search.clearMarks(); search.dispose();
      ensure(disposed === 1 && handler === null, 'lifecycle disposal');
      root.remove();
    }};
}

export async function helpers() {
  ensure(new RegExp(fullSearchEscape('a+b.c?')).test('a+b.c?'), 'literal escaping');
  ensure(!new RegExp(fullSearchEscape('a+b.c?')).test('aaabXc'), 'escaped pattern must be literal');
  ensure(fullSearchPageOffset(102, 51) === 50 && fullSearchPageOffset(102, 101) === 100 &&
    fullSearchPageOffset(102, 500) === 100 && fullSearchPageOffset(0, 0) === 0 &&
    fullSearchPageOffset(102, -10) === 0, 'pagination clamp');
  const snippet = fullSearchSnippet('x'.repeat(80) + 'needle' + 'y'.repeat(100), 80, 6);
  ensure(snippet.matchStart === 72 && snippet.matchLength === 6 && snippet.prefix === '…' &&
    snippet.suffix === '…' && snippet.text.slice(snippet.matchStart, snippet.matchStart + 6) === 'needle', 'snippet bounds');
}

export async function crossNodeAndStaleNavigation() {
  const f = fixture();
  try {
    const p = document.createElement('p'); p.dataset.page = '3';
    p.append(document.createTextNode('prefix nee'), document.createTextNode('dle suffix')); f.root.append(p);
    const results = await f.search.search(f.root, '', 'needle', f.generation, false);
    ensure(results.length === 1 && results[0].location === '第 3 页', 'cross-node page match');
    ensure(f.root.querySelectorAll('mark.full-search-highlight').length === 2, 'cross-node highlight');
    f.search.clearMarks();
    ensure(p.textContent === 'prefix needle suffix' && !f.root.querySelector('mark'), 'mark cleanup');
    ensure(await results[0].activate(f.navigation), 'activation');
    f.search.clearMarks();
    f.nextNavigation(); p.textContent = 'x'.repeat(200) + 'needle';
    let walks = 0;
    const original = document.createTreeWalker;
    document.createTreeWalker = function (...args) { walks++; return original.apply(this, args); };
    try {
      ensure(!await results[0].activate(f.navigation - 1) && !f.root.querySelector('mark') && walks === 0,
        'stale navigation');
    } finally { document.createTreeWalker = original; }
    p.textContent = 'needle';
    const stale = await f.search.search(f.root, '', 'needle', f.generation, false);
    f.search.clearMarks(); p.textContent = 'replacement';
    ensure(!await stale[0].activate(f.navigation) && !f.root.querySelector('mark'), 'mutated target');
  } finally { f.finish(); }
}

export async function progressivePagingAndReuse() {
  const f = fixture();
  try {
    const p = document.createElement('p'); p.textContent = 'needle '.repeat(130); f.root.append(p);
    const first = await f.search.search(f.root, '', 'needle', f.generation, true);
    ensure(first.length === 50 && f.publications.at(-1).value.total === 130 &&
      f.publications.at(-1).progressive === false, 'progressive total');
    const last = f.publications.at(-1).loader(100);
    ensure(last.offset === 100 && last.results.length === 30, 'pagination results');
    f.search.clearMarks();
    const repeated = await f.search.search(f.root, '', 'needle', f.generation, true);
    ensure(repeated.length === 50 && f.publications.at(-1).value.total === 130, 'cached progressive repeat');
    f.search.clearMarks();
    const paged = f.publications.at(-1).loader(100);
    ensure(await paged.results[5].activate(f.navigation), 'paged activation');
    ensure(f.root.querySelectorAll('mark.full-search-highlight').length === 1, 'paged match highlight');
    f.search.pruneMarks();
  } finally { f.finish(); }
}

export async function synchronousSnapshotInvalidation() {
  const f = fixture();
  try {
    const p = document.createElement('p'); p.textContent = 'needle '.repeat(130); f.root.append(p);
    await f.search.search(f.root, '', 'needle', f.generation, true);
    f.search.clearMarks();
    await f.search.search(f.root, '', 'needle', f.generation, true);
    f.search.clearMarks();
    p.firstChild.data = 'plain';
    const replacement = document.createElement('b'); replacement.append(document.createTextNode('needle'));
    p.append(replacement); f.publications.length = 0;
    try { await f.search.search(f.root, '', 'needle', f.generation, true); }
    catch (error) { throw new Error('mutation invalidates cached snapshot', {cause: error}); }
    ensure(f.publications.at(-1).value.total === 1, 'mutation invalidates cached snapshot');
  } finally { f.finish(); }
}

export async function cancellation() {
  let f;
  f = fixture(async () => { f.cancel(); });
  try {
    f.root.textContent = 'needle '.repeat(100);
    const cancelled = await f.search.search(f.root, '', 'needle', f.generation, true);
    ensure(cancelled.length === 0 && f.publications.length === 1 && f.publications[0].progressive === true,
      'stale search cannot publish a final page');
    ensure(!f.root.querySelector('mark'), 'cancelled search cannot highlight');
  } finally { f.finish(); }
}

export async function headingsAndExcludedNodes() {
  const f = fixture();
  try {
    f.root.innerHTML = '<p>needle before</p><h2>First</h2><p>needle</p>' +
      '<script>needle</script><style>needle</style><span class="reader-pdf-text">needle</span>' +
      '<mark class="full-search-highlight">needle</mark><h2>Second</h2><p>needle</p>';
    const headings = f.root.querySelectorAll('h2');
    f.entries.push({target: headings[0], label: 'First label'}, {target: headings[1], label: 'Second label'});
    const result = await f.search.search(f.root, '', 'needle', f.generation, false);
    ensure(result.length === 3 && result[0].location.startsWith('正文 ') &&
      result[1].location === 'First label' && result[2].location === 'Second label', 'heading labels and excluded nodes');
    ensure(document.createTreeWalker(f.root, NodeFilter.SHOW_TEXT).nextNode(), 'text remains in DOM');
  } finally { f.finish(); }
}

export async function occurrenceSelection() {
  const f = fixture();
  try {
    f.root.textContent = 'needle one needle two needle';
    const result = await f.search.search(f.root, '', 'needle', f.generation, true, 1, f.navigation);
    ensure(result.length === 1 && result[0].target?.textContent === 'needle' &&
      f.root.querySelectorAll('mark.full-search-highlight').length === 1, 'occurrence selection');
    f.search.clearMarks(); f.nextNavigation();
    const stale = await f.search.search(f.root, '', 'needle', f.generation, true, 1, f.navigation - 1);
    ensure(stale.length === 0 && !f.root.querySelector('mark'), 'stale occurrence selection');
  } finally { f.finish(); }
}
