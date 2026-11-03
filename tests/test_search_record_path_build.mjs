import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {APP_DEPENDENCIES, stripBundledScripts} from "../scripts/build/compose_app.mjs";

const resources = createRequire(import.meta.url)("../static/reader-resources.js");
const html = readFileSync("static/index.html", "utf8");
const worker = readFileSync("static/sw.js", "utf8");
const moduleName = "search/record-path.js";
assert.equal(APP_DEPENDENCIES.filter(name => name === moduleName).length, 1);
assert.equal((html.match(/<script src="[^"\n]*search\/record-path\.js"><\/script>/g) || []).length, 1);
assert.ok(html.indexOf(moduleName) < html.lastIndexOf("app.js"));
const bundled = stripBundledScripts(html);
assert.doesNotMatch(bundled, /<script src="[^"\n]*search\/record-path\.js"/);
assert.equal((bundled.match(/<script\s+src=/g) || []).length, 1);
for (const project of ["github", "hf"]) {
  assert.equal(resources.buildFiles(project).filter(name => name === moduleName).length, 1);
}
assert.match(worker, /["']\/(?:search\/)?static\/app\.js["']/);
assert.doesNotMatch(worker, /["']\/(?:search\/)?static\/search\/record-path\.js["']/);
console.log("record path source and bundled shell/SW contracts preserved");
