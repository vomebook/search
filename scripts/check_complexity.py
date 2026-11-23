"""Audit owned Python and JavaScript. See complexity-policy.md before changing budgets."""
from __future__ import annotations

import argparse
import ast
from collections import defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import re
import subprocess
import tokenize


ROOT = Path(__file__).resolve().parents[1]
BUDGET = Path("scripts/complexity-budget.json")
LIMIT = 12
EXCLUDED = {Path("static/vendor"), Path("scripts/node_modules")}
SCOPE = {
    "frontend": ("static", "scripts"),
    "site": ("app.py", "backend", "static", "scripts"),
    "pipeline": ("scripts",),
}
JS = {".js", ".mjs", ".cjs"}
PYTHON_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
PYTHON_BRANCHES = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.Assert)
COMPLEXITY_MESSAGE = re.compile(r"^(.+) has a complexity of (\d+)\. Maximum allowed is 1\.$")


@dataclass(frozen=True)
class Score:
    path: str
    name: str
    line: int
    complexity: int


def walk(root: Path, path: Path):
    relative = path.relative_to(root)
    if relative in EXCLUDED or path.name == "__pycache__":
        return
    if path.is_symlink():
        raise ValueError(f"Symlink in source inventory: {relative}")
    if path.is_file():
        yield path
    elif path.is_dir():
        for child in sorted(path.iterdir()):
            yield from walk(root, child)


def branch_count(node):
    if isinstance(node, PYTHON_BRANCHES):
        return 1
    if isinstance(node, ast.BoolOp):
        return len(node.values) - 1
    if isinstance(node, ast.comprehension):
        return 1 + len(node.ifs)
    if isinstance(node, ast.Match):
        return sum(case.guard is not None or not isinstance(case.pattern, ast.MatchAs)
                   or case.pattern.pattern is not None for case in node.cases)
    return 0


class PythonScores(ast.NodeVisitor):
    def __init__(self, path):
        self.path = path
        self.parts = []
        self.discovered = []
        self.branches = 0

    def visit(self, node):
        if isinstance(node, PYTHON_SCOPES):
            return self.scope(node, getattr(node, "name", "<lambda>"), node.lineno)
        self.branches += branch_count(node)
        return super().visit(node)

    def scope(self, node, name, line):
        self.parts.append(name)
        parent, self.branches = self.branches, 0
        self.generic_visit(node)
        self.discovered.append(Score(self.path, ".".join(self.parts), line, self.branches + 1))
        self.branches = parent
        self.parts.pop()


def python_scores(root, files):
    for path in files:
        rel = path.relative_to(root).as_posix()
        with tokenize.open(path) as infile:
            tree = ast.parse(infile.read(), filename=rel)
        visitor = PythonScores(rel)
        visitor.scope(tree, "<module>", 1)
        yield from visitor.discovered


def js_scores(root, files):
    command = ["node", "node_modules/eslint/bin/eslint.js", "--no-inline-config", "--no-ignore", "--format", "json",
               "--rule", 'complexity:["error",1]']
    paths = [path.relative_to(root).as_posix() for path in files]
    # Explicit local executable and repository-relative path arguments, never a shell.
    run = subprocess.run([*command, "--", *paths], cwd=root, text=True, capture_output=True, check=False)  # noqa: S603
    if run.returncode not in {0, 1} or not run.stdout:
        raise ValueError(f"ESLint could not measure JavaScript: {run.stderr}")
    seen = set()
    for item in json.loads(run.stdout):
        rel = Path(item["filePath"]).relative_to(root).as_posix()
        seen.add(rel)
        for message in item["messages"]:
            match = COMPLEXITY_MESSAGE.fullmatch(message["message"])
            if message["ruleId"] == "complexity" and match:
                name, value = match.groups()
                yield Score(rel, name, message["line"], int(value))
            elif message.get("fatal") or message["ruleId"] in {None, "complexity"}:
                raise ValueError(f"ESLint could not score {rel}:{message['line']}: {message['message']}")
    if seen != set(paths):
        raise ValueError(f"Missing ESLint coverage: {sorted(set(paths) - seen)}")


def inventory(root, scope):
    sources = [root / path for path in SCOPE[scope]]
    for path in sources:
        present = path.is_file() if path.name == "app.py" else path.is_dir()
        if not present:
            raise ValueError(f"Missing source root or wrong file type: {path.relative_to(root)}")
    files = [path for source in sources for path in walk(root, source)]
    py = [path for path in files if path.suffix == ".py"]
    js = [path for path in files if path.suffix in JS]
    if not py or (scope != "pipeline" and not js):
        raise ValueError("Incomplete source inventory")
    return py, js


def snapshot(scores, scope):
    totals = defaultdict(list)
    for fact in scores:
        if fact.complexity > LIMIT:
            totals[fact.path].append(fact.complexity)
    return {
        "version": 1,
        "scope": scope,
        "limit": LIMIT,
        "branches": sum(fact.complexity - 1 for fact in scores),
        "files": {path: {"peak": max(values), "excess": sum(value - LIMIT for value in values)}
                  for path, values in sorted(totals.items())},
    }


def regressions(old, new):
    if any(old[key] != new[key] for key in ("version", "scope", "limit")):
        raise ValueError("Complexity budget version, source scope or limit mismatch")
    if new["branches"] > old["branches"]:
        yield f"Overall decision count {new['branches']} > {old['branches']}"
    for path, counts in new["files"].items():
        cap = old["files"].get(path, {"peak": LIMIT, "excess": 0})
        for kind, actual in counts.items():
            if actual > cap[kind]:
                yield f"{path}: {kind} {actual} > {cap[kind]}"


def print_report(scores, budget):
    print(f"{budget['scope']}: {budget['branches']} decisions, "
          f"{sum(score.complexity > LIMIT for score in scores)} regions > {LIMIT}, "
          f"{len(budget['files'])} over-limit files")
    for fact in sorted(scores, key=lambda fact: (-fact.complexity, fact.path, fact.line))[:15]:
        print(f"{fact.complexity:3} {fact.path}:{fact.line} {fact.name}")


def self_test():
    import unittest

    class RatchetTests(unittest.TestCase):
        def budget(self, *values, path="a.py"):
            return snapshot([Score(path, "sample", line, value) for line, value in enumerate(values)], "pipeline")

        def test_scope_separates_nested_branches_without_losing_them(self):
            visitor = PythonScores("a.py")
            visitor.scope(ast.parse("""\
if top:
    class C:
        def method(self):
            def inner():
                return x if a and b else y
            return [x for x in z if x]
"""), "<module>", 1)
            self.assertEqual([(s.name, s.complexity) for s in visitor.discovered], [
                ("<module>.C.method.inner", 3), ("<module>.C.method", 3),
                ("<module>.C", 1), ("<module>", 2),
            ])

        def test_split_alone_does_not_reduce_total_decisions(self):
            baseline = self.budget(21)
            self.assertEqual(self.budget(11, 11)["branches"], baseline["branches"])
            self.assertEqual(list(regressions(baseline, self.budget(11, 11))), [])
            self.assertEqual(len(list(regressions(baseline, self.budget(8, 8, 8)))), 1)

        def test_rejects_new_hotspot_even_with_lower_total(self):
            self.assertEqual(len(list(regressions(self.budget(27), self.budget(13, path="b.py")))), 2)

        def test_rejects_peak_and_excess_regressions_independently(self):
            self.assertEqual(list(regressions(self.budget(14, 14), self.budget(15))), ["a.py: peak 15 > 14"])
            self.assertEqual(list(regressions(self.budget(16, 10, 4), self.budget(16, 13))), ["a.py: excess 5 > 4"])

        def test_approved_reduction_and_empty_debt_file(self):
            before = self.budget(16, 12)
            after = self.budget(12, 12)
            self.assertEqual(list(regressions(before, after)), [])
            self.assertEqual(after["files"], {})

    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(RatchetTests))
    if not result.wasSuccessful():
        raise SystemExit(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--scope", choices=SCOPE, required=True)
    parser.add_argument("--budget", type=Path, default=BUDGET)
    parser.add_argument("--base-budget", type=Path, help="Also verify that the checked-in budget only tightens this trusted budget")
    parser.add_argument("--mode", choices=("report", "sample", "check", "tighten", "self-test"), default="check")
    args = parser.parse_args(argv)
    if args.mode == "self-test":
        self_test()
        return 0
    root = args.root.resolve()
    py, js = inventory(root, args.scope)
    scores = list(python_scores(root, py))
    if args.scope != "pipeline":
        scores.extend(js_scores(root, js))
    current = snapshot(scores, args.scope)
    if args.mode == "sample":
        print(json.dumps(current, indent=2))
        return 0
    if args.mode == "report":
        print_report(scores, current)
        return 0
    path = root / args.budget
    old = json.loads(path.read_bytes())
    if args.base_budget:
        base = json.loads(args.base_budget.read_bytes())
        if problems := list(regressions(base, old)):
            print("Checked-in budget raises trusted caps:\n" + "\n".join(problems))
            return 1
    if problems := list(regressions(old, current)):
        print("Complexity budget regressions:\n" + "\n".join(problems))
        return 1
    if args.mode == "tighten":
        path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    print(f"Complexity budget: {current['branches']} decisions, {len(current['files'])} over-limit files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
