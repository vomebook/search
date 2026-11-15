import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ensureSearchGeneration} from "./fetch_search_generation.mjs";
import {fetchReaderAssets} from "./fetch_reader_assets.mjs";

export async function prepareTestData(target = "data") {
  const {generation} = JSON.parse(await readFile(new URL("../../config/search-data.json", import.meta.url), "utf8"));
  const result = await ensureSearchGeneration(generation, "pages", target);
  // Independently refresh Reader metadata using its existing URL and validator.
  // A Reader failure fails preparation; the verified search files remain reusable.
  await fetchReaderAssets(join(target, "reader_assets.json.gz"));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error("usage: node scripts/data/prepare_test_data.mjs [OUTPUT_DIR]");
  console.log(JSON.stringify(await prepareTestData(process.argv[2])));
}
