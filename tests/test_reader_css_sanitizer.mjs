// Offline contract for Reader CSS reference sanitization (EPUB/chapter styles).
import assert from "node:assert/strict";
import { createReaderHtmlFormat } from "../static/reader/formats/reader-html-format.mjs";

const { sanitizeCssReferences: clean } = createReaderHtmlFormat({});
const cases = [
  // [input, expected, options]
  ["p{background:url(https://x.test/a.png)}", "p{background:none}"],
  ["p{background:URL( 'https://x.test/a.png' )}", "p{background:none}"],
  ["p{background:\\75 rl(https://x.test/a.png)}", "p{background:none}"],
  ["p{background:\\75rl(//x.test/a.png)}", "p{background:none}"],
  ["p{background:url(ht\\74ps://x.test/a.png)}", "p{background:none}"],
  ["p{background:url(\"java\\9script:x\")}", "p{background:none}"],
  ["p{background:url(h\ttps://x.test)}", "p{background:none}"],
  ["p{background:image-set(\"https://x.test/a.png\" 1x)}", "p{background:none}"],
  ["p{background:-webkit-image-set(url(https://x.test/a.png) 1x)}", "p{background:none}"],
  ["p{--bg:\"https://x.test/a.png\";background:image-set(var(--bg) 1x)}", "p{--bg:\"\";background:image-set(var(--bg) 1x)}"],
  ["@import \"https://x.test/a.css\";p{}", "p{}"],
  ["@import/**/url(https://x.test/a.css) screen;p{}", "p{}"],
  ["@\\69mport 'https://x.test/a.css';p{}", "p{}"],
  ["@import url(data:text/css,p{});p{}", "p{}"],
  ["@import \"blob:https://site/abc\";p{}", "p{}"],
  ["@import \"blob:https://site/abc\";p{}", "@import \"blob:https://site/abc\";p{}", { keepBlobImports: true }],
  ["@import \"local.css\";p{}", "@import \"local.css\";p{}"],
  // Safe references and non-reference strings stay byte-for-byte.
  ["p{background:url(blob:https://site/1)}", null],
  ["p{background:url(\"data:image/svg+xml,<svg/>\")}", null],
  ["@font-face{src:url(\"blob:https://site/f\") format(\"woff2\"),local(\"Noto\")}", null],
  ["p{background:url(images/a.png)} q{fill:url(#grad)}", null],
  ["p::before{content:\"https://example.com\"}", null],
  ["p{content:\"url(https://x.test)\"} /* url(https://x.test) */", null],
  ["p{background:url(https://x.test/a.png)}", "p{background:none}", { strict: false }],
  // Strict (offline HTML) removes every reference.
  ["p{background:url(#a)}@import 'x.css';", "p{background:}", { strict: true }],
  ["<p style>background:url(javascript:bad);color:#111", "<p style>background:;color:#111", { strict: true }],
];
let failures = 0;
for (const [input, expected, options] of cases) {
  const actual = clean(input, options);
  try {
    assert.equal(actual, expected ?? input);
  } catch (error) {
    failures++;
    console.error(`FAIL ${JSON.stringify(input)}\n  got      ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected ?? input)}`);
  }
}
// Linear-time behaviour on adversarial nesting/escapes.
const big = "p{background:" + "image-set(".repeat(20000) + "\"https://x.test\"" + ")".repeat(20000) + "}" + "\\".repeat(50000);
const started = Date.now();
assert.ok(!clean(big).includes("https://x.test"));
assert.ok(Date.now() - started < 2000, "scanner must stay linear");
if (failures) {
  console.error(`${failures} CSS sanitizer case(s) failed`);
  process.exit(1);
}
console.log(`reader CSS sanitizer: ${cases.length} cases passed`);
