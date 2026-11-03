const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Expectations were captured from each site's original app.js functions.
const app = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const sandbox = vm.createContext({HF_DATASET_BASE: "https://huggingface.co/datasets"});
const filename = path.join(__dirname, "../static/search/record-path.js");
vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox, {filename});
for (const name of ["buildRecordLink", "buildRecordPath", "getBrowserFileName", "getBrowserFileLink"]) {
  const match = app.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `missing original ${name}`);
  vm.runInContext(match[0], sandbox);
}
const {buildRecordRelativePath, buildRecordLink, buildRecordPath, encodeRecordPath, getBrowserFileLink} = sandbox;
const root = "https://huggingface.co/datasets/VoiceOfML/Test";
for (const [record, relative, encoded] of [
  [{Repo:"VoiceOfML/Test", File:"poster.jpg", Extension:"jpg", Folder:[]}, "poster.jpg.jpg", "poster.jpg.jpg"],
  [{Repo:"VoiceOfML/Test", File:"a b#?%", Extension:"txt", Folder:["目录", "子 文件"]},
    "目录/子 文件/a b#?%.txt", "%E7%9B%AE%E5%BD%95/%E5%AD%90%20%E6%96%87%E4%BB%B6/a%20b%23%3F%25.txt"],
  [{Repo:"VoiceOfML/Test", File:"README", Folder:null}, "README", "README"],
  [{Repo:"VoiceOfML/Test", File:"", Extension:"pdf", Folder:["root"]}, "root/.pdf", "root/.pdf"],
  [{Repo:"VoiceOfML/Test", File:"x", Extension:"", Folder:["", "sub"]}, "/sub/x", "/sub/x"]
]) {
  assert.equal(buildRecordRelativePath(record), relative);
  assert.equal(buildRecordLink(record), `${root}/resolve/main/${encoded}`);
  assert.equal(buildRecordPath(record), `${root}/blob/main/${encoded}`);
}
assert.equal(encodeRecordPath("a/b c/😀"), "a/b%20c/%F0%9F%98%80");
assert.equal(encodeRecordPath(null), "");
assert.equal(buildRecordRelativePath({}), "");
assert.equal(getBrowserFileLink("VoiceOfML/Test", "目录", {name:"a #", ext:"jpg"}),
  `${root}/resolve/main/%E7%9B%AE%E5%BD%95/a%20%23.jpg`);
assert.equal(getBrowserFileLink("VoiceOfML/Test", "", {link:"https://example.test/file"}), "https://example.test/file");
console.log("search record paths preserve filenames, separators and URL encoding");
