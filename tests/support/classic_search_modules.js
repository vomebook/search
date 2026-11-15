// Classic search scripts are composed into the production bundle before app.js.
// Tests that extract host functions from app.js must install the same modules in
// their vm context, otherwise host wrappers would call an undefined namespace.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MODULES = ["static/search/folder-selection.js", "static/search/domain/height-index.js",
  "static/search/requests/infrastructure/shared-transport.js", "static/search/requests/application/prefetch-controller.js"];
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
