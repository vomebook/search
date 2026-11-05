"""Mutation tests for the static quality gate (no source files are changed)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class StaticGateTests(unittest.TestCase):
    def setUp(self):
        # Honour a disk-backed TMPDIR, but keep fixtures outside the checkout so
        # eslint never discovers them during its own scan.
        temp_root = Path(tempfile.gettempdir()).resolve()
        if temp_root == ROOT or ROOT in temp_root.parents:
            temp_root = Path("/tmp")
        self.temp = tempfile.TemporaryDirectory(prefix="static-gate-", dir=temp_root)
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

    def test_strict_javascript_gate_rejects_implicit_any(self):
        config = json.loads((ROOT / "jsconfig.strict.json").read_text())
        self.assertTrue(config["compilerOptions"]["strict"])
        for relative in config["files"]:
            source = self.root / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, source)
        (self.root / "jsconfig.strict.json").write_text(json.dumps(config))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", "jsconfig.strict.json"]
        self.assert_check(self.run_check(*check), True, "")
        source = self.root / config["files"][0]
        source.write_text(source.read_text() + "\nfunction strictProbe(value) { return value; }\nstrictProbe(1);\n")
        self.assert_check(self.run_check(*check), False, "TS7006")
        shutil.copyfile(ROOT / config["files"][0], source)
        source = self.root / "static/reader/pdf/reader-engine-preload.js"
        self.assertIn(str(source.relative_to(self.root)), config["files"])
        source.write_text(source.read_text() + "\nfunction strictPreloadProbe(value) { return value; }\nstrictPreloadProbe(1);\n")
        self.assert_check(self.run_check(*check), False, "TS7006")
        shutil.copyfile(ROOT / "static/reader/pdf/reader-engine-preload.js", source)
        source = self.root / "static/reader/formats/reader-format-adapters.js"
        self.assertIn(str(source.relative_to(self.root)), config["files"])
        source.write_text(source.read_text() + "\nfunction strictAdapterProbe(value) { return value; }\nstrictAdapterProbe(1);\n")
        self.assert_check(self.run_check(*check), False, "TS7006")
        shutil.copyfile(ROOT / "static/reader/formats/reader-format-adapters.js", source)
        source = self.root / "static/reader/formats/reader-chapter-repository.js"
        self.assertIn(str(source.relative_to(self.root)), config["files"])
        source.write_text(source.read_text() + "\nfunction strictChapterProbe(value) { return value; }\nstrictChapterProbe(1);\n")
        self.assert_check(self.run_check(*check), False, "TS7006")
        shutil.copyfile(ROOT / "static/reader/formats/reader-chapter-repository.js", source)
        source = self.root / "static/reader/formats/reader-section-virtualizer.js"
        self.assertIn(str(source.relative_to(self.root)), config["files"])
        source.write_text(source.read_text() + "\nfunction strictVirtualProbe(value) { return value; }\nstrictVirtualProbe(1);\n")
        self.assert_check(self.run_check(*check), False, "TS7006")
        shutil.copyfile(ROOT / "static/reader/formats/reader-section-virtualizer.js", source)
        source = self.root / "static/reader/ui/reader-scroll-anchor.js"
        self.assertIn(str(source.relative_to(self.root)), config["files"])
        source.write_text(source.read_text() + "\nfunction strictScrollProbe(value) { return value; }\nstrictScrollProbe(1);\n")
        self.assert_check(self.run_check(*check), False, "TS7006")

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

    def test_reader_adapter_contract_rejects_invalid_mode_and_missing_methods(self):
        source = self.root / "static/adapter-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/adapter-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('const registry = VoiceOfMLReaderAdapters.createAdapterRegistry();\n'
                          'registry.register("text", { open() {}, render() {}, restore() {}, dispose() {} });\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('VoiceOfMLReaderAdapters.createAdapterRegistry().activate(42);\n')
        self.assert_check(self.run_check(*check), False, "TS2345")
        source.write_text('VoiceOfMLReaderAdapters.createAdapterRegistry().register("text", { open() {} });\n')
        self.assert_check(self.run_check(*check), False, "TS2739")

    def test_adapter_coverage_gate_fails_when_contract_tests_are_removed(self):
        source = self.root / "static/reader/formats/reader-format-adapters.js"
        source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "static/reader/formats/reader-format-adapters.js", source)
        shutil.copyfile(ROOT / "tests/test_reader_adapter_registry.js", self.root / "tests/test_reader_adapter_registry.js")
        shutil.copyfile(ROOT / "scripts/check_adapter_coverage.mjs", self.root / "scripts/check_adapter_coverage.mjs")
        check = ["node", "scripts/check_adapter_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "reader-format-adapters.js")
        test = self.root / "tests/test_reader_adapter_registry.js"
        original = test.read_text()
        name = "reader adapter registry"
        anchor = 'require("node:test")("' + name + '", runContracts)'
        self.assertEqual(original.count(anchor), 1)
        for replacement in ('require("node:test")("renamed contract", runContracts)',
                            'require("node:test").skip("' + name + '", runContracts)',
                            'require("node:test").todo("' + name + '", runContracts)'):
            test.write_text(original.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, "passing named contract")
        for extra in ('require("node:test")("' + name + '", () => {});',
                      'require("node:test").skip("extra skip", () => {});',
                      'require("node:test").todo("extra todo");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contract")
        for extra in ('console.log("skipped 0"); require("node:test").skip("extra skip", () => {});',
                      'console.log("todo 0"); require("node:test").todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contract")
        marker = "reader adapter registry contracts passed"
        self.assertEqual(original.count(marker), 1)
        test.write_text(original.replace(marker, "missing adapter completion marker"))
        self.assert_check(self.run_check(*check), False, "passing named contract")
        anchor = "  checkRegistry();\n  console.log("
        self.assertEqual(original.count(anchor), 1)
        test.write_text(original.replace(anchor, "  checkRegistry();\n  throw new Error('adapter assertion failure');\n  console.log("))
        self.assert_check(self.run_check(*check), False, "adapter assertion failure")
        test.write_text('const test = require("node:test"); test("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "requires exactly one fully covered source row")
        test.write_text('const test = require("node:test"), vm = require("node:vm"), fs = require("node:fs");\n'
                        'test("load only", () => vm.runInNewContext(fs.readFileSync("static/reader/formats/'
                        'reader-format-adapters.js", "utf8"), {}, { filename: process.cwd() + '
                        '"/static/reader/formats/reader-format-adapters.js" }));\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_document_loader_coverage_gate_fails_closed(self):
        paths = ["static/reader/core/reader-document-loader.mjs", "scripts/check_document_loader_coverage.mjs",
                 "tests/test_reader_document_loader_contract.mjs", "tests/test_reader_pdf_rate_outer.mjs"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_document_loader_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "reader-document-loader.mjs")
        contract = self.root / paths[2]
        original = contract.read_text()
        names = ["retry policy keeps bounded delay and never retries rate-limited or aborted work",
                 "proxy fallback respects response ownership, cancellation and bucket routing",
                 "preloads are single-owner and fall back on failure or mismatched identity",
                 "document preparation preserves failure and byte-limit ownership",
                 "script load releases timers, handlers and resources on success, error and close",
                 "image fallback is not used for budget failures or closed readers"]
        for name in names:
            anchor = 'test("' + name + '"'
            self.assertEqual(original.count(anchor), 1)
            for replacement in ('test("renamed contract"', 'test.skip("' + name + '"', 'test.todo("' + name + '"'):
                contract.write_text(original.replace(anchor, replacement))
                self.assert_check(self.run_check(*check), False, "passing named tests")
        name = names[2]
        for extra in ('test("' + name + '", () => {});', 'test.skip("extra skip", () => {});',
                      'test.todo("extra todo");'):
            contract.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            contract.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        contract.write_text(original)
        rate_test = self.root / paths[3]
        rate_source = rate_test.read_text()
        marker = 'PDF rate-limit retry boundary and generic retry preserved'
        self.assertEqual(rate_source.count(marker), 1)
        rate_test.write_text(rate_source.replace(marker, 'missing rate completion marker'))
        self.assert_check(self.run_check(*check), False, "passing named tests")
        rate_test.write_text('import "../static/reader/core/reader-document-loader.mjs";\n')
        self.assert_check(self.run_check(*check), False, "passing named tests")
        rate_test.write_text(rate_source)
        for path in paths[2:]:
            (self.root / path).write_text('import {test} from "node:test"; test("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one source row")
        (self.root / paths[2]).write_text('throw new Error("failed loader test");\n')
        self.assert_check(self.run_check(*check), False, "failed loader test")
        (self.root / paths[2]).write_text('import "../static/reader/core/reader-document-loader.mjs";\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_download_controller_coverage_gate_fails_closed(self):
        paths = ["static/search/download-controller.js", "scripts/check_download_controller_coverage.mjs",
                 "scripts/check_tap_contracts.mjs", "tests/test_download_controller_contract.js"]
        for relative in paths:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        check = ["node", "scripts/check_download_controller_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "download-controller.js")
        contract = self.root / paths[3]
        original = contract.read_text()
        names = re.findall(r'^test\("([^"\n]+)"', original, re.M)
        self.assertEqual(len(names), 14)
        self.assertEqual(len(set(names)), len(names))
        for name in names:
            anchor = 'test("' + name + '"'
            self.assertEqual(original.count(anchor), 1)
            for replacement in ('test("renamed contract"', 'test.skip("' + name + '"', 'test.todo("' + name + '"'):
                contract.write_text(original.replace(anchor, replacement))
                self.assert_check(self.run_check(*check), False, "passing named contracts")
        for extra in ('test("' + names[0] + '", () => {});',
                      'test.skip("extra skip", () => {});', 'test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            contract.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contracts")
        contract.write_text('throw new Error("failed download contract");\n')
        self.assert_check(self.run_check(*check), False, "failed download contract")
        contract.write_text('const test = require("node:test"); test("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one source row")
        contract.write_text(original)
        gate = self.root / paths[1]
        source = gate.read_text()
        anchor = "const minimum = [100, 88.89, 100];"
        self.assertEqual(source.count(anchor), 1)
        gate.write_text(source.replace(anchor, "const minimum = [100, 89, 100];"))
        self.assert_check(self.run_check(*check), False, "above each minimum")

    def test_download_controller_declaration_matches_exact_runtime(self):
        config = self.root / "download-exact.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        for name in ("jsconfig.strict.json", "jsconfig.search-exact.json"):
            self.assertIn("static/search/download-controller.js", json.loads((ROOT / name).read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "noUncheckedIndexedAccess": True, "exactOptionalPropertyTypes": True,
            "target": "esnext", "module": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/download-controller.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        before = "checkDownload(link: string, speculative?: boolean, signal?: AbortSignal): Promise<unknown>;"
        self.assertEqual(original.count(before), 1)
        declaration.write_text(original.replace(before, "checkDownload(link: string, speculative?: boolean, signal?: AbortSignal): Promise<boolean | string>;"))
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_download_controller_type_contract_rejects_invalid_inputs(self):
        config = self.root / "download-usage.json"
        source = self.root / "static/download-usage.js"
        declaration = ROOT / "typings/reader-globals.d.ts"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "noUncheckedIndexedAccess": True, "exactOptionalPropertyTypes": True,
            "target": "esnext"}, "files": [str(declaration), str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        prefix = ('const controller = VoiceOfMLDownloadController.createDownloadController({'
                  'buildCheckUrl: link => link, buildDownloadUrl: (name, link) => name + link, '
                  'triggerDownload: url => void url, showToast: value => void value});\n')
        source.write_text(prefix + 'controller.checkDownload("book"); controller.downloadFile("book", "link", {quiet:true});\n')
        self.assert_check(self.run_check(*check), True, "")
        for invalid, expected in [('controller.checkDownload(3);', "TS2345"),
                                  ('controller.downloadFile("book", "link", {quiet:"yes"});', "TS2322"),
                                  ('controller.downloadFile("book", "link", {signal:new AbortController().signal});', "TS2353"),
                                  ('/** @type {Promise<string>} */ const result = controller.checkDownload("book");', "TS2322")]:
            source.write_text(prefix + invalid + "\n")
            self.assert_check(self.run_check(*check), False, expected)

    def test_shared_tap_validator_tests_are_required(self):
        paths = ["scripts/check_tap_contracts.mjs", "tests/test_tap_contracts.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "--test", "--test-reporter=tap", paths[1]]
        self.assert_check(self.run_check(*check), True, "# pass 3")
        helper = self.root / paths[0]
        original = helper.read_text()
        anchor = 'todo[0] === "# todo 0"'
        self.assertEqual(original.count(anchor), 1)
        helper.write_text(original.replace(anchor, 'true'))
        self.assert_check(self.run_check(*check), False, "not ok")

    def test_document_loader_coverage_checks_fractional_minimum(self):
        paths = ["static/reader/core/reader-document-loader.mjs", "scripts/check_document_loader_coverage.mjs",
                 "tests/test_reader_document_loader_contract.mjs", "tests/test_reader_pdf_rate_outer.mjs"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        gate = self.root / paths[1]
        source = gate.read_text()
        self.assertEqual(source.count("const minimum = [100, 94.20, 97.22];"), 1)
        gate.write_text(source.replace("const minimum = [100, 94.20, 97.22];",
                                       "const minimum = [100, 94.99, 97.22];"))
        self.assert_check(self.run_check("node", "scripts/check_document_loader_coverage.mjs"), False,
                          "above each minimum")

    def test_document_loader_strict_type_contract_rejects_bad_inputs(self):
        source = self.root / "static/loader-usage.mjs"
        config = self.root / "jsconfig.json"
        module = (ROOT / "static/reader/core/reader-document-loader.mjs").as_posix()
        source.write_text(f'import {{createReaderDocumentLoader}} from "{module}";\n'
                          'createReaderDocumentLoader({sourceUrl: 42});\n')
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "module": "esnext", "moduleResolution": "bundler"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), str(ROOT / "static/reader/core/reader-document-loader.mjs"),
                      str(source)]}))
        result = self.run_check("node", ROOT / "node_modules/typescript/bin/tsc", "--project", config)
        self.assert_check(result, False, "TS2322")


    def test_search_response_cache_coverage_gate_fails_closed(self):
        paths = ["static/search/response-cache.js", "scripts/check_search_response_cache_coverage.mjs",
                 "tests/search/response-cache/test_search_response_cache_contract.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_search_response_cache_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "response-cache.js")
        test = self.root / paths[2]
        original = test.read_text()
        names = ["cache preserves LRU access order and exact expiration boundary",
                 "has promotes live entries and undefined values throw without insertion",
                 "byte accounting bounds entries and bypasses oversize without corrupting survivors",
                 "replacement resets TTL, byte count and LRU position",
                 "oversize replacement and serialization errors retire the previous key",
                 "the independent one-MiB entry cap rejects larger entries even with a larger total budget"]
        for name in names:
            anchor = 'test("' + name + '"'
            self.assertEqual(original.count(anchor), 1)
            for replacement in ('test("renamed contract"', 'test.skip("' + name + '"', 'test.todo("' + name + '"'):
                test.write_text(original.replace(anchor, replacement))
                self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('test("' + names[0] + '", () => {});', 'test.skip("extra skip", () => {});',
                      'test.todo("extra todo");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");',
                      'console.log("tests 6");', 'console.log("pass 6");', 'console.log("fail 0");',
                      'console.log("cancelled 0");', 'console.log("duration_ms 1");',
                      'console.log("start of coverage report");', 'console.log("end of coverage report");',
                      'console.log("1..6");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("response-cache.js | 99.00 | 99.00 | 99.00 |");',
                      'console.log("response-cache.js | 100.00 | 100.00 | 100.00 |");'):
            with self.subTest(forged_row=extra):
                test.write_text(original + "\n" + extra + "\n")
                result = self.run_check(*check)
                self.assert_check(result, False, "exactly one fully covered source row")
                self.assertIn("#   response-cache.js | 100.00", result.stdout)
                self.assertEqual(result.stdout.count("response-cache.js |"), 2)
        test.write_text('require("node:test")("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one fully covered source row")
        test.write_text('throw new Error("failed response cache test");\n')
        self.assert_check(self.run_check(*check), False, "failed response cache test")
        test.write_text('const vm = require("vm"), fs = require("fs");\n'
                        'const filename = process.cwd() + "/static/search/response-cache.js";\n'
                        'vm.runInNewContext(fs.readFileSync(filename, "utf8"), {}, {filename});\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_search_response_cache_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/response-cache.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/response-cache.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        before = "  constructor(limit: number, ttl: number, budget?: number);"
        self.assertEqual(original.count(before), 1)
        declaration.write_text(original.replace(before, "  constructor(limit: string, ttl: number, budget?: number);"))
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_response_cache_generic_type_rejects_wrong_keys_and_values(self):
        source = self.root / "static/cache-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        prefix = '/** @type {BoundedResponseCache<{value: number}>} */ const cache = new BoundedResponseCache(2, 100);\n'
        source.write_text(prefix + 'cache.set("a", {value: 1}); cache.get("a")?.value;\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text(prefix + 'cache.set(42, {value: 1});\n')
        self.assert_check(self.run_check(*check), False, "TS2345")
        source.write_text(prefix + 'cache.set("a", {value: "wrong"});\n')
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_result_identity_coverage_gate_fails_closed(self):
        paths = ["static/search/result-identity.js", "static/search/record-path.js",
                 "scripts/check_search_result_identity_coverage.mjs", "tests/search/baselines/test_search_stable_id_baseline.mjs", "static/app.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[2]]
        self.assert_check(self.run_check(*check), True, "result-identity.js")
        test = self.root / paths[3]
        source = test.read_text()
        name = 'path lookup remains lazy through early returns and Repo conversion'
        self.assertEqual(source.count("test('" + name + "'"), 1)
        test.write_text(source.replace("test('" + name + "'", "test('renamed contract'"))
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source.replace("test('" + name + "'", "test.skip('" + name + "'"))
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source.replace("test('" + name + "', () => {", "test('" + name + "', () => { throw new Error('identity failure');"))
        self.assert_check(self.run_check(*check), False, "identity failure")
        test.unlink()
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source)
        gate = self.root / paths[2]
        gate_source = gate.read_text()
        include = "--test-coverage-include=**/static/search/result-identity.js"
        self.assertEqual(gate_source.count(include), 1)
        gate.write_text(gate_source.replace(include, "--test-coverage-include=**/missing-identity.js"))
        self.assert_check(self.run_check(*check), False, "exactly one fully covered source row")

    def test_search_result_identity_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/result-identity.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/result-identity.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        before = "declare var VoiceOfMLSearchIdentity: {getResultStableId(result: unknown): string};"
        self.assertEqual(original.count(before), 1)
        declaration.write_text(original.replace(before, before.replace("): string};", "): number};")))
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_result_identity_rejects_wrong_return_types(self):
        source = self.root / "static/identity-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"}, "files": [str(ROOT / "typings/reader-globals.d.ts"), str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('VoiceOfMLSearchIdentity.getResultStableId(null);\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('VoiceOfMLSearchIdentity.getResultStableId(null, () => "");\n')
        self.assert_check(self.run_check(*check), False, "TS2554")
        source.write_text('/** @type {number} */ const id = VoiceOfMLSearchIdentity.getResultStableId(null);\n')
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_response_validation_coverage_gate_fails_closed(self):
        paths = ["static/search/response-validation.js", "scripts/check_search_response_validation_coverage.mjs",
                 "tests/search/baselines/test_search_response_validation_baseline.mjs", "static/app.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "response-validation.js")
        test = self.root / paths[2]
        source = test.read_text()
        name = 'complete, final, empty and past-end pages preserve exact cardinality'
        self.assertEqual(source.count("test('" + name + "'"), 1)
        test.write_text(source.replace("test('" + name + "'", "test('renamed contract'"))
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source.replace("test('" + name + "'", "test.skip('" + name + "'"))
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source.replace("test('" + name + "', () => {",
                                       "test('" + name + "', () => { throw new Error('contract failure');"))
        self.assert_check(self.run_check(*check), False, "contract failure")
        test.unlink()
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source)
        gate = self.root / paths[1]
        gate_source = gate.read_text()
        include = "--test-coverage-include=**/static/search/response-validation.js"
        self.assertEqual(gate_source.count(include), 1)
        gate.write_text(gate_source.replace(include, "--test-coverage-include=**/missing-validator.js"))
        self.assert_check(self.run_check(*check), False, "exactly one fully covered source row")

    def test_search_response_validation_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/response-validation.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/response-validation.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        for before, after in [("expectedPage: number, expectedPageSize: number): unknown",
                               "expectedPage: string, expectedPageSize: number): unknown"),
                              ("expectedPage: number, expectedPageSize: number): unknown",
                               "expectedPage: number, expectedPageSize: number): boolean")]:
            self.assertEqual(original.count(before), 1)
            declaration.write_text(original.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_response_validation_rejects_wrong_argument_types(self):
        source = self.root / "static/validation-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('VoiceOfMLSearchValidation.isValidSearchResponse(null, 1, 2);\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('VoiceOfMLSearchValidation.isValidSearchResponse(null, "1", 2);\n')
        self.assert_check(self.run_check(*check), False, "TS2345")
        source.write_text('VoiceOfMLSearchValidation.isValidSearchResponse(null, 1, {});\n')
        self.assert_check(self.run_check(*check), False, "TS2345")
        source.write_text('/** @type {number} */ const value = VoiceOfMLSearchValidation.isValidSearchResponse(null, 1, 2);\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        source.write_text('/** @type {boolean} */ const value = VoiceOfMLSearchValidation.isValidSearchResponse(null, 1, 2);\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        source.write_text('const value = VoiceOfMLSearchValidation.isValidSearchResponse(null, 1, 2);\n'
                          'if (typeof value === "boolean") { /** @type {boolean} */ const checked = value; }\n')
        self.assert_check(self.run_check(*check), True, "")

    def test_search_file_types_coverage_gate_fails_closed(self):
        paths = ["static/search/file-types.js", "scripts/check_search_file_types_coverage.mjs",
                 "tests/search/baselines/test_search_extension_inventory_baseline.mjs", "static/app.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_search_file_types_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "file-types.js")
        test = self.root / paths[2]
        original = test.read_text()
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text('import test from "node:test"; test("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one fully covered source row")
        test.write_text('throw new Error("failed file types test");\n')
        self.assert_check(self.run_check(*check), False, "failed file types test")
        test.write_text('import vm from "node:vm"; import fs from "node:fs";\n'
                        'const filename = process.cwd() + "/static/search/file-types.js";\n'
                        'vm.runInNewContext(fs.readFileSync(filename, "utf8"), {}, {filename});\n')
        self.assert_check(self.run_check(*check), False, "coverage")
        names = ["all 67 ordered filter extensions are pinned, including case-sensitive lookup",
                 "all 77 icon mappings and their case-insensitive lookup are pinned",
                 "fallback, inherited keys, errors and lowercase invocation match the original",
                 "original lexical inventories cannot be reassigned or shadowed through global properties",
                 "const bindings retain their original mutable array and map contents",
                 "inventory data is isolated between script evaluations"]
        test.write_text('import vm from "node:vm"; import fs from "node:fs"; import test from "node:test";\n'
                        'const filename=process.cwd()+"/static/search/file-types.js";\n'
                        'vm.runInNewContext(fs.readFileSync(filename,"utf8"),{}, {filename});\n' +
                        '\n'.join('test.skip(' + json.dumps(name) + ', () => {});' for name in names))
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_search_file_types_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/file-types.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/file-types.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        for before, after in [
            ("orderedExtensions: string[];", "orderedExtensions: number[];"),
            ("fileIconMap: Record<string, string | object>", "fileIconMap: Record<string, number>")
        ]:
            self.assertEqual(original.count(before), 1)
            declaration.write_text(original.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_highlight_coverage_gate_fails_closed(self):
        paths = ["static/search/highlight.js", "scripts/search/check_search_highlight_coverage.mjs",
                 "tests/search/highlight/test_search_highlight_contract.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/search/check_search_highlight_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "highlight.js")
        test = self.root / paths[2]
        source = test.read_text()
        name = 'HTML escaping preserves text and protects attribute and markup delimiters'
        self.assertEqual(source.count('test("' + name + '"'), 1)
        test.write_text(source.replace('test("' + name + '"', 'test("renamed contract"'))
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source.replace('test("' + name + '"', 'test.skip("' + name + '"'))
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source + '\ntest("' + name + '", () => {});\n')
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source + '\ntest.skip("additional skipped contract", () => {});\n')
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text(source + '\ntest.todo("unfinished contract");\n')
        self.assert_check(self.run_check(*check), False, "passing named contracts")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named contracts")
        test.write_text('require("node:test")("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one source row")
        test.write_text('throw new Error("failed highlight test");\n')
        self.assert_check(self.run_check(*check), False, "failed highlight test")
        test.write_text('const vm = require("vm"), fs = require("fs");\n'
                        'const filename = process.cwd() + "/static/search/highlight.js";\n'
                        'vm.runInNewContext(fs.readFileSync(filename, "utf8"), {}, {filename});\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_search_highlight_coverage_checks_fractional_minimum(self):
        for path in ("static/search/highlight.js", "scripts/search/check_search_highlight_coverage.mjs",
                     "tests/search/highlight/test_search_highlight_contract.js", "scripts/check_tap_contracts.mjs"):
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        gate = self.root / "scripts/search/check_search_highlight_coverage.mjs"
        source = gate.read_text()
        before = "const minimum = [100, 95.45, 100];"
        self.assertEqual(source.count(before), 1)
        gate.write_text(source.replace(before, "const minimum = [100, 95.99, 100];"))
        self.assert_check(self.run_check("node", str(gate)), False, "above each minimum")

    def test_search_highlight_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/highlight.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/highlight.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        for before, after in [
            ("declare function escapeHTML(text: unknown): string | undefined;", "declare function escapeHTML(text: unknown): number;"),
            ("declare function escapeHTML(text: unknown): string | undefined;", "declare function escapeHTML(text: unknown): string;"),
            ("declare function getHighlightRegex(query: string): RegExp | null;",
             "declare function getHighlightRegex(query: string): RegExp;"),
            ("declare function highlightText(text: unknown, query: string | null | undefined): string | undefined;",
             "declare function highlightText(text: unknown, query: string | number | null | undefined): string | undefined;"),
            ("declare function highlightText(text: unknown, query: string | null | undefined): string | undefined;",
             "declare function highlightText(text: unknown, query: string | null | undefined): string;")
        ]:
            self.assertEqual(original.count(before), 1)
            declaration.write_text(original.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_record_path_coverage_gate_fails_closed(self):
        paths = ["static/search/record-path.js", "scripts/check_search_record_path_coverage.mjs",
                 "tests/test_search_record_path.js", "static/app.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_search_record_path_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "record-path.js")
        test = self.root / paths[2]
        original = test.read_text()
        marker = 'search record paths preserve filenames, separators and URL encoding'
        self.assertEqual(original.count(marker), 1)
        test.write_text(original.replace(marker, 'missing path completion marker'))
        self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('require("node:test").skip("extra skip", () => {});',
                      'require("node:test").todo("extra todo");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("skipped 0"); require("node:test").skip("extra skip", () => {});',
                      'console.log("todo 0"); require("node:test").todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        test.write_text(original + '\nrequire("node:test")("unexpected failure", () => { throw new Error("path assertion failure"); });\n')
        self.assert_check(self.run_check(*check), False, "path assertion failure")
        test.write_text('require("node:test")("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one fully covered source row")
        test.write_text('throw new Error("failed path test");\n')
        self.assert_check(self.run_check(*check), False, "failed path test")
        test.write_text('const vm = require("vm"), fs = require("fs");\n'
                        'const filename = process.cwd() + "/static/search/record-path.js";\n'
                        'vm.runInNewContext(fs.readFileSync(filename, "utf8"), {}, {filename});\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_search_record_path_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/record-path.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/record-path.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        for before, after in [
            ("declare function encodeRecordPath(path: string | null | undefined): string;",
             "declare function encodeRecordPath(path: string | null | undefined): number;"),
            ("declare function buildRecordRelativePath(record: {File?: string; Extension?: string; Folder?: string[] | null}): string;",
             "declare function buildRecordRelativePath(record: {File?: string | number; Extension?: string; Folder?: string[] | null}): string;")
        ]:
            self.assertEqual(original.count(before), 1)
            declaration.write_text(original.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_size_coverage_gate_fails_closed(self):
        paths = ["static/search/size-format.js", "scripts/search/check_search_size_coverage.mjs",
                 "tests/search/size/test_search_size_format.js", "tests/search/size/test_search_size_render_contract.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/search/check_search_size_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "size-format.js")
        render = self.root / paths[3]
        original = render.read_text()
        names = ["display preserves binary boundaries and historical precision",
                 "display retains original coercion and empty-value behavior",
                 "display retains prototype and normalized cache behavior"]
        for name in names:
            anchor = 'test("' + name + '"'
            self.assertEqual(original.count(anchor), 1)
            for replacement in ('test("renamed contract"', 'test.skip("' + name + '"', 'test.todo("' + name + '"'):
                render.write_text(original.replace(anchor, replacement))
                self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('test("' + names[0] + '", () => {});', 'test.skip("extra skip", () => {});',
                      'test.todo("extra todo");'):
            render.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            render.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        render.write_text(original)
        formatted = self.root / paths[2]
        formatted_source = formatted.read_text()
        marker = 'search size formatting, parser compatibility and URL round trips passed'
        self.assertEqual(formatted_source.count(marker), 1)
        formatted.write_text(formatted_source.replace(marker, 'missing size completion marker'))
        self.assert_check(self.run_check(*check), False, "passing named tests")
        formatted.write_text(formatted_source)
        for test in paths[2:]:
            (self.root / test).write_text('require("node:test")("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one fully covered source row")
        shutil.copyfile(ROOT / paths[2], self.root / paths[2])
        self.assert_check(self.run_check(*check), False, "coverage")
        (self.root / paths[2]).write_text('require("node:test")("empty", () => {});\n')
        shutil.copyfile(ROOT / paths[3], self.root / paths[3])
        self.assert_check(self.run_check(*check), False, "coverage")
        (self.root / paths[3]).write_text('require("node:test")("empty", () => {});\n')
        (self.root / paths[2]).write_text('throw new Error("failed size test");\n')
        self.assert_check(self.run_check(*check), False, "failed size test")

    def test_search_size_display_declaration_matches_runtime(self):
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/size-format.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        before = "declare function formatSize(bytes: number | string | null | undefined): string | object | undefined;"
        self.assertEqual(original.count(before), 1)
        for after in ("declare function formatSize(bytes: number | string | null | undefined): number;",
                      "declare function formatSize(bytes: number | string | null | undefined): string;",
                      "declare function formatSize(bytes: number | string | null | undefined): string | object;"):
            declaration.write_text(original.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")

    def test_request_manager_coverage_gate_fails_closed(self):
        paths = ["static/reader/core/reader-request-manager.js", "scripts/check_request_manager_coverage.mjs",
                 "tests/test_reader_request_manager.js", "tests/test_reader_initial_recovery.js",
                 "tests/test_reader_request_manager_edges.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_request_manager_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "reader-request-manager.js")
        source = self.root / paths[2]
        original = source.read_text()
        before = 'require("node:test")("reader request manager behavior",'
        self.assertEqual(original.count(before), 1)
        source.write_text(original.replace(before, 'require("node:test")("renamed request contract",'))
        self.assert_check(self.run_check(*check), False, "passing named tests")
        source.write_text(original + '\nrequire("node:test").skip("unexpected skipped check", () => {});\n')
        self.assert_check(self.run_check(*check), False, "passing named tests")
        source.write_text(original + '\nrequire("node:test").todo("unfinished check");\n')
        self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("skipped 0"); require("node:test").skip("extra skip", () => {});',
                      'console.log("todo 0"); require("node:test").todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            source.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        source.write_text(original + '\nrequire("node:test")("reader request manager behavior", () => {});\n')
        self.assert_check(self.run_check(*check), False, "passing named tests")
        source.write_text(original)
        markers = ["reader request manager contracts passed", "reader initial response recovery contracts passed",
                   "reader request manager edge contracts passed"]
        for path, marker in zip(paths[2:], markers):
            test = self.root / path
            before = test.read_text()
            self.assertEqual(before.count(marker), 1)
            test.write_text(before.replace(marker, "missing completion marker"))
            self.assert_check(self.run_check(*check), False, "passing named tests")
            test.write_text(before)
        for path in paths[2:]:
            (self.root / path).write_text('require("node:test")("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "exactly one source coverage row")
        (self.root / paths[2]).write_text('throw new Error("failed request test");\n')
        self.assert_check(self.run_check(*check), False, "failed request test")
        (self.root / paths[2]).write_text('const vm = require("vm"), fs = require("fs");\n'
            'const filename = process.cwd() + "/static/reader/core/reader-request-manager.js";\n'
            'vm.runInNewContext(fs.readFileSync(filename, "utf8"), {}, {filename});\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_request_manager_disposal_mutation_is_detected(self):
        # Once the late response is released, a missing owner cancellation
        # must fail an assertion instead of leaving the fake-timer test idle.
        paths = ["static/reader/core/reader-request-manager.js", "tests/test_reader_request_manager_edges.js"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        source = self.root / paths[0]
        original = source.read_text()
        before = 'for (const record of active) abort(record, new DOMException("Reader disposed", "AbortError"));'
        self.assertEqual(original.count(before), 1)
        source.write_text(original.replace(before, 'for (const record of active) void record;'))
        self.assert_check(self.run_check("node", "--test", "--test-reporter=tap", paths[1]), False,
                          "Missing expected rejection")

    def test_search_size_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/size-format.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        before = "declare function fmtSizeUrl(bytes: number | null | undefined): string | null;"
        self.assertEqual(original.count(before), 1)
        declaration.write_text(original.replace(before,
            "declare function fmtSizeUrl(bytes: number | null | undefined): number;"))
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_request_manager_coverage_gate_fails_on_fractional_regression(self):
        paths = ["static/reader/core/reader-request-manager.js", "scripts/check_request_manager_coverage.mjs",
                 "tests/test_reader_request_manager.js", "tests/test_reader_initial_recovery.js",
                 "tests/test_reader_request_manager_edges.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        gate = self.root / paths[1]
        source = gate.read_text()
        self.assertEqual(source.count("const minimum = [100, 95.24, 95.12];"), 1)
        gate.write_text(source.replace("const minimum = [100, 95.24, 95.12];",
                                       "const minimum = [100, 95.99, 95.12];"))
        self.assert_check(self.run_check("node", "scripts/check_request_manager_coverage.mjs"), False,
                          "above each minimum")

    def test_request_manager_async_test_runner_rejects_unfinished_test(self):
        test = self.root / "tests/pending-request.js"
        test.write_text('require("node:test")("unfinished", {timeout: 25}, async () => new Promise(() => {}));\n')
        self.assert_check(self.run_check("node", "--test", "--test-reporter=tap", test), False,
                          "test timed out")

    def test_strict_reader_request_manager_contract(self):
        source = self.root / "static/request-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/request-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        valid = ('const manager = VoiceOfMLReaderRequests.createReaderRequestManager({initialIdleMs: 10});\n'
                 'manager.request("/a", 1000, {signal: new AbortController().signal}).then(r => r.text());\n'
                 'manager.requestBuffered("/b", 1000, 8).then(r => r.json()); manager.dispose();\n')
        source.write_text(valid)
        self.assert_check(self.run_check(*check), True, "")
        for bad in ('manager.request("/a", "slow");', 'manager.requestBuffered("/a", 10, "huge");',
                    'manager.request("/a", 10).then(r => r.notAResponseMethod());',
                    'VoiceOfMLReaderRequests.createReaderRequestManager({initialIdleMs: "slow"});'):
            with self.subTest(bad=bad):
                source.write_text(valid + bad + "\n")
                self.assert_check(self.run_check(*check), False, "error TS")

    def test_request_manager_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/reader/core/reader-request-manager.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        valid = "readonly pendingCount: number;\n  readonly activeCount: number;\n  readonly disposed: boolean;"
        self.assertEqual(original.count(valid), 1)
        declaration.write_text(original.replace(valid, valid.replace("activeCount: number", "activeCount: string")))
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_pdf_network_coverage_gate_fails_closed(self):
        paths = ["static/reader/pdf/reader-pdf-network.mjs", "static/reader/core/reader-security.js",
                 "static/reader/pdf/reader-pdf-engine.mjs", "scripts/check_pdf_network_coverage.mjs",
                 "scripts/check_pdf_network_mutations.mjs",
                 "tests/test_reader_pdf_backpressure.mjs", "tests/test_reader_pdf_network_contract.mjs",
                 "tests/test_reader_pdf_sparse_ranges.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_pdf_network_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "reader-pdf-network.mjs")
        contracts = [("tests/test_reader_pdf_backpressure.mjs",
                      "429 feedback, shared spacing, bounded retry, version consistency and cancellation passed"),
                     ("tests/test_reader_pdf_network_contract.mjs",
                      "PDF network contracts: cache identity, safe revalidation and live cancellation passed"),
                     ("tests/test_reader_pdf_sparse_ranges.mjs",
                      "Sparse PDF detection, exact demand ranges, bounded concurrency and disposal passed")]
        for path, marker in contracts:
            test = self.root / path
            original = test.read_text()
            self.assertEqual(original.count(marker), 1)
            test.write_text(original.replace(marker, "missing PDF network completion marker"))
            self.assert_check(self.run_check(*check), False, "passing named tests")
            test.write_text(original)
        test = self.root / contracts[0][0]
        original = test.read_text()
        for extra in ('import {test as extraTest} from "node:test"; extraTest.skip("extra skip", () => {});',
                      'import {test as extraTest} from "node:test"; extraTest.todo("extra todo");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('import {test as extraTest} from "node:test"; console.log("skipped 0"); extraTest.skip("extra skip", () => {});',
                      'import {test as extraTest} from "node:test"; console.log("todo 0"); extraTest.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(original + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        test.write_text(original + '\nthrow new Error("PDF network assertion failure");\n')
        self.assert_check(self.run_check(*check), False, "PDF network assertion failure")
        test.write_text(original)
        empty = 'import { test } from "node:test"; test("empty", () => {});\n'
        for path in paths:
            if path.startswith("tests/"):
                (self.root / path).write_text(empty)
        self.assert_check(self.run_check(*check), False, "exactly one source coverage row")
        (self.root / "tests/test_reader_pdf_network_contract.mjs").write_text(
            'import "../static/reader/pdf/reader-pdf-network.mjs";\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_pdf_network_coverage_gate_enforces_fractional_minimum(self):
        paths = ["static/reader/pdf/reader-pdf-network.mjs", "static/reader/core/reader-security.js",
                 "static/reader/pdf/reader-pdf-engine.mjs", "scripts/check_pdf_network_coverage.mjs",
                 "tests/test_reader_pdf_backpressure.mjs", "tests/test_reader_pdf_network_contract.mjs",
                 "tests/test_reader_pdf_sparse_ranges.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        gate = self.root / "scripts/check_pdf_network_coverage.mjs"
        source = gate.read_text()
        measured = self.run_check("node", "scripts/check_pdf_network_coverage.mjs")
        self.assert_check(measured, True, "reader-pdf-network.mjs")
        row = re.search(r"(?m)^\s*#\s*reader-pdf-network\.mjs\s*\|\s*(\d+(?:\.\d+)?)\s*\|", measured.stdout)
        self.assertIsNotNone(row, measured.stdout)
        hundredths = int(round(float(row.group(1)) * 100))
        self.assertLess(hundredths, 10000, "fractional negative test needs a non-perfect line baseline")
        needle = "const minimum = [98.31, 85.65, 88.43];"
        self.assertEqual(source.count(needle), 1)
        above = f"const minimum = [{(hundredths + 1) / 100:.2f}, 85.65, 88.43];"
        gate.write_text(source.replace(needle, above))
        self.assert_check(self.run_check("node", "scripts/check_pdf_network_coverage.mjs"), False,
                          "PDF network coverage gate requires passing named tests")

    def test_pdf_network_coverage_gate_rejects_removed_branch_coverage(self):
        paths = ["static/reader/pdf/reader-pdf-network.mjs", "static/reader/core/reader-security.js",
                 "static/reader/pdf/reader-pdf-engine.mjs", "scripts/check_pdf_network_coverage.mjs",
                 "tests/test_reader_pdf_backpressure.mjs", "tests/test_reader_pdf_network_contract.mjs",
                 "tests/test_reader_pdf_sparse_ranges.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        test = self.root / "tests/test_reader_pdf_network_contract.mjs"
        source = test.read_text()
        start = source.index("  // The optional shared cache belongs")
        end = source.index("  // Once a previously validated origin", start)
        test.write_text(source[:start] + source[end:])
        self.assert_check(self.run_check("node", "scripts/check_pdf_network_coverage.mjs"), False,
                          "PDF network coverage gate requires passing named tests")

    def test_pdf_network_coverage_gate_keeps_cancellation_test(self):
        paths = ["static/reader/pdf/reader-pdf-network.mjs", "static/reader/core/reader-security.js",
                 "static/reader/pdf/reader-pdf-engine.mjs", "scripts/check_pdf_network_coverage.mjs",
                 "scripts/check_pdf_network_mutations.mjs",
                 "tests/test_reader_pdf_backpressure.mjs", "tests/test_reader_pdf_network_contract.mjs",
                 "tests/test_reader_pdf_sparse_ranges.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        test = self.root / "tests/test_reader_pdf_backpressure.mjs"
        original = test.read_text()
        begin = "  // BEGIN_PDF_ADMISSION_CANCELLATION\n"
        end = "  // END_PDF_ADMISSION_CANCELLATION\n"
        self.assertEqual(original.count(begin), 1)
        self.assertEqual(original.count(end), 1)
        start = original.index(begin)
        finish = original.index(end, start) + len(end)
        test.write_text(original[:start] + original[finish:])
        # Aggregate coverage alone cannot detect loss of this regression test;
        # the same lines execute in other paths. The explicit mutant must die.
        self.assert_check(self.run_check("node", "scripts/check_pdf_network_mutations.mjs"), False,
                          "post-admission cancellation mutant survived")

    def test_reader_core_coverage_gate_requires_every_source(self):
        paths = ["static/reader/formats/reader-section-virtualizer.js",
                 "static/reader/formats/reader-chapter-repository.js",
                 "static/reader/ui/reader-scroll-anchor.js", "static/reader/core/reader-contract.js",
                 "static/reader/core/reader-security.js", "scripts/check_reader_core_coverage.mjs",
                 "tests/test_reader_section_virtualizer.js", "tests/test_reader_chapter_repository.js",
                 "tests/test_reader_chapter_scheduler.js", "tests/test_reader_chapter_preload.js",
                 "tests/test_reader_scroll_anchor.js"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_reader_core_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "reader-chapter-repository.js")
        gate = self.root / "scripts/check_reader_core_coverage.mjs"
        original_gate = gate.read_text()
        first = 'tests/test_reader_chapter_repository.js'
        second = 'tests/test_reader_chapter_scheduler.js'
        list_anchor = '"' + first + '", "' + second + '",'
        self.assertEqual(original_gate.count(list_anchor), 1)
        gate.write_text(original_gate.replace(list_anchor, '"' + first + '", "' + first + '",'))
        self.assert_check(self.run_check(*check), False, "passing named tests")
        gate.write_text(original_gate)
        chapter_test = self.root / first
        original_test = chapter_test.read_text()
        chapter_test.write_text(original_test + '\nrequire("node:test").skip("unrelated skipped check", () => {});\n')
        self.assert_check(self.run_check(*check), False, "passing named tests")
        chapter_test.write_text(original_test + '\nrequire("node:test").todo("unfinished check");\n')
        self.assert_check(self.run_check(*check), False, "passing named tests")
        for extra in ('console.log("skipped 0"); require("node:test").skip("extra skip", () => {});',
                      'console.log("todo 0"); require("node:test").todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            chapter_test.write_text(original_test + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "passing named tests")
        chapter_test.write_text(original_test.replace('reader chapter repository contracts passed', 'renamed success marker'))
        self.assert_check(self.run_check(*check), False, "passing named tests")
        chapter_test.write_text(original_test)
        (self.root / "tests/test_reader_scroll_anchor.js").write_text(
            'const test = require("node:test"); test("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "reader-scroll-anchor.js")
        (self.root / "tests/test_reader_scroll_anchor.js").write_text(
            'require("../static/reader/ui/reader-scroll-anchor.js");\n')
        self.assert_check(self.run_check(*check), False, "coverage")

    def test_pdf_network_safety_mutation_gate_rejects_unexpected_failure(self):
        paths = ["static/reader/pdf/reader-pdf-network.mjs", "tests/test_reader_pdf_backpressure.mjs",
                 "tests/test_reader_pdf_network_contract.mjs", "scripts/check_pdf_network_mutations.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_pdf_network_mutations.mjs"]
        self.assert_check(self.run_check(*check), True, '"total":6,"killed":6,"survived":0,"errors":0')
        (self.root / paths[1]).write_text('import "../static/reader/pdf/reader-pdf-network.mjs";\nthrow Error("unrelated");\n')
        self.assert_check(self.run_check(*check), False, "unexpected failure, not a killed mutant")

    def test_chapter_scheduler_type_contract_rejects_invalid_index(self):
        source = self.root / "static/chapter-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": False, "skipLibCheck": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/chapter-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        create = ('const chapters = VoiceOfMLReaderChapters.createChapterScheduler({ '
                  'create: async (index, signal, priority) => index });\n')
        source.write_text(create + 'chapters.load(42);\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text(create + 'chapters.load("not a chapter number");\n')
        self.assert_check(self.run_check(*check), False, "TS2345")

    def test_strict_chapter_repository_and_scheduler_contracts(self):
        source = self.root / "static/chapter-strict-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/chapter-strict-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        valid = ('const repository = VoiceOfMLReaderChapters.createChapterRepository({count: 2, '
                 'find: index => index === 0 ? "cached" : undefined, create: async index => `chapter-${index}`, '
                 'commit: (_index, value) => value.toUpperCase()});\n'
                 'repository.load(0).then(value => value?.toUpperCase());\n'
                 'const state = repository.state(0); if (state && state.status === "ready") state.value?.toUpperCase();\n'
                 'const chapters = VoiceOfMLReaderChapters.createChapterScheduler({create: async '
                 '(index, signal, priority) => { signal.throwIfAborted(); return `${index}:${priority}`; }});\n'
                 'chapters.load(0).then(value => value.toUpperCase()); chapters.prefetch([1, 2]);\n')
        source.write_text(valid)
        self.assert_check(self.run_check(*check), True, "")
        for bad, diagnostic in (
            ('repository.load("wrong");', "TS2345"),
            ('VoiceOfMLReaderChapters.createChapterRepository({count: 1, find: () => null});', "TS2741"),
            ('repository.state(0).status;', "TS2531"),
            ('chapters.load(1).then(value => value.toFixed());', "TS2551"),
            ('VoiceOfMLReaderChapters.createChapterRepository({count: 1, find: () => "x", '
             'create: () => "x", commit: (_index, value) => value - 1});', "TS2362"),
        ):
            with self.subTest(bad=bad):
                source.write_text(valid + bad + "\n")
                self.assert_check(self.run_check(*check), False, diagnostic)

    def test_strict_section_virtualizer_type_contract(self):
        source = self.root / "static/virtualizer-strict-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/virtualizer-strict-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        valid = ('const sections = VoiceOfMLReaderVirtual.createSectionVirtualizer({'
                 'limit: 9, getLoaded: () => [document.body], getIndex: node => node.tabIndex, '
                 'getHeight: node => node.clientHeight, virtualize: (node, index, height) => '
                 'node.style.height = `${height}px`, release: index => index, '
                 'canVirtualize: node => !node.hidden});\nsections.trim(1); sections.dispose();\n')
        source.write_text(valid)
        self.assert_check(self.run_check(*check), True, "")
        for bad, diagnostic in (
            ('sections.trim("wrong");', "TS2345"),
            ('VoiceOfMLReaderVirtual.createSectionVirtualizer({limit: 9});', "TS2739"),
            ('VoiceOfMLReaderVirtual.createSectionVirtualizer({limit: 9, getLoaded: () => [document.body], '
             'getIndex: node => node.noSuchProperty, getHeight: node => node.clientHeight, '
             'virtualize: () => {}, release: () => {}});', "TS2339"),
        ):
            with self.subTest(bad=bad):
                source.write_text(valid + bad + "\n")
                self.assert_check(self.run_check(*check), False, diagnostic)

    def test_strict_scroll_anchor_type_contract(self):
        source = self.root / "static/scroll-strict-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), "static/scroll-strict-usage.js"]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        valid = ('const manager = VoiceOfMLReaderScroll.createScrollAnchorManager('
                 '{viewport: document.body, candidates: () => [document.body]});\n'
                 'const saved = manager.capture(); manager.restore(saved);\n'
                 'const resultLength = manager.preserve(() => "text").length;\n'
                 'manager.whenIdle(() => console.log(resultLength)); manager.observe(document.body);\n'
                 'VoiceOfMLReaderScroll.createScrollAnchorManager({viewport: document.body, candidates: () => [], '
                 'requestFrame: callback => 1, cancelFrame: id => {}, '
                 'setTimer: (callback, delay) => { if (typeof callback === "function") callback(); return 1; }, '
                 'clearTimer: id => {}});\n')
        source.write_text(valid)
        self.assert_check(self.run_check(*check), True, "")
        for bad, diagnostic in (
            ('VoiceOfMLReaderScroll.createScrollAnchorManager({viewport: "bad", candidates: () => []});', "TS2322"),
            ('VoiceOfMLReaderScroll.createScrollAnchorManager({viewport: document.body, candidates: () => [3]});', "TS2322"),
            ('manager.restore({node: document.body, offset: "bad", generation: 1});', "TS2322"),
            ('manager.preserve(() => "text").toFixed();', "TS2551"),
            ('manager.whenIdle("bad");', "TS2345"),
            ('VoiceOfMLReaderScroll.createScrollAnchorManager({viewport: document.body, candidates: () => [], '
             'setTimer: () => "wrong"});', "TS2322"),
        ):
            with self.subTest(bad=bad):
                source.write_text(valid + bad + "\n")
                self.assert_check(self.run_check(*check), False, diagnostic)

    def test_scroll_anchor_declaration_matches_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/reader/ui/reader-scroll-anchor.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        valid_return = "restore(snapshot?: ReaderScrollAnchor | null): boolean;"
        self.assertEqual(original.count(valid_return), 1)
        declaration.write_text(original.replace(valid_return, "restore(snapshot?: ReaderScrollAnchor | null): string;"))
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_session_declaration_matches_strict_runtime(self):
        config = self.root / "jsconfig.json"
        declaration = self.root / "reader-globals.d.ts"
        original = (ROOT / "typings/reader-globals.d.ts").read_text()
        declaration.write_text(original)
        self.assertIn("static/search/search-session.js", json.loads((ROOT / "jsconfig.strict.json").read_text())["files"])
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(declaration), str(ROOT / "static/search/search-session.js")]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        for before, after in [
            ("openSearchSessionDB(): Promise<IDBDatabase>;", "openSearchSessionDB(): Promise<string>;"),
            ("persistSearchSession(): Promise<void>;", "persistSearchSession(): Promise<number>;"),
            ("restoreSearchSession(): Promise<boolean>;", "restoreSearchSession(): Promise<string>;")
        ]:
            self.assertEqual(original.count(before), 1)
            declaration.write_text(original.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")
        declaration.write_text(original)
        implementation = self.root / "static/search-session.js"
        source = (ROOT / "static/search/search-session.js").read_text()
        before = "return { openSearchSessionDB, persistSearchSession, restoreSearchSession };"
        self.assertEqual(source.count(before), 1)
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext", "moduleDetection": "force"}, "files": [str(declaration), str(implementation)]}))
        for after in [
            'return { openSearchSessionDB: async () => "bad", persistSearchSession, restoreSearchSession };',
            'return { openSearchSessionDB, persistSearchSession: async () => 42, restoreSearchSession };',
            'return { openSearchSessionDB, persistSearchSession, restoreSearchSession: async () => "bad" };'
        ]:
            implementation.write_text(source.replace(before, after))
            self.assert_check(self.run_check(*check), False, "TS2322")

    def test_search_session_rejects_invalid_policy_and_return_types(self):
        source = self.root / "static/session-usage.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "target": "esnext"}, "files": [str(ROOT / "typings/reader-globals.d.ts"), str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('const s=VoiceOfMLSearchSession.createSearchSession({canPersist:()=>true,canRestore:t=>!t||t.protocol==="https:"});\n'
                          '/** @type {Promise<boolean>} */ const restored=s.restoreSearchSession();\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('const s=VoiceOfMLSearchSession.createSearchSession({canPersist:()=>true,canRestore:()=>true});\n'
                          '/** @type {Promise<string>} */ const db=s.openSearchSessionDB();\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        source.write_text('const s=VoiceOfMLSearchSession.createSearchSession({canPersist:()=>true,canRestore:()=>true});\n'
                          '/** @type {Promise<number>} */ const saved=s.persistSearchSession();\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        source.write_text('VoiceOfMLSearchSession.createSearchSession({canPersist:()=>"yes",canRestore:()=>true});\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        source.write_text('VoiceOfMLSearchSession.createSearchSession({canPersist:()=>true,canRestore:()=>1});\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        source.write_text('const s=VoiceOfMLSearchSession.createSearchSession({canPersist:()=>true,canRestore:()=>true});\n'
                          '/** @type {Promise<string>} */ const restored=s.restoreSearchSession();\n')
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_reader_navigation_exact_contract_rejects_wrong_usage_and_untrusted_json(self):
        original = json.loads((ROOT / "jsconfig.search-exact.json").read_text())
        files = [str(ROOT / file) for file in original["files"]]
        source = self.root / "static/navigation-type-usage.js"
        config = self.root / "jsconfig-navigation.json"
        config.write_text(json.dumps({"compilerOptions": original["compilerOptions"], "files": files + [str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        source.write_text('const nav=VoiceOfMLReaderNavigation.createNavigation("/reader.html");\n'
                          'const saved=nav.saved(); if(typeof saved === "object" && saved !== null && "readerUrl" in saved) '
                          'console.log(saved.readerUrl);\n'
                          '/** @type {HTMLIFrameElement|null} */ const frame=nav.backgroundReader;\n'
                          'nav.clear(new URL("https://example.test")); nav.disposeBackground();\n')
        self.assert_check(self.run_check(*check), True, "")
        cases = [
            ('const n=VoiceOfMLReaderNavigation.createNavigation(42);', 'TS2345'),
            ('const n=VoiceOfMLReaderNavigation.createNavigation("/reader.html"); n.parse(42);', 'TS2345'),
            ('const n=VoiceOfMLReaderNavigation.createNavigation("/reader.html"); n.mergeSearchParams("/", "", {keys:[3]});', 'TS2322'),
            ('const n=VoiceOfMLReaderNavigation.createNavigation("/reader.html"); n.saved().readerUrl;', 'TS2571'),
            ('const n=VoiceOfMLReaderNavigation.createNavigation("/reader.html");\n/** @type {string} */ const frame=n.backgroundReader;', 'TS2322'),
            ('const n=VoiceOfMLReaderNavigation.createNavigation("/reader.html");\n/** @type {HTMLIFrameElement} */ const frame=n.replace("/reader.html", {});', 'TS2322'),
            ('VoiceOfMLReaderNavigation.createNavigation("/reader.html", {resume:42});', 'TS2322'),
        ]
        for program, error in cases:
            with self.subTest(program=program):
                source.write_text(program + '\n')
                self.assert_check(self.run_check(*check), False, error)

        # Compile an isolated physical copy of the implementation with the
        # production exact options; a permissive declaration alone cannot pass.
        implementation = self.root / "static/search/reader-navigation.js"
        implementation.parent.mkdir(parents=True, exist_ok=True)
        body = (ROOT / "static/search/reader-navigation.js").read_text()
        implementation.write_text(body)
        declarations = ROOT / "typings/reader-globals.d.ts"
        config.write_text(json.dumps({"compilerOptions": original["compilerOptions"],
                                      "files": [str(declarations), str(implementation)]}))
        self.assert_check(self.run_check(*check), True, "")
        anchors = [
            ('/** @param {string | URL} raw */\n    function parse(raw)',
             '/** @param {number} raw */\n    function parse(raw)'),
            ('/** @returns {unknown} */\n    function saved()',
             '/** @returns {number} */\n    function saved()'),
            ('return Object.freeze({\n      parse,',
             'return Object.freeze({\n      parse: () => 123,'),
        ]
        for before, after in anchors:
            with self.subTest(implementation=before):
                self.assertEqual(body.count(before), 1)
                implementation.write_text(body.replace(before, after))
                self.assert_check(self.run_check(*check), False, "TS2322")

    def test_reader_navigation_baseline_gate_fails_closed(self):
        paths = ["static/search/reader-navigation.js", "scripts/check_reader_navigation_baseline.mjs",
                 "tests/test_reader_navigation_baseline.mjs", "scripts/check_tap_contracts.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "# pass 11")
        test = self.root / paths[2]
        source = test.read_text()
        name = 'remember stores a private reader URL but exposes a sanitized history URL'
        anchor = "test('" + name + "'"
        self.assertEqual(source.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            test.write_text(source.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source.replace(anchor + ", () => {", anchor + ", () => { throw new Error('navigation baseline failed');"))
        self.assert_check(self.run_check(*check), False, "navigation baseline failed")
        test.unlink()
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source)
        (self.root / paths[0]).unlink()
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")

    def test_reader_navigation_coverage_gate_requires_exact_source_row_and_thresholds(self):
        paths = ["static/search/reader-navigation.js", "scripts/check_reader_navigation_baseline.mjs",
                 "tests/test_reader_navigation_baseline.mjs", "scripts/check_tap_contracts.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        gate = self.root / paths[1]
        original = gate.read_text()
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "reader-navigation.js |")
        # Keep the real subprocess and TAP report but reject its parsed row.
        anchor = 'const rows = text.split(/\\r?\\n/).flatMap(line => {'
        self.assertEqual(original.count(anchor), 1)
        altered = original.replace(anchor, 'const observedRows = text.split(/\\r?\\n/).flatMap(line => {')
        altered = altered.replace('const required = [', 'const rows = [];\nconst required = [')
        gate.write_text(altered)
        self.assert_check(self.run_check(*check), False, 'one source row above each minimum')
        gate.write_text(original.replace('const required = [', 'const duplicateRows = rows.concat(rows);\nconst required = [')
                        .replace('rows.length !== 1', 'duplicateRows.length !== 1'))
        self.assert_check(self.run_check(*check), False, 'one source row above each minimum')
        for thresholds in ('[35.86, 81.82, 27.27]', '[31.96, 84.10, 27.27]', '[31.96, 81.82, 27.28]'):
            self.assertIn('[31.96, 81.82, 27.27]', original)
            gate.write_text(original.replace('[31.96, 81.82, 27.27]', thresholds))
            self.assert_check(self.run_check(*check), False, 'one source row above each minimum')

    def test_reader_image_loader_coverage_gate_fails_closed(self):
        paths = ["static/reader/formats/reader-image-loader.mjs", "scripts/check_reader_image_loader_coverage.mjs",
                 "scripts/check_tap_contracts.mjs", "tests/test_reader_image_loader.mjs",
                 "tests/test_reader_image_loader_contract.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "reader-image-loader.mjs |")
        test = self.root / paths[4]
        source = test.read_text()
        name = 'image cancellation settles immediately even when the reader stays active'
        anchor = "test('" + name + "'"
        self.assertEqual(source.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            test.write_text(source.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, 'Reader image loader requires named contracts')
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, 'Reader image loader requires named contracts')
        test.unlink()
        self.assert_check(self.run_check(*check), False, 'Reader image loader requires named contracts')
        test.write_text(source)
        legacy = self.root / paths[3]
        legacy_source = legacy.read_text()
        marker = 'Reader image loader: direct load, cleanup, cancellation, HTTP errors and bounded fallback passed'
        self.assertEqual(legacy_source.count(marker), 1)
        legacy.write_text(legacy_source.replace(marker, 'missing completion marker'))
        self.assert_check(self.run_check(*check), False, 'Reader image loader requires named contracts')
        legacy.write_text(legacy_source)
        gate = self.root / paths[1]
        original = gate.read_text()
        anchor = 'const rows = text.split(/\\r?\\n/).flatMap(line => {'
        self.assertEqual(original.count(anchor), 1)
        altered = original.replace(anchor, 'const observedRows = text.split(/\\r?\\n/).flatMap(line => {')
        gate.write_text(altered.replace('const required = [', 'const rows = [];\nconst required = ['))
        self.assert_check(self.run_check(*check), False, 'exactly one source row')
        gate.write_text(original.replace('const required = [', 'const duplicateRows = rows.concat(rows);\nconst required = [')
                        .replace('rows.length !== 1', 'duplicateRows.length !== 1'))
        self.assert_check(self.run_check(*check), False, 'exactly one source row')
        self.assertEqual(original.count('reader-image-loader\\.mjs'), 1)
        gate.write_text(original.replace('reader-image-loader\\.mjs', 'missing-image-loader\\.mjs'))
        self.assert_check(self.run_check(*check), False, 'exactly one source row')
        for thresholds in ('[100.01, 87.18, 91.67]', '[100, 87.19, 91.67]', '[100, 87.18, 91.68]'):
            self.assertIn('[100, 87.18, 91.67]', original)
            gate.write_text(original.replace('[100, 87.18, 91.67]', thresholds))
            self.assert_check(self.run_check(*check), False, 'Reader image loader requires named contracts')

    def test_pdf_book_client_coverage_gate_fails_closed(self):
        paths = ['static/reader/search/reader-pdf-book-search.mjs',
                 'scripts/check_pdf_book_client_coverage.mjs', 'scripts/check_tap_contracts.mjs',
                 'tests/reader/pdf-search/test_pdf_book_client.mjs']
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ['node', paths[1]]
        message = 'PDF book-search client requires named contracts'
        self.assert_check(self.run_check(*check), True, '# pass 9')
        source = self.root / paths[3]
        original = source.read_text()
        name = 'a page requested during progress uses the current partial session'
        anchor = "test('" + name + "'"
        self.assertEqual(original.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            source.write_text(original.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, message)
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("todo 0");',
                      'console.log("pass 9");', 'console.log("end of coverage report");'):
            source.write_text(original + '\n' + extra + '\n')
            self.assert_check(self.run_check(*check), False, message)
        self.assertIn(anchor + ',async()=>{', original)
        source.write_text(original.replace(anchor + ',async()=>{',
                                           anchor + ",async()=>{throw new Error('injected client failure');"))
        self.assert_check(self.run_check(*check), False, 'injected client failure')
        source.unlink()
        self.assert_check(self.run_check(*check), False, message)
        source.write_text(original)
        gate = self.root / paths[1]
        gate_original = gate.read_text()
        self.assertEqual(gate_original.count('[100,100,100]'), 1)
        for minimum in ('[100.01,100,100]', '[100,100.01,100]', '[100,100,100.01]'):
            gate.write_text(gate_original.replace('[100,100,100]', minimum))
            self.assert_check(self.run_check(*check), False, message)
        self.assertEqual(gate_original.count('reader-pdf-book-search\\.mjs'), 1)
        gate.write_text(gate_original.replace('reader-pdf-book-search\\.mjs', 'missing-pdf-book-search\\.mjs'))
        self.assert_check(self.run_check(*check), False, message)

    def test_reader_text_coverage_gate_fails_closed(self):
        paths = ['static/reader/formats/reader-text-format.mjs',
                 'scripts/check_reader_text_coverage.mjs', 'scripts/check_tap_contracts.mjs',
                 'tests/reader/text/test_reader_text_baseline.mjs',
                 'tests/reader/text/test_reader_text_faults.mjs']
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ['node', paths[1]]
        message = 'Reader text requires named contracts and exactly one source row'
        self.assert_check(self.run_check(*check), True, '# pass 14')
        source = self.root / paths[3]
        original = source.read_text()
        name = 'stream rejects an oversized body and cancels its reader'
        anchor = "test('" + name + "'"
        self.assertEqual(original.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            source.write_text(original.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, message)
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("todo 0");',
                      'console.log("pass 14");', 'console.log("end of coverage report");'):
            source.write_text(original + '\n' + extra + '\n')
            self.assert_check(self.run_check(*check), False, message)
        self.assertIn(anchor + ',async()=>{', original)
        source.write_text(original.replace(anchor + ',async()=>{',
                                           anchor + ",async()=>{throw new Error('injected text failure');"))
        self.assert_check(self.run_check(*check), False, 'injected text failure')
        source.unlink()
        self.assert_check(self.run_check(*check), False, message)
        source.write_text(original)
        gate = self.root / paths[1]
        gate_original = gate.read_text()
        self.assertEqual(gate_original.count('[100, 91.89, 90.91]'), 1)
        for minimum in ('[100.01, 91.89, 90.91]', '[100, 91.90, 90.91]', '[100, 91.89, 90.92]'):
            gate.write_text(gate_original.replace('[100, 91.89, 90.91]', minimum))
            self.assert_check(self.run_check(*check), False, message)
        self.assertEqual(gate_original.count('reader-text-format\\.mjs'), 1)
        gate.write_text(gate_original.replace('reader-text-format\\.mjs', 'missing-text-format\\.mjs'))
        self.assert_check(self.run_check(*check), False, message)

    def test_reader_media_coverage_gate_fails_closed(self):
        paths = ['static/reader/formats/reader-media-format.mjs',
                 'scripts/check_reader_media_coverage.mjs', 'scripts/check_tap_contracts.mjs',
                 'tests/reader/media/test_reader_media_baseline.mjs',
                 'tests/reader/media/test_reader_media_metadata.mjs']
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ['node', paths[1]]
        message = 'Reader media requires named contracts and exactly one source row'
        self.assert_check(self.run_check(*check), True, '# pass 15')
        source = self.root / paths[4]
        original = source.read_text()
        name = 'resource cleanup rejects pending metadata and removes listeners'
        anchor = "test('" + name + "'"
        self.assertEqual(original.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            source.write_text(original.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, message)
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("todo 0");',
                      'console.log("pass 15");', 'console.log("end of coverage report");'):
            source.write_text(original + '\n' + extra + '\n')
            self.assert_check(self.run_check(*check), False, message)
        source.write_text(original.replace(anchor + ', async () => {',
                                           anchor + ", async () => { throw new Error('injected media failure');"))
        self.assert_check(self.run_check(*check), False, 'injected media failure')
        source.unlink()
        self.assert_check(self.run_check(*check), False, message)
        source.write_text(original)
        gate = self.root / paths[1]
        gate_original = gate.read_text()
        self.assertEqual(gate_original.count('[100, 90.77, 100]'), 1)
        for minimum in ('[100.01, 90.77, 100]', '[100, 90.78, 100]', '[100, 90.77, 100.01]'):
            gate.write_text(gate_original.replace('[100, 90.77, 100]', minimum))
            self.assert_check(self.run_check(*check), False, message)
        self.assertEqual(gate_original.count('reader-media-format\\.mjs'), 1)
        gate.write_text(gate_original.replace('reader-media-format\\.mjs', 'missing-media-format\\.mjs'))
        self.assert_check(self.run_check(*check), False, message)

    def test_reader_djvu_contract_gate_fails_closed(self):
        for name in ('check_reader_djvu_contracts.mjs', 'check_tap_contracts.mjs'):
            shutil.copyfile(ROOT / 'scripts' / name, self.root / 'scripts' / name)
        # V8 resolves symlinks before applying coverage includes. Copy the
        # source into the fixture so the exact source row is really measured.
        shutil.copytree(ROOT / 'static/reader', self.root / 'static/reader')
        names = ('only', 'png', 'range', 'range_fallback', 'scheduler', 'source_integrity', 'worker')
        directory = self.root / 'tests/reader/djvu'
        directory.mkdir(parents=True)
        for name in names:
            shutil.copyfile(ROOT / 'tests/reader/djvu' / f'test_reader_djvu_{name}.mjs',
                            directory / f'test_reader_djvu_{name}.mjs')
        boundary = directory / 'test_reader_djvu_range_boundaries.mjs'
        shutil.copyfile(ROOT / 'tests/reader/djvu/test_reader_djvu_range_boundaries.mjs', boundary)
        check = ['node', 'scripts/check_reader_djvu_contracts.mjs']
        message = 'DjVu contracts require seven named scripts'
        self.assert_check(self.run_check(*check), True, '# pass 7')
        worker = directory / 'test_reader_djvu_worker.mjs'
        source = worker.read_text()
        marker = 'DjVu Worker bounds, errors, timeout, cancellation and geometry checks passed'
        self.assertEqual(source.count(marker), 1)
        for replacement in ('renamed completion marker', ''):
            worker.write_text(source.replace(marker, replacement))
            self.assert_check(self.run_check(*check), False, message)
        worker.write_text(source + "\nthrow new Error('injected DjVu failure');\n")
        self.assert_check(self.run_check(*check), False, 'injected DjVu failure')
        worker.unlink()
        self.assert_check(self.run_check(*check), False, message)
        for summary in ('skipped 0', 'skipped 1', 'todo 0', 'todo 1', 'pass 7'):
            worker.write_text(source.replace("console.log('" + marker + "'", "console.log('" + summary + "');\nconsole.log('" + marker + "'"))
            self.assert_check(self.run_check(*check), False, message)
        worker.write_text(source)
        gate = self.root / 'scripts/check_reader_djvu_contracts.mjs'
        original = gate.read_text()
        anchor = '...required.map(({name}) => name)'
        self.assertEqual(original.count(anchor), 1)
        gate.write_text(original.replace(anchor, '...required.slice(1).map(({name}) => name)'))
        self.assert_check(self.run_check(*check), False, message)
        gate.write_text(original.replace(anchor, '...required.slice(0, 6).map(({name}) => name)'))
        self.assert_check(self.run_check(*check), False, message)
        gate.write_text(original)
        boundary_source = boundary.read_text()
        boundary_name = 'reads reject invalid lengths and offsets without dispatching new windows'
        self.assertEqual(boundary_source.count(boundary_name), 1)
        boundary.write_text(boundary_source.replace(boundary_name, 'renamed boundary contract'))
        self.assert_check(self.run_check(*check), False, message)
        boundary.write_text(boundary_source.replace("test('" + boundary_name + "'", "test.skip('" + boundary_name + "'"))
        self.assert_check(self.run_check(*check), False, message)
        boundary.unlink()
        self.assert_check(self.run_check(*check), False, message)
        boundary.write_text(boundary_source)
        for summary in ('skipped 0', 'todo 0', 'pass 2', 'end of coverage report'):
            boundary.write_text(boundary_source + '\nconsole.log(' + json.dumps(summary) + ');\n')
            self.assert_check(self.run_check(*check), False, message)
        boundary.write_text(boundary_source)
        for minimum in ('[100.01, 86.81, 78.95]', '[100, 86.82, 78.95]', '[100, 86.81, 78.96]'):
            self.assertEqual(original.count('[100, 86.81, 78.95]'), 1)
            gate.write_text(original.replace('[100, 86.81, 78.95]', minimum))
            self.assert_check(self.run_check(*check), False, message)
        self.assertEqual(original.count('reader-djvu-range\\.mjs'), 1)
        gate.write_text(original.replace('reader-djvu-range\\.mjs', 'missing-djvu-range\\.mjs'))
        self.assert_check(self.run_check(*check), False, message)

    def test_reader_lifecycle_coverage_gate_fails_closed(self):
        paths = ["static/reader/core/reader-lifecycle.mjs", "scripts/check_reader_lifecycle_coverage.mjs",
                 "scripts/check_tap_contracts.mjs", "tests/reader/lifecycle/test_reader_lifecycle.mjs"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "reader-lifecycle.mjs |")
        test = self.root / paths[3]
        source = test.read_text()
        name = 'error classification preserves dynamic getter access and uncoerced matching codes'
        anchor = "test('" + name + "'"
        self.assertEqual(source.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            test.write_text(source.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, 'Reader lifecycle requires named contracts')
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("pass 99");',
                      'console.log("duration_ms 1");', 'console.log("end of coverage report");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, 'Reader lifecycle requires named contracts')
        test.unlink()
        self.assert_check(self.run_check(*check), False, 'Reader lifecycle requires named contracts')
        test.write_text(source)
        gate = self.root / paths[1]
        original = gate.read_text()
        anchor = 'const rows = text.split(/\\r?\\n/).flatMap(line => {'
        self.assertEqual(original.count(anchor), 1)
        altered = original.replace(anchor, 'const observedRows = text.split(/\\r?\\n/).flatMap(line => {')
        gate.write_text(altered.replace('const required = [', 'const rows = [];\nconst required = ['))
        self.assert_check(self.run_check(*check), False, 'exactly one source row')
        gate.write_text(original.replace('const required = [', 'const duplicateRows = rows.concat(rows);\nconst required = [')
                        .replace('rows.length !== 1', 'duplicateRows.length !== 1'))
        self.assert_check(self.run_check(*check), False, 'exactly one source row')
        self.assertEqual(original.count('reader-lifecycle\\.mjs'), 1)
        gate.write_text(original.replace('reader-lifecycle\\.mjs', 'missing-lifecycle\\.mjs'))
        self.assert_check(self.run_check(*check), False, 'exactly one source row')
        for thresholds in ('[100.01, 97.47, 100]', '[100, 97.48, 100]', '[100, 97.47, 100.01]'):
            gate.write_text(original.replace('[100, 97.47, 100]', thresholds))
            self.assert_check(self.run_check(*check), False, 'Reader lifecycle requires named contracts')

    def test_search_readability_baseline_gate_fails_closed(self):
        paths = ["static/app.js", "scripts/check_search_readability_baseline.mjs",
                 "tests/search/baselines/test_search_readability_baseline.mjs", "scripts/check_tap_contracts.mjs",
                 "static/reader/core/reader-contract.js"]
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "# pass 9")
        test = self.root / paths[2]
        source = test.read_text()
        name = 'docx without a converted link is rejected before capability lookup'
        anchor = "test('" + name + "'"
        self.assertEqual(source.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            test.write_text(source.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');", 'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source.replace(anchor + ", () => {", anchor + ", () => { throw new Error('readability failed');"))
        self.assert_check(self.run_check(*check), False, "readability failed")
        test.unlink()
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source)
        app = self.root / paths[0]
        app.write_text(app.read_text().replace('function isReadableRecord(', 'function renamedReadableRecord('))
        self.assert_check(self.run_check(*check), False, 'expected one original isReadableRecord definition')
        shutil.copyfile(ROOT / paths[0], app)
        fragment = self.root / 'readability-fragment.js'
        fragment.write_text('function isReadableRecord() { return true; }')
        result = subprocess.run(check, cwd=self.root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                env={**os.environ, 'READABILITY_BASELINE_FRAGMENT': str(fragment)})
        self.assert_check(result, False, 'all named baseline contracts')

    def test_search_folder_merge_baseline_gate_fails_closed(self):
        paths = ["static/app.js", "scripts/check_search_folder_merge_baseline.mjs",
                 "tests/search/baselines/test_search_folder_merge_baseline.mjs"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "# pass 10")
        test = self.root / paths[2]
        source = test.read_text()
        name = 'membership is captured before subtree filter access mutates the self array'
        anchor = "test('" + name + "'"
        self.assertEqual(source.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            test.write_text(source.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        for extra in ("test('" + name + "', () => {});", "test.skip('extra skip', () => {});",
                      "test.todo('extra todo');"):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source.replace(anchor + ", () => {", anchor + ", () => { throw new Error('folder merge failed');"))
        self.assert_check(self.run_check(*check), False, "folder merge failed")
        test.unlink()
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source)
        app = self.root / paths[0]
        app.write_text(app.read_text().replace("function mergeFolderFilters(", "function renamedFolderFilters("))
        self.assert_check(self.run_check(*check), False, "original inline folder merge")

    def test_search_filter_equality_baseline_gate_fails_closed(self):
        paths = ["static/app.js", "scripts/check_search_filter_equality_baseline.mjs",
                 "tests/search/baselines/test_search_filter_equality_baseline.mjs"]
        for path in [*paths, "scripts/check_tap_contracts.mjs"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", paths[1]]
        self.assert_check(self.run_check(*check), True, "# pass 7")
        test = self.root / paths[2]
        source = test.read_text()
        name = 'the current length is re-read after indexed getters mutate it'
        anchor = "test('" + name + "'"
        self.assertEqual(source.count(anchor), 1)
        for replacement in ("test('renamed contract'", "test.skip('" + name + "'", "test.todo('" + name + "'"):
            test.write_text(source.replace(anchor, replacement))
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source + "\ntest('" + name + "', () => {});\n")
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source + "\ntest.skip('additional skip', () => {});\n")
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        for extra in ('console.log("skipped 0"); test.skip("extra skip", () => {});',
                      'console.log("todo 0"); test.todo("extra todo");',
                      'console.log("skipped 0");', 'console.log("todo 0");'):
            test.write_text(source + "\n" + extra + "\n")
            self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source.replace(anchor + ", () => {", anchor + ", () => { throw new Error('filter baseline failed');"))
        self.assert_check(self.run_check(*check), False, "filter baseline failed")
        test.unlink()
        self.assert_check(self.run_check(*check), False, "all named baseline contracts")
        test.write_text(source)
        app = self.root / paths[0]
        app.write_text(app.read_text().replace("function sameSearchFilterValues(", "function renamedFilterValues("))
        self.assert_check(self.run_check(*check), False, "original inline filter comparison")

    def test_search_exact_gate_rejects_unchecked_indexes_and_undefined_optionals(self):
        original = json.loads((ROOT / "jsconfig.search-exact.json").read_text())
        options = original["compilerOptions"]
        for flag in ("allowJs", "checkJs", "noEmit", "strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes"):
            self.assertIs(options.get(flag), True, flag)
        required = {"static/search/search-session.js", "static/search/reader-navigation.js", "static/search/download-controller.js", "static/search/result-identity.js", "static/search/record-path.js",
                    "static/search/response-validation.js", "static/search/response-cache.js", "static/search/file-types.js",
                    "static/search/highlight.js", "static/search/size-format.js"}
        self.assertEqual(set(original["files"]) - {"typings/reader-globals.d.ts"}, required)
        self.assertIn("tsc --project jsconfig.search-exact.json", json.loads((ROOT / "package.json").read_text())["scripts"]["types"])
        source = self.root / "static/exact-usage.js"
        config = self.root / "jsconfig.json"
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        def configure(settings):
            config.write_text(json.dumps({"compilerOptions": settings,
                "files": [*[str(ROOT / name) for name in original["files"]], str(source)]}))
        configure(options)
        source.write_text('/** @param {string[]} values @returns {string} */ function first(values) { return values[0] || ""; }\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('/** @param {string[]} values @returns {string} */ function first(values) { return values[0]; }\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        configure({**options, "noUncheckedIndexedAccess": False})
        self.assert_check(self.run_check(*check), True, "")
        configure(options)
        source.write_text('/** @type {{name?: string}} */ const item={name:undefined};\n')
        self.assert_check(self.run_check(*check), False, "TS2375")
        configure({**options, "exactOptionalPropertyTypes": False})
        self.assert_check(self.run_check(*check), True, "")
        local_config = self.root / "jsconfig.search-exact.json"
        local_config.write_text(json.dumps(original))
        for name in original["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        production_check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", local_config]
        self.assert_check(self.run_check(*production_check), True, "")
        module = self.root / "static/search/result-identity.js"
        module.write_text(module.read_text() + '\n/** @param {string[]} values @returns {string} */ function probe(values) { return values[0]; }\n')
        self.assert_check(self.run_check(*production_check), False, "TS2322")
        shutil.copyfile(ROOT / "static/search/result-identity.js", module)
        module = self.root / "static/search/highlight.js"
        module.write_text(module.read_text() + '\n/** @param {string[]} values @returns {string} */ function probe(values) { return values[0]; }\n')
        self.assert_check(self.run_check(*production_check), False, "TS2322")
        shutil.copyfile(ROOT / "static/search/highlight.js", module)
        module = self.root / "static/search/size-format.js"
        module.write_text(module.read_text() + '\n/** @param {string[]} values @returns {string} */ function probe(values) { return values[0]; }\n')
        self.assert_check(self.run_check(*production_check), False, "TS2322")
        shutil.copyfile(ROOT / "static/search/size-format.js", module)
        module = self.root / "static/search/download-controller.js"
        module.write_text(module.read_text() + '\n/** @param {string[]} values @returns {string} */ function probe(values) { return values[0]; }\n')
        self.assert_check(self.run_check(*production_check), False, "TS2322")

    def test_size_exact_gate_preserves_original_lookups(self):
        config = self.root / "jsconfig.search-exact.json"
        original = json.loads((ROOT / "jsconfig.search-exact.json").read_text())
        config.write_text(json.dumps(original))
        for name in original["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        module = self.root / "static/search/size-format.js"
        source = module.read_text()
        assertions = [('/** @type {string} */ (m[1])', 'm[1]', "TS2345"),
                      ('@returns {string | object | undefined}', '@returns {string | object}', "TS2322")]
        for assertion, original_lookup, diagnostic in assertions:
            self.assertEqual(source.count(assertion), 1)
            module.write_text(source.replace(assertion, original_lookup))
            self.assert_check(self.run_check(*check), False, diagnostic)

    def test_highlight_exact_gate_preserves_dynamic_escape_lookup(self):
        config = self.root / "jsconfig.search-exact.json"
        original = json.loads((ROOT / "jsconfig.search-exact.json").read_text())
        config.write_text(json.dumps(original))
        for name in original["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        module = self.root / "static/search/highlight.js"
        source = module.read_text()
        assertion = '/** @type {string} */ (HTML_ESCAPE_MAP[ch])'
        self.assertEqual(source.count(assertion), 1)
        module.write_text(source.replace(assertion, 'HTML_ESCAPE_MAP[ch]'))
        self.assert_check(self.run_check(*check), False, "TS2769")

    def test_reader_chapter_exact_gate_checks_original_bounds_invariant(self):
        config = self.root / "jsconfig.reader-exact.json"
        original = json.loads((ROOT / "jsconfig.reader-exact.json").read_text())
        config.write_text(json.dumps(original))
        for name in original["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")
        module = self.root / "static/reader/formats/reader-chapter-repository.js"
        source = module.read_text()
        assertion = '/** @type {ChapterRecord<T>} */ (records[index])'
        self.assertEqual(source.count(assertion), 2)
        module.write_text(source.replace(assertion, 'records[index]'))
        self.assert_check(self.run_check(*check), False, "TS18048")

    def test_reader_image_request_signal_shape_is_exact(self):
        config = self.root / "jsconfig.json"
        source = self.root / "static/image-signal-usage.mjs"
        module = (ROOT / "static/reader/formats/reader-image-loader.mjs").as_posix()
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": True, "noUncheckedIndexedAccess": True, "exactOptionalPropertyTypes": True,
            "target": "esnext", "module": "esnext", "moduleResolution": "bundler"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"), module, str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        setup = f'''import {{createReaderImageLoader}} from "{module}";
const options = /** @type {{Parameters<typeof createReaderImageLoader>[0]}} */ (/** @type {{unknown}} */ ({{}}));
const request = options.request;
'''
        source.write_text(setup + 'request("https://example.test", 1, {signal:undefined, priority:"auto"});\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text(setup + 'request("https://example.test", 1, {priority:"auto"});\n')
        self.assert_check(self.run_check(*check), False, "TS2741")
        source.write_text(setup + 'request("https://example.test", 1, {signal:null, priority:"auto"});\n')
        self.assert_check(self.run_check(*check), False, "TS2322")

    def test_pdf_first_page_worker_adapter_strict_signatures(self):
        module = (ROOT / "static/reader/pdf/pdf-first-page-worker-adapter.mjs").as_posix()
        source = self.root / "static/pdf-first-page-worker-usage.mjs"
        config = self.root / "jsconfig.json"
        options = json.loads((ROOT / "jsconfig.reader-exact.json").read_text())["compilerOptions"]
        config.write_text(json.dumps({"compilerOptions": options,
            "files": [str(ROOT / "typings/reader-globals.d.ts"), module, str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        prefix = f'import {{makeFirstPageWorkerSource, installFirstPageWorker}} from "{module}";\n'
        valid = ('makeFirstPageWorkerSource("worker");\n'
                 'installFirstPageWorker(new URL("https://example.test/worker.mjs"), "digest", '
                 '{signal:undefined, response:undefined});\n')
        source.write_text(prefix + valid)
        self.assert_check(self.run_check(*check), True, "")
        for expression, diagnostic in [
            ('makeFirstPageWorkerSource(123);', "TS2345"),
            ('installFirstPageWorker(123, "digest");', "TS2345"),
            ('installFirstPageWorker("worker", 123);', "TS2345"),
            ('installFirstPageWorker("worker", "digest", {signal:null});', "TS2322"),
            ('installFirstPageWorker("worker", "digest", {response:Promise.resolve("not a response")});', "TS2322"),
        ]:
            with self.subTest(expression=expression):
                source.write_text(prefix + expression + "\n")
                self.assert_check(self.run_check(*check), False, diagnostic)

        # Removing any implementation parameter annotation must break strict
        # checking; otherwise a permissive signature could hide regressions.
        adapter = self.root / "static/reader/pdf/pdf-first-page-worker-adapter.mjs"
        adapter.parent.mkdir(parents=True, exist_ok=True)
        original = (ROOT / "static/reader/pdf/pdf-first-page-worker-adapter.mjs").read_text()
        local_config = self.root / "jsconfig.reader-exact.json"
        project = json.loads((ROOT / "jsconfig.reader-exact.json").read_text())
        for name in project["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        local_config.write_text(json.dumps(project))
        production_check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", local_config]
        self.assert_check(self.run_check(*production_check), True, "")
        for annotation in [
            '/** @template T @param {PromiseLike<T> | T} promise @param {AbortSignal} signal @returns {Promise<T>} */',
            '/** @param {string} source @param {string} needle @param {string} replacement @param {string} label @returns {string} */',
            '/** @param {string} source */',
        ]:
            with self.subTest(missing=annotation):
                self.assertEqual(original.count(annotation), 1)
                adapter.write_text(original.replace(annotation, ""))
                self.assert_check(self.run_check(*production_check), False, "TS7006")
        adapter.write_text(original)

    def test_pdf_book_client_strict_signatures_and_annotations(self):
        module = (ROOT / 'static/reader/search/reader-pdf-book-search.mjs').as_posix()
        source = self.root / 'static/pdf-book-client-usage.mjs'
        config = self.root / 'jsconfig.json'
        options = json.loads((ROOT / 'jsconfig.reader-exact.json').read_text())['compilerOptions']
        config.write_text(json.dumps({'compilerOptions': options, 'files': [module, str(source)]}))
        check = ['node', ROOT / 'node_modules/typescript/bin/tsc', '--project', config]
        prefix = (f'import {{createPdfBookSearch}} from "{module}";\n'
                  'const client = createPdfBookSearch({url:"https://example.test",bytes:1,sha256:"a",pageCount:1});\n')
        source.write_text(prefix + '''
const result = await client.search('needle', progress => {
  progress.scanned.toFixed(); progress.pages.toFixed(); progress.results.forEach(hit => hit.boxes.forEach(box => box.box));
});
result.session.toFixed(); (await client.page(50)).total.toFixed();
const prefetched = await client.prefetch();
/** @type {true} */ const ready = prefetched.ready;
/** @type {undefined | null} */ const session = prefetched.session;
''')
        self.assert_check(self.run_check(*check), True, '')
        for expression, diagnostic in [
            ('createPdfBookSearch({});', 'TS2739'),
            ('createPdfBookSearch({url:"x",bytes:"1",sha256:"a",pageCount:1});', 'TS2322'),
            ('client.search(7);', 'TS2345'),
            ('client.page("1");', 'TS2345'),
            ('(await client.prefetch()).results;', 'TS2339'),
            ('(await client.search("x")).ready;', 'TS2339'),
            ('(await client.prefetch()).session.id;', 'TS2533'),
            ('client.search("x", progress => { progress.scanned.toUpperCase(); });', 'TS2339'),
        ]:
            with self.subTest(expression=expression):
                source.write_text(prefix + expression + '\n')
                self.assert_check(self.run_check(*check), False, diagnostic)
        project = json.loads((ROOT / 'jsconfig.reader-exact.json').read_text())
        for name in project['files']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        local_config = self.root / 'jsconfig.reader-exact.json'
        local_config.write_text(json.dumps(project))
        production_check = ['node', ROOT / 'node_modules/typescript/bin/tsc', '--project', local_config]
        self.assert_check(self.run_check(*production_check), True, '')
        local = self.root / 'static/reader/search/reader-pdf-book-search.mjs'
        original = local.read_text()
        for annotation in ('/** @param {PdfBookSearchConfiguration} configuration */',
                           '/** @param {string} type @param {Record<string, unknown>} values\n'
                           '   * @param {(value: PdfBookSearchProgress) => void} [progress] @returns {Promise<PdfBookSearchResult | PdfBookPrefetchResult>} */',
                           '/** @param {string} query @param {(value: PdfBookSearchProgress) => void} [progress] */',
                           '/** @param {number} offset */'):
            with self.subTest(missing=annotation):
                self.assertEqual(original.count(annotation), 1)
                local.write_text(original.replace(annotation, ''))
                self.assert_check(self.run_check(*production_check), False, 'TS7006')
        local.write_text(original)

    def test_reader_text_strict_signatures_and_annotations(self):
        module = (ROOT / 'static/reader/formats/reader-text-format.mjs').as_posix()
        source = self.root / 'static/text-usage.mjs'
        config = self.root / 'jsconfig.json'
        options = json.loads((ROOT / 'jsconfig.reader-exact.json').read_text())['compilerOptions']
        config.write_text(json.dumps({'compilerOptions': options,
            'files': [str(ROOT / 'typings/reader-globals.d.ts'), module, str(source)]}))
        check = ['node', ROOT / 'node_modules/typescript/bin/tsc', '--project', config]
        prefix = (f'import {{createReaderTextFormat}} from "{module}";\n'
                  f'import {{createReaderDocumentLoader}} from "{(ROOT / "static/reader/core/reader-document-loader.mjs").as_posix()}";\n'
                  'const ctx = /** @type {Parameters<typeof createReaderTextFormat>[0]} */ (/** @type {unknown} */ ({}));\n'
                  'const loaderCtx = /** @type {Parameters<typeof createReaderDocumentLoader>[0]} */ (/** @type {unknown} */ ({}));\n'
                  'const loader = createReaderDocumentLoader(loaderCtx);\n'
                  'const text = createReaderTextFormat(ctx);\n')
        source.write_text(prefix + '''
/** @type {string} */ const encoding = text.detectTextEncoding(new Uint8Array([65]), 'book');
/** @type {Promise<void>} */ const rendering = text.renderPlainText(new Response('synthetic'));
text.renderTextDocument({response: Promise.resolve(new Response('hello'))});
text.renderMarkdownDocument({response: new Response('hello'), engines: Promise.resolve([])});
text.renderTextDocument(await loader.loadTextDocument());
text.renderMarkdownDocument(loader.loadMarkdownDocument());
ctx.renderText(false, {response: new Response()});
ctx.renderText(true, {response: new Response(), engines: Promise.resolve([])});
''')
        self.assert_check(self.run_check(*check), True, '')
        for expression, diagnostic in [
            ('text.detectTextEncoding("bytes");', 'TS2345'),
            ('text.detectTextEncoding(new Uint8Array(), 123);', 'TS2345'),
            ('text.renderPlainText("not a response");', 'TS2345'),
            ('text.renderTextDocument({});', 'TS2741'),
            ('text.renderMarkdownDocument({response: new Response()});', 'TS2345'),
            ('ctx.renderText(true, {response: new Response()});', 'TS2769'),
            ('ctx.renderText(false, {});', 'TS2769'),
            ('ctx.renderText(true, {response: new Response(), engines: undefined});', 'TS2769'),
            ('/** @type {number} */ const value = text.detectTextEncoding(new Uint8Array());', 'TS2322'),
            ('/** @type {Promise<string>} */ const value = text.renderPlainText(new Response());', 'TS2322'),
            ('createReaderTextFormat({});', 'TS2740'),
        ]:
            with self.subTest(expression=expression):
                source.write_text(prefix + expression + '\n')
                self.assert_check(self.run_check(*check), False, diagnostic)
        project = json.loads((ROOT / 'jsconfig.reader-exact.json').read_text())
        for name in project['files']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        local_config = self.root / 'jsconfig.reader-exact.json'
        local_config.write_text(json.dumps(project))
        production_check = ['node', ROOT / 'node_modules/typescript/bin/tsc', '--project', local_config]
        self.assert_check(self.run_check(*production_check), True, '')
        local = self.root / 'static/reader/formats/reader-text-format.mjs'
        original = local.read_text()
        for annotation in ('/** @param {ReaderTextContext} readerContext */', '/** @param {Response} response */',
                           '/** @param {string} value @param {string} [encoding] */',
                           '/** @param {Uint8Array} bytes @param {string} [hint] */',
                           '/** @param {ReaderTextPrepared} prepared */',
                           '/** @param {ReaderMarkdownPrepared} prepared */'):
            with self.subTest(missing=annotation):
                self.assertEqual(original.count(annotation), 1)
                local.write_text(original.replace(annotation, ''))
                self.assert_check(self.run_check(*production_check), False, 'TS7006')
        local.write_text(original)

    def test_reader_media_strict_signatures_and_annotations(self):
        module = (ROOT / 'static/reader/formats/reader-media-format.mjs').as_posix()
        source = self.root / 'static/media-usage.mjs'
        config = self.root / 'jsconfig.json'
        options = json.loads((ROOT / 'jsconfig.reader-exact.json').read_text())['compilerOptions']
        config.write_text(json.dumps({'compilerOptions': options,
            'files': [str(ROOT / 'typings/reader-globals.d.ts'), module, str(source)]}))
        check = ['node', ROOT / 'node_modules/typescript/bin/tsc', '--project', config]
        prefix = (f'import {{createReaderMediaFormat}} from "{module}";\n'
                  'const ctx = /** @type {Parameters<typeof createReaderMediaFormat>[0]} */ (/** @type {unknown} */ ({}));\n'
                  'const media = createReaderMediaFormat(ctx);\n')
        source.write_text(prefix + '''
/** @type {string} */ const time = media.formatMediaTime(Symbol('dynamic'));
/** @type {Promise<void>} */ const audio = media.renderMedia('audio');
/** @type {Promise<void>} */ const video = media.renderMedia('video');
/** @type {Promise<Uint8Array>} */ const flash = media.loadSwfDocument();
media.renderImageDocument(document.createElement('div')); media.renderSwf({custom:true});
ctx.resolvedReaderData = {original_extension: null}; ctx.resolvedReaderData = {original_extension: undefined};
''')
        self.assert_check(self.run_check(*check), True, '')
        for expression, diagnostic in [
            ('media.renderImageDocument("not a Node");', 'TS2345'),
            ('media.renderMedia(42);', 'TS2345'),
            ('/** @type {number} */ const value = media.formatMediaTime(1);', 'TS2322'),
            ('/** @type {Promise<string>} */ const value = media.renderMedia("audio");', 'TS2322'),
            ('/** @type {Promise<string>} */ const value = media.loadSwfDocument();', 'TS2322'),
            ('createReaderMediaFormat({});', 'TS2740'),
            ('ctx.readerAbortController = 7;', 'TS2322'),
            ('ctx.READER_PROXY_TIMEOUT_MS = "slow";', 'TS2322'),
        ]:
            with self.subTest(expression=expression):
                source.write_text(prefix + expression + '\n')
                self.assert_check(self.run_check(*check), False, diagnostic)
        project = json.loads((ROOT / 'jsconfig.reader-exact.json').read_text())
        for name in project['files']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        local_config = self.root / 'jsconfig.reader-exact.json'
        local_config.write_text(json.dumps(project))
        production_check = ['node', ROOT / 'node_modules/typescript/bin/tsc', '--project', local_config]
        self.assert_check(self.run_check(*production_check), True, '')
        local = self.root / 'static/reader/formats/reader-media-format.mjs'
        original = local.read_text()
        for annotation in ('/** @param {ReaderMediaContext} readerContext */', '/** @param {unknown} seconds */',
                           '/** @param {Node} image */', '/** @param {string} mode */',
                           '/** @param {unknown} data */', '/** @param {string} message */'):
            with self.subTest(missing=annotation):
                self.assertEqual(original.count(annotation), 1)
                local.write_text(original.replace(annotation, ''))
                self.assert_check(self.run_check(*production_check), False, 'TS7006')
        local.write_text(original)

    def test_reader_lifecycle_strict_signatures_and_annotations(self):
        module = (ROOT / "static/reader/core/reader-lifecycle.mjs").as_posix()
        source = self.root / "static/lifecycle-usage.mjs"
        config = self.root / "jsconfig.json"
        options = json.loads((ROOT / "jsconfig.reader-exact.json").read_text())["compilerOptions"]
        config.write_text(json.dumps({"compilerOptions": options,
            "files": [str(ROOT / "typings/reader-globals.d.ts"), module, str(source)]}))
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        prefix = (f'import {{createReaderLifecycle}} from "{module}";\n'
                  'const context = /** @type {Parameters<typeof createReaderLifecycle>[0]} */ (/** @type {unknown} */ ({}));\n'
                  'const lifecycle = createReaderLifecycle(context);\n')
        source.write_text(prefix + '''
/** @type {Promise<number>} */ const number = lifecycle.awaitReader(Promise.resolve(42));
/** @type {Promise<string>} */ const text = lifecycle.awaitReader("ok", null);
/** @type {unknown} */ const code = lifecycle.classifyReaderError(null);
lifecycle.trackReaderResource(() => {}); lifecycle.isReaderGenerationCurrent("search", 1);
''')
        self.assert_check(self.run_check(*check), True, "")
        for expression, diagnostic in [
            ('/** @type {Promise<string>} */ const value = lifecycle.awaitReader(Promise.resolve(42));', 'TS2322'),
            ('lifecycle.awaitReader("ok", 42);', 'TS2345'),
            ('lifecycle.trackReaderResource(42);', 'TS2345'),
            ('lifecycle.isReaderGenerationCurrent("search", "1");', 'TS2345'),
            ('/** @type {string} */ const code = lifecycle.classifyReaderError(null);', 'TS2322'),
        ]:
            with self.subTest(expression=expression):
                source.write_text(prefix + expression + "\n")
                self.assert_check(self.run_check(*check), False, diagnostic)
        local_config = self.root / "jsconfig.reader-exact.json"
        project = json.loads((ROOT / "jsconfig.reader-exact.json").read_text())
        for name in project["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        local_config.write_text(json.dumps(project))
        production_check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", local_config]
        self.assert_check(self.run_check(*production_check), True, "")
        lifecycle = self.root / "static/reader/core/reader-lifecycle.mjs"
        original = lifecycle.read_text()
        for annotation in ('/** @param {ReaderLifecycleContext} readerContext */',
                           '/** @param {() => unknown} cleanup */',
                           '/** @template T @param {T | PromiseLike<T>} promise @param {AbortSignal | null} [extraSignal] @returns {Promise<Awaited<T>>} */'):
            with self.subTest(missing=annotation):
                self.assertEqual(original.count(annotation), 1)
                lifecycle.write_text(original.replace(annotation, ""))
                self.assert_check(self.run_check(*production_check), False, "TS7006")
        lifecycle.write_text(original)

    def test_reader_exact_gate_rejects_unchecked_indexes_and_undefined_optionals(self):
        original = json.loads((ROOT / "jsconfig.reader-exact.json").read_text())
        options = original["compilerOptions"]
        for flag in ("allowJs", "checkJs", "noEmit", "strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes"):
            self.assertIs(options.get(flag), True, flag)
        required = {"static/reader/core/reader-diagnostics.mjs", "static/reader/core/reader-document-loader.mjs",
                    "static/reader/core/reader-lifecycle.mjs",
                    "static/reader/core/reader-request-manager.js", "static/reader/formats/reader-format-adapters.js",
                    "static/reader/formats/reader-image-loader.mjs", "static/reader/formats/reader-media-format.mjs", "static/reader/formats/reader-text-format.mjs", "static/reader/search/reader-pdf-book-search.mjs", "static/reader/formats/reader-chapter-repository.js",
                    "static/reader/ui/reader-document-styles.mjs", "static/reader/pdf/reader-engine-preload.js",
                    "static/reader/pdf/pdf-first-page-worker-adapter.mjs",
                    "static/reader/formats/reader-section-virtualizer.js", "static/reader/ui/reader-scroll-anchor.js"}
        self.assertEqual(set(original["files"]) - {"typings/reader-globals.d.ts"}, required)
        self.assertTrue(required <= set(json.loads((ROOT / "jsconfig.strict.json").read_text())["files"]))
        self.assertIn("tsc --project jsconfig.reader-exact.json", json.loads((ROOT / "package.json").read_text())["scripts"]["types"])
        source = self.root / "static/exact-usage.js"
        config = self.root / "jsconfig.json"
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        def configure(settings):
            config.write_text(json.dumps({"compilerOptions": settings,
                "files": [*[str(ROOT / name) for name in original["files"]], str(source)]}))
        configure(options)
        source.write_text('/** @param {string[]} values @returns {string} */ function first(values) { return values[0] || ""; }\n')
        self.assert_check(self.run_check(*check), True, "")
        source.write_text('/** @param {string[]} values @returns {string} */ function first(values) { return values[0]; }\n')
        self.assert_check(self.run_check(*check), False, "TS2322")
        configure({**options, "noUncheckedIndexedAccess": False})
        self.assert_check(self.run_check(*check), True, "")
        configure(options)
        source.write_text('/** @type {{name?: string}} */ const item={name:undefined};\n')
        self.assert_check(self.run_check(*check), False, "TS2375")
        configure({**options, "exactOptionalPropertyTypes": False})
        self.assert_check(self.run_check(*check), True, "")
        local_config = self.root / "jsconfig.reader-exact.json"
        local_config.write_text(json.dumps(original))
        for name in original["files"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        production_check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", local_config]
        self.assert_check(self.run_check(*production_check), True, "")
        for name in required:
            source = self.root / name
            source.write_text(source.read_text() + '\n/** @param {string[]} values @returns {string} */ function probe(values) { return values[0]; }\n')
            self.assert_check(self.run_check(*production_check), False, "TS2322")
            shutil.copyfile(ROOT / name, source)

    def test_static_globals_match_their_runtime_implementations(self):
        # Compile the actual classic scripts with their public declarations so
        # that an incorrect hand-written interface cannot hide behind any.
        source = self.root / "static/global-contract.js"
        config = self.root / "jsconfig.json"
        config.write_text(json.dumps({"compilerOptions": {"allowJs": True, "checkJs": True, "noEmit": True,
            "strict": False, "skipLibCheck": True, "target": "esnext", "moduleDetection": "force"},
            "files": [str(ROOT / "typings/reader-globals.d.ts"),
                      str(ROOT / "static/search/search-session.js"),
                      str(ROOT / "static/search/download-controller.js"),
                      str(ROOT / "static/search/reader-navigation.js"), "static/global-contract.js"]}))
        source.write_text("console.log('contracts loaded');\n")
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", config]
        self.assert_check(self.run_check(*check), True, "")

    def test_every_first_party_browser_script_is_type_checked(self):
        compiler = ROOT / "node_modules/typescript/bin/tsc"
        checked = set()
        for config in ("jsconfig.check.json", "jsconfig.service-worker.json"):
            options = json.loads((ROOT / config).read_text())["compilerOptions"]
            self.assertTrue(options.get("allowJs"), config)
            self.assertTrue(options.get("checkJs"), config)
            self.assertTrue(options.get("noEmit"), config)
            self.assertFalse(options.get("noCheck", False), config)
            result = subprocess.run(["node", compiler, "--project", config, "--listFilesOnly"],
                                    cwd=ROOT, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout)
            checked.update(Path(line).resolve() for line in result.stdout.splitlines())
        sources = {path.resolve() for path in (ROOT / "static").rglob("*")
                   if path.is_file() and path.suffix in (".js", ".mjs")
                   and "vendor" not in path.parts and "foliate-reader" not in path.parts}
        self.assertFalse(sources - checked, f"browser scripts missing from type check: {sorted(sources - checked)}")
        for path in sources:
            self.assertNotRegex(path.read_text(), r"@ts-(?:nocheck|ignore|expect-error)\b", str(path))

    def test_entry_points_reject_type_errors_with_production_config(self):
        # Exercise the real project config in an isolated copy rather than
        # merely checking that the two entry paths appear in --listFilesOnly.
        for path in (ROOT / "static").rglob("*"):
            if (path.is_file() and path.suffix in (".js", ".mjs")
                    and "vendor" not in path.parts and "foliate-reader" not in path.parts):
                target = self.root / path.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
        shutil.copytree(ROOT / "static/vendor/djvu-rs-reader", self.root / "static/vendor/djvu-rs-reader")
        shutil.copytree(ROOT / "typings", self.root / "typings")
        shutil.copyfile(ROOT / "jsconfig.check.json", self.root / "jsconfig.check.json")
        check = ["node", ROOT / "node_modules/typescript/bin/tsc", "--project", "jsconfig.check.json"]
        self.assert_check(self.run_check(*check), True, "")
        for relative in ("static/app.js", "static/reader.js"):
            source = self.root / relative
            original = source.read_text()
            with self.subTest(entry=relative):
                source.write_text(original + '\n/** @type {number} */ const __staticGateBadType = "wrong";\n')
                self.assert_check(self.run_check(*check), False, "TS2322")
                source.write_text(original)

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
            strict = json.loads((ROOT / "pyrightconfig.strict.json").read_text())
            self.assertEqual(strict["typeCheckingMode"], "strict")
            self.assertIn("backend/search_execution.py", strict["include"])

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

    def test_pyright_strict_seo_gate_rejects_unknown_parameter(self):
        config = json.loads((ROOT / "pyrightconfig.strict.json").read_text())
        self.assertEqual(config["typeCheckingMode"], "strict")
        self.assertIn("scripts/build/seo.py", config["include"])
        source = self.root / "scripts/build/seo.py"
        source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "scripts/build/seo.py", source)
        (self.root / "pyrightconfig.strict.json").write_text(json.dumps(config))
        check = ["node", ROOT / "node_modules/pyright/index.js", "--pythonpath", sys.executable,
                 "--project", "pyrightconfig.strict.json"]
        self.assert_check(self.run_check(*check), True, "0 errors")
        source.write_text(source.read_text() + "\ndef strict_probe(value):\n    return value\n")
        self.assert_check(self.run_check(*check), False, "reportUnknownParameterType")


if __name__ == "__main__":
    unittest.main()
