const fs = require("fs");
const assert = require("assert");
const { test, run } = require("./test_harness");

const app = fs.readFileSync("static/app.js", "utf8");
const worker = fs.readFileSync("static/index-worker.js", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("static/style.css", "utf8");
const workflow = fs.readFileSync(".github/workflows/static.yml", "utf8");

test("main thread retains folder-search state", () => {
  assert.match(app, /searchFolders/);
  assert.match(app, /folderMatchMode/);
});
test("main thread retains stale-search and cancellation controls", () => {
  assert.match(app, /searchRequestId/);
  assert.match(app, /AbortController/);
});
test("main thread has warm-connection keepalive", () => {
  assert.match(app, /function warmConnection/);
  assert.match(app, /keepalivePending/);
  assert.match(app, /KEEPALIVE_INTERVAL_MS|KEEPALIVE_MIN_GAP_MS/);
  assert.match(app, /document\.hidden \|\| !navigator\.onLine/);
  assert.match(app, /apiAvailable/);
  assert.match(app, /API_BASE.*\/api\/ping/);
  assert.match(html, /fetch\("https:\/\/voiceofml-search\.hf\.space\/api\/ping", \{ cache: "no-store" \}\)\.catch/);
  assert.ok(html.indexOf("/api/ping") < html.indexOf('href="static/style.css"'));
});
test("fresh first-page results use bounded entrance motion", () => {
  assert.match(app, /function animateVisibleResultRows/);
  assert.match(app, /Number\(row\.dataset\.index\) >= 30/);
  assert.match(app, /renderResults\(true\)/);
  assert.strictEqual((app.match(/renderResults\(true\)/g) || []).length, 3);
  assert.match(css, /\.result-item\.result-enter/);
  assert.match(css, /animation: result-item-enter 180ms/);
  assert.match(css, /opacity: 0\.82/);
  assert.strictEqual(/opacity: 0\.45/.test(css), false);
  assert.strictEqual(/transform: translateY\(3px\)/.test(css), false);
  assert.match(css, /prefers-reduced-motion/);
});
test("Worker retains tokenizer and fuzzy edit distance", () => {
  assert.match(worker, /function tokenize/);
  assert.match(worker, /function editDistance/);
});
test("Worker retains wildcard conversion", () => {
  assert.match(worker, /function wildcardPatternToRegExp/);
});
test("Service Worker cache name remains fixed", () => {
  assert.match(sw, /vomebook-search-v1\.0\.0/);
});
test("Service Worker precaches the search Worker", () => {
  assert.match(sw, /search\/static\/index-worker\.js/);
});
test("HTML registers Service Worker under search scope", () => {
  assert.match(html, /register\("\/search\/sw\.js", \{ scope: "\/search\/" \}\)/);
});
test("HTML loads the real application and stylesheet", () => {
  assert.match(html, /href="static\/style\.css"/);
  assert.match(html, /src="static\/app\.js"/);
});
test("deployment workflow runs for main pushes and manual dispatch", () => {
  assert.match(workflow, /push:\s*\n\s*branches: \["main"\]/);
  assert.match(workflow, /workflow_dispatch:/);
});
test("deployment workflow grants required Pages permissions", () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});
test("deployment workflow uses official checkout configure upload and deploy actions", () => {
  const actions = Array.from(workflow.matchAll(/uses: ([^\s]+)/g), (match) => match[1]);
  assert.deepStrictEqual(actions, [
    "actions/checkout@v5",
    "actions/setup-node@v4",
    "actions/configure-pages@v5",
    "actions/upload-pages-artifact@v3",
    "actions/deploy-pages@v5",
  ]);
});
test("deployment workflow builds and uploads minified static artifacts", () => {
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /esbuild@0\.25\.8 static\/app\.js --minify-syntax --minify-whitespace/);
  assert.match(workflow, /esbuild@0\.25\.8 static\/index-worker\.js --minify-syntax --minify-whitespace/);
  assert.match(workflow, /esbuild@0\.25\.8 static\/style\.css --minify/);
  assert.match(workflow, /esbuild@0\.25\.8 sw\.js --minify/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v3\s*\n\s*with:\s*[\s\S]*?path: '_site'/);
});
test("deployment workflow exposes deployment URL through github-pages environment", () => {
  assert.match(workflow, /environment:\s*\n\s*name: github-pages\s*\n\s*url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(workflow, /id: deployment/);
});

run("static contracts");
