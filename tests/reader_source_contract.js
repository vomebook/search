const assert = require("assert");
const fs = require("fs");
const path = require("path");

function readReaderSource(root) {
  const resources = require(path.join(root, "static/reader-resources.js"));
  return ["reader.js", ...resources.readerComponentFiles].map(file =>
    fs.readFileSync(path.join(root, "static", file), "utf8")
      .replace(/\breaderContext\./g, "").replace(/^  /gm, "")).join("\n");
}

// Match code tokens across layout changes, preserving quoted values and operators.
// This is a snippet matcher, not a JavaScript parser or a source minifier.
function codePattern(snippet) {
  const tokens = snippet.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|===|!==|=>|\?\.|\?\?|&&|\|\||==|!=|<=|>=|\+\+|--|\S/g) || [];
  return new RegExp(tokens.map((token, index) => {
    const gap = index === 0 ? "" : /[\w$]$/.test(tokens[index - 1]) && /^[\w$]/.test(token) ? "\\s+" : "\\s*";
    return gap + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join(""));
}

function assertCode(source, snippet) {
  assert.match(source, codePattern(snippet), snippet);
}

module.exports = { codePattern, assertCode, readReaderSource };
