"""Mutation tests for the static quality gate (no source files are changed)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class StaticGateTests(unittest.TestCase):
    def setUp(self):
        # Use the system temp directory even if a caller set TMPDIR to the
        # checkout; otherwise eslint may discover fixtures during its own scan.
        self.temp = tempfile.TemporaryDirectory(prefix="static-gate-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for filename in ("eslint.config.mjs", "ruff.toml"):
            shutil.copyfile(ROOT / filename, self.root / filename)
        # Node's module resolver follows this symlink to the already installed,
        # version-pinned dependencies; temporary fixtures never leave the host.
        (self.root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for directory in ("static", "static/vendor", "scripts", "tests"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / "static/index.html").write_text('<!doctype html><html><body><p id="ok">ok</p></body></html>')
        (self.root / "static/style.css").write_text("p { color: red; }")
        (self.root / "static/main.js").write_text("const valid = 1;\nconsole.log(valid);\n")
        (self.root / "static/vendor/ignored.js").write_text("not valid javascript ! !\n")
        (self.root / "scripts/check_python_static.py").write_bytes((ROOT / "scripts/check_python_static.py").read_bytes())
        (self.root / "scripts/sample.py").write_text("print('ok')\n")

    def run_check(self, *command):
        return subprocess.run(command, cwd=self.root, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, env=os.environ.copy(), timeout=30)

    def assert_check(self, result, success, message):
        self.assertEqual(result.returncode == 0, success, result.stdout)
        if message:
            self.assertIn(message, result.stdout)

    def test_javascript_reports_undefined_names_and_ignores_vendor(self):
        eslint = ROOT / "node_modules/eslint/bin/eslint.js"
        self.assert_check(self.run_check("node", eslint, "static"), True, "")
        (self.root / "static/main.js").write_text("console.log(missingStaticGateName);\n")
        self.assert_check(self.run_check("node", eslint, "static"), False, "no-undef")

    def test_python_reports_undefined_names_and_duplicate_tests(self):
        check = [sys.executable, "-B", "scripts/check_python_static.py"]
        self.assert_check(self.run_check(*check), True, "All checks passed")
        sample = self.root / "scripts/sample.py"
        sample.write_text("print(missing_static_gate_name)\n")
        self.assert_check(self.run_check(*check), False, "F821")
        sample.write_text("def test_duplicate(): pass\ndef test_duplicate(): pass\n")
        self.assert_check(self.run_check(*check), False, "F811")

    @unittest.skipUnless((ROOT / "pyrightconfig.json").exists(), "HF backend security gate")
    def test_backend_security_rule_is_enabled(self):
        backend = self.root / "backend"
        backend.mkdir()
        (backend / "risky.py").write_text("def run(value):\n    return eval(value)\n")
        check = [sys.executable, "-B", "scripts/check_python_static.py"]
        self.assert_check(self.run_check(*check), False, "S307")

    def test_unused_imports_are_checked_in_production_scripts(self):
        (self.root / "scripts/sample.py").write_text("import fractions\n")
        check = [sys.executable, "-B", "scripts/check_python_static.py"]
        self.assert_check(self.run_check(*check), False, "F401")

    def test_markup_checks_html_css_inline_javascript_and_jsonld(self):
        check = ["node", ROOT / "scripts/check_markup.mjs", self.root]
        self.assert_check(self.run_check(*check), True, "unique IDs")
        html = self.root / "static/index.html"
        css = self.root / "static/style.css"
        cases = [
            (html, '<!doctype html><html><body><div id="x"></div><b id="x"></b></body></html>', "duplicate id"),
            (html, '<!doctype html><html><body><div id="x" id="y"></div></body></html>', "duplicate-attribute"),
            (html, '<!doctype html><html><head><script>const = ;</script></head></html>', "inline JavaScript"),
            (html, '<!doctype html><html><head><script type="application/ld+json">{</script></head></html>', "invalid JSON-LD"),
            (css, 'p { color: red;', "CSS"),
        ]
        originals = {item: item.read_text() for item, _, _ in cases}
        for file, content, expected in cases:
            with self.subTest(expected=expected):
                file.write_text(content)
                self.assert_check(self.run_check(*check), False, expected)
                file.write_text(originals[file])

    def test_typescript_checks_selected_modules(self):
        compiler = ROOT / "node_modules/typescript/bin/tsc"
        source = self.root / "static/typed.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": False, "skipLibCheck": True, "target": "es2022"}, "files": ["static/typed.js"]}))
        source.write_text('/** @type {number} */ let value = 1;\nconsole.log(value);\n')
        check = ["node", compiler, "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('/** @type {number} */ let value = "wrong";\nconsole.log(value);\n')
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_reader_type_contract_rejects_wrong_arguments(self):
        source = self.root / "static/reader-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": False, "skipLibCheck": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/reader-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('VoiceOfMLReaderSecurity.createByteBudget(42);\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('VoiceOfMLReaderSecurity.createByteBudget("not a number");\n')
        self.assert_check(self.run_check(*check), False, "TS2345")

    def test_worker_type_contract_rejects_invalid_responses(self):
        source = self.root / "static/worker.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": False, "skipLibCheck": True, "target": "esnext", "lib": ["esnext", "webworker"]},
            "files": ["static/worker.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('const scope = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));\n'
                          'scope.addEventListener("fetch", event => event.respondWith(Promise.resolve(new Response())));\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('const scope = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));\n'
                          'scope.addEventListener("fetch", event => event.respondWith(Promise.resolve(42)));\n')
        self.assert_check(self.run_check(*check), False, "TS2345")

    def test_source_inventory_includes_production_trees(self):
        config = (ROOT / "eslint.config.mjs").read_text()
        package = json.loads((ROOT / "package.json").read_text())
        self.assertIn("eslint static scripts tests", package["scripts"]["lint"])
        self.assertIn('"static/**/*.{js,mjs}"', config)
        self.assertIn('"{scripts,tests}/**/*.{js,mjs}"', config)
        self.assertIn('"**/vendor/**"', config)
        self.assertIn('"**/foliate-reader/**"', config)
        self.assertIn('"no-undef"', config)
        self.assertIn('"tests/**/*.py" = ["F401", "F841"', (ROOT / "ruff.toml").read_text())
        paths = (self.root / "scripts/check_python_static.py").read_text()
        for expected in ('root / "app.py"', 'root / "backend"', 'root / "scripts"', 'root / "tests"'):
            self.assertIn(expected, paths)
        if (ROOT / "pyrightconfig.json").exists():
            self.assertTrue((ROOT / "backend/app.py").is_file())
            self.assertEqual(json.loads((ROOT / "pyrightconfig.json").read_text())["include"], ["app.py", "backend"])

    @unittest.skipUnless((ROOT / "pyrightconfig.json").exists(), "HF backend-only type gate")
    def test_pyright_checks_selected_backend_modules(self):
        module = self.root / "backend/example.py"
        module.parent.mkdir()
        config = self.root / "pyrightconfig.json"
        config.write_text(json.dumps({"include": ["backend/example.py"], "pythonVersion": "3.11",
                                      "typeCheckingMode": "basic"}))
        module.write_text("def value() -> int:\n    return 1\n")
        check = ["node", ROOT / "node_modules/pyright/index.js", "--project", config]
        self.assert_check(self.run_check(*check), True, "0 errors")
        module.write_text("def value() -> int:\n    return 'wrong'\n")
        self.assert_check(self.run_check(*check), False, "reportReturnType")


if __name__ == "__main__":
    unittest.main()
