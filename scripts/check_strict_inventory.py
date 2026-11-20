"""Fail when new production sources are outside existing strict type gates.

The JSON inventory is the explicit legacy debt, not a source exclusion from
basic checks. Removing an entry requires adding its file to a strict gate.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DEBT_FILE = "quality/baselines/strict-inventory-debt.json"
STRICT_FRONTEND_PROJECTS = (
    "config/types/jsconfig.strict.json",
    "config/types/jsconfig.service-worker-strict.json",
    "config/types/jsconfig.chapter-worker-strict.json",
    "config/types/jsconfig.search-worker-text-strict.json",
    "config/types/jsconfig.search-index-worker-strict.json",
)
REQUIRED_FRONTEND_FLAGS = (
    "noUncheckedIndexedAccess", "exactOptionalPropertyTypes", "noImplicitOverride",
    "noImplicitReturns", "noFallthroughCasesInSwitch",
)


def browser_sources(root: Path) -> set[str]:
    return {path.relative_to(root).as_posix() for path in (root / "static").rglob("*")
            if path.is_file() and path.suffix in (".js", ".mjs")
            and path.relative_to(root).parts[1] != "vendor"}


def backend_sources(root: Path) -> set[str]:
    # Search deploys static assets and the SEO builder; app/backend may be added later.
    paths = list((root / "backend").rglob("*.py")) + list((root / "scripts/build").rglob("*.py"))
    if (root / "app.py").is_file():
        paths.append(root / "app.py")
    return {path.relative_to(root).as_posix() for path in paths
            if "__pycache__" not in path.relative_to(root).parts}


def inventory_errors(root: Path, js_strict: set[str], js_basic: set[str],
                     py_strict: set[str], debt: dict[str, list[str]],
                     previous_debt: dict[str, list[str]] | None = None) -> list[str]:
    groups = {
        "browser_js": (browser_sources(root), js_strict),
        "backend_python": (backend_sources(root), py_strict),
    }
    errors: list[str] = []
    if set(debt) != set(groups):
        errors.append("debt inventory must contain browser_js and backend_python only")
    for name, (sources, strict) in groups.items():
        baseline = debt.get(name, [])
        if len(baseline) != len(set(baseline)):
            errors.append(f"duplicate {name} debt entries")
        if previous_debt is not None:
            for path in sorted(set(baseline) - set(previous_debt.get(name, []))):
                errors.append(f"strict debt cannot grow: {path}")
        missing = sources - strict
        for path in sorted(missing - set(baseline)):
            errors.append(f"new {name} source is not in a strict gate: {path}")
        for path in sorted(set(baseline) - missing):
            errors.append(f"stale {name} debt entry (remove it): {path}")
    for path in sorted(browser_sources(root) - js_basic):
        errors.append(f"browser source is not in the basic gate: {path}")
    for path in sorted(backend_sources(root)):
        if re.search(r"#\s*(?:type:\s*ignore|pyright:\s*(?:ignore|strict|basic|off))\b",
                     (root / path).read_text()):
            errors.append(f"inline Python type suppression or mode directive is forbidden: {path}")
    for path in sorted(browser_sources(root)):
        if re.search(r"@ts-(?:nocheck|ignore|expect-error)\b", (root / path).read_text()):
            errors.append(f"inline JavaScript type suppression is forbidden: {path}")
    return errors


def compiler_output(root: Path, config: str, flag: str) -> str:
    if config not in ("config/types/jsconfig.check.json", "config/types/jsconfig.service-worker.json",
                      "config/types/jsconfig.service-worker-strict.json", "config/types/jsconfig.chapter-worker-strict.json",
                      "config/types/jsconfig.search-worker-text-strict.json", "config/types/jsconfig.search-index-worker-strict.json",
                      "config/types/jsconfig.strict.json"):
        raise ValueError("unknown TypeScript configuration")
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node is required to inspect the TypeScript graph")
    compiler = root / "node_modules/typescript/bin/tsc"
    # The executable is resolved from PATH and all remaining arguments are
    # fixed project paths selected from the allowlist above, never shell input.
    result = subprocess.run([node, str(compiler), "--project", config, flag],  # noqa: S603
                            cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    if result.returncode:
        raise RuntimeError(f"{config}: {result.stdout}")
    return result.stdout


def compiler_files(root: Path, config: str) -> set[str]:
    paths: set[str] = set()
    for line in compiler_output(root, config, "--listFilesOnly").splitlines():
        path = Path(line).resolve()
        if path.is_relative_to(root):
            paths.add(path.relative_to(root).as_posix())
    return paths


def main() -> int:
    types = json.loads((ROOT / "package.json").read_text())["scripts"]["types"]
    commands = {command.strip() for command in types.split("&&")}
    for project in STRICT_FRONTEND_PROJECTS:
        if f"tsc --project {project}" not in commands:
            raise RuntimeError(f"{project}: npm run types must compile this strict frontend project")
    for config in STRICT_FRONTEND_PROJECTS:
        options = json.loads(compiler_output(ROOT, config, "--showConfig"))["compilerOptions"]
        # --showConfig resolves extends, but may omit strict's implied flags.
        if (not all(options.get(key) is True for key in ("strict", "allowJs", "checkJs", "noEmit"))
                or any(options.get(key, True) is not True for key in (
                    "strictNullChecks", "noImplicitAny", "strictFunctionTypes", "strictBindCallApply",
                    "strictPropertyInitialization", "noImplicitThis", "useUnknownInCatchVariables",
                    "alwaysStrict", "strictBuiltinIteratorReturn"))):
            raise RuntimeError(f"{config}: strict JavaScript checking must remain enabled")
        for flag in REQUIRED_FRONTEND_FLAGS:
            if options.get(flag) is not True:
                raise RuntimeError(f"{config}: effective {flag} must be enabled")
    basic = (compiler_files(ROOT, "config/types/jsconfig.check.json")
             | compiler_files(ROOT, "config/types/jsconfig.service-worker.json"))
    strict = set().union(*(compiler_files(ROOT, project) for project in STRICT_FRONTEND_PROJECTS))
    py_config = json.loads((ROOT / "pyrightconfig.strict.json").read_text())
    if py_config.get("typeCheckingMode") != "strict":
        raise RuntimeError("backend strict type gate must use strict mode")
    py_strict = set(py_config["include"])
    debt = json.loads((ROOT / DEBT_FILE).read_text())
    previous = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) == 2 else None
    if len(sys.argv) > 2:
        raise RuntimeError("usage: python scripts/check_strict_inventory.py [BASELINE_DEBT_JSON]")
    browser = browser_sources(ROOT)
    errors = inventory_errors(ROOT, strict, basic, py_strict, debt, previous)
    for path in sorted((browser - strict) & set(debt.get("browser_js", []))):
        errors.append(f"browser source must be checked with all five frontend flags: {path}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    python_sources = backend_sources(ROOT)
    print(f"Strict inventory: JS {len(browser & strict)}/{len(browser)}; "
          f"production Python {len(python_sources & py_strict)}/{len(python_sources)}; "
          "no new ungated files; all five frontend flags enforced")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        import tempfile
        import unittest

        class InventoryTests(unittest.TestCase):
            def test_inventory_and_ratchet(self):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / "static").mkdir()
                    (root / "scripts/build").mkdir(parents=True)
                    (root / "static/old.js").write_text("const old = 1;\n")
                    (root / "scripts/build/seo.py").write_text("value = 1\n")
                    debt = {"browser_js": ["static/old.js"], "backend_python": []}
                    basic, strict_py = {"static/old.js"}, {"scripts/build/seo.py"}
                    check = lambda js, py, baseline, previous=None: inventory_errors(  # noqa: E731
                        root, js, basic, py, baseline, previous)
                    self.assertEqual(check(set(), strict_py, debt), [])
                    (root / "static/new.mjs").write_text("const fresh = 1;\n")
                    (root / "scripts/build/new.py").write_text("value = 1\n")
                    errors = "\n".join(check(set(), strict_py, debt))
                    self.assertIn("new browser_js source", errors)
                    self.assertIn("browser source is not in the basic gate", errors)
                    self.assertIn("new backend_python source", errors)
                    expanded = {"browser_js": ["static/old.js", "static/new.mjs"],
                                "backend_python": ["scripts/build/new.py"]}
                    self.assertIn("strict debt cannot grow: static/new.mjs",
                                  check(set(), strict_py, expanded, debt))
                    (root / "static/new.mjs").unlink()
                    (root / "scripts/build/new.py").unlink()
                    self.assertIn("stale browser_js debt entry (remove it): static/old.js",
                                  check({"static/old.js"}, strict_py, debt))
                    (root / "static/old.js").write_text("// @ts-nocheck\n")
                    (root / "scripts/build/seo.py").write_text("x = y  # type: ignore\n")
                    errors = "\n".join(check(set(), strict_py, debt))
                    self.assertIn("inline JavaScript type suppression", errors)
                    self.assertIn("inline Python type suppression", errors)

            def test_runtime_strict_options_and_nested_sources(self):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / "scripts").mkdir()
                    shutil.copy(__file__, root / "scripts/check_strict_inventory.py")
                    (root / "node_modules").mkdir()
                    (root / "node_modules/typescript").symlink_to(ROOT / "node_modules/typescript", target_is_directory=True)
                    (root / "config/types").mkdir(parents=True)
                    (root / "quality/baselines").mkdir(parents=True)
                    (root / "static").mkdir()
                    (root / "static/main.js").write_text("const value = 1;\n")
                    (root / "pyrightconfig.strict.json").write_text(json.dumps({"typeCheckingMode": "strict", "include": []}))
                    (root / DEBT_FILE).write_text(json.dumps({"browser_js": [], "backend_python": []}))
                    options = {"strict": True, "allowJs": True, "checkJs": True, "noEmit": True}
                    configs = ("jsconfig.strict.json", "jsconfig.service-worker-strict.json",
                               "jsconfig.chapter-worker-strict.json", "jsconfig.search-worker-text-strict.json",
                               "jsconfig.search-index-worker-strict.json")
                    options.update(dict.fromkeys(REQUIRED_FRONTEND_FLAGS, True))
                    all_configs = (*configs, "jsconfig.check.json", "jsconfig.service-worker.json")
                    package = root / "package.json"
                    commands = [f"tsc --project config/types/{config}" for config in configs]

                    def configure_types(commands):
                        package.write_text(json.dumps({"scripts": {"types": " && ".join(commands)}}))

                    configure_types(commands)
                    for config in all_configs:
                        (root / "config/types" / config).write_text(json.dumps({
                            "compilerOptions": options, "files": ["../../static/main.js"]}))

                    def run():
                        return subprocess.run([sys.executable, str(root / "scripts/check_strict_inventory.py")],
                                              cwd=root, text=True, capture_output=True, timeout=60)  # noqa: S603

                    result = run()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    configure_types(commands[:-1])
                    result = run()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("npm run types must compile this strict frontend project", result.stderr)
                    configure_types(commands)
                    for config in configs:
                        path = root / "config/types" / config
                        for option in ("strictNullChecks", "noImplicitAny", "strictFunctionTypes", "strictBindCallApply",
                                       "strictPropertyInitialization", "noImplicitThis", "useUnknownInCatchVariables",
                                       "alwaysStrict", "strictBuiltinIteratorReturn"):
                            # Exercise inherited overrides as well as the real CLI entry point.
                            (root / "config/types/base.json").write_text(json.dumps({
                                "compilerOptions": {**options, option: False}}))
                            path.write_text(json.dumps({"extends": "./base.json", "files": ["../../static/main.js"]}))
                            result = run()
                            self.assertNotEqual(result.returncode, 0, (config, option))
                            self.assertIn("strict JavaScript checking must remain enabled", result.stderr)
                        path.write_text(json.dumps({"compilerOptions": options, "files": ["../../static/main.js"]}))
                    worker_config = root / "config/types/jsconfig.chapter-worker-strict.json"
                    base = root / "config/types/base.json"
                    base.write_text(json.dumps({"compilerOptions": options}))
                    for flag in REQUIRED_FRONTEND_FLAGS:
                        with self.subTest(flag=flag):
                            worker_config.write_text(json.dumps({"extends": "./base.json",
                                "compilerOptions": {flag: False}, "files": ["../../static/main.js"]}))
                            result = run()
                            self.assertNotEqual(result.returncode, 0)
                            self.assertIn(f"effective {flag} must be enabled", result.stderr)
                    worker_config.write_text(json.dumps({"extends": "./base.json", "files": ["../../static/main.js"]}))
                    (root / "static/worker.js").write_text("const worker = 1;\n")
                    index_config = root / "config/types/jsconfig.search-index-worker-strict.json"
                    for config in ("jsconfig.check.json", "jsconfig.search-index-worker-strict.json"):
                        (root / "config/types" / config).write_text(json.dumps({"compilerOptions": options,
                            "files": ["../../static/main.js", "../../static/worker.js"]}))
                    self.assertIn("static/worker.js", compiler_files(root, "config/types/jsconfig.search-index-worker-strict.json"))
                    self.assertEqual(run().returncode, 0)
                    index_config.write_text(json.dumps({"compilerOptions": options, "files": ["../../static/main.js"]}))
                    self.assertIn("new browser_js source is not in a strict gate: static/worker.js", run().stderr)
                    (root / "static/worker.js").unlink()
                    (root / "config/types/jsconfig.check.json").write_text(json.dumps({"compilerOptions": options,
                        "files": ["../../static/main.js"]}))
                    (root / "static/vendor").mkdir()
                    (root / "static/vendor/ignored.js").write_text("const x = 1;\n")
                    (root / "static/reader/vendor").mkdir(parents=True)
                    (root / "static/reader/vendor/new.js").write_text("const x = 1;\n")
                    (root / "static/foliate-reader").mkdir()
                    (root / "static/foliate-reader/new.js").write_text("const x = 1;\n")
                    result = run()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("static/reader/vendor/new.js", result.stderr)
                    self.assertIn("static/foliate-reader/new.js", result.stderr)
                    self.assertNotIn("static/vendor/ignored.js", result.stderr)

        unittest.main(argv=[sys.argv[0]])
    else:
        raise SystemExit(main())
