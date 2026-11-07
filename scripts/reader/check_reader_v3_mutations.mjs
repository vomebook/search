// Isolated copies retain the real contract and the original relative imports.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';

const source = readFileSync('static/reader/pdf/reader-v3.mjs', 'utf8');
const probes = [
  ['JSON path type', 'if (!ref || typeof ref.path !== "string" || !["vomebook/pdf-pages-v2"', 'if (!ref || !["vomebook/pdf-pages-v2"', 'resource paths use the real contract and reject JSON coercion', 'Missing expected exception (invalid).'],
  ['page-map null', '!p || p.page !== i + 1', 'p.page !== i + 1', 'page map null entry', "TypeError: Cannot read properties of null (reading 'page')"],
  ['partition null', '!part || !integer(part.start)', '!integer(part.start)', 'manifest preview null partition', "TypeError: Cannot read properties of null (reading 'start')"],
  ['text layer entry null', '!entry || !layer || layer.version', '!layer || layer.version', 'text layer null entry', "TypeError: Cannot read properties of null (reading 'page')"],
  ['text index null', 'if (!value || value.version !== 1 || value.kind !== "pdf-text-layer-index"', 'if (value.version !== 1 || value.kind !== "pdf-text-layer-index"', 'text index root null', "TypeError: Cannot read properties of null (reading 'version')"],
  ['text partition null', 'if (!value || value.version !== 1 || value.kind !== "pdf-text-partition"', 'if (value.version !== 1 || value.kind !== "pdf-text-partition"', 'text partition root null', "TypeError: Cannot read properties of null (reading 'version')"],
  ['text partition entry null', '!p || p.page !== part.start + i', 'p.page !== part.start + i', 'text partition entry null', "TypeError: Cannot read properties of null (reading 'page')"]
];
// Node versions may omit unmatched tests or report them as SKIP. Neither may run.
function validTap(text, target, passing) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const results = lines.filter(line => /^(?:not )?ok \d+ - /.test(line));
  const active = results.filter(line => !/ # SKIP(?: |$)/.test(line));
  const skipped = results.length - active.length;
  const expected = `${passing ? 'ok' : 'not ok'} 1 - ${target}`;
  const summary = {tests: results.length, pass: passing ? 1 : 0, fail: passing ? 0 : 1,
    skipped, cancelled: 0, todo: 0, suites: 0};
  return lines[0] === 'TAP version 13' && active.length === 1 && active[0] === expected &&
    lines.filter(line => line === `# Subtest: ${target}`).length === 1 &&
    lines.filter(line => /^# Subtest: /.test(line)).length === results.length &&
    lines.filter(line => /^1\.\.\d+$/.test(line)).length === 1 && lines.includes(`1..${results.length}`) &&
    Object.entries(summary).every(([key, value]) =>
      lines.filter(line => line.startsWith(`# ${key} `)).length === 1 && lines.includes(`# ${key} ${value}`));
}
let killed = 0, survived = 0, errors = 0;
for (const [name, before, after, test, diagnostic] of probes) {
  if (source.split(before).length !== 2) { console.error(`${name}: expected exactly one target`); errors++; continue; }
  const temp = mkdtempSync(join(tmpdir(), 'reader-v3-mutant-'));
  try {
    for (const path of ['static/reader/core/reader-contract.js', 'tests/reader/pdf-v3/test_reader_v3_untrusted.mjs']) {
      mkdirSync(dirname(join(temp, path)), {recursive:true});
      copyFileSync(path, join(temp, path));
    }
    const target = join(temp, 'static/reader/pdf/reader-v3.mjs');
    mkdirSync(dirname(target), {recursive:true});
    const escaped = test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const args = ['--test', '--test-isolation=none', '--test-reporter=tap', `--test-name-pattern=^${escaped}$`, 'tests/reader/pdf-v3/test_reader_v3_untrusted.mjs'];
    const run = () => spawnSync(process.execPath, args, {cwd:temp, encoding:'utf8', timeout:15000, killSignal:'SIGKILL'});
    writeFileSync(target, source);
    const baseline = run();
    if (baseline.error || baseline.signal || baseline.status !== 0 || !validTap(baseline.stdout, test, true)) {
      errors++; console.error(`${name}: baseline failed\n${baseline.stdout || ''}`); continue;
    }
    writeFileSync(target, source.replace(before, after));
    const result = run();
    if (result.error || result.signal || result.status === null) { errors++; console.error(`${name}: execution error`); continue; }
    if (result.status === 0) { survived++; console.error(`${name}: survived`); continue; }
    const output = (result.stdout || '').replace(/\r\n/g, '\n');
    const failure = new RegExp(`^not ok \\d+ - ${escaped}\\n([\\s\\S]*?)(?=\\n(?:# Subtest:|1\\.\\.))`, 'm').exec(output);
    const expectedError = diagnostic.startsWith('TypeError:')
      ? `  error: |-\n    The "invalid" validation function is expected to return "true". Received false\n    \n    Caught error:\n    \n    ${diagnostic}\n`
      : `  error: '${diagnostic}'\n`;
    if (!validTap(output, test, false) || !failure || !failure[1].includes(expectedError) ||
        !/^  code: 'ERR_ASSERTION'$/m.test(failure[1]) || !/^  name: 'AssertionError'$/m.test(failure[1])) {
      errors++; console.error(`${name}: unexpected failure\n${output}`); continue;
    }
    killed++; console.log(`${name}: killed by ${test} (${diagnostic})`);
  } finally { rmSync(temp, {recursive:true, force:true}); }
}
console.log(JSON.stringify({scope:'targeted reader-v3 mutations', total:probes.length, killed, survived, errors}));
if (killed !== probes.length || survived || errors) process.exitCode = 1;
