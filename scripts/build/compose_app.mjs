import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const resources = createRequire(import.meta.url)(resolve("static/reader-resources.js"));
// The host list excludes the standalone Pages Worker and its dependencies.
export const APP_DEPENDENCIES = Object.freeze([
  "reader-resources.js", "reader/core/reader-contract.js",
  ...resources.searchHostFiles,
]);

export function stripBundledScripts(html) {
  return html.replace(/<script\s+src="(?:\/?(?:search\/)?static\/)([^"\s]+)"\s*>\s*<\/script>\s*/g,
    (tag, filename) => APP_DEPENDENCIES.includes(filename) ? "" : tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write([...APP_DEPENDENCIES, "app.js"]
    .map(file => readFileSync("static/" + file, "utf8")).join("\n;\n"));
}
