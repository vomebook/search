import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// One ordered dependency list owns the production app and its shell scripts.
// Keep classic-script globals for the host; each dependency owns its own scope.
export const APP_DEPENDENCIES = Object.freeze([
  "reader-resources.js", "reader/core/reader-contract.js", "search/reader-navigation.js",
  "search/reader-host/presentation/return-position.js", "search/reader-host/application/host.js",
  "search/search-session.js", "search/download-controller.js", "search/size-format.js", "search/record-path.js",
  "search/highlight.js", "search/response-cache.js", "search/file-types.js", "search/response-validation.js", "search/result-identity.js",
  "search/input/domain/ownership.js", "search/input/application/controller.js",
  "search/requests/infrastructure/shared-transport.js", "search/requests/application/prefetch-controller.js",
  "search/results/window/application/page-loader.js", "search/results/window/presentation/status.js",
  "search/results/domain/paging-policy.js", "search/results/application/paging-controller.js", "search/results/presentation/paging-status.js",
  "search/folder-selection.js", "search/domain/height-index.js", "search/domain/stable-stringify.js", "search/domain/search-view-key.js", "search/domain/search-recovery.js", "search/domain/search-window-page.js", "search/presentation/sidebar-render.js", "search/sidebar/presentation/filter-list.js", "search/sidebar/presentation/folder-tree.js", "search/sidebar/application/filters.js"
]);

export function stripBundledScripts(html) {
  return html.replace(/<script\s+src="(?:\/?(?:search\/)?static\/)([^"\s]+)"\s*>\s*<\/script>\s*/g,
    (tag, filename) => APP_DEPENDENCIES.includes(filename) ? "" : tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write([...APP_DEPENDENCIES, "app.js"]
    .map(file => readFileSync("static/" + file, "utf8")).join("\n;\n"));
}
