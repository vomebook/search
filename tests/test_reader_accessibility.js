const assert = require("assert");
const fs = require("fs");
const { assertCode, readReaderSource } = require("./reader_source_contract");

const reader = readReaderSource(require("path").resolve("."));
const html = fs.readFileSync("static/reader.html", "utf8");
const css = fs.readFileSync("static/reader.css", "utf8");
const search = fs.readFileSync("static/reader/search/reader-search-controller.mjs", "utf8");
for (const value of ['role="status"', 'id="page-number"', 'id="page-total"']) assert.ok(html.includes(value), value);
for (const value of ['["#back", "返回"]', '["#page-number", "页码"]', '["#zoom", "缩放百分比"]']) assertCode(reader, value);
for (const value of ['setAttribute("role", "region")', 'setAttribute("aria-label", `第 ${page} 页`)', 'setAttribute("aria-modal", "true")', 'focus({ preventScroll: true })', 'composedPath()']) assertCode(reader, value);
assert.match(css, /prefers-contrast\s*:\s*more/);
for (const value of ['aria-label="下载原文件"', 'role="tablist"', 'role="tab"', 'aria-controls="toc-panel"', 'role="tabpanel"']) assert.ok(html.includes(value), value);
assert.doesNotMatch(html, /id=["']ocr["']/i);
for (const value of ['class="reader-skip-link"', 'tabindex="-1" aria-label="正文"',
  'aria-controls="history-panel" aria-expanded="false"', 'aria-label="关闭阅读选项"',
  'aria-labelledby="reader-panel-title" hidden inert']) assert.ok(html.includes(value), value);
for (const value of ['panel.inert = true', 'panel.inert = false',
  'setAttribute("aria-current", "location")']) assertCode(reader, value);
assertCode(search, 'setAttribute("aria-controls", view.id)');
console.log("reader accessibility contracts passed");
