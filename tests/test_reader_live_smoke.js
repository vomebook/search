const https = require("https");
const assert = require("assert");
const base = process.env.GITHUB_SEARCH_LIVE_BASE_URL;
if (!base) { console.log("reader live smoke skipped"); process.exit(0); }
function get(url) { return new Promise((resolve, reject) => https.get(url, { headers: { "User-Agent": "reader-live-smoke" } }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"), type: response.headers["content-type"] || "" })); }).on("error", reject)); }
(async () => {
  const root = new URL("search/", base.endsWith("/") ? base : base + "/");
  const sw = await get(new URL('sw.js', root));
  assert.strictEqual(sw.status, 200);
  const pinned = [...new Set(sw.body.match(/\/search\/static\/[^"'\s]+\.[0-9a-f]{12}\.(?:js|mjs|css)/g))];
  const current = file => {
    const split = file.lastIndexOf('.'), stem = file.slice(0, split), extension = file.slice(split);
    const matches = pinned.filter(url => url.startsWith('/search/static/' + stem + '.') && url.endsWith(extension));
    assert.strictEqual(matches.length, 1, file); return matches[0];
  };
  const files = ["static/reader.html", ...require('../static/reader-resources.js').readerFiles.map(current), "static/foliate-reader/view.js"];
  for (const file of files) { const response = await get(new URL(file, root)); assert.strictEqual(response.status, 200, file); assert.ok(response.body.length > 20, file); }
  const reader = await get(new URL(current('reader.js'), root)); assert.match(reader.body, /createReaderRuntime|VoiceOfMLReaderRuntime/); assert.match(reader.body, /createAdapterRegistry|VoiceOfMLReaderAdapters/);
  console.log("reader live smoke ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
