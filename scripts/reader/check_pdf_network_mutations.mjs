import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A deliberately small safety-mutation gate, not exhaustive mutation
// coverage. Mutate isolated modules only; never write the production source.
const source = readFileSync("static/reader/pdf/reader-pdf-network.mjs", "utf8");
const cacheSource = readFileSync("static/reader/pdf/reader-pdf-range-cache.mjs", "utf8");
const hintsSource = readFileSync("static/reader/pdf/reader-pdf-range-hints.mjs", "utf8");
const backpressure = readFileSync("tests/reader/pdf-network/test_reader_pdf_backpressure.mjs", "utf8");
const contracts = readFileSync("tests/reader/pdf-network/test_reader_pdf_network_contract.mjs", "utf8");
const hintContracts = readFileSync("tests/reader/pdf-network/test_pdf_range_hints_contract.mjs", "utf8");
const probes = [{name:"post-admission cancellation", test:backpressure, before:
  "        signal.throwIfAborted();\n      }\n      response = null;", after:
  "      }\n      response = null;", diagnostic:"no native dispatch after admission cancellation"},
{name:"stale identity", test:contracts, before:"      if (versions.has(url)) inconsistent = true;",
  after:"      if (versions.has(url)) inconsistent = false;", diagnostic:"AssertionError"},
{name:"changed ETag", test:contracts, before:"checked.etag === previous.etag && checked.total === previous.total",
  after:"checked.total === previous.total", diagnostic:"AssertionError"},
{name:"weak ETag", test:contracts, before:'!/^"[^"\\r\\n]+"$/.test(etag || "") && last+1 < total',
  after:"false && last+1 < total", diagnostic:"AssertionError"},
{name:"cache input ownership", test:contracts, cache:true, before:"    const retained = value.slice();",
  after:"    const retained = value;", diagnostic:"AssertionError"},
{name:"cache output ownership", test:contracts, cache:true, before:"return row.bytes.slice(begin - row.begin, end - row.begin);",
  after:"return row.bytes.subarray(begin - row.begin, end - row.begin);", diagnostic:"detached ArrayBuffer"},
{name:"sparse tree in stream", test:hintContracts, hints:true, before:"  const stop = stream ? stream.index : head.length;\n  let object;",
  after:"  const stop = head.length;\n  let object;", diagnostic:"fake sparse tree in stream"},
{name:"small-file fallback", test:hintContracts, hints:true, before:"!Number.isSafeInteger(total) || total < 8 * 1024 * 1024 ||",
  after:"!Number.isSafeInteger(total) || total < 0 ||", diagnostic:"small files must retain fallback"}];
let killed = 0, survived = 0, errors = 0;
for (const probe of probes) {
  const pieces = (probe.hints ? hintsSource : probe.cache ? cacheSource : source).split(probe.before);
  if (pieces.length !== 2) {
    console.error(`${probe.name}: expected exactly one mutation target`);errors++;continue;
  }
  const directory = mkdtempSync(join(tmpdir(), "reader-pdf-mutation-"));
  try {
    const module = join(directory, "reader-pdf-network.mjs"), runner = join(directory, "test.mjs");
    writeFileSync(module, probe.cache || probe.hints ? source : pieces.join(probe.after));
    writeFileSync(join(directory, "reader-pdf-range-cache.mjs"), probe.cache ? pieces.join(probe.after) : cacheSource);
    writeFileSync(join(directory, "reader-pdf-range-hints.mjs"), probe.hints ? pieces.join(probe.after) : hintsSource);
    const imported = "../../../static/reader/pdf/reader-pdf-network.mjs";
    if (probe.test.split(imported).length !== 2) throw new Error("expected exactly one PDF network import");
    let test = probe.test.replace(imported, "./reader-pdf-network.mjs");
    if (probe.hints) {
      const dependency = "../../../static/reader/pdf/reader-pdf-range-hints.mjs";
      if (test.split(dependency).length !== 2) throw new Error("expected exactly one PDF hints import");
      test = test.replace(dependency, "./reader-pdf-range-hints.mjs");
    }
    writeFileSync(runner, test);
    const result = spawnSync(process.execPath, [runner], {encoding:"utf8", timeout:15000});
    if (result.error || result.signal || result.status === null) {
      errors++;console.error(`${probe.name}: execution failed or timed out`);continue;
    }
    if (result.status === 0) {survived++;console.error(`${probe.name} mutant survived`);continue;}
    if (!(result.stderr || "").includes(probe.diagnostic)) {
      errors++;console.error(`${probe.name}: unexpected failure, not a killed mutant`);continue;
    }
    killed++;
  } finally { rmSync(directory,{recursive:true,force:true}); }
}
console.log(JSON.stringify({scope:"targeted PDF network safety mutations",total:probes.length,killed,survived,errors}));
if (killed !== probes.length || survived || errors) process.exitCode = 1;
