"""Alternate original and extracted anchor lookups on synthetic orders."""
from __future__ import annotations

from array import array
import ast
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import time

BASE_APP = '53cd08539a5aeb8f89331fde338d5c4eadd6fd00df94c499686e3edef1ad460e'
CANDIDATE_APP = '9e470d65e23723a22fc447661d1a56083be7df084acc9284798594817f807627'
CANDIDATE_MODULE = '1e02f53b5f3be792c42b21bbdc4eb9ade8b65c63b3946666ab1f9812addf9d05'


def main() -> None:
    baseline, candidate, output = (Path(os.environ[name]) for name in
                                   ('BENCH_BASELINE', 'BENCH_CANDIDATE', 'BENCH_OUTPUT'))
    if output.exists():
        raise SystemExit('refuse to overwrite evidence')
    old_source = (baseline / 'backend/app.py').read_bytes()
    if (hashlib.sha256(old_source).hexdigest() != BASE_APP
            or hashlib.sha256((candidate / 'backend/app.py').read_bytes()).hexdigest() != CANDIDATE_APP
            or hashlib.sha256((candidate / 'backend/search_anchor.py').read_bytes()).hexdigest() != CANDIDATE_MODULE):
        raise SystemExit('unexpected source')

    def no_network(_self: object, _address: object) -> None:
        raise RuntimeError('network forbidden')

    socket.socket.connect = no_network
    from backend import app

    node = next(item for item in ast.parse(old_source).body
                if isinstance(item, ast.FunctionDef) and item.name == '_find_search_anchor')
    node.name = '_benchmark_original_anchor'
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(baseline / 'backend/app.py'), 'exec'),
         app.__dict__)
    before, after = app._benchmark_original_anchor, app._find_search_anchor
    app.records = [{'Repo': 'Bench/A', 'File': f'file-{i}', 'Extension': 'txt', 'Folder': ['books']}
                   for i in range(10000)]
    results = {}
    for count in (100, 10000):
        order = array('I', range(count))
        cases = [('first', 'Bench/A\0books/file-0.txt'),
                 ('last', f'Bench/A\0books/file-{count - 1}.txt'),
                 ('missing', 'Bench/A\0books/not-present.txt')]
        for scenario, anchor in cases:
            for mode in ('cold', 'warm'):
                def call(function):
                    if mode == 'cold':
                        app._search_anchor_cache.clear()
                    return function(order, anchor)

                app._search_anchor_cache = OrderedDict()
                expected = call(before)
                app._search_anchor_cache = OrderedDict()
                if call(after) != expected:
                    raise AssertionError((count, scenario, mode))
                for function in (before, after):
                    app._search_anchor_cache = OrderedDict()
                    for _ in range(30):
                        if call(function) != expected:
                            raise AssertionError('warmup mismatch')
                iterations = 10 if count == 10000 and mode == 'cold' else 200
                rows = []
                for round_number in range(40):
                    pair = (('baseline', before), ('candidate', after))
                    if round_number % 2:
                        pair = tuple(reversed(pair))
                    row = {}
                    for label, function in pair:
                        app._search_anchor_cache = OrderedDict()
                        if mode == 'warm':
                            call(function)
                        start = time.perf_counter_ns()
                        for _ in range(iterations):
                            value = call(function)
                        row[label] = (time.perf_counter_ns() - start) / iterations / 1e6
                        if value != expected:
                            raise AssertionError((count, scenario, mode, label))
                    rows.append(row)
                ratios = [row['candidate'] / row['baseline'] for row in rows]
                results[f'{count}_{scenario}_{mode}'] = {
                    'baseline_median_ms': statistics.median(row['baseline'] for row in rows),
                    'candidate_median_ms': statistics.median(row['candidate'] for row in rows),
                    'median_paired_ratio': statistics.median(ratios),
                    'candidate_slower_pairs': sum(value > 1 for value in ratios),
                    'pairs': len(rows), 'iterations': iterations, 'expected_index': expected, 'rows': rows,
                }
    payload = {'metadata': {'architecture': platform.machine(), 'python': platform.python_version(),
                            'platform': platform.platform(), 'run_id': os.environ.get('BENCH_RUN_ID')},
               'source_sha256': {'baseline': BASE_APP, 'candidate': CANDIDATE_APP, 'module': CANDIDATE_MODULE},
               'scope': 'Synthetic in-memory anchor lookups, same-process alternating pairs, cold and warm caches; '
                        'no network, HTTP, production corpus or user latency.', 'results': results}
    output.write_text(json.dumps(payload, indent=2) + '\n')
    print(json.dumps({'metadata': payload['metadata'], 'results': {
        name: {key: value for key, value in row.items() if key != 'rows'} for name, row in results.items()}}))


if __name__ == '__main__':
    main()
