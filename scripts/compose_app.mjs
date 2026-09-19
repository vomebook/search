import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// One ordered dependency list owns the production app and its shell scripts.
// Keep classic-script globals for the host; each dependency owns its own scope.
export const APP_DEPENDENCIES = Object.freeze([
  "reader-resources.js", "reader-contract.js", "reader-navigation.js",
  "search-session.js", "download-controller.js"
]);

export function stripBundledScripts(html) {
  return html.replace(/<script\s+src="(?:\/?(?:search\/)?static\/)([^"/]+)"\s*>\s*<\/script>\s*/g,
    (tag, filename) => APP_DEPENDENCIES.includes(filename) ? "" : tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write([...APP_DEPENDENCIES, "app.js"]
    .map(file => readFileSync("static/" + file, "utf8")).join("\n;\n"));
}
