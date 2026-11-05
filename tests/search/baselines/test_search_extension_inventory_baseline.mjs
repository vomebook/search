// Expectations were pinned against the original inline declarations before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({});
const filename = path.join(process.cwd(), 'static/search/file-types.js');
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename});
const host = fs.readFileSync(path.join(process.cwd(), 'static/app.js'), 'utf8');
for (const pattern of [/^const ORDERED_EXTENSIONS = [^\n]+/m, /^const FILE_ICON_MAP = [^\n]+/m,
  /^function getFileIconType\([^]*?^}/m]) {
  const match = host.match(pattern);
  assert.ok(match, `host declaration missing: ${pattern}`);
  vm.runInContext(match[0], context);
}
const evaluate = code => vm.runInContext(code, context);
const local = value => JSON.parse(JSON.stringify(value));

const extensions = ['pdf', 'djvu', 'txt', 'md', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'chm',
  'doc', 'docx', 'odt', 'rtf', 'wps', 'caj', 'kdh', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'pps',
  'odp', 'ps', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'psd', 'html', 'htm', 'mht',
  'mhtml', 'markdown', 'vcf', 'ini', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'mpga', 'wma', 'ape', 'amr',
  'mp4', 'mov', 'flv', 'f4v', 'rm', 'rmvb', 'mkv', 'avi', 'mpg', 'mpeg', 'mts', 'ts', 'wmv', 'asx', 'swf'];
const expectedIcons = {
  pdf: 'pdf', txt: 'text', mht: 'text', epub: 'book', mobi: 'book', azw: 'book', azw3: 'book',
  fb2: 'book', fbz: 'book', djvu: 'book', chm: 'book', caj: 'book', doc: 'doc', docx: 'doc',
  odt: 'doc', rtf: 'doc', ppt: 'ppt', pptx: 'ppt', pps: 'ppt', odp: 'ppt', xls: 'xls',
  xlsx: 'xls', ods: 'xls', csv: 'csv', jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  tif: 'image', tiff: 'image', bmp: 'image', webp: 'image', svg: 'image', html: 'code', htm: 'code',
  aspx: 'code', css: 'code', js: 'code', xml: 'code', json: 'code', ini: 'code', bat: 'code',
  mp4: 'video', mov: 'video', flv: 'video', swf: 'video', asx: 'video', rm: 'video', rmvb: 'video',
  wmv: 'video', mpg: 'video', mpeg: 'video', mkv: 'video', avi: 'video', mts: 'video', ts: 'video',
  f4v: 'video', mp3: 'audio', wav: 'audio', wma: 'audio', ape: 'audio', m4a: 'audio', aac: 'audio',
  amr: 'audio', flac: 'audio', mpga: 'audio', iso: 'archive', msi: 'archive', dat: 'archive',
  exe: 'file', db: 'database', itf: 'database', url: 'text', vcf: 'text', hhc: 'text',
  md: 'markdown', markdown: 'markdown',
};

test('all 67 ordered filter extensions are pinned, including case-sensitive lookup', () => {
  assert.equal(extensions.length, 67);
  assert.deepEqual(local(evaluate('ORDERED_EXTENSIONS')), extensions);
  assert.equal(evaluate(`ORDERED_EXTENSIONS.indexOf('pdf')`), 0);
  assert.equal(evaluate(`ORDERED_EXTENSIONS.indexOf('PDF')`), -1);
  assert.equal(evaluate(`ORDERED_EXTENSIONS.indexOf('new-format')`), -1);
});

test('all 77 icon mappings and their case-insensitive lookup are pinned', () => {
  assert.equal(Object.keys(expectedIcons).length, 77);
  assert.deepEqual(local(evaluate('FILE_ICON_MAP')), expectedIcons);
  for (const [extension, icon] of Object.entries(expectedIcons)) {
    context.input = extension;
    assert.equal(evaluate('getFileIconType(input)'), icon, extension);
    context.input = extension.toUpperCase();
    assert.equal(evaluate('getFileIconType(input)'), icon, extension.toUpperCase());
  }
});

test('fallback, inherited keys, errors and lowercase invocation match the original', () => {
  for (const value of [undefined, null, false, 0, '', 'unknown']) {
    context.input = value;
    assert.equal(evaluate('getFileIconType(input)'), 'file');
  }
  assert.equal(evaluate(`typeof getFileIconType('__proto__')`), 'object');
  assert.equal(evaluate(`typeof getFileIconType('constructor')`), 'function');
  for (const value of [true, 1, {}, Symbol('x')]) {
    context.input = value;
    assert.throws(() => evaluate('getFileIconType(input)'), {name: 'TypeError'});
  }
  assert.deepEqual(local(evaluate(`(() => {
    let calls = 0;
    const input = {toLowerCase() { calls++; return 'pdf'; }};
    return {value:getFileIconType(input), calls};
  })()`)), {value: 'pdf', calls: 1});
  assert.throws(() => evaluate(`getFileIconType({toLowerCase(){throw new Error('lowercase');}})`),
    {message: 'lowercase'});
});

test('original lexical inventories cannot be reassigned or shadowed through global properties', () => {
  assert.equal(evaluate("Object.hasOwn(globalThis, 'ORDERED_EXTENSIONS')"), false);
  assert.equal(evaluate("Object.hasOwn(globalThis, 'FILE_ICON_MAP')"), false);
  assert.throws(() => evaluate('ORDERED_EXTENSIONS = []'), {name: 'TypeError'});
  assert.throws(() => evaluate('FILE_ICON_MAP = {}'), {name: 'TypeError'});
  assert.throws(() => evaluate('const ORDERED_EXTENSIONS = []'), {name: 'SyntaxError'});
  assert.throws(() => evaluate('const FILE_ICON_MAP = {}'), {name: 'SyntaxError'});
});

test('const bindings retain their original mutable array and map contents', () => {
  evaluate("ORDERED_EXTENSIONS.push('probe-extension'); FILE_ICON_MAP['probe-extension'] = 'audio'");
  assert.equal(evaluate("ORDERED_EXTENSIONS.indexOf('probe-extension')"), 67);
  assert.equal(evaluate("getFileIconType('PROBE-EXTENSION')"), 'audio');
  evaluate("ORDERED_EXTENSIONS.pop(); delete FILE_ICON_MAP['probe-extension']");
});

test('inventory data is isolated between script evaluations', () => {
  const other = vm.createContext({});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), other, {filename});
  evaluate("ORDERED_EXTENSIONS.push('temporary'); FILE_ICON_MAP.temporary = 'audio'");
  assert.equal(vm.runInContext('VoiceOfMLSearchFileTypes.orderedExtensions.length', other), 67);
  assert.equal(vm.runInContext("Object.hasOwn(VoiceOfMLSearchFileTypes.fileIconMap, 'temporary')", other), false);
  evaluate("ORDERED_EXTENSIONS.pop(); delete FILE_ICON_MAP.temporary");
});
