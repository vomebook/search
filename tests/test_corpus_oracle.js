const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const zlib = require("zlib");
const { test, run } = require("./test_harness");

const workerSource = fs.readFileSync("static/index-worker.js", "utf8");
const compact = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/search_data.json.gz")).toString("utf8"));

// This decoder intentionally does not use app.js or its compact-data helpers.
const corpus = compact.rc.map((item) => ({
  Repo: compact.rp[item[0]],
  File: item[1] || "",
  Extension: item[2] || "",
  Folder: compact.fd[item[3]].slice(),
  Size: item[4],
  HasTxt: !!item[5],
}));
const idOccurrences = {};
const corpusIds = corpus.map((record) => {
  const base = [record.Repo, record.Folder.join("/"), record.File, record.Extension].join("\u001f");
  const occurrence = idOccurrences[base] || 0;
  idOccurrences[base] = occurrence + 1;
  return [record.Repo, record.Folder.concat([record.File, record.Extension]).join("/"), String(occurrence)].join("\u001f");
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function realWorkerSearch(params) {
  const messages = [];
  let listener;
  const context = {
    console,
    self: {
      addEventListener(type, fn) { if (type === "message") listener = fn; },
      postMessage(message) { messages.push(clone(message)); },
    },
  };
  vm.createContext(context);
  vm.runInContext(workerSource, context, { filename: "static/index-worker.js" });
  await listener({ data: { protocol: 1, type: "replace-corpus", id: "load", payload: { data: clone(compact) } } });
  await listener({ data: { protocol: 1, type: "local-search", id: "oracle", payload: params } });
  return messages[messages.length - 1].result;
}

function wildcard(pattern) {
  const escaped = String(pattern || "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\*/g, ".*").replace(/\?/g, "."), "i");
}

function bruteForce(params) {
  const query = String(params.q || "").trim();
  const searchFolders = params.searchFolders !== false;
  const pattern = query && (query.indexOf("*") >= 0 || query.indexOf("?") >= 0) ? wildcard(query) : null;
  const lower = query.toLowerCase();
  let matched = [];
  for (let index = 0; index < corpus.length; index += 1) {
    const record = corpus[index];
    const file = record.File.toLowerCase();
    const repo = record.Repo.toLowerCase();
    const folderPath = record.Folder.join("/");
    const folder = folderPath.toLowerCase();
    if (query && !(pattern
      ? pattern.test(file) || pattern.test(repo) || (searchFolders && pattern.test(folder))
      : file.indexOf(lower) >= 0 || repo.indexOf(lower) >= 0 || (searchFolders && folder.indexOf(lower) >= 0))) continue;
    if (params.repos && params.repos.length && params.repos.indexOf(record.Repo) < 0) continue;
    if (params.extensions && params.extensions.length && params.extensions.indexOf(record.Extension.toLowerCase()) < 0) continue;
    let folderMatch = true;
    if (params.folderMatchMode === "mixed") {
      const self = (params.folderSelfs || []).map(cleanPath);
      const subtree = (params.folderSubtrees || []).map(cleanPath);
      if (self.length || subtree.length) {
        folderMatch = self.indexOf(folderPath) >= 0;
        for (let depth = 1; !folderMatch && depth <= record.Folder.length; depth += 1) {
          folderMatch = subtree.indexOf(record.Folder.slice(0, depth).join("/")) >= 0;
        }
      }
    } else if (params.folders && params.folders.length) {
      folderMatch = false;
      for (const raw of params.folders) {
        const selected = cleanPath(raw);
        if (params.folderMatchMode === "exact") folderMatch = folderPath === selected;
        else if (!selected) folderMatch = record.Folder.length === 0;
        else folderMatch = folderPath === selected || folderPath.indexOf(selected + "/") === 0;
        if (folderMatch) break;
      }
    }
    if (!folderMatch) continue;
    if (typeof record.Size === "number" && record.Size > 0) {
      if (params.minSize !== null && record.Size < params.minSize) continue;
      if (params.maxSize !== null && record.Size > params.maxSize) continue;
    }
    matched.push(index);
  }
  if (params.sort === "name") matched.sort((a, b) => corpus[a].File.localeCompare(corpus[b].File, "zh"));
  else if (params.sort === "size") matched.sort((a, b) => (Number(corpus[b].Size) || 0) - (Number(corpus[a].Size) || 0));
  else if (query) {
    const tokens = query.toLowerCase().match(/[a-z0-9]+/g) || [];
    const chinese = [];
    for (const character of query.toLowerCase()) {
      if ((character >= "\u4e00" && character <= "\u9fff") || (character >= "\u3400" && character <= "\u4dbf")) {
        chinese.push(character);
        tokens.push(character);
      }
    }
    for (let index = 0; index < chinese.length - 1; index += 1) tokens.push(chinese[index] + chinese[index + 1]);
    const uniqueTokens = Array.from(new Set(tokens));
    matched.sort((a, b) => {
      function score(record) {
        const file = record.File.toLowerCase();
        const repo = record.Repo.toLowerCase();
        const folder = record.Folder.join("/").toLowerCase();
        return uniqueTokens.reduce((total, token) => total + (file.indexOf(token) >= 0 ? 3 : 0) + (searchFolders && folder.indexOf(token) >= 0 ? 2 : 0) + (repo.indexOf(token) >= 0 ? 1 : 0), 0);
      }
      return score(corpus[b]) - score(corpus[a]);
    });
  }
  const page = params.page || 1;
  const pageSize = params.pageSize || 100;
  const indices = matched.slice((page - 1) * pageSize, page * pageSize);
  return {
    records: indices.map((index) => corpus[index]),
    ids: indices.map((index) => corpusIds[index]),
    total: matched.length,
    page,
    pageSize,
    generation: 1,
  };
}

function cleanPath(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

async function compare(params) {
  assert.deepStrictEqual(await realWorkerSearch(params), bruteForce(params));
}

test("independent decoder reconstructs corpus count and known first record", () => {
  assert.strictEqual(corpus.length, compact.rc.length);
  assert.deepStrictEqual(corpus[0], {
    Repo: compact.rp[compact.rc[0][0]], File: compact.rc[0][1], Extension: compact.rc[0][2],
    Folder: compact.fd[compact.rc[0][3]], Size: compact.rc[0][4], HasTxt: !!compact.rc[0][5],
  });
});
test("exact literal filename query matches brute-force corpus scan", () => compare({ q: "目录", exact: true, page: 1, pageSize: 37 }));
test("exact repository metadata query matches brute-force corpus scan", () => compare({ q: "VoiceOfML/Omnibus", exact: true, page: 1, pageSize: 23 }));
test("exact folder search toggle matches brute-force corpus scan", async () => {
  await compare({ q: "原版目录", exact: true, searchFolders: true, page: 1, pageSize: 50 });
  await compare({ q: "原版目录", exact: true, searchFolders: false, page: 1, pageSize: 50 });
});
test("star and question wildcard scans match independent regular expressions", async () => {
  await compare({ q: "*目录*", exact: true, page: 2, pageSize: 19 });
  await compare({ q: "第?批", exact: true, page: 1, pageSize: 31 });
});
test("repository and extension filters match brute-force scan", () => compare({
  q: "", exact: true, repos: ["VoiceOfML/Omnibus"], extensions: ["pdf"], page: 1, pageSize: 17,
}));
test("size bounds and descending size page match brute-force scan", () => compare({
  q: "", exact: true, minSize: 1024, maxSize: 1048576, sort: "size", page: 3, pageSize: 29,
}));
test("folder prefix exact and mixed matrices match brute-force scan", async () => {
  await compare({ q: "", exact: true, folders: ["原版目录"], folderMatchMode: "prefix", page: 1, pageSize: 41 });
  await compare({ q: "", exact: true, folders: ["原版目录"], folderMatchMode: "exact", page: 1, pageSize: 41 });
  await compare({ q: "", exact: true, folderMatchMode: "mixed", folderSelfs: ["原版目录"], folderSubtrees: ["遗失书籍"], page: 1, pageSize: 41 });
});
test("pagination beyond final page matches brute-force total and empty indices", () => compare({
  q: "VoiceOfML/Omnibus", exact: true, page: 9999, pageSize: 13,
}));
test("global generated first page is the corpus source order", () => {
  const payload = JSON.parse(fs.readFileSync("data/initial/global.json", "utf8"));
  assert.strictEqual(payload.total, corpus.length);
  assert.deepStrictEqual(payload.results, corpus.slice(0, payload.page_size));
});
test("every repository generated first page preserves filtered corpus order and total", () => {
  for (const repo of compact.rp) {
    const short = repo.slice(repo.indexOf("/") + 1);
    const payload = JSON.parse(fs.readFileSync(`data/initial/repos/${short}.json`, "utf8"));
    const expected = corpus.filter((record) => record.Repo === repo);
    assert.strictEqual(payload.total, expected.length, repo);
    assert.deepStrictEqual(payload.results, expected.slice(0, payload.page_size), repo);
  }
});

run("corpus oracle");
