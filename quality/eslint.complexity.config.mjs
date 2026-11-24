import { createRequire } from "node:module";
import lintConfig from "../eslint.config.mjs";
import { programComplexityRule } from "./program-complexity.mjs";

const localRequire = createRequire(import.meta.url);
const eslintPackage = localRequire.resolve("eslint/package.json");
const eslintRequire = createRequire(eslintPackage);
for (const [name, actual, expected] of [
  ["ESLint", localRequire(eslintPackage).version, "10.15.0"],
  ["Espree (from ESLint)", eslintRequire("espree/package.json").version, "11.2.0"],
]) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}; review rule parity before updating`);
}

// Keep the repository's complete flat config. The checker passes the same
// CLI flags and built-in complexity rule as v1, and adds only this rule.
export default [
  ...lintConfig,
  {
    plugins: { "book-complexity": { rules: { program: programComplexityRule } } },
    rules: { "book-complexity/program": "error" },
  },
];
