// Synthetic contracts for the existing search-host navigation module. These
// cover URL/session rules and DOM ownership with a synthetic shell. Real browser
// traversal, layout, speech and native navigation remain browser-test contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const filename = path.join(process.cwd(), 'static/search/reader-host/application/navigation.js');
const source = fs.readFileSync(filename, 'utf8');
const origin = 'https://search.example';
const readerPath = '/search/static/reader.html';

function fixture(readerDestination = readerPath, document = {readyState: 'loading', addEventListener() {}}) {
  const data = new Map();
  const calls = [];
  const storage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
  const root = new EventTarget();
  const crypto = {randomUUID: () => 'fixed-token'};
  const history = {
    pushState(...args) { calls.push(['push', ...args]); },
    replaceState(...args) { calls.push(['replace', ...args]); }
  };
  // Supply location and storage through the global as in browsers. Unrelated
  // DOM and asynchronous Reader services remain intentionally unstubbed.
  const context = vm.createContext({self: root, window: root, document, sessionStorage: storage,
    localStorage: storage, location: new URL(origin + '/search/#/'), URL, URLSearchParams,
    crypto, history, console, HTMLElement: ShellElement, Event});
  vm.runInContext(source, context, {filename});
  return {nav: root.VoiceOfMLReaderNavigation.createNavigation(readerDestination), data, storage, crypto, calls, context};
}

const json = value => JSON.parse(JSON.stringify(value));

// Deliberately small DOM double: events run synchronously so dispose reentry is
// observable. It does not simulate layout, iframe loading or browser history.
class ShellElement extends EventTarget {
  constructor(document, tagName) {
    super();
    this.document = document;
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.styles = new Map();
    this.style = {
      setProperty: (key, value) => this.styles.set(key, value),
      removeProperty: key => this.styles.delete(key)
    };
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value)
    };
    if (tagName === 'iframe') {
      this.contentWindow = new EventTarget();
      this.contentWindow.postMessage = () => {};
      this.contentDocument = {title: 'VoiceOfML Reader', URL: 'about:blank'};
    }
  }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  focus() { this.document.activeElement = this; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
}

function shellFixture(destination = readerPath) {
  const document = {readyState: 'loading', title: 'Search', addEventListener() {}};
  document.createElement = tag => new ShellElement(document, tag);
  document.body = document.createElement('body');
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  const state = fixture(destination, document);
  return {...state, document, input,
    shell: () => document.body.children.find(child => child.className === 'reader-overlay-opening')};
}

test('deferred titles survive failed history and release only for the requested URL', () => {
  const {nav, document, context} = shellFixture();
  const url = new URL(origin + readerPath + '?id=book&title=Filename&nav=new');
  const frame = nav.mount(url, true);
  assert.equal(document.title, 'Search');
  assert.equal(frame.title, 'Filename');
  const push = context.history.pushState;
  context.history.pushState = () => { throw new Error('push failed'); };
  assert.throws(() => nav.remember(url, {}), /push failed/);
  frame.contentDocument = {URL: url.href, title: 'Loaded title'};
  frame.dispatchEvent(new Event('load'));
  assert.equal(frame.title, 'Loaded title');
  assert.equal(document.title, 'Search');
  const message = new Event('message');
  Object.assign(message, {origin, source: frame.contentWindow, data: {type: 'voice-reader-title', title: 'Resolved title'}});
  context.window.dispatchEvent(message);
  assert.equal(frame.title, 'Resolved title');
  assert.equal(document.title, 'Search', 'messages cannot bypass a failed history write');
  context.history.pushState = push;
  nav.remember(new URL(origin + readerPath + '?id=other'), {});
  assert.equal(document.title, 'Search', 'an unrelated history write cannot release the pending title');
  nav.remember(url, {});
  assert.equal(document.title, 'Resolved title');
  nav.dismiss();
  document.title = 'Browser traversal title';
  nav.unmount(false);
  assert.equal(document.title, 'Search', 'dismiss retains the original title for post-traversal unmount');
});

test('history reentry cannot release a newer mount of the same URL', () => {
  const {nav, document, context} = shellFixture();
  const url = new URL(origin + readerPath + '?id=book&title=Book');
  nav.mount(url, true);
  const push = context.history.pushState;
  context.history.pushState = (...args) => {
    push(...args);
    nav.mount(url, true);
  };
  nav.remember(url, {});
  assert.equal(document.title, 'Search');
  context.history.pushState = push;
  nav.remember(url, {});
  assert.equal(document.title, 'Book');
  nav.unmount(false);
});

test('direct mount yields to disposal reentry and keeps the newer title', () => {
  const {nav, document} = shellFixture();
  const first = nav.mount(new URL(origin + readerPath + '?id=first&title=First'));
  let newest;
  first.contentWindow.addEventListener('voice-reader-dispose', () => {
    newest = nav.mount(new URL(origin + readerPath + '?id=newest&title=Newest'));
  });
  const result = nav.mount(new URL(origin + readerPath + '?id=stale&title=Stale'), true);
  assert.equal(result, newest);
  assert.equal(document.title, 'Newest');
  assert.equal(document.body.children.filter(child => child.tagName === 'iframe').length, 1);
  nav.unmount(false);
  assert.equal(document.title, 'Search');
});

test('close during disposal cancels the in-flight mount even after frame ownership is released', () => {
  const {nav, document, input} = shellFixture();
  const first = nav.mount(new URL(origin + readerPath + '?id=first&title=First'));
  first.contentWindow.addEventListener('voice-reader-dispose', () => {
    assert.equal(nav.unmount(false), null);
  });
  const result = nav.mount(new URL(origin + readerPath + '?id=cancelled&title=Cancelled'), true);
  assert.equal(result, null);
  assert.equal(document.body.children.filter(child => child.tagName === 'iframe').length, 0);
  assert.equal(document.body.classList.contains('reader-overlay-open'), false);
  assert.equal(input.hasAttribute('inert'), false);
  assert.equal(input.hasAttribute('aria-hidden'), false);
  assert.equal(document.title, 'Search');
  assert.equal(nav.returnFocus, null);
  assert.equal(nav.backgroundReader, null);
});

test('replacement and history restoration publish titles without a deferred push', () => {
  const {nav, document} = shellFixture();
  nav.mount(new URL(origin + readerPath + '?id=first&title=First'));
  assert.equal(document.title, 'First');
  nav.replace(readerPath + '?id=second&title=Second', {});
  assert.equal(document.title, 'Second');
  nav.replace(readerPath + '?id=third&title=Third', {});
  assert.equal(document.title, 'Third');
  nav.unmount(false);
  assert.equal(document.title, 'Search');
});

test('replacement revision preserves a Reader opened synchronously during disposal', () => {
  const {nav, document, input} = shellFixture();
  const first = nav.mount(new URL(origin + readerPath + '?id=first&nav=token&return=%2Fsearch%2F'));
  assert.equal(nav.returnFocus, input);
  assert.equal(nav.backgroundReader, null);
  let newest;
  first.contentWindow.addEventListener('voice-reader-dispose', () => {
    newest = nav.mount(new URL(origin + readerPath + '?id=newest'));
  });
  const result = nav.replace(readerPath + '?id=stale', {top: 50});
  assert.equal(result, newest, 'outer replacement must yield to the reentrant mount');
  assert.equal(first.parent, null);
  assert.equal(first.src, 'about:blank');
  assert.equal(document.body.children.filter(child => child.tagName === 'iframe').length, 1);
  assert.equal(nav.accepts({origin, source: newest.contentWindow}), true);
  assert.equal(nav.accepts({origin: 'https://other.example', source: newest.contentWindow}), false);
  assert.equal(nav.accepts({origin, source: {frameElement: newest}}), true);
  assert.equal(nav.accepts({origin, source: null}), false);
  assert.equal(nav.accepts({origin, source: {get frameElement() { throw new Error('cross-origin'); }}}), false);
  assert.equal(nav.accepts({origin, source: first.contentWindow}), false);
  nav.unmount(false);
  assert.equal(nav.returnFocus, null);
  assert.equal(nav.unmount(), null);
});

test('ordinary replacement carries handoff and focus while releasing background ownership', () => {
  const {nav, document, input, data} = shellFixture();
  const hidden = document.createElement('aside');
  hidden.setAttribute('inert', '');
  hidden.setAttribute('aria-hidden', 'false');
  document.body.append(hidden);
  const first = nav.mount(new URL(origin + readerPath + '?id=first&nav=token&return=%2Fsearch%2F'));
  const next = nav.replace(readerPath + '?id=next', {top: 50});
  assert.notEqual(next, first);
  assert.equal(new URL(next.src).searchParams.get('nav'), 'token');
  assert.equal(new URL(next.src).searchParams.get('return'), '/search/');
  assert.equal(JSON.parse(data.get('reader-navigation-current')).readerUrl, next.src);
  assert.equal(nav.returnFocus, input);
  assert.equal(nav.unmount(false), input);
  assert.equal(input.hasAttribute('inert'), false);
  assert.equal(input.hasAttribute('aria-hidden'), false);
  assert.equal(hidden.hasAttribute('inert'), true);
  assert.equal(hidden.getAttribute('aria-hidden'), 'false');
});

test('close recovery validates both search routes without changing history or private handoff', () => {
  for (const destination of [readerPath, '/static/reader.html']) {
    const {nav, document, input, shell, data, calls} = shellFixture(destination);
    const search = destination === readerPath ? '/search/' : '/';
    nav.showCloseRecovery(search);
    assert.equal(shell(), undefined, 'no recovery without an active Reader');
    const url = nav.prepare(destination + '?id=book&title=Book', origin + search);
    nav.mount(url);
    nav.remember(url, {top: 50});
    const saved = data.get('reader-navigation-current');
    nav.showCloseRecovery(search);
    assert.equal(shell().children.some(child => child.tagName === 'a'), false, 'no recovery before close');
    nav.dismiss();
    assert.equal(document.title, 'Search');
    const valid = destination === readerPath ? '/search/#/Repo?q=book' : '/Repo?q=book';
    for (const [raw, expected] of [
      [valid, valid], ['https://other.example/', search], ['javascript:alert(1)', search],
      ['/static/reader.html', search], ['/elsewhere/page', search], ['http://[', search],
      ['https://user:password@search.example' + search, search]
    ]) {
      nav.showCloseRecovery(raw);
      const link = shell().children.find(child => child.tagName === 'a');
      assert.equal(link.href, origin + expected);
      assert.equal(shell().parent, document.body);
      assert.equal(shell().hasAttribute('inert'), false);
      assert.equal(shell().styles.has('opacity'), false);
      assert.equal(shell().styles.has('pointer-events'), false);
      assert.equal(document.activeElement, link);
      assert.equal(input.hasAttribute('inert'), true);
    }
    assert.equal(calls.length, 1, 'recovery must not push or replace history');
    assert.equal(data.get('reader-navigation-current'), saved);
    assert.equal(data.has('reader-navigation-restore'), false, 'handoff waits for explicit activation');
    assert.equal(nav.returnFocus, input);
    nav.unmount(false);
    assert.equal(shell(), undefined);
  }
});

test('recovery survives late shell load and records handoff only on native link activation', () => {
  const {nav, document, shell, data, calls, storage} = shellFixture();
  const target = origin + '/search/#/?q=book';
  const url = nav.prepare(readerPath + '?id=book', target);
  const frame = nav.mount(url);
  frame.contentDocument.URL = frame.src;
  frame.dispatchEvent(new Event('load'));
  assert.equal(shell(), undefined);
  nav.dismiss();
  nav.showCloseRecovery(target);
  const recovery = shell();
  const link = recovery.children.find(child => child.tagName === 'a');
  frame.dispatchEvent(new Event('load'));
  assert.equal(shell(), recovery);
  assert.equal(document.activeElement, link);
  const click = new Event('click', {cancelable: true});
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false, 'native href remains the navigation action');
  assert.deepEqual(JSON.parse(data.get('reader-navigation-restore')), {readerUrl: url.href, returnUrl: target});
  storage.setItem = () => { throw new Error('quota'); };
  assert.doesNotThrow(() => link.dispatchEvent(new Event('click')));
  assert.deepEqual(calls, []);
  assert.equal(nav.unmount(false).tagName, 'input');
  nav.showCloseRecovery(target);
  assert.equal(shell(), undefined);
});

test('parse accepts only the same-origin reader pathname', () => {
  const {nav} = fixture();
  assert.equal(nav.parse(readerPath + '?title=a%20b#part').href,
    origin + readerPath + '?title=a%20b#part');
  for (const raw of ['https://other.example' + readerPath, '/reader.html', readerPath + '/extra'])
    assert.throws(() => nav.parse(raw), {message: 'Invalid reader destination'});
  assert.throws(() => nav.parse('http://['), {name: 'TypeError'});
});

test('ordinary query merging replaces only selected keys and keeps repeated values', () => {
  const {nav} = fixture();
  const original = new URL(origin + '/search/?keep=1&q=old&q=older&ext=pdf#section');
  const source = new URLSearchParams('q=first&q=second&ext=txt&unused=x');
  const result = nav.mergeSearchParams(original, source, {keys: ['q', 'ext', 'missing']});
  assert.equal(result.href, origin + '/search/?keep=1&q=first&q=second&ext=txt#section');
  assert.equal(original.href, origin + '/search/?keep=1&q=old&q=older&ext=pdf#section');
  assert.equal(source.toString(), 'q=first&q=second&ext=txt&unused=x');
});

test('hash query merging preserves route and unrelated query components', () => {
  const {nav} = fixture();
  const result = nav.mergeSearchParams('/search/?outer=1#/Repo?path=dir%2Fone&q=old&folder=x',
    'q=hello+world&q=two&folder=', {hashRoute: true, keys: ['q', 'folder', 'absent']});
  assert.equal(result.pathname, '/search/');
  assert.equal(result.search, '?outer=1');
  assert.equal(result.hash, '#/Repo?path=dir%2Fone&q=hello+world&q=two&folder=');
  assert.equal(nav.mergeSearchParams('/search/#/Repo?q=x', '',
    {hashRoute: true, keys: ['q']}).hash, '#/Repo');
});

test('merge without selected keys preserves existing query and returns a new URL', () => {
  const {nav} = fixture();
  const target = new URL(origin + '/search/?a=1&a=2#/Repo?b=3');
  const result = nav.mergeSearchParams(target, 'a=other');
  assert.notEqual(result, target);
  assert.equal(result.href, target.href);
});

test('prepare records the return location and removes the previous handoff', () => {
  const {nav, data} = fixture();
  const old = origin + readerPath + '?nav=old-token&ext=txt';
  data.set('reader-return:old-token', origin + '/old');
  data.set('reader-navigation-current', JSON.stringify({readerUrl: old}));
  const url = nav.prepare(readerPath + '?url=book&nav=stale', '/search/#/Repo?path=a');
  assert.equal(url.searchParams.get('return'), '/search/#/Repo?path=a');
  assert.equal(url.searchParams.get('nav'), 'fixed-token');
  assert.equal(data.get('reader-return:fixed-token'), origin + '/search/#/Repo?path=a');
  assert.equal(data.has('reader-return:old-token'), false);
  assert.equal(data.has('reader-navigation-current'), false);
});

test('prepare tolerates unavailable storage or token generation without skipping destination validation', () => {
  for (const broken of ['storage', 'crypto']) {
    const {nav, storage, crypto} = fixture();
    if (broken === 'storage') storage.setItem = () => { throw new Error('storage unavailable'); };
    else crypto.randomUUID = () => { throw new Error('crypto unavailable'); };
    const url = nav.prepare(readerPath + '?ext=txt', '/search/#/');
    assert.equal(url.searchParams.get('return'), '/search/#/');
    assert.equal(url.searchParams.has('nav'), false);
    assert.throws(() => nav.prepare('https://other.example' + readerPath, '/search/'),
      {message: 'Invalid reader destination'});
  }
});

test('remember stores a private reader URL but exposes a sanitized history URL', () => {
  const {nav, data, calls} = fixture();
  const url = new URL(origin + readerPath + '?url=book&return=%2Fsearch%2F&nav=secret&ext=txt');
  const scroll = {top: 125, key: 'entry'};
  nav.remember(url, scroll);
  nav.remember(url, scroll, true);
  const share = origin + readerPath + '?url=book&ext=txt';
  assert.deepEqual(json(nav.saved()), {shareUrl: share, readerUrl: url.href, returnScroll: scroll});
  assert.equal(data.has('reader-navigation-current'), true);
  assert.deepEqual(json(calls), [
    ['push', {voiceReaderOverlay: true, readerUrl: url.href}, '', share],
    ['replace', {voiceReaderOverlay: true, readerUrl: url.href}, '', share]
  ]);
  assert.equal(url.searchParams.get('nav'), 'secret');
});

test('remember still updates history when storage fails and saved rejects malformed JSON', () => {
  const {nav, data, storage, calls} = fixture();
  data.set('reader-navigation-current', '{not-json');
  assert.equal(nav.saved(), null);
  // Valid JSON is returned verbatim; it is not guaranteed to be our record.
  for (const value of [true, 17, 'text', ['item'], {readerUrl: 23}]) {
    data.set('reader-navigation-current', JSON.stringify(value));
    assert.deepEqual(json(nav.saved()), value);
  }
  storage.setItem = () => { throw new Error('quota'); };
  const url = new URL(origin + readerPath + '?nav=secret');
  nav.remember(url, {top: 2});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'push');
  assert.equal(calls[0][3], origin + readerPath);
});

test('clear removes only the matching session and selected return token', () => {
  const {nav, data} = fixture();
  const current = new URL(origin + readerPath + '?nav=current');
  const other = new URL(origin + readerPath + '?nav=other');
  data.set('reader-navigation-current', JSON.stringify({readerUrl: current.href}));
  data.set('reader-return:current', 'current');
  data.set('reader-return:other', 'other');
  nav.clear(other);
  assert.equal(data.has('reader-return:other'), false);
  assert.equal(data.has('reader-navigation-current'), true);
  nav.clear(current);
  assert.equal(data.has('reader-return:current'), false);
  assert.equal(data.has('reader-navigation-current'), false);
});

test('messages are rejected when no reader iframe is active', () => {
  const {nav} = fixture();
  assert.equal(nav.accepts({origin, source: {}}), false);
  assert.equal(nav.accepts({origin: 'https://other.example', source: null}), false);
});

test('pathname and search parameter prototype overrides retain their original effects', () => {
  const {nav, context} = fixture();
  const path = Object.getOwnPropertyDescriptor(URL.prototype, 'pathname');
  const get = URLSearchParams.prototype.get;
  try {
    Object.defineProperty(URL.prototype, 'pathname', {...path, get() { return undefined; }});
    assert.throws(() => nav.parse(readerPath), {message: 'Invalid reader destination'});
    Object.defineProperty(URL.prototype, 'pathname', path);
    const result = nav.mergeSearchParams('/search/#/Repo?path=first', 'q=ok', {hashRoute:true, keys:['q']});
    assert.equal(result.hash, '#/Repo?path=first&q=ok');
    URLSearchParams.prototype.get = function() { return undefined; };
    assert.equal(nav.prepare(readerPath, '/search/').searchParams.get('nav'), undefined);
    vm.runInContext('String.prototype.split = function() { return []; }', context);
    assert.match(nav.mergeSearchParams('/search/#/Repo', '', {hashRoute:true}).hash, /^#undefined/);
  } finally {
    Object.defineProperty(URL.prototype, 'pathname', path);
    URLSearchParams.prototype.get = get;
  }
});
