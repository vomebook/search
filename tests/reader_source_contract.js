const assert = require("assert");

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

module.exports = { codePattern, assertCode };
