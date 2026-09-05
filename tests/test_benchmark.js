const fs = require("fs");
const zlib = require("zlib");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { test, run } = require("./test_harness");

var resultsPath = __dirname + "/benchmark-results.json";

function gitSha() {
  try {
    return require("child_process")
      .execSync("git log -1 --format=%H", { timeout: 5000 })
      .toString()
      .trim();
  } catch (e) {
    return "";
  }
}

var gzData = fs.readFileSync("data/search_data.json.gz");
var rawData = zlib.gunzipSync(gzData);
var payload = JSON.parse(rawData);

var source = fs.readFileSync("static/index-worker.js", "utf8");

async function makeWorker() {
  var listeners = {};
  var messages = [];
  var context = {
    console: console,
    self: {
      addEventListener: function (type, listener) { listeners[type] = listener; },
      postMessage: function (msg) { messages.push(msg); },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "static/index-worker.js" });

  async function send(data) {
    var before = messages.length;
    await listeners.message({ data: data });
    return messages.slice(before);
  }

  await send({ protocol: 1, type: "replace-corpus", id: "load", payload: { data: payload } });

  return {
    search: async function (params) {
      var sent = await send({ protocol: 1, type: "local-search", id: "bench", payload: params || {} });
      return sent[0].result;
    },
  };
}

var collected = [];

async function bench(label, fn, iterations) {
  if (iterations === undefined) iterations = 10;
  var times = [];
  for (var i = 0; i < iterations; i++) {
    var start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort(function (a, b) { return a - b; });
  var median = times[Math.floor(times.length / 2)];
  var min = times[0];
  var max = times[times.length - 1];
  function pad(v, n) {
    var s = v.toFixed(3);
    while (s.length < n) s = " " + s;
    return s;
  }
  console.log("  " + label + " ".repeat(Math.max(1, 46 - label.length))
    + "median=" + pad(median, 8) + "ms  min=" + pad(min, 8) + "ms  max=" + pad(max, 8) + "ms  (n=" + iterations + ")");
  collected.push({
    label: label.trim(),
    iterations: iterations,
    median_ms: +median.toFixed(3),
    min_ms: +min.toFixed(3),
    max_ms: +max.toFixed(3),
  });
}

function saveResults() {
  var existing = { results: [] };
  try { existing = JSON.parse(fs.readFileSync(resultsPath, "utf8")); } catch (e) {}
  if (!existing.results) existing.results = [];
  existing.results.push({
    timestamp: new Date().toISOString(),
    project: "github-Search",
    git_sha: gitSha(),
    queries: collected,
  });
  fs.writeFileSync(resultsPath, JSON.stringify(existing, null, 2) + "\n");
}

test("search benchmarks", async function () {
  var w = await makeWorker();

  await bench('"手机" normal', function () { return w.search({ q: "手机" }); });
  await bench('"手机" exact', function () { return w.search({ q: "手机", exact: true }); });
  await bench('"文化革命" exact', function () { return w.search({ q: "文化革命", exact: true }); });
  await bench('"文化 革命" normal', function () { return w.search({ q: "文化 革命" }); });
  await bench('"手。机" exact', function () { return w.search({ q: "手。机", exact: true }); });
  await bench('"手*机" exact', function () { return w.search({ q: "手*机", exact: true }); });
  await bench('"手?机" exact', function () { return w.search({ q: "手?机", exact: true }); });
  await bench('"文" exact', function () { return w.search({ q: "文", exact: true }); });
  await bench('"ABC" normal', function () { return w.search({ q: "ABC" }); });
  await bench('"手机" searchFolders=false', function () { return w.search({ q: "手机", searchFolders: false }); });
  await bench('root direct files mixed filter', function () {
    return w.search({ page: 1, pageSize: 100, folderMatchMode: "mixed", folderSelfs: [""] });
  });
  await bench('sort by name', function () { return w.search({ page: 1, pageSize: 100, sort: "name" }); });
  await bench('sort by size', function () { return w.search({ page: 1, pageSize: 100, sort: "size" }); });

  saveResults();
});

run("benchmark/search");
