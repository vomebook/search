import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// One ordered dependency list owns the production app and its shell scripts.
// Keep classic-script globals for the host; each dependency owns its own scope.
export const APP_DEPENDENCIES = Object.freeze([
  "reader-resources.js", "reader/core/reader-contract.js", "search/reader-host/application/navigation.js",
  "search/reader-host/presentation/return-position.js", "search/reader-host/application/host.js",
  "search/positions/domain/policy.js", "search/positions/infrastructure/indexed-db.js", "search/positions/application/persistence.js", "search/positions/application/restoration.js",
  "search/results/presentation/row.js", "search/results/application/interactions.js",
  "search/discovery/application/random.js",
  "search/shell/presentation/view.js", "search/shell/application/controller.js",
  "search/bootstrap/domain/initial-payload.js", "search/bootstrap/application/controller.js",
  "search/reader-assets/infrastructure/scheduling.js", "search/reader-assets/infrastructure/sidecar.js", "search/reader-assets/application/snapshot.js",
  "search/results/virtual/domain/heights.js", "search/results/virtual/presentation/rows.js", "search/results/virtual/application/controller.js",
  "search/routing/domain/route.js", "search/routing/application/router.js",
  "search/history/infrastructure/store.js",
  "search/history/application/controller.js",
  "search/ambient/application/quotation.js",
  "search/corpus/application/client.js",
  "search/results/snapshots/domain/copy-budget.js", "search/results/snapshots/application/store.js",
  "search/execution/domain/policy.js", "search/execution/application/controller.js",
  "search/execution/application/session.js", "search/downloads/application/controller.js", "search/downloads/application/batch.js", "search/downloads/presentation/queue.js", "search/results/presentation/size-format.js", "search/catalog/domain/record-path.js",
  "search/results/presentation/highlight.js", "search/requests/infrastructure/response-cache.js", "search/catalog/domain/file-types.js", "search/requests/domain/response-validation.js", "search/results/domain/result-identity.js",
  "search/input/domain/ownership.js", "search/input/application/controller.js",
  "search/requests/infrastructure/shared-transport.js", "search/requests/application/prefetch-controller.js", "search/requests/application/response-store.js",
  "search/catalog/domain/sidebar-payload.js", "search/catalog/application/client.js",
  "search/results/window/application/page-loader.js", "search/results/window/presentation/status.js",
  "search/results/domain/paging-policy.js", "search/results/application/paging-controller.js", "search/results/presentation/paging-status.js",
  "search/sidebar/domain/folder-selection.js", "search/results/virtual/domain/height-index.js", "search/shared/domain/stable-stringify.js", "search/positions/domain/view-key.js", "search/results/domain/recovery.js", "search/results/window/domain/page.js", "search/sidebar/presentation/markup.js", "search/sidebar/presentation/filter-list.js", "search/sidebar/presentation/folder-tree.js", "search/sidebar/application/filters.js", "search/sidebar/infrastructure/scroll.js", "search/sidebar/presentation/directory.js", "search/sidebar/application/directory.js"
]);

export function stripBundledScripts(html) {
  return html.replace(/<script\s+src="(?:\/?(?:search\/)?static\/)([^"\s]+)"\s*>\s*<\/script>\s*/g,
    (tag, filename) => APP_DEPENDENCIES.includes(filename) ? "" : tag);
}

// Bundled search host modules are needed individually in development only.
// Keep shared Reader dependencies and standalone Worker scripts in precache.
export function stripBundledPrecache(sw, staticBase) {
  const bundled = new Set(APP_DEPENDENCIES.filter(file => file.startsWith("search/"))
    .map(file => staticBase + file));
  // Pages minifies the worker before the hash pass, retaining this same array
  // initializer. Only edit its entries, not the separate hashed asset graph.
  return sw.replace(/(\bPRECACHE_URLS\s*=\s*\[)([^\]]*)(\])/, (_, start, entries, end) =>
    start + entries.split(",").filter(entry => {
      const literal = /^(?:"([^"]+)"|'([^']+)')$/.exec(entry.trim());
      return !literal || !bundled.has(literal[1] ?? literal[2]);
    }).join(",") + end);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write([...APP_DEPENDENCIES, "app.js"]
    .map(file => readFileSync("static/" + file, "utf8")).join("\n;\n"));
}
