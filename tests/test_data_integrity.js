const fs = require("fs");
const path = require("path");
const assert = require("assert");
const zlib = require("zlib");
const { test, run } = require("./test_harness");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function compressed(file) {
  return fs.readFileSync(file);
}

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(compressed(file)).toString("utf8"));
}

function manifestFiles(directory) {
  return fs.readdirSync(directory).reduce((files, name) => {
    if (name === "manifest.json") return files;
    if (name === "repos") return files.concat(fs.readdirSync(path.join(directory, name)).map((file) => `repos/${file}`));
    return files.concat(name);
  }, []).sort();
}

function validateManifest(directory) {
  const manifest = readJson(path.join(directory, "manifest.json"));
  assert.strictEqual(manifest.version, 2);
  assert.ok(Array.isArray(manifest.urls) && manifest.urls.length > 1);
  assert.strictEqual(new Set(manifest.urls).size, manifest.urls.length, `${directory}: duplicate URLs`);
  const prefix = `/search/${directory}/`;
  const actual = manifest.urls.map((url) => {
    assert.ok(url.startsWith(prefix), `${url}: must stay under ${prefix}`);
    return url.slice(prefix.length);
  }).sort();
  assert.deepStrictEqual(actual, manifestFiles(directory));
  for (const url of manifest.urls) assert.ok(fs.statSync(url.slice("/search/".length)).isFile(), `${url}: missing file`);
}

const gzipFiles = ["data/search_data.json.gz"];
const searchData = readGzipJson(gzipFiles[0]);
const sidebar = readJson("data/sidebar/global.json");
const initial = readJson("data/initial/global.json");

test("all generated gzip files have signatures and parse as JSON", () => {
  for (const file of gzipFiles) {
    const bytes = compressed(file);
    assert.strictEqual(bytes[0], 0x1f, `${file}: gzip magic byte 1`);
    assert.strictEqual(bytes[1], 0x8b, `${file}: gzip magic byte 2`);
    assert.ok(readGzipJson(file) && typeof readGzipJson(file) === "object");
  }
});
test("search payload uses compact version 2 tables", () => {
  assert.strictEqual(searchData.v, 2);
  assert.ok(Array.isArray(searchData.rp) && searchData.rp.length > 0);
  assert.ok(Array.isArray(searchData.fd) && searchData.fd.length > 0);
  assert.ok(Array.isArray(searchData.rc) && searchData.rc.length > 0);
  assert.strictEqual(new Set(searchData.rp).size, searchData.rp.length);
});
test("compact folder table contains string path segments", () => {
  for (const folder of searchData.fd) assert.ok(Array.isArray(folder) && folder.every((part) => typeof part === "string"));
});
test("every compact record has valid table references and field types", () => {
  for (let index = 0; index < searchData.rc.length; index += 1) {
    const record = searchData.rc[index];
    assert.ok(Array.isArray(record) && record.length >= 6, `record ${index}: compact shape`);
    assert.ok(Number.isInteger(record[0]) && record[0] >= 0 && record[0] < searchData.rp.length, `record ${index}: repository reference`);
    assert.strictEqual(typeof record[1], "string", `record ${index}: file`);
    assert.strictEqual(typeof record[2], "string", `record ${index}: extension`);
    assert.ok(Number.isInteger(record[3]) && record[3] >= 0 && record[3] < searchData.fd.length, `record ${index}: folder reference`);
    assert.ok(typeof record[4] === "number" || typeof record[4] === "string", `record ${index}: size`);
    assert.ok(record[5] === 0 || record[5] === 1 || typeof record[5] === "boolean", `record ${index}: text flag`);
  }
});
test("initial manifest exactly covers generated initial payloads", () => validateManifest("data/initial"));
test("sidebar manifest exactly covers generated sidebar payloads", () => validateManifest("data/sidebar"));
test("global initial payload schema and total match the corpus", () => {
  assert.strictEqual(initial.version, 2);
  assert.strictEqual(initial.mode, "global");
  assert.strictEqual(initial.repo, null);
  assert.strictEqual(initial.page, 1);
  assert.strictEqual(initial.total, searchData.rc.length);
  assert.ok(Array.isArray(initial.results) && initial.results.length <= initial.page_size);
  for (const result of initial.results) {
    assert.ok(searchData.rp.includes(result.Repo));
    assert.strictEqual(typeof result.File, "string");
    assert.strictEqual(typeof result.Extension, "string");
    assert.ok(Array.isArray(result.Folder));
  }
});
test("global sidebar repositories and aggregate total match the corpus", () => {
  assert.ok(Array.isArray(sidebar.repos));
  assert.strictEqual(sidebar.repos.reduce((sum, repo) => sum + repo.count, 0), searchData.rc.length);
  assert.deepStrictEqual(sidebar.repos.map((repo) => repo.name).sort(), searchData.rp.slice().sort());
  assert.ok(sidebar.repos.every((repo) => Number.isInteger(repo.count) && repo.count >= 0));
});
test("every repository initial payload matches sidebar identity and total", () => {
  for (const repo of sidebar.repos) {
    const shortName = repo.name.slice(repo.name.indexOf("/") + 1);
    const payload = readJson(`data/initial/repos/${shortName}.json`);
    assert.strictEqual(payload.version, 2);
    assert.strictEqual(payload.mode, "repo");
    assert.strictEqual(payload.repo, repo.name);
    assert.strictEqual(payload.total, repo.count, `${repo.name}: total`);
    assert.ok(payload.results.length <= payload.page_size);
    assert.ok(payload.results.every((result) => result.Repo === repo.name));
  }
});
test("every repository sidebar payload has root folder and file arrays", () => {
  for (const repo of sidebar.repos) {
    const shortName = repo.name.slice(repo.name.indexOf("/") + 1);
    const payload = readJson(`data/sidebar/repos/${shortName}.json`);
    assert.strictEqual(payload.repo, repo.name);
    assert.strictEqual(payload.path, "");
    assert.ok(Array.isArray(payload.folders));
    assert.ok(Array.isArray(payload.files));
    assert.ok(payload.folders.every((folder) => typeof folder.n === "string" && Number.isInteger(folder.c)));
  }
});
test("PWA manifest scope start URL and icons are deployable under search", () => {
  const manifest = readJson("manifest.json");
  assert.strictEqual(manifest.start_url, "/search/");
  assert.strictEqual(manifest.scope, "/search/");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith("/search/icons/"));
    assert.ok(fs.statSync(icon.src.slice("/search/".length)).isFile(), `${icon.src}: missing icon`);
  }
});
test("HTML references existing PWA and runtime assets under expected paths", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /href="\/search\/manifest\.json"/);
  assert.match(html, /src="static\/app\.js"/);
  assert.match(html, /register\("\/search\/sw\.js"/);
  for (const file of ["static/style.css", "static/app.js", "static/index-worker.js", "sw.js", "manifest.json"]) assert.ok(fs.statSync(file).isFile());
});

run("generated data");
