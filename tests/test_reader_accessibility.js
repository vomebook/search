const assert = require("assert");
const fs = require("fs");
const { assertCode } = require("./reader_source_contract");

const reader = fs.readFileSync("static/reader.js", "utf8");
const html = fs.readFileSync("static/reader.html", "utf8");
const css = fs.readFileSync("static/reader.css", "utf8");
for (const value of ['role="status"', 'id="page-number"', 'id="page-total"']) assert.ok(html.includes(value), value);
for (const value of ['["#back", "返回"]', '["#page-number", "页码"]', '["#zoom", "缩放百分比"]']) assertCode(reader, value);
for (const value of ['setAttribute("role", "region")', 'setAttribute("aria-label", `第 ${page} 页`)', 'setAttribute("aria-modal", "true")', 'focus({ preventScroll: true })', 'composedPath()']) assertCode(reader, value);
assert.match(css, /prefers-contrast\s*:\s*more/);
for (const value of ['aria-label="下载原文件"', 'role="tablist"', 'role="tab"', 'aria-controls="toc-panel"', 'role="tabpanel"']) assert.ok(html.includes(value), value);
assert.doesNotMatch(html, /id=["']ocr["']/i);
console.log("reader accessibility contracts passed");
