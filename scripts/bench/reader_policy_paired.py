"""Paired synthetic Reader path classification; no document or network access."""
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

BASE_APP = '53cd08539a5aeb8f89331fde338d5c4eadd6fd00df94c499686e3edef1ad460e'
CANDIDATE_APP = 'ff963cff759c7394d04a7828fe374087c8d1a2df347ebaefdbb1be250975cf71'
CANDIDATE_MODULE = 'f5030a1c6a75813b11d091efa73b34c99c02fd88ab7196a9df6dd2a1add3afe4'


def main() -> None:
    baseline, candidate, output = (Path(os.environ[name]) for name in
                                   ('BENCH_BASELINE', 'BENCH_CANDIDATE', 'BENCH_OUTPUT'))
    if output.exists():
        raise SystemExit('refuse overwrite')
    original_source = (baseline / 'backend/app.py').read_bytes()
    if (hashlib.sha256(original_source).hexdigest() != BASE_APP
            or hashlib.sha256((candidate / 'backend/app.py').read_bytes()).hexdigest() != CANDIDATE_APP
            or hashlib.sha256((candidate / 'backend/reader_cache_policy.py').read_bytes()).hexdigest() != CANDIDATE_MODULE):
        raise SystemExit('unexpected source')

    def no_network(_self: object, _address: object) -> None:
        raise RuntimeError('network forbidden')

    socket.socket.connect = no_network
    from backend import app

    names = ('is_reader_bucket_cacheable', 'reader_bucket_cache_control', 'reader_bucket_for_path')
    nodes = [item for item in ast.parse(original_source).body if isinstance(item, ast.FunctionDef) and item.name in names]
    if len(nodes) != len(names):
        raise RuntimeError('baseline functions missing')
    for node in nodes:
        node.name = '_benchmark_original_' + node.name
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(baseline / 'backend/app.py'), 'exec'),
         app.__dict__)
    digest, revision = 'a' * 64, 'b' * 16
    paths = [f'objects/aa/{digest}/{revision}/pages/page-000001.webp',
             f'objects/aa/{digest}/{revision}/preview/cover.webp',
             f'objects/aa/{digest}/{revision}/ocr-manifest.json',
             f'chapters/ebook/chm/{digest}/{revision}/chapter-manifest.json',
             f'documents/pdf/ps/{digest}.pdf', 'other/unrecognized', '']
    results = {}
    for name in names:
        old, new = getattr(app, '_benchmark_original_' + name), getattr(app, name)
        expected = [old(path) for path in paths]
        if [new(path) for path in paths] != expected:
            raise AssertionError(name)
        for path in paths:
            for _ in range(500):
                old(path)
                new(path)
        rows = []
        for round_number in range(40):
            pair = (('baseline', old), ('candidate', new))
            if round_number % 2:
                pair = tuple(reversed(pair))
            row = {}
            for label, func in pair:
                checksum = 0
                started = time.perf_counter_ns()
                for _ in range(2000):
                    for path in paths:
                        checksum += bool(func(path))
                row[label] = (time.perf_counter_ns() - started) / (2000 * len(paths))
                row[label + '_checksum'] = checksum
            if row['baseline_checksum'] != row['candidate_checksum']:
                raise AssertionError('checksum mismatch')
            rows.append(row)
        ratios = [row['candidate'] / row['baseline'] for row in rows]
        results[name] = {'baseline_median_ns': statistics.median(row['baseline'] for row in rows),
                         'candidate_median_ns': statistics.median(row['candidate'] for row in rows),
                         'median_paired_ratio': statistics.median(ratios),
                         'candidate_slower_pairs': sum(value > 1 for value in ratios),
                         'pairs': len(rows), 'rows': rows}
    payload = {'metadata': {'architecture': platform.machine(), 'python': platform.python_version(),
                            'platform': platform.platform(), 'run_id': os.environ.get('BENCH_RUN_ID')},
               'source_sha256': {'baseline': BASE_APP, 'candidate': CANDIDATE_APP, 'module': CANDIDATE_MODULE},
               'scope': 'Synthetic strings and pure classification only; no Reader assets, PDF bytes, network, '
                        'HTTP handlers or production traffic.', 'results': results}
    output.write_text(json.dumps(payload, indent=2) + '\n')
    print(json.dumps({'metadata': payload['metadata'], 'results': {
        name: {key: value for key, value in row.items() if key != 'rows'} for name, row in results.items()}}))


if __name__ == '__main__':
    main()
