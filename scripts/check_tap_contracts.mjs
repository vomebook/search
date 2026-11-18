// Shared TAP contract checks for coverage gates; percentages stay gate-owned.

/** Verify a complete flat Node TAP report, independently of a fixed test count.
 * @param {string} text */
export function hasCompleteFlatTapReport(text) {
  const lines = text.split(/\r?\n/);
  const headers = lines.filter(line => /^(?:# )?TAP version\b/.test(line));
  if (lines[0] !== "TAP version 13" || headers.length !== 1) return false;
  const summary = lines.filter(line => /^(?:# )?1\.\.|^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(line));
  const planLine = summary[0] || '';
  const count = /^1\.\.([1-9]\d*)$/.exec(planLine)?.[1];
  if (!count || summary.length !== 9 || !/^# duration_ms \d+(?:\.\d+)?$/.test(summary[8] || '')) return false;
  const expected = [`# tests ${count}`, '# suites 0', `# pass ${count}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'];
  if (expected.some((line, index) => line !== summary[index + 1])) return false;
  const plan = lines.indexOf(planLine);
  if (summary.some((line, index) => lines[plan + index] !== line)) return false;
  const results = lines.filter(line => /^\s*(?:not ok|ok)\b/.test(line));
  if (String(results.length) !== count || lines.slice(plan).some(line => /^\s*(?:not ok|ok)\b/.test(line))) return false;
  return results.every((line, index) => line.startsWith(`ok ${index + 1} - `) &&
    line.length > `ok ${index + 1} - `.length && !/\s+#\s*(?:SKIP|TODO)\b/i.test(line));
}
/** @param {string} text @param {{name: string, marker?: string}[]} required */
export function hasPassingTapContracts(text, required) {
  const lines = text.split(/\r?\n/);
  const skipped = lines.filter(line => /^# skipped(?:\s|$)/.test(line));
  const todo = lines.filter(line => /^# todo(?:\s|$)/.test(line));
  if (!(skipped.length === 1 && skipped[0] === "# skipped 0" && todo.length === 1 && todo[0] === "# todo 0")) return false;
  if (!Array.isArray(required) || required.length === 0 ||
      required.some(contract => !contract || typeof contract !== "object" || typeof contract.name !== "string" || !contract.name ||
        ("marker" in contract && typeof contract.marker !== "string"))) return false;
  if (new Set(required.map(contract => contract.name)).size !== required.length) return false;
  return required.every(({name, marker}) => {
      const index = lines.indexOf(`# Subtest: ${name}`);
      return index >= 0 && lines.lastIndexOf(`# Subtest: ${name}`) === index &&
        (marker === undefined || lines[index - 1] === `# ${marker}`) &&
        new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(lines[index + 1] || "");
    });
}
