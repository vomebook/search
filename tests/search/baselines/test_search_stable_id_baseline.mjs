// Expectations were pinned against both original inline ID functions before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const context = vm.createContext({});
const dependency = path.join(root, 'static/search/record-path.js');
vm.runInContext(fs.readFileSync(dependency, 'utf8'), context, {filename: dependency});
const identity = path.join(root, 'static/search/result-identity.js');
vm.runInContext(fs.readFileSync(identity, 'utf8'), context, {filename: identity});
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const match = source.match(/^function getResultStableId\([^]*?^}/m);
assert.ok(match, 'host getResultStableId binding must remain inline');
vm.runInContext(match[0], context);
const id = context.getResultStableId;

test('non-objects are empty while object fallbacks retain exact path spelling', () => {
  for (const value of [undefined, null, false, 0, 1, '', 'abc', Symbol('x'), () => {}]) {
    assert.equal(id(value), '');
  }
  for (const [value, expected] of [
    [{}, '\0'],
    [[], '\0'],
    [{Repo: 'Repo/Case', File: 'hello world', Extension: 'txt', Folder: ['中', 'sub/dir']},
      'Repo/Case\0中/sub/dir/hello world.txt'],
    [{Repo: 'X', File: 'file.pdf', Extension: 'pdf', Folder: []}, 'X\0file.pdf.pdf'],
    [{Repo: 0, File: 0, Extension: '', Folder: null}, '\0'],
    [{Repo: 'X', File: 'a', Extension: '', Folder: ['', 'tail']}, 'X\0/tail/a']
  ]) assert.equal(id(value), expected);
});

test('truthy Id precedes id and both retain original String conversion', () => {
  for (const [value, expected] of [
    [{Id: 'Upper', id: 'lower'}, 'Upper'],
    [{Id: 0, id: 'lower'}, 'lower'],
    [{Id: false, id: 17}, '17'],
    [{Id: Symbol.for('probe')}, 'Symbol(probe)'],
    [{Id: {toString() { return 'object-id'; }}}, 'object-id'],
    [Object.assign(Object.create({Id: 'inherited'}), {id: 'own'}), 'inherited']
  ]) assert.equal(id(value), expected);
});

test('ID and path getter reads retain their original order and short-circuiting', () => {
  const trace = [];
  const record = {
    get Id() { trace.push('Id'); return ''; },
    get id() { trace.push('id'); return 0; },
    get Repo() { trace.push('Repo'); return 'R'; },
    get File() { trace.push('File'); return 'a'; },
    get Extension() { trace.push('Extension'); return 'txt'; },
    get Folder() { trace.push('Folder'); return ['folder']; }
  };
  assert.equal(id(record), 'R\0folder/a.txt');
  assert.deepEqual(trace, ['Id', 'id', 'Repo', 'File', 'Extension', 'Folder', 'Folder']);
  const seen = [];
  assert.equal(id({get Id() { seen.push('Id'); return 'stable'; },
    get Repo() { throw new Error('Repo must not be read'); }}), 'stable');
  assert.deepEqual(seen, ['Id', 'Id']);
});

test('dependency lookup and exceptional values propagate unchanged', () => {
  assert.throws(() => id({get Id() { throw new Error('id getter'); }}), {message: 'id getter'});
  assert.throws(() => id({Repo: Symbol('repo')}), {name: 'TypeError'});
  const original = context.buildRecordRelativePath;
  const record = {Repo: 'R'};
  context.buildRecordRelativePath = value => { assert.equal(value, record); return 'mock/path'; };
  assert.equal(id(record), 'R\0mock/path');
  context.buildRecordRelativePath = () => { throw new Error('path helper'); };
  assert.throws(() => id(record), {message: 'path helper'});
  context.buildRecordRelativePath = original;
});

test('deleted path binding preserves lazy lookup and ReferenceError', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(dependency, 'utf8'), context, {filename: dependency});
  vm.runInContext(fs.readFileSync(identity, 'utf8'), context, {filename: identity});
  vm.runInContext(match[0], context);
  const id = context.getResultStableId;
  const seen = [];
  delete context.buildRecordRelativePath;
  assert.equal(id({get Id() { seen.push('Id'); return 'stable'; }}), 'stable');
  assert.deepEqual(seen, ['Id', 'Id']);
  Object.defineProperty(context, 'buildRecordRelativePath', {configurable: true, get() {
    throw new Error('helper binding must not be read before Repo conversion');
  }});
  assert.throws(() => id({Repo: {[Symbol.toPrimitive](hint) {
    seen.push(`repo:${hint}`); delete context.buildRecordRelativePath; return 'R';
  }}}), {name: 'ReferenceError'});
  assert.deepEqual(seen, ['Id', 'Id', 'repo:string']);
});

test('missing path binding and lookup-time ReferenceError retain lazy ordering', () => {
  // A fresh realm loads the real module and host wrapper, without the path helper.
  const isolated = vm.createContext({});
  vm.runInContext(fs.readFileSync(identity, 'utf8'), isolated, {filename: identity});
  vm.runInContext(match[0], isolated);
  const isolatedId = isolated.getResultStableId;
  assert.equal(isolatedId({Id: 'stable'}), 'stable');
  assert.throws(() => isolatedId({Repo: 'R'}), {name: 'ReferenceError'});

  // A context extension avoids unstable VM global-property invalidation. Install
  // the failing binding during conversion: its exact ReferenceError must escape.
  const ordered = vm.createContext({});
  const trace = [];
  const bindings = {};
  const missing = new ReferenceError('missing path binding');
  Object.defineProperty(bindings, 'buildRecordRelativePath', {configurable: true, get() {
    trace.push('old lookup'); throw new Error('lookup before Repo conversion');
  }});
  vm.compileFunction(fs.readFileSync(identity, 'utf8'), [], {
    parsingContext: ordered, contextExtensions: [bindings], filename: identity
  })();
  vm.runInContext(match[0], ordered);
  const orderedId = ordered.getResultStableId;
  assert.equal(orderedId({Id: 'stable'}), 'stable');
  assert.throws(() => orderedId({Repo: {[Symbol.toPrimitive](hint) {
    trace.push(`repo:${hint}`);
    Object.defineProperty(bindings, 'buildRecordRelativePath', {configurable: true, get() {
      trace.push('new lookup'); throw missing;
    }});
    return 'R';
  }}}), error => error === missing && error instanceof ReferenceError);
  assert.deepEqual(trace, ['repo:string', 'new lookup']);
});

test('path lookup remains lazy through early returns and Repo conversion', () => {
  const prior = Object.getOwnPropertyDescriptor(context, 'buildRecordRelativePath');
  const trace = [];
  try {
    const sentinel = new Error('path binding lookup');
    const seen = [];
    Object.defineProperty(context, 'buildRecordRelativePath', {configurable: true, get() {
      seen.push('lookup'); return () => { throw sentinel; };
    }});
    assert.equal(id({Id: 'stable'}), 'stable');
    assert.deepEqual(seen, []);
    assert.throws(() => id({Repo: {[Symbol.toPrimitive](hint) {
      seen.push(`repo:${hint}`); return 'R';
    }}}), error => error === sentinel);
    assert.deepEqual(seen, ['repo:string', 'lookup']);
    Object.defineProperty(context, 'buildRecordRelativePath', {configurable: true, get() {
      trace.push('early lookup'); throw new Error('must not lookup');
    }});
    assert.equal(id({Id: 'stable'}), 'stable');
    assert.deepEqual(trace, []);
    const record = {Repo: {[Symbol.toPrimitive](hint) {
      trace.push(`repo:${hint}`);
      Object.defineProperty(context, 'buildRecordRelativePath', {configurable: true, value: value => {
        trace.push('rebound path'); assert.equal(value, record); return 'new/path';
      }});
      return 'R';
    }}};
    assert.equal(id(record), 'R\0new/path');
    assert.deepEqual(trace, ['repo:string', 'rebound path']);
  } finally {
    Object.defineProperty(context, 'buildRecordRelativePath', prior);
  }
});

test('host binding forwards the original result and uncoerced return value', () => {
  const api = context.VoiceOfMLSearchIdentity;
  const original = api.getResultStableId;
  const input = {probe: true};
  const sentinel = {value: 'sentinel'};
  try {
    api.getResultStableId = (...args) => {
      assert.deepEqual(args, [input]);
      return sentinel;
    };
    assert.equal(context.getResultStableId(input), sentinel);
  } finally {
    api.getResultStableId = original;
  }
  const host = context.getResultStableId;
  context.getResultStableId = () => 'replaced';
  assert.equal(vm.runInContext('getResultStableId()', context), 'replaced');
  context.getResultStableId = host;
  assert.equal(vm.runInContext('delete globalThis.getResultStableId', context), false);
});
