// Classic search scripts are composed into the production bundle before app.js.
// Tests that extract host functions from app.js must install the same modules in
// their vm context, otherwise host wrappers would call an undefined namespace.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MODULES = ["static/search/search-session.js", "static/search/domain/search-window-page.js",
  "static/search/positions/domain/policy.js", "static/search/positions/infrastructure/indexed-db.js", "static/search/positions/application/persistence.js",
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
  for (const name of MODULES) {
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
