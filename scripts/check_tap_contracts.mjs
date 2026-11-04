// Shared TAP contract checks for coverage gates; percentages stay gate-owned.
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
