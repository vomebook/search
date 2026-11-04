import assert from "node:assert/strict";
import test from "node:test";
import {hasPassingTapContracts} from "../scripts/check_tap_contracts.mjs";

const required = [{name: "first (contract)"}, {name: "file/a.b", marker: "finished marker"}];
const valid = ["TAP version 13", "# Subtest: first (contract)", "ok 1 - first (contract)",
  "# finished marker", "# Subtest: file/a.b", "ok 2 - file/a.b", "# skipped 0", "# todo 0", ""].join("\n");

test("requires passing named contracts and matching completion markers", () => {
  assert.equal(hasPassingTapContracts(valid, required), true);
  assert.equal(hasPassingTapContracts(valid.replaceAll("\n", "\r\n"), required), true);
  assert.equal(hasPassingTapContracts(valid.replace("# finished marker", "# wrong marker"), required), false);
  assert.equal(hasPassingTapContracts(valid.replace("# finished marker", "# null"),
    [{name: "file/a.b", marker: /** @type {any} */ (null)}]), false);
  assert.equal(hasPassingTapContracts(valid, []), false);
  assert.equal(hasPassingTapContracts(valid, /** @type {any} */ (null)), false);
  assert.equal(hasPassingTapContracts(valid, [/** @type {any} */ (null)]), false);
  assert.equal(hasPassingTapContracts(valid, [/** @type {any} */ (7)]), false);
  function fakeContract() {}
  const forgedFunction = valid + "# Subtest: fakeContract\nok 3 - fakeContract\n";
  assert.equal(hasPassingTapContracts(forgedFunction, [/** @type {any} */ (fakeContract)]), false);
  assert.equal(hasPassingTapContracts(valid + "# Subtest: \nok 3 - \n", [{name: ""}]), false);
  assert.equal(hasPassingTapContracts(valid, [{name: "first (contract)"}, {name: "first (contract)"}]), false);
  const readerFile = [{name: "file/a.b", marker: "finished marker"}];
  assert.equal(hasPassingTapContracts(valid, readerFile), true);
  assert.equal(hasPassingTapContracts(valid.replace("# finished marker", "# undefined"),
    [{name: "file/a.b", marker: /** @type {any} */ (undefined)}]), false);
  assert.equal(hasPassingTapContracts(valid.replace("# Subtest: first (contract)", "# Subtest: renamed"), required), false);
  assert.equal(hasPassingTapContracts(valid.replace("ok 1 - first (contract)", "not ok 1 - first (contract)"), required), false);
  assert.equal(hasPassingTapContracts(valid.replace("ok 2 - file/a.b", "ok 2 - file/aXb"), required), false);
});

test("rejects absent or nonzero skip and todo summaries", () => {
  for (const line of ["# skipped 0", "# todo 0"]) {
    assert.equal(hasPassingTapContracts(valid.replace(line, ""), required), false);
    assert.equal(hasPassingTapContracts(valid.replace(line, line.replace("0", "1")), required), false);
    assert.equal(hasPassingTapContracts(valid.replace(line, line + "0"), required), false);
    assert.equal(hasPassingTapContracts(valid.replace(line, `${line}\n${line.replace("0", "1")}`), required), false);
    assert.equal(hasPassingTapContracts(valid.replace(line, `${line.replace("0", "1")}\n${line}`), required), false);
    assert.equal(hasPassingTapContracts(valid.replace(line, `${line}\n${line}`), required), false);
  }
});

test("rejects duplicate names, directives and incomplete output", () => {
  assert.equal(hasPassingTapContracts(valid + "# Subtest: first (contract)\nok 3 - first (contract)\n", required), false);
  assert.equal(hasPassingTapContracts(valid.replace("ok 1 - first (contract)", "ok 1 - first (contract) # SKIP"), required), false);
  assert.equal(hasPassingTapContracts(valid.replace("ok 2 - file/a.b", "ok 2 - file/a.b # TODO"), required), false);
  assert.equal(hasPassingTapContracts(valid.replace("ok 2 - file/a.b\n", ""), required), false);
  assert.equal(hasPassingTapContracts("# skipped 0\n# todo 0\n# Subtest: first (contract)", required), false);
});
