"""Alternate original and extracted search in one process with synthetic data."""
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

BASE_HASH = "b73c5db076ae1dce7c8988fc30049d2c0120ffdf9b6d6b2fd02a4b97e726b3cb"
CANDIDATE_HASH = "bd3de63841020bfc3c16f5015894ae39ff08c38e6a6d3bc03129e1b86ed91a84"
MODULE_HASH = "81dbe74b8142aed5447478e2a05c36150a5a2abf67f4aa0b55bc3d43b297cec4"


def main() -> None:
    baseline = Path(os.environ["BENCH_BASELINE"])
    candidate = Path(os.environ["BENCH_CANDIDATE"])
    output = Path(os.environ["BENCH_ORDER_OUTPUT"])
    if output.exists():
        raise SystemExit("refusing to overwrite benchmark evidence")
    original_source = (baseline / "backend/app.py").read_bytes()
    if (hashlib.sha256(original_source).hexdigest() != BASE_HASH
            or hashlib.sha256((candidate / "backend/app.py").read_bytes()).hexdigest() != CANDIDATE_HASH
            or hashlib.sha256((candidate / "backend/search_candidates.py").read_bytes()).hexdigest() != MODULE_HASH):
        raise SystemExit("unexpected benchmark source")

    def no_network(_self: object, _address: object) -> None:
        raise RuntimeError("network forbidden in benchmark")

    socket.socket.connect = no_network
    from backend import app  # loaded from the explicit candidate checkout in PYTHONPATH

    original = next(node for node in ast.parse(original_source).body
                    if isinstance(node, ast.FunctionDef) and node.name == "literal_candidates")
    original.name = "_benchmark_original_literal_candidates"
    code = compile(ast.fix_missing_locations(ast.Module(body=[original], type_ignores=[])),
                   str(baseline / "backend/app.py"), "exec")
    exec(code, app.__dict__)
    before, after = app._benchmark_original_literal_candidates, app.literal_candidates
    scenarios = (
        ("exact_literal", {"q": "alpha", "exact": True}),
        ("exact_repo", {"q": "alpha", "exact": True, "repos": ["Bench/Example"]}),
        ("exact_wildcard", {"q": "alpha*", "exact": True}),
        ("fuzzy_multi", {"q": "alphaa guide"}),
        ("exact_missing", {"q": "zzzz", "exact": True}),
        ("empty_filter", {"q": "", "repos": ["Bench/Example"], "extensions": ["pdf"]}),
    )
    results = {}
    for count in (1500, 10000):
        app.records = [{"Repo": "Bench/Example" if i % 2 == 0 else "Bench/Other",
                        "File": "alpha guide" if i % 11 == 0 else (
                            "alpa guide" if i % 13 == 0 else f"file_{i:07}"),
                        "Extension": "pdf" if i % 3 else "txt",
                        "Folder": ["books", f"group{i % 20}"], "Size": i, "HasTxt": False}
                       for i in range(count)]
        app.build_indexes()
        grams: dict[int, dict[str, set[int]]] = {2: {}, 3: {}}
        for index, record in enumerate(app.records):
            text = (record["File"] + " " + record["Repo"] + " " + " ".join(record["Folder"])).lower()
            for width in (2, 3):
                for gram in {text[i:i + width] for i in range(len(text) - width + 1)}:
                    grams[width].setdefault(gram, set()).add(index)
        app.ngram_postings, app.ngram_posting_buffers = grams, {}
        for name, arguments in scenarios:
            values = {}
            for label, func in (("baseline", before), ("candidate", after)):
                app.literal_candidates = func
                values[label] = list(app._search_order_uncached(**arguments))
            if values["baseline"] != values["candidate"]:
                raise AssertionError((count, name, "result mismatch"))
            reference = values["baseline"]
            for _ in range(20):
                for func in (before, after):
                    app.literal_candidates = func
                    if list(app._search_order_uncached(**arguments)) != reference:
                        raise AssertionError((count, name, "unstable warmup"))
            iterations = 12 if count == 1500 else 4
            rows = []
            for round_number in range(40):
                order = (("baseline", before), ("candidate", after))
                if round_number % 2:
                    order = tuple(reversed(order))
                row = {}
                for label, func in order:
                    app.literal_candidates = func
                    started = time.perf_counter_ns()
                    for _ in range(iterations):
                        value = app._search_order_uncached(**arguments)
                    row[label] = (time.perf_counter_ns() - started) / iterations / 1e6
                    if list(value) != reference:
                        raise AssertionError((count, name, label))
                rows.append(row)
            ratios = [row["candidate"] / row["baseline"] for row in rows]
            results[f"{count}_{name}"] = {
                "baseline_median_ms": statistics.median(row["baseline"] for row in rows),
                "candidate_median_ms": statistics.median(row["candidate"] for row in rows),
                "median_paired_ratio": statistics.median(ratios),
                "candidate_slower_pairs": sum(ratio > 1 for ratio in ratios),
                "pairs": len(rows), "iterations_per_pair": iterations, "result_count": len(reference),
                "result_sha256": hashlib.sha256(json.dumps(reference).encode()).hexdigest(), "rows": rows,
            }
    app.literal_candidates = after
    metadata = {"platform": platform.platform(), "architecture": platform.machine(),
                "python": platform.python_version(), "cpu_count": os.cpu_count(),
                "run_id": os.environ.get("BENCH_RUN_ID")}
    payload = {"metadata": metadata, "source_sha256": {"baseline": BASE_HASH, "candidate": CANDIDATE_HASH,
                 "module": MODULE_HASH}, "results": results,
               "scope": "Synthetic in-memory indexed records. Cold direct search-order function only, "
                        "same process and alternating original/extracted implementations; excludes HTTP, "
                        "cache hits, network and production hardware."}
    output.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"metadata": metadata, "results": {name: {k: v for k, v in row.items() if k != "rows"}
                                                        for name, row in results.items()}}, sort_keys=True))


if __name__ == "__main__":
    main()
