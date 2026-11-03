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
        test.write_text('const test = require("node:test"); test("empty", () => {});\n')
        self.assert_check(self.run_check(*check), False, "requires exactly one fully covered source row")
        test.write_text('const test = require("node:test"), vm = require("node:vm"), fs = require("node:fs");\n'
                        'test("load only", () => vm.runInNewContext(fs.readFileSync("static/reader/formats/'
                        'reader-format-adapters.js", "utf8"), {}, { filename: process.cwd() + '
                        '"/static/reader/formats/reader-format-adapters.js" }));\n')
        self.assert_check(self.run_check(*check), False, "coverage")

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
        self.assertIn("const minimum = [98.31, 85.65, 88.43];", source)
        gate.write_text(source.replace("const minimum = [98.31, 85.65, 88.43];",
                                       "const minimum = [98.32, 85.65, 88.43];"))
        self.assert_check(self.run_check("node", "scripts/check_pdf_network_coverage.mjs"), False,
                          "PDF network coverage gate requires passing tests")

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
                          "PDF network coverage gate requires passing tests")

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
        for path in paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        check = ["node", "scripts/check_reader_core_coverage.mjs"]
        self.assert_check(self.run_check(*check), True, "reader-chapter-repository.js")
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
