// Synthetic contracts for the existing search-host navigation module. These
// cover URL and session behavior, not iframe, speech, or whole-file coverage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const filename = path.join(process.cwd(), 'static/search/reader-navigation.js');
const source = fs.readFileSync(filename, 'utf8');
const origin = 'https://search.example';
const readerPath = '/search/static/reader.html';

function fixture() {
  const data = new Map();
  const calls = [];
  const storage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
  const root = {addEventListener() {}};
  const document = {readyState: 'loading', addEventListener() {}};
  const crypto = {randomUUID: () => 'fixed-token'};
  const history = {
    pushState(...args) { calls.push(['push', ...args]); },
    replaceState(...args) { calls.push(['replace', ...args]); }
  };
  // Supply location and storage through the global as in browsers. Unrelated
  // DOM and asynchronous Reader services remain intentionally unstubbed.
  const context = vm.createContext({self: root, document, sessionStorage: storage,
    localStorage: storage, location: new URL(origin + '/search/#/'), URL, URLSearchParams,
    crypto, history, console});
  vm.runInContext(source, context, {filename});
  return {nav: root.VoiceOfMLReaderNavigation.createNavigation(readerPath), data, storage, crypto, calls};
}

const json = value => JSON.parse(JSON.stringify(value));

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
