const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const resources = require('../../../static/reader-resources.js');
const {test, run} = require('../../support/test_harness');

function load(path) {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, {filename: path});
  return context;
}
const actual = load('static/search/worker/domain/text.js');
const reference = load('tests/search/worker/text-parent.fixture.txt');
const normal = value => JSON.stringify(value);

test('extracted text algorithms agree with the frozen parent across Unicode and coercions', () => {
  const values = ['', 'ABC 123', '手机手机', '㐀䶿一鿿', '😀𠮷', '\ud800', '\udc00', 'İKſßΣς', 'a\n中.文', null, undefined, 0, false, 42, ['A', '中']];
  let seed = 47;
  const alphabet = ['a','Z','0','中','㐀','𠮷','😀','\ud800','\udc00','İ','K','ſ',' ','\n','*','?','.'];
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 1000; i++) values.push(Array.from({length: rand(16)}, () => alphabet[rand(alphabet.length)]).join(''));
  for (const value of values) {
    for (const name of ['tokenizeParts', 'tokenize', 'literalSearch'])
      assert.strictEqual(normal(actual[name](value)), normal(reference[name](value)), `${name}: ${normal(value)}`);
    if (typeof value === 'string') {
      for (const name of ['isChineseToken', 'fuzzyDistanceBudget'])
        assert.strictEqual(actual[name](value), reference[name](value), `${name}: ${normal(value)}`);
    }
  }
  const strings = values.filter(v => typeof v === 'string');
  for (let i = 0; i < 5000; i++) {
    const a = strings[rand(strings.length)], b = strings[rand(strings.length)];
    assert.strictEqual(actual.compareCodepoints(a, b), reference.compareCodepoints(a, b), normal([a, b]));
  }
});
test('build pins the worker import and precaches both assets for offline startup', () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-build-'));
  const out = path.join(temp, 'out');
  function put(name, content) {
    const target = path.join(out, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
  }
  try {
    const files = resources.buildFiles('github');
    assert(files.indexOf('search/worker/domain/text.js') < files.indexOf('search/index-worker.js'));
    for (const name of files) {
      const real = ['search/worker/domain/text.js', 'search/index-worker.js'].includes(name);
      put('static/' + name, real ? fs.readFileSync(path.join(root, 'static', name)) : '');
    }
    put('static/app.js', 'new Worker("static/search/index-worker.js");');
    put('index.html', ''); put('static/reader.html', '');
    put('sw.js', fs.readFileSync('static/sw.js'));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build/build_static_assets.mjs')],
      {cwd: root, env: {...process.env, STATIC_OUTPUT_DIR: out}, encoding: 'utf8'});
    assert.strictEqual(result.status, 0, result.stderr);
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    const app = fs.readFileSync(path.join(out, 'static', fs.readdirSync(path.join(out, 'static')).find(name => /^app\.[a-f0-9]{12}\.js$/.test(name))), 'utf8');
    const workerUrl = app.match(/static\/search\/index-worker\.[a-f0-9]{12}\.js/)[0];
    const worker = fs.readFileSync(path.join(out, workerUrl), 'utf8');
    const imported = worker.match(/importScripts\("(\.\/worker\/domain\/text\.[a-f0-9]{12}\.js)"\)/)[1];
    const resolved = new URL(imported, 'https://example.test/search/' + workerUrl).pathname;
    assert(fs.existsSync(path.join(out, resolved.slice('/search/'.length))));
    assert(sw.includes('/search/' + workerUrl));
    assert(sw.includes(resolved));
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
run('worker/text');
