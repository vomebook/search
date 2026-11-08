import {spawnSync} from "node:child_process";
import {hasPassingTapContracts} from "../check_tap_contracts.mjs";

const result = spawnSync(process.execPath, [
  "--test", "--test-reporter=tap", "--test-isolation=none", "--experimental-test-coverage",
  "--test-coverage-include=**/static/search/presentation/sidebar-render.js",
  "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100",
  "tests/search/baselines/test_sidebar_markup_baseline.mjs",
  "tests/search/baselines/test_sidebar_markup_differential.mjs",
  "tests/search/baselines/test_sidebar_markup_module.mjs"
], {encoding:"utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
const text=result.stdout || "";
const rows=text.split(/\r?\n/).filter(line =>
  /^\s*#\s*sidebar-render\.js\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|\s*100(?:\.0+)?\s*\|/.test(line));
const required=[
  "empty sidebar preserves original output and scroll restore timing",
  "folder and file markup preserve site-specific attributes, escaping and order",
  "missing folder paths keep each site original serialization",
  "exceptions before final assignment do not restore scroll or partially replace DOM",
  "DOM assignment exceptions prevent scroll restoration",
  "empty, folder and file markup remains byte-identical to each host",
  "repository callback rebinding is observed on later rows",
  "array getters and site-specific iterator semantics remain unchanged",
  "object-valued escaped labels preserve coercion and callback order",
  "exceptions leave the original DOM intact and do not restore scroll",
  "both surfaces preserve folder and reader attribute distinctions",
  "null families and empty data leave no markup",
  "dynamic lists use the original surface iteration behavior",
  "input and injected presentation failures propagate"
].map(name=>({name}));
if (result.status !== 0 || rows.length !== 1 || !hasPassingTapContracts(text,required)) {
  console.error("Sidebar markup requires passing named contracts and exactly one fully covered source row");
  process.exitCode=1;
}
