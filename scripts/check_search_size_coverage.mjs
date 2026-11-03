import {spawnSync} from "node:child_process";

// Only the extracted size-format module, as exercised by the compatibility
// vectors; an unloaded file must not be accepted as an empty 100% report.
const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/size-format.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/test_search_size_format.js", "tests/test_search_size_render_contract.js"
], {encoding: "utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text = result.stdout || "";
const lines = text.split(/\r?\n/);
const rows = lines.filter(line =>
  /^\s*#\s*size-format\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required = ["tests/test_search_size_format.js", "display preserves binary boundaries and historical precision",
  "display retains original coercion and empty-value behavior", "display retains prototype and normalized cache behavior"];
if (result.status !== 0 || rows.length !== 1 || !/^# skipped 0$/m.test(text) || !/^# todo 0$/m.test(text) ||
    required.some(name => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index < 0 || lines.lastIndexOf(`# Subtest: ${name}`) !== index ||
        !new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "") ||
        (name === "tests/test_search_size_format.js" &&
         lines[index - 1] !== "# search size formatting, parser compatibility and URL round trips passed");
    })) {
  console.error("Search size coverage gate requires passing named tests and exactly one fully covered source row");
  process.exitCode = 1;
}
