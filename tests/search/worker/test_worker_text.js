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
test('intersection agrees with frozen parent across mixed posting lists and threshold boundaries', () => {
  const actualIntersection = load('static/search/worker/domain/intersection.js').intersectCandidateLists;
  const oldIntersection = load('tests/search/worker/intersection-parent.fixture.txt').intersectCandidateLists;
  let seed = 73;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const check = (lists, sorted) => {
    const before = lists.map(list => Array.from(list));
    const expected = oldIntersection(lists, sorted), result = actualIntersection(lists, sorted);
    assert.strictEqual(normal(result), normal(expected));
    assert.strictEqual(result.constructor.name, expected.constructor.name);
    assert.deepStrictEqual(lists.map(list => Array.from(list)), before);
  };
  check([], false);
  for (let n = 0; n < 1200; n++) {
    const lists = Array.from({length: rand(5)}, () => {
      const values = Array.from({length: rand(35)}, () => rand(50));
      return rand(2) ? values : Uint32Array.from(values);
    });
    check(lists, false);
    check(lists.map(list => list.slice().sort((a, b) => a - b)), true);
  }
  for (const size of [0, 1, 510, 511, 512, 513, 1024]) {
    const first = Array.from({length: size}, (_, i) => i * 2);
    const second = Array.from({length: size + 7}, (_, i) => i * 2 + (i % 3 === 0 ? 1 : 0));
    for (const a of [first, Uint32Array.from(first)]) for (const b of [second, Uint32Array.from(second)]) {
      check([a, b], true); check([b, a], true); check([a], true); check([a, b], false);
    }
  }
  check([[9, 7, 9, 1], Uint32Array.from([1, 7, 9])], false);
  check([Uint32Array.from([9, 7, 9, 1]), [1, 7, 9]], false);
});
test('build pins worker imports and includes assets in the cache manifest', () => {
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
    assert(files.indexOf('search/worker/domain/text.js') < files.indexOf('search/worker/domain/intersection.js'));
    assert(files.indexOf('search/worker/domain/intersection.js') < files.indexOf('search/index-worker.js'));
    for (const name of files) {
      const real = ['search/worker/domain/text.js', 'search/worker/domain/intersection.js', 'search/index-worker.js'].includes(name);
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
    const intersection = worker.match(/importScripts\("(\.\/worker\/domain\/intersection\.[a-f0-9]{12}\.js)"\)/)[1];
    const intersectionPath = new URL(intersection, 'https://example.test/search/' + workerUrl).pathname;
    assert(fs.existsSync(path.join(out, intersectionPath.slice('/search/'.length))));
    assert(sw.includes(intersectionPath));
    assert(sw.includes('/search/' + workerUrl));
    assert(sw.includes(resolved));
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
run('worker/text');
