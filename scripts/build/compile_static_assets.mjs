import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [project, cwd, outdir, esbuild] = process.argv.slice(2);
if (!["github", "hf"].includes(project) || !cwd || !outdir || !esbuild) {
  throw new Error("Usage: compile_static_assets.mjs <github|hf> <cwd> <outdir> <esbuild>");
}

// Resolve against the source checkout, not the location of this driver.
const resources = createRequire(import.meta.url)(resolve(cwd, "static/reader-resources.js"));
for (const file of resources.buildFiles(project)) {
  if (file === "app.js") continue; // The caller builds the composed app separately.
  const result = spawnSync(esbuild, [
    `static/${file}`, ...resources.bundleArguments(file),
    "--minify", "--target=es2020", "--charset=utf8", "--legal-comments=none",
    `--outfile=${outdir}/${file}`,
  ], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
