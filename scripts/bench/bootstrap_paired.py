"""Measure initial payload construction on synthetic records in one process."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import time

BASE_APP = "bd3de63841020bfc3c16f5015894ae39ff08c38e6a6d3bc03129e1b86ed91a84"
TARGET_APP = "f9582d39a22dbe75c29422c58d978b586e5d38e483e51d75eefa906d25e3d713"
TARGET_MODULE = "b6d5f1fd576fad02901ddfda7a5eda8c30591ec234e98465bcdd800e1e4336cb"


def main() -> None:
    base, candidate, output = (Path(os.environ[name]) for name in
                               ("BENCH_BASELINE", "BENCH_CANDIDATE", "BENCH_OUTPUT"))
    if output.exists():
        raise SystemExit("refusing to overwrite evidence")
    old_source = (base / "backend/app.py").read_bytes()
    if (hashlib.sha256(old_source).hexdigest() != BASE_APP
            or hashlib.sha256((candidate / "backend/app.py").read_bytes()).hexdigest() != TARGET_APP
            or hashlib.sha256((candidate / "backend/search_bootstrap.py").read_bytes()).hexdigest() != TARGET_MODULE):
        raise SystemExit("unexpected benchmark source")

    def no_network(_self: object, _address: object) -> None:
        raise RuntimeError("network forbidden in benchmark")

    socket.socket.connect = no_network
    from backend import app

    nodes = [node for node in ast.parse(old_source).body if isinstance(node, ast.FunctionDef)
             and node.name in ("trim_initial_results", "build_initial_payload")]
    if len(nodes) != 2:
        raise RuntimeError("original functions not found")
    for node in nodes:
        node.name = "_benchmark_original_" + node.name
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(base / "backend/app.py"), "exec"),
         app.__dict__)
    before, after = app._benchmark_original_build_initial_payload, app.build_initial_payload
    old_trim, new_trim = app._benchmark_original_trim_initial_results, app.trim_initial_results
    app.INITIAL_PAGE_SIZE = 100
    results = {}
    for count in (1500, 10000):
        app.records = [{"Repo": "Bench/A" if i % 2 else "Bench/B", "File": f"file-{i}",
                        "Extension": "pdf", "Folder": ["books"], "Size": i, "HasTxt": False}
                       for i in range(count)]
        app.repo_records_map = {"Bench/A": list(range(1, count, 2)), "Bench/B": list(range(0, count, 2))}
        for name, repo in (("global", None), ("repo", "Bench/A"), ("missing", "Bench/missing")):
            def invoke(old: bool):
                app.trim_initial_results = old_trim if old else new_trim
                return (before if old else after)(repo)

            reference = invoke(True)
            if invoke(False) != reference:
                raise AssertionError((count, name, "payload mismatch"))
            for _ in range(100):
                if invoke(True) != reference or invoke(False) != reference:
                    raise AssertionError((count, name, "warmup mismatch"))
            rows = []
            for round_number in range(40):
                row = {}
                for label, old in (("baseline", True), ("candidate", False)) if round_number % 2 == 0 else (
                        ("candidate", False), ("baseline", True)):
                    started = time.perf_counter_ns()
                    for _ in range(300):
                        value = invoke(old)
                    row[label] = (time.perf_counter_ns() - started) / 300 / 1e6
                    if value != reference:
                        raise AssertionError((count, name, label))
                rows.append(row)
            ratios = [row["candidate"] / row["baseline"] for row in rows]
            results[f"{count}_{name}"] = {
                "baseline_median_ms": statistics.median(row["baseline"] for row in rows),
                "candidate_median_ms": statistics.median(row["candidate"] for row in rows),
                "median_paired_ratio": statistics.median(ratios),
                "candidate_slower_pairs": sum(value > 1 for value in ratios), "pairs": len(rows),
                "result_count": len(reference["results"]), "rows": rows,
            }
    app.trim_initial_results = new_trim
    payload = {"metadata": {"architecture": platform.machine(), "python": platform.python_version(),
                            "platform": platform.platform(), "run_id": os.environ.get("BENCH_RUN_ID")},
               "source_sha256": {"baseline_app": BASE_APP, "candidate_app": TARGET_APP, "module": TARGET_MODULE},
               "scope": "Synthetic in-memory initial search pages; same-process alternating pairs; excludes HTTP, "
                        "production data, network, startup index generation and browser latency.", "results": results}
    output.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"metadata": payload["metadata"], "results": {
        name: {key: value for key, value in row.items() if key != "rows"} for name, row in results.items()}}))


if __name__ == "__main__":
    main()
