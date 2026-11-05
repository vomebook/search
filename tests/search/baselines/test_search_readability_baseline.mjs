// Pin the original inline Reader eligibility decisions before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const app = fs.readFileSync(path.join(process.cwd(), 'static/app.js'), 'utf8');
const names = ['isReadableRecord', 'isDefaultReadableRecord'];
const fragments = names.map(name => {
  const matches = [...app.matchAll(new RegExp(`^function ${name}\\([^]*?^}`, 'gm'))];
  assert.equal(matches.length, 1, `expected one original ${name} definition`);
  return matches[0][0];
});
// Optional coverage fixtures must contain the exact same two physical fragments.
// Their report does not represent app.js or its callers.
const fragment = process.env.READABILITY_BASELINE_FRAGMENT;
if (fragment) assert.equal(fs.readFileSync(fragment, 'utf8'), fragments.join('\n'));

function fixture(capability = () => ({article: true})) {
  const reader = {capability};
  const context = vm.createContext({VoiceOfMLReader: reader});
  vm.runInContext(fragments.join('\n'), context, {filename: fragment || 'readability-baseline.js'});
  return {context, reader, readable: context.isReadableRecord, original: context.isDefaultReadableRecord};
}

test('converted extension takes precedence while default uses the original extension', () => {
  const calls = [];
  const {readable, original} = fixture(value => { calls.push(value); return {article: value === 'pdf'}; });
  const record = {Extension: 'docx', ReaderExtension: 'pdf', ReaderLink: 'converted'};
  assert.equal(readable(record), true);
  assert.equal(original(record), false);
  assert.deepEqual(calls, ['pdf', 'docx']);
});

test('docx without a converted link is rejected before capability lookup', () => {
  const calls = [];
  const {readable} = fixture(value => { calls.push(value); return {article: true}; });
  for (const link of [undefined, null, false, 0, '']) {
    assert.equal(readable({Extension: 'DOCX', ReaderLink: link}), false);
    assert.equal(readable({ReaderExtension: 'DoCx', Extension: 'pdf', ReaderLink: link}), false);
  }
  assert.deepEqual(calls, []);
  assert.equal(readable({Extension: 'docx', ReaderLink: 'present'}), true);
  assert.deepEqual(calls, ['docx']);
});

test('falsy converted extensions fall back to the original without normalizing the argument', () => {
  const calls = [];
  const {readable} = fixture(value => { calls.push(value); return {article: value}; });
  for (const value of [undefined, null, false, 0, '']) {
    assert.equal(readable({ReaderExtension: value, Extension: 'PDF'}), 'PDF');
  }
  assert.deepEqual(calls, ['PDF', 'PDF', 'PDF', 'PDF', 'PDF']);
});

test('falsy records are forwarded unchanged to capability by both helpers', () => {
  const calls = [];
  const {readable, original} = fixture(value => { calls.push(value); return {article: 'result'}; });
  for (const record of [undefined, null, false, 0, '']) {
    assert.equal(readable(record), 'result');
    assert.equal(original(record), 'result');
  }
  assert.deepEqual(calls, [undefined, undefined, null, null, false, false, 0, 0, '', '']);
});

test('capability article values are returned without coercion', () => {
  const marker = {article: true};
  for (const value of [undefined, null, false, 0, '', 'yes', marker]) {
    const {readable, original} = fixture(() => ({article: value}));
    assert.equal(readable({Extension: 'pdf'}), value);
    assert.equal(original({Extension: 'pdf'}), value);
  }
});

test('the real Reader contract retains native and converted format eligibility', () => {
  const context = vm.createContext({self: {}});
  const contract = fs.readFileSync(path.join(process.cwd(), 'static/reader/core/reader-contract.js'), 'utf8');
  vm.runInContext(contract, context, {filename: 'reader-contract.js'});
  const reader = context.self.VoiceOfMLReader;
  assert.equal(typeof reader.capability, 'function');
  const {readable, original} = fixture(reader.capability);
  for (const extension of ['pdf', 'djvu', 'epub', 'txt', 'html', 'jpg', 'mp3', 'mp4', 'swf']) {
    assert.equal(readable({Extension: extension.toUpperCase()}), true, extension);
    assert.equal(original({Extension: extension}), true, extension);
  }
  for (const extension of ['docx', 'caj', 'kdh', 'ps', 'zip', '']) {
    assert.equal(readable({Extension: extension}), false, extension);
    assert.equal(original({Extension: extension}), false, extension);
  }
  const converted = {Extension: 'docx', ReaderExtension: 'pdf', ReaderLink: '/converted'};
  assert.equal(readable(converted), true);
  assert.equal(original(converted), false);
  assert.equal(readable({Extension: 'pdf', ReaderExtension: 'docx', ReaderLink: 'present'}), false);
});

test('getter and coercion order includes a second extension read', () => {
  const trace = [];
  const extension = {toString() { trace.push('stringify'); return 'pdf'; }};
  const record = {get ReaderExtension() { trace.push('reader-extension'); return extension; },
    get Extension() { trace.push('extension'); return 'txt'; },
    get ReaderLink() { trace.push('reader-link'); return ''; }};
  const {readable, reader} = fixture(value => { trace.push('call'); assert.equal(value, extension); return {article: 7}; });
  const capability = reader.capability;
  Object.defineProperty(reader, 'capability', {get() { trace.push('capability'); return capability; }});
  assert.equal(readable(record), 7);
  assert.deepEqual(trace, ['reader-extension', 'stringify', 'capability', 'reader-extension', 'call']);
});

test('capability rebinding and errors remain observable', () => {
  const {reader, readable, original} = fixture();
  reader.capability = function(value) { assert.equal(this, reader); return {get article() { return value; }}; };
  assert.equal(readable({Extension: 'pdf'}), 'pdf');
  assert.equal(original({Extension: 'txt'}), 'txt');
  const failure = new Error('capability failed');
  reader.capability = () => { throw failure; };
  assert.throws(() => readable({Extension: 'pdf'}), error => error === failure);
  assert.throws(() => original({Extension: 'pdf'}), error => error === failure);
});

test('the original global function bindings remain writable but not deletable', () => {
  const {context} = fixture();
  for (const name of names) {
    context[name] = () => 'replaced';
    assert.equal(vm.runInContext(`${name}()`, context), 'replaced');
    assert.equal(vm.runInContext(`delete globalThis.${name}`, context), false);
  }
});
