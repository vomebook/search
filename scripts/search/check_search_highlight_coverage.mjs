import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

// Node 26/V8 scope: search/highlight.js and its pinned behavior contracts.
// The unhit branch guards an empty RegExp match, which ordinary escaped terms
// cannot produce. Reject an unloaded source or any passing-but-empty report.
const minimum = [100, 95.45, 100];
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/highlight.js",
  ...minimum.map((value, index) => `--test-coverage-${["lines", "branches", "functions"][index]}=${value}`),
  "tests/search/highlight/test_search_highlight_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const rows = (result.stdout || "").split(/\r?\n/).flatMap(line => {
  const match = /^\s*#\s*highlight\.js\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});
const text = result.stdout || "";
const required = [
  "HTML escaping preserves text and protects attribute and markup delimiters",
  "highlighting matches raw text without marking tags or encoded entities",
  "highlight regexp is case-insensitive, deduplicated, reusable and literal",
  "highlight cache is bounded FIFO and a hit does not change insertion order"
].map(name => ({name}));
if (result.status !== 0 || rows.length !== 1 || rows[0].some((value, index) => value < minimum[index]) ||
    !hasPassingTapContracts(text, required)) {
  console.error("Search highlight coverage requires passing named contracts and exactly one source row above each minimum");
  process.exitCode = 1;
}
