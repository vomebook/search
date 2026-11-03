"""Compare compression eligibility on synthetic requests without reading documents."""
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
from types import SimpleNamespace

BASE_APP = '53cd08539a5aeb8f89331fde338d5c4eadd6fd00df94c499686e3edef1ad460e'
CANDIDATE_APP = '55466335c8caae8cced1562b1052ad492909136d05ae4bd5130616c60ae4dc1e'
CANDIDATE_MODULE = '1b1cdeb59be76bfa2db824d3f00e7177d6fe7e71f5bb6c50cc881f92830e32a6'


def main() -> None:
    baseline, candidate, output = (Path(os.environ[name]) for name in
                                   ('BENCH_BASELINE', 'BENCH_CANDIDATE', 'BENCH_OUTPUT'))
    if output.exists():
        raise SystemExit('refuse overwrite')
    original = (baseline / 'backend/app.py').read_bytes()
    if (hashlib.sha256(original).hexdigest() != BASE_APP
            or hashlib.sha256((candidate / 'backend/app.py').read_bytes()).hexdigest() != CANDIDATE_APP
            or hashlib.sha256((candidate / 'backend/reader_compression.py').read_bytes()).hexdigest() != CANDIDATE_MODULE):
        raise SystemExit('unexpected source')

    def no_network(_self: object, _address: object) -> None:
        raise RuntimeError('network forbidden')

    socket.socket.connect = no_network
    from backend import app

    node = next(item for item in ast.parse(original).body
                if isinstance(item, ast.FunctionDef) and item.name == 'reader_body_allows_compression')
    node.name = '_benchmark_original_compression'
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(baseline / 'backend/app.py'), 'exec'),
         app.__dict__)
    old, new = app._benchmark_original_compression, app.reader_body_allows_compression
    cases = {
        'text_get': ('https://fixture.invalid/a%2Etxt?download=1', SimpleNamespace(method='GET', headers={}), 200),
        'binary_get': ('https://fixture.invalid/a.pdf', SimpleNamespace(method='GET', headers={}), 200),
        'range_get': ('https://fixture.invalid/a.txt', SimpleNamespace(method='GET', headers={'Range': 'bytes=0-1'}), 206),
        'conditional_get': ('https://fixture.invalid/a.txt', SimpleNamespace(method='GET', headers={'If-None-Match': 'x'}), 200),
        'text_head': ('https://fixture.invalid/a.txt', SimpleNamespace(method='HEAD', headers={}), 200),
        'no_request': ('/a.json', None, 200),
    }
    results = {}
    for name, arguments in cases.items():
        expected = old(*arguments)
        if new(*arguments) != expected:
            raise AssertionError(name)
        for _ in range(500):
            old(*arguments)
            new(*arguments)
        rows = []
        for round_number in range(40):
            pair = (('baseline', old), ('candidate', new))
            if round_number % 2:
                pair = tuple(reversed(pair))
            row = {}
            for label, function in pair:
                checksum = 0
                start = time.perf_counter_ns()
                for _ in range(5000):
                    checksum += bool(function(*arguments))
                row[label] = (time.perf_counter_ns() - start) / 5000
                row[label + '_checksum'] = checksum
            if row['baseline_checksum'] != row['candidate_checksum']:
                raise AssertionError((name, 'checksum mismatch'))
            rows.append(row)
        ratios = [row['candidate'] / row['baseline'] for row in rows]
        results[name] = {'baseline_median_ns': statistics.median(row['baseline'] for row in rows),
                         'candidate_median_ns': statistics.median(row['candidate'] for row in rows),
                         'median_paired_ratio': statistics.median(ratios),
                         'candidate_slower_pairs': sum(value > 1 for value in ratios),
                         'pairs': len(rows), 'rows': rows}
    payload = {'metadata': {'architecture': platform.machine(), 'python': platform.python_version(),
                            'platform': platform.platform(), 'run_id': os.environ.get('BENCH_RUN_ID')},
               'source_sha256': {'baseline_app': BASE_APP, 'candidate_app': CANDIDATE_APP, 'module': CANDIDATE_MODULE},
               'scope': 'Synthetic URLs and request objects, alternating in one process. No PDF bytes, '
                        'production data, network, HTTP handling or browser latency.', 'results': results}
    output.write_text(json.dumps(payload, indent=2) + '\n')
    print(json.dumps({'metadata': payload['metadata'], 'results': {
        name: {key: value for key, value in row.items() if key != 'rows'} for name, row in results.items()}}))


if __name__ == '__main__':
    main()
