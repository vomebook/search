// Classic search scripts are composed into the production bundle before app.js.
// Tests that extract host functions from app.js must install the same modules in
// their vm context, otherwise host wrappers would call an undefined namespace.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MODULES = ["static/search/execution/domain/policy.js", "static/search/execution/application/controller.js", "static/search/downloads/application/batch.js", "static/search/downloads/presentation/queue.js", "static/search/presentation/sidebar-render.js", "static/search/sidebar/infrastructure/scroll.js", "static/search/sidebar/presentation/directory.js", "static/search/sidebar/application/directory.js", "static/search/search-session.js", "static/search/domain/search-window-page.js",
  "static/search/positions/domain/policy.js", "static/search/positions/infrastructure/indexed-db.js", "static/search/positions/application/persistence.js", "static/search/positions/application/restoration.js",
  "static/search/results/presentation/row.js", "static/search/results/application/interactions.js",
  "static/search/discovery/application/random.js",
  "static/search/shell/presentation/view.js", "static/search/shell/application/controller.js",
  "static/search/bootstrap/domain/initial-payload.js", "static/search/bootstrap/application/controller.js",
  "static/search/results/virtual/domain/heights.js", "static/search/results/virtual/presentation/rows.js", "static/search/results/virtual/application/controller.js",
  "static/search/routing/domain/route.js", "static/search/routing/application/router.js",
  "static/search/history/infrastructure/store.js", "static/search/history/application/controller.js",
  "static/search/ambient/application/quotation.js",
  "static/search/corpus/application/client.js",
  "static/search/results/snapshots/domain/copy-budget.js", "static/search/results/snapshots/application/store.js",
  "static/search/folder-selection.js", "static/search/domain/height-index.js",
  "static/search/reader-host/presentation/return-position.js", "static/search/reader-host/application/host.js",
  "static/search/requests/infrastructure/shared-transport.js", "static/search/requests/application/prefetch-controller.js",
  "static/search/results/window/application/page-loader.js", "static/search/results/window/presentation/status.js"];
const sources = new Map();
const installed = new WeakMap();

/**
 * Install every shared classic search module into `context` once per context.
 * @param {string} root site root that owns `static/`
 * @param {object} context vm context that later runs app.js functions
 */
function installClassicSearchModules(root, context) {
  let done = installed.get(context);
  if (!done) installed.set(context, done = new Set());
  // Shared performance tests target either site; use that site's explicit
  // inventory (Space intentionally has no local corpus Worker).
  const targetLoader = path.resolve(root, "tests/support/classic_search_modules.js");
  const modules = targetLoader === __filename ? MODULES : require(targetLoader).MODULES;
  for (const name of modules) {
    if (done.has(name)) continue;
    const sourcePath = path.join(root, name);
    let source = sources.get(sourcePath);
    if (source === undefined) {
      source = fs.readFileSync(sourcePath, "utf8");
      sources.set(sourcePath, source);
    }
    vm.runInContext(source, context, {filename: name});
    done.add(name);
  }
}

module.exports = {installClassicSearchModules, MODULES};
