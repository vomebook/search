/* global document, Element, NodeFilter */
// Browser-only contracts for the real DOM-search module; all data is synthetic.
import {createReaderDomSearch, fullSearchEscape, fullSearchPageOffset, fullSearchSnippet}
  from '../../../static/reader/search/reader-dom-search.mjs';
import {createReaderSearchController} from '../../../static/reader/search/reader-search-controller.mjs';

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
  let publish;
  const search = createReaderDomSearch({content: root, runtime,
    isCurrent: (name, generation) => generation === runtime.currentGeneration(name),
    yieldTask, getTocEntries: () => entries,
    publishPage: (value, loader, progressive) => {
      publications.push({value, loader, progressive});
      publish?.(value, loader, progressive);
    }});
  return {root, entries, publications, search, runtime, setPublisher(callback) { publish = callback; },
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
    const results = await f.search.search(f.root, '', 'needle', f.generation);
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
    const stale = await f.search.search(f.root, '', 'needle', f.generation);
    f.search.clearMarks(); p.textContent = 'replacement';
    ensure(!await stale[0].activate(f.navigation) && !f.root.querySelector('mark'), 'mutated target');
    p.replaceChildren(document.createTextNode('前𐐀'), document.createTextNode('界后'));
    const unicode = await f.search.search(f.root, '', '𐐨界', f.generation);
    ensure(unicode.length === 1 && p.querySelectorAll('mark').length === 2 &&
      unicode[0].snippet.text.includes('𐐀界'), 'cross-node unicode case folding');
    f.search.clearMarks();
    f.root.innerHTML = '<p>alpha</p><p>beta</p><div>gamma<br>delta<div></div>epsilon</div>' +
      '<h2>Heading</h2><p data-page="7">prefix <span>al</span><em>phab</em>eta suffix</p>';
    f.entries.push({target: f.root.querySelector('h2'), label: 'Heading label'});
    for (const query of ['alpha\nbeta', 'betagamma', 'gammadelta', 'deltaepsilon']) {
      ensure((await f.search.search(f.root, '', query, f.generation)).length === 0, 'block boundary: ' + query);
    }
    for (let i = 0; i < 2; i++) {
      const inline = await f.search.search(f.root, '', 'alphabeta', f.generation);
      ensure(inline.length === 1 && inline[0].location === '第 7 页', 'only inline match across adjacent blocks');
      const marks = () => Array.from(f.root.querySelectorAll('mark'), mark => mark.textContent).join('|');
      ensure(marks() === 'al|phab|eta', 'inline marks on cold and cached search');
      ensure(await inline[0].activate(f.navigation) && marks() === 'al|phab|eta', 'inline activation after block offsets');
      f.search.clearMarks();
      f.cancel();
    }
    f.root.innerHTML = '<div class="reader-text"><pre class="reader-text-block"></pre>' +
      '<pre class="reader-text-block"></pre></div>';
    const [left, right] = f.root.querySelectorAll('pre');
    left.textContent = 'x'.repeat(32764) + '𐐀\r\n';
    right.textContent = '界后';
    for (let i = 0; i < 2; i++) {
      const txt = await f.search.search(f.root, '', '𐐨\r\n界', f.generation);
      ensure(txt.length === 1 && txt[0].snippet.text.includes('𐐀\r\n界'), 'TXT chunk match and unchanged CRLF');
      ensure(await txt[0].activate(f.navigation) && left.querySelector('mark')?.textContent === '𐐀\r\n' &&
        right.querySelector('mark')?.textContent === '界', 'TXT chunk activation');
      f.search.clearMarks();
    }
  } finally { f.finish(); }
}

export async function progressivePagingAndReuse() {
  const f = fixture();
  try {
    for (let i = 0; i < 136; i++) {
      const p = document.createElement('p');
      p.dataset.page = String(i + 1);
      p.innerHTML = `line ${i}: <span>nee</span><b>dle</b>`;
      f.root.append(p);
    }
    const first = await f.search.search(f.root, '', 'needle', f.generation);
    ensure(first.length === 50 && f.publications.at(-1).value.total === 136 &&
      f.publications.at(-1).progressive === false, 'progressive total');
    const last = f.publications.at(-1).loader(100);
    ensure(last.offset === 100 && last.results.length === 36, 'pagination results');
    f.search.clearMarks();
    f.cancel();
    const repeated = await f.search.search(f.root, '', 'needle', f.generation);
    ensure(repeated.length === 50 && f.publications.at(-1).value.total === 136, 'cached progressive repeat');
    const paged = f.publications.at(-1).loader(100);
    ensure(paged.results[35].location === '第 136 页' && await paged.results[35].activate(f.navigation), 'paged activation');
    ensure(f.root.querySelectorAll('mark.full-search-highlight').length === 2 &&
      f.root.lastElementChild.querySelector('b mark')?.textContent === 'dle', 'paged match highlights after checkpoint');
    f.search.pruneMarks();
  } finally { f.finish(); }
  for (const mode of ['text', 'markdown', 'html']) await delayedInitialSearch(mode);
}

async function delayedInitialSearch(mode) {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const panel = document.createElement('aside');
  panel.id = 'history-panel';
  panel.innerHTML = '<button id="full-search-toggle"></button><div class="reader-panel-tabs"></div>';
  document.body.append(panel);
  const state = {query: '', results: [], index: -1};
  let open = false, serial = 0, run, deferredActivation;
  const controller = createReaderSearchController({document, signal: new AbortController().signal,
    runtime: {state: {search: state}, currentGeneration: f.runtime.currentGeneration, events: {on: () => () => {}}},
    nextGeneration: () => { f.cancel(); return f.generation; }, isCurrent: generation => generation === f.generation,
    updateSearch: patch => Object.assign(state, patch),
    backend: {mode: () => mode, clearMarks: f.search.clearMarks, chapterClient: () => null, pdfClient: () => null,
      search(query, generation) {
        run = f.search.search(f.root, '', query, generation).then(results => {
          if (generation === f.generation) state.results = results;
        });
        return run;
      },
      activate: (result, generation) => deferredActivation?.promise.then(() => result.activate(generation)) ?? result.activate(generation)},
    navigation: {begin: () => { f.nextNavigation(); return f.navigation; },
      current: generation => generation === f.navigation, reportError: error => { throw error; }},
    panel: {isOpen: () => open, serial: () => serial, show: () => { open = true; view.hidden = false; serial++; },
      hide: () => { view.hidden = true; }, close: () => { open = false; }, focus: () => { serial++; }}});
  const {button, input, view, status, cancel, retry} = controller.elements;
  f.setPublisher((page, loader, partial) => {
    controller.state.page = page;
    controller.state.pageLoader = async offset => loader(offset);
    if (partial) {
      state.results = page.results;
      controller.render();
      status.textContent = `${page.total} 个结果（正在搜索…）`;
    }
  });
  const find = id => document.getElementById(id);
  const waitForPartial = async () => {
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    ensure(release && status.textContent === '70 个结果（正在搜索…）', 'paused after 70 matches');
  };
  const settle = async () => {
    const resume = release;
    release = null;
    resume();
    await run;
  };
  try {
    f.root.textContent = 'needle '.repeat(70).padEnd(65536, 'x') + 'needle '.repeat(65);
    input.value = 'needle';
    button.click();
    await waitForPartial();
    const generation = f.generation;
    const pageInput = find('full-search-page'), pageNext = find('full-search-page-next');
    const prev = find('full-search-prev'), next = find('full-search-next');
    ensure(!cancel.hidden && pageInput.disabled && pageNext.disabled && prev.disabled && !next.disabled,
      'partial pagination locked but in-page activation available');
    // Synthetic events exercise the guards even when controls are disabled.
    pageInput.value = '2';
    pageInput.dispatchEvent(new Event('change'));
    pageNext.dispatchEvent(new Event('click'));
    prev.dispatchEvent(new Event('click'));
    ensure(pageInput.value === '1' && f.generation === generation && state.index === -1, 'no partial page jump or wrap back');
    await controller.move(1);
    ensure(state.index === 0 && f.root.querySelector('mark')?.textContent === 'needle', 'in-page next during scan');
    await controller.activate(49);
    ensure(!open && state.index === 49 && f.root.querySelectorAll('mark').length === 1, 'partial result activation closes panel');
    button.click();
    ensure(f.generation === generation && next.disabled && !prev.disabled, 'reopen keeps owned scan and selection');
    next.dispatchEvent(new Event('click'));
    ensure(f.generation === generation && controller.state.page.offset === 0, 'no partial cross-page next');
    await settle();
    ensure(status.textContent === '135 个结果' && !pageInput.disabled && !pageNext.disabled && !next.disabled && cancel.hidden,
      'all 135 matches retained and pagination enabled');
    await controller.move(1);
    ensure(controller.state.page.offset === 50 && state.index === 0, 'cross-page next after scan');
    pageInput.value = '3';
    pageInput.dispatchEvent(new Event('change'));
    await Promise.resolve();
    ensure(controller.state.page.offset === 100 && state.results.length === 35, 'direct page jump reaches final 35 matches');
    const restart = controller.run();
    await waitForPartial();
    await controller.activate(0, false);
    ensure(f.root.querySelector('mark'), 'partial activation paints a highlight');
    cancel.click();
    ensure(state.results.length === 0 && status.textContent === '搜索已取消' && !retry.hidden && !f.root.querySelector('mark'),
      'cancel clears partial page and highlights immediately');
    const obsolete = release;
    release = null;
    retry.click();
    await waitForPartial();
    obsolete();
    await restart;
    ensure(!cancel.hidden && pageNext.disabled && state.results.length === 50, 'obsolete run cannot unlock retry');
    await controller.activate(0, false);
    controller.close();
    await settle();
    ensure(view.hidden && state.results.length === 0 && !controller.state.complete && !f.root.querySelector('mark'),
      'explicit close cancels partial search and clears highlights');
    button.click();
    await waitForPartial();
    await settle();
    ensure(status.textContent === '135 个结果', 'reopen after cancellation starts fresh');
    for (const newerNavigation of [false, true]) {
      deferredActivation = Promise.withResolvers();
      const activating = controller.activate(0);
      const activeResult = f.navigation;
      if (newerNavigation) f.nextNavigation();
      find('full-search-clear').click();
      ensure(f.navigation === activeResult + 1, 'clear cancels only the owned result jump');
      ensure(!f.root.querySelector('mark'), 'clear removes the old highlights');
      deferredActivation.resolve();
      await activating;
      ensure(open && state.results.length === 0 && !f.root.querySelector('mark'), 'cleared result cannot land');
      if (!newerNavigation) {
        input.value = 'needle';
        const searching = controller.run();
        await waitForPartial();
        await settle();
        await searching;
      }
    }
  } finally {
    controller.dispose();
    f.cancel();
    release?.();
    f.finish();
    panel.remove();
  }
}

export async function chapterProgressPreservesSelection() {
  const panel = document.createElement('aside');
  panel.id = 'history-panel';
  panel.innerHTML = '<button id="full-search-toggle"></button><div class="reader-panel-tabs"></div>';
  document.body.append(panel);
  let search = 0, nav = 0, activate, panelState, closes = 0;
  const state = {query: '', results: [], index: -1};
  const controller = createReaderSearchController({document, signal: new AbortController().signal,
    runtime: {state: {search: state}, currentGeneration: () => search,
      events: {on: (_, callback) => { panelState = callback; return () => {}; }}},
    nextGeneration: () => ++search, isCurrent: generation => generation === search,
    updateSearch: patch => Object.assign(state, patch),
    backend: {mode: () => 'epub-chapters', clearMarks: () => {}, chapterClient: () => null, pdfClient: () => null,
      chapterResult: hit => ({...hit}), activate: () => activate.promise},
    navigation: {begin: () => ++nav, current: generation => generation === nav, reportError: error => { throw error; }},
    panel: {serial: () => 0, close: () => { closes++; panelState({panel: {open: false, selected: 'full-search'}}); }}});
  const publish = (starts, offset = 0) => {
    controller.applyChapterPage({total: starts.length + offset, offset, pageSize: 50,
      results: starts.map(start => ({chapterIndex: 1, start, length: 6, location: 'Chapter 1',
        snippet: fullSearchSnippet('needle', 0, 6)}))});
    controller.render();
  };
  try {
    panelState({panel: {open: true, selected: 'full-search'}});
    controller.elements.view.hidden = false;
    publish([0]);
    const row = controller.elements.results.firstElementChild, result = state.results[0];
    row.focus();
    activate = Promise.withResolvers();
    const pending = controller.activate(0);
    publish([0, 12]);
    publish([0, 12, 24]);
    ensure(row === controller.elements.results.firstElementChild && document.activeElement === row &&
      state.results[0] === result && state.index === 0 && row.getAttribute('aria-current') === 'true', 'EPUB progress preserves focused result');
    activate.resolve(true);
    await pending;
    ensure(closes === 1 && state.index === 0, 'EPUB in-flight activation survives result progress');
    publish([36], 50);
    ensure(state.index === -1 && state.results[0] !== result, 'new results page resets selection');
  } finally {
    controller.dispose();
    panel.remove();
  }
}

export async function synchronousSnapshotInvalidation() {
  const f = fixture();
  try {
    const p = document.createElement('p'); p.textContent = 'needle '.repeat(130); f.root.append(p);
    await f.search.search(f.root, '', 'needle', f.generation);
    f.search.clearMarks();
    await f.search.search(f.root, '', 'needle', f.generation);
    f.search.clearMarks();
    p.firstChild.data = 'plain';
    const replacement = document.createElement('b'); replacement.append(document.createTextNode('needle'));
    p.append(replacement); f.publications.length = 0;
    try { await f.search.search(f.root, '', 'needle', f.generation); }
    catch (error) { throw new Error('mutation invalidates cached snapshot', {cause: error}); }
    ensure(f.publications.at(-1).value.total === 1, 'mutation invalidates cached snapshot');

    f.search.clearMarks();
    replacement.textContent = 'needle '.repeat(3);
    // Mark cleanup must drain queued external mutations before disconnecting.
    f.search.clearMarks();
    await f.search.search(f.root, '', 'needle', f.generation);
    ensure(f.publications.at(-1).value.total === 3, 'mark cleanup preserves pending mutation invalidation');
  } finally { f.finish(); }
}

export async function cancellation() {
  let f;
  f = fixture(async () => { f.cancel(); });
  try {
    f.root.textContent = 'needle '.repeat(100);
    const cancelled = await f.search.search(f.root, '', 'needle', f.generation);
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
    const result = await f.search.search(f.root, '', 'needle', f.generation);
    ensure(result.length === 3 && result[0].location.startsWith('正文 ') &&
      result[1].location === 'First label' && result[2].location === 'Second label', 'heading labels and excluded nodes');
    ensure(document.createTreeWalker(f.root, NodeFilter.SHOW_TEXT).nextNode(), 'text remains in DOM');
  } finally { f.finish(); }
}

export async function largeHeadingOrder() {
  const f = fixture();
  try {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 300; i++) {
      const heading = document.createElement('h2');
      heading.textContent = `heading ${i}`;
      const paragraph = document.createElement('p');
      paragraph.append('prefix ', document.createTextNode('nee'), document.createTextNode('dle'));
      fragment.append(heading, paragraph);
      f.entries.push({target: heading, label: `label ${i}`});
    }
    f.root.append(fragment);
    const first = await f.search.search(f.root, '', 'needle', f.generation);
    ensure(first.length === 50 && first.every((result, i) => result.location === `label ${i}`) &&
      f.publications.at(-1).value.total === 300, 'large heading order');
    f.search.clearMarks();
    const hot = await f.search.search(f.root, '', 'needle', f.generation);
    ensure(hot.every((result, i) => result.location === `label ${i}`), 'large heading hot snapshot');
    f.search.clearMarks();
    // Out-of-order entries must still take the legacy fallback, including
    // headings that have the same text offset (no intervening text nodes).
    const a = document.createElement('i'), b = document.createElement('i');
    f.root.prepend(a, b);
    f.entries.unshift({target: b, label: 'b'}, {target: a, label: 'a'});
    const unordered = await f.search.search(f.root, '', 'needle', f.generation);
    ensure(unordered.length === 50 && unordered[0].location === 'label 0' &&
      f.publications.at(-1).value.total === 300, 'unordered heading fallback');
  } finally { f.finish(); }
}

export async function occurrenceSelection() {
  const f = fixture();
  try {
    for (let i = 1; i <= 64; i++) {
      const row = document.createElement('p');
      row.dataset.page = String(i);
      row.textContent = 'needle';
      f.root.append(row);
    }
    await f.search.search(f.root, '', 'needle', f.generation);
    const {results} = f.publications.at(-1).loader(50);
    const result = results[1], navigation = f.navigation;
    ensure(await result.activate(navigation) &&
      f.root.querySelectorAll('mark.full-search-highlight').length === 1 &&
      f.root.querySelector('[data-page="52"] mark')?.textContent === 'needle', 'paged occurrence selection');
    f.search.clearMarks(); f.nextNavigation();
    ensure(!await result.activate(navigation) && !f.root.querySelector('mark'), 'stale occurrence selection');
    f.root.innerHTML = '<span class="reader-text-padding" hidden>          </span>needle';
    const raw = f.root.textContent;
    for (let i = 0; i < 2; i++) {
      await f.search.search(f.root, '', '          needle', f.generation);
      const {results: matches} = f.publications.at(-1).loader(0);
      const targets = [];
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function () { targets.push(this.textContent); };
      try {
        ensure(matches.length === 1 && await matches[0].activate(f.navigation), 'exact whitespace occurrence');
        ensure(targets.length === 1 && targets[0] === 'needle', 'visible part owns navigation');
      } finally { Element.prototype.scrollIntoView = scrollIntoView; }
      ensure(f.root.querySelector('.reader-text-padding mark')?.textContent === '          ', 'exact whitespace matched');
      f.search.clearMarks();
      ensure(f.root.textContent === raw && !f.root.querySelector('mark'), 'padding survives highlight cleanup');
    }
  } finally { f.finish(); }
}
