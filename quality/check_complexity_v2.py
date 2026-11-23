"""Keep v1 ceilings and audit the separately reviewed JS program budget."""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import astuple
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import check_complexity as v1  # noqa: E402

SCOPES = ("frontend", "site")
WRAPPER = "quality/eslint.complexity.config.mjs"
PROGRAM_RULE = "book-complexity/program"
PROGRAM_MESSAGE = re.compile(r"Program complexity: ([1-9][0-9]*)\.")
METRIC = "js-program-classic"


def lint(root, files):
    paths = [path.relative_to(root).as_posix() for path in files]
    if not paths or len(paths) != len(set(paths)):
        raise ValueError("Empty or duplicate JS input inventory")
    command = ["node", "node_modules/eslint/bin/eslint.js", "--no-inline-config", "--no-ignore", "--format", "json",
               "--rule", 'complexity:["error",1]', "--config", WRAPPER, "--", *paths]
    run = subprocess.run(command, cwd=root, text=True, capture_output=True, check=False)  # noqa: S603
    if run.returncode not in {0, 1} or not run.stdout:
        raise ValueError(f"ESLint could not measure JavaScript: {run.stderr.strip()}")
    return read_results(root, set(paths), json.loads(run.stdout))


def read_results(root, expected, items):
    regions, programs = [], {}
    for item in items:
        path = Path(item["filePath"]).relative_to(root).as_posix()
        if path not in expected or path in programs:
            raise ValueError(f"Unexpected or duplicate ESLint file result: {path}")
        programs[path] = read_messages(path, item["messages"], regions)
    if missing := expected - programs.keys():
        raise ValueError(f"Missing ESLint file results: {sorted(missing)}")
    return regions, programs


def read_messages(path, messages, regions):
    program = None
    for msg in messages:
        rule, text = msg["ruleId"], msg["message"]
        if msg.get("fatal") or rule is None:
            raise ValueError(f"ESLint could not score {path}:{msg.get('line', '?')}: {text}")
        if rule == PROGRAM_RULE:
            if program is not None:
                raise ValueError(f"Duplicate program score: {path}")
            match = PROGRAM_MESSAGE.fullmatch(text)
            if not match or (msg.get("messageId"), msg.get("line"), msg.get("column")) != ("score", 1, 1):
                raise ValueError(f"Malformed program score: {path}: {text}")
            program = int(match[1]) - 1
        elif rule == "complexity":
            match = v1.COMPLEXITY_MESSAGE.fullmatch(text)
            if not match or int(match[2]) <= 1:
                raise ValueError(f"Malformed v1 region score: {path}: {text}")
            regions.append(v1.Score(path, match[1], msg["line"], int(match[2])))
    if program is None:
        raise ValueError(f"Missing program score: {path}")
    return program


def digest(records):
    payload = json.dumps(sorted(records), separators=(",", ":"), ensure_ascii=True)
    return sha256(payload.encode("ascii")).hexdigest()


def verify_v1(root, py, js, python, regions):
    # Compare v1's complete fact multiset, not just totals or hotspot maxima.
    reference = Counter([*v1.python_scores(root, py), *v1.js_scores(root, js)])
    wrapped = Counter([*python, *regions])
    if reference != wrapped:
        raise ValueError(f"v1 region mismatch: missing {list((reference - wrapped).items())[:5]}; "
                         f"added {list((wrapped - reference).items())[:5]}")
    return digest(astuple(fact) for fact in reference.elements())


def program_snapshot(programs, scope):
    return {"version": 2, "scope": scope, "metric": METRIC, "branches": sum(programs.values()),
            "files": {path: n for path, n in sorted(programs.items()) if n > 0}}


def program_regressions(old, new):
    if new["branches"] > old["branches"]:
        yield f"Program decisions {new['branches']} > {old['branches']}"
    for path, actual in new["files"].items():
        cap = old["files"].get(path, 0)
        if actual > cap:
            yield f"{path}: program decisions {actual} > {cap}"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate budget key: {key}")
        result[key] = value
    return result


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def read_budget(path, scope, version):
    data = json.loads(path.read_bytes(), object_pairs_hook=unique_object)
    identity = {"version": version, "scope": scope}
    identity.update({"limit": v1.LIMIT} if version == 1 else {"metric": METRIC})
    if (not isinstance(data, dict) or data.keys() != identity.keys() | {"branches", "files"}
            or any(type(data[k]) is not type(v) or data[k] != v for k, v in identity.items())
            or not integer(data["branches"]) or not isinstance(data["files"], dict)):
        raise ValueError(f"Invalid v{version} budget schema, scope or metric: {path}")
    if version == 1:
        for counts in data["files"].values():
            if not (isinstance(counts, dict) and counts.keys() == {"peak", "excess"}
                    and integer(counts["peak"], v1.LIMIT + 1) and integer(counts["excess"], counts["peak"] - v1.LIMIT)):
                raise ValueError(f"Invalid v1 file caps: {path}")
    else:
        caps = data["files"].values()
        if not all(integer(n, 1) for n in caps) or data["branches"] > sum(caps):
            raise ValueError(f"Invalid program file or total caps: {path}")
    return data


def budget_pair(candidate, trusted, scope, version):
    old = read_budget(candidate, scope, version)
    base = read_budget(trusted, scope, version)
    if candidate.samefile(trusted):
        raise ValueError(f"Use an independent trusted v{version} budget, not the checked-in file itself")
    return old, base


def read_caps(root, args):
    old_v1 = read_budget(root / args.budget, args.scope, 1)
    old_program = read_budget(root / args.program_budget, args.scope, 2)
    if args.base_budget:
        _, base_v1 = budget_pair(root / args.budget, args.base_budget, args.scope, 1)
        reject("Checked-in v1 budget raises trusted caps", v1.regressions(base_v1, old_v1))
    if args.base_program_budget:
        _, base_program = budget_pair(root / args.program_budget, args.base_program_budget, args.scope, 2)
        reject("Checked-in program budget raises trusted caps", program_regressions(base_program, old_program))
    return old_v1, old_program


def reject(label, problems):
    if messages := list(problems):
        raise ValueError(label + ":\n" + "\n".join(messages))


def report(root, py, js, python, regions, legacy, programs, program, reference_digest):
    ranked = sorted(programs.items(), key=lambda item: (-item[1], item[0]))
    overs = [{"path": path, "score": n + 1, "excess": n + 1 - v1.LIMIT}
             for path, n in ranked if n + 1 > v1.LIMIT]
    return {
        "scope": legacy["scope"],
        "inventory": {"python": len(py), "javascript": len(js)},
        "owned_source_bytes_sha256": digest((p.relative_to(root).as_posix(), sha256(p.read_bytes()).hexdigest())
                                            for p in [*py, *js]),
        "v1_parity_verified": reference_digest is not None,
        "v1_reference_facts_sha256": reference_digest,
        "v1_facts_sha256": digest(astuple(fact) for fact in [*python, *regions]),
        "v1_python_facts": len(python),
        "v1_js_reported_facts": len(regions),
        "v1_python_decisions": sum(fact.complexity - 1 for fact in python),
        "v1_js_region_decisions": sum(fact.complexity - 1 for fact in regions),
        "v1_snapshot": legacy,
        "program_facts_sha256": digest(programs.items()),
        "program_decisions_by_path": dict(sorted(programs.items())),
        "program_debt": {"nonzero_files": len(program["files"]), "peak_score": ranked[0][1] + 1,
                         "over_limit_files": overs, "total_excess": sum(item["excess"] for item in overs)},
        "combined_decisions_informational": legacy["branches"] + program["branches"],
        "program_budget_proposal": program,
    }


def arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", choices=SCOPES, required=True)
    parser.add_argument("--mode", choices=("report", "check"), default="check")
    parser.add_argument("--verify-v1", action="store_true", help="Compare every v1 fact with a separate original run")
    parser.add_argument("--budget", type=Path, default=v1.BUDGET, help="Existing v1 budget")
    parser.add_argument("--base-budget", type=Path, help="Independent trusted v1 budget")
    parser.add_argument("--program-budget", type=Path, default=Path("quality/js-program-budget.json"),
                        help="Reviewed JS program budget")
    parser.add_argument("--base-program-budget", type=Path, help="Independent trusted JS program budget")
    return parser.parse_args(argv)


def main(argv=None):
    args = arguments(argv)
    try:
        caps = read_caps(ROOT, args) if args.mode == "check" else None
        py, js = v1.inventory(ROOT, args.scope)
        python = list(v1.python_scores(ROOT, py))
        regions, programs = lint(ROOT, js)
        reference_digest = verify_v1(ROOT, py, js, python, regions) if args.verify_v1 else None
        legacy = v1.snapshot([*python, *regions], args.scope)
        program = program_snapshot(programs, args.scope)
        if caps is not None:
            reject("v1 complexity regressions", v1.regressions(caps[0], legacy))
            reject("JS program complexity regressions", program_regressions(caps[1], program))
            print(f"v1: {legacy['branches']} decisions; JS program: {program['branches']} decisions in {len(programs)} files")
        else:
            print(json.dumps(report(ROOT, py, js, python, regions, legacy, programs, program, reference_digest), indent=2))
    except (OSError, ValueError, SyntaxError, KeyError, TypeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
