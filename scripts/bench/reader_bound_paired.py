"""Paired bounded-cache benchmark; synthetic memory and no network traffic."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import time
from types import CodeType, FunctionType, SimpleNamespace
from unittest.mock import patch

EXPECTED = {
    'baseline': 'db91dcb900f0e4b22a31c62e75b14aec01a62cf7640b8e34fa57a11f53a12920',
    'candidate': 'da682fc48a3e627e4eea8a9ebeb8722d7c39272cb4dfa4d063e54c70bd3ac000',
}


def main() -> None:
    paths = {label: Path(os.environ[name]) for label, name in (
        ('baseline', 'BENCH_BASELINE'), ('candidate', 'BENCH_CANDIDATE'))}
    output = Path(os.environ['BENCH_OUTPUT'])
    if output.exists():
        raise SystemExit('refuse overwrite')
    source = {label: (repo / 'backend/app.py').read_bytes() for label, repo in paths.items()}
    for label in paths:
        if hashlib.sha256(source[label]).hexdigest() != EXPECTED[label]:
            raise SystemExit('unexpected source: ' + label)

    def no_network(_self: object, _address: object) -> None:
        raise RuntimeError('network forbidden')

    socket.socket.connect = no_network
    from backend import app

    functions = {}
    for label in paths:
        compiled = compile(source[label], str(paths[label] / 'backend/app.py'), 'exec')
        codes = [value for value in compiled.co_consts if isinstance(value, CodeType)
                 and value.co_name == 'get_reader_bucket_resource']
        if len(codes) != 1:
            raise RuntimeError('missing or duplicate bucket code')
        functions[label] = FunctionType(codes[0], app.__dict__, 'get_reader_bucket_resource',
                                        (app.READER_RESOURCE_MAX_BYTES,))

    async def compare():
        loop = asyncio.get_running_loop()
        path = 'objects/aa/' + 'a' * 64 + '/' + 'b' * 16 + '/page-manifest.json'
        payload = b'synthetic manifest'
        state = SimpleNamespace(reader_bucket_cache=OrderedDict({path: (time.monotonic(), payload)}),
                                reader_bucket_cache_bytes=len(payload), reader_bucket_inflight={})
        rounds, repeats = 40, 3000
        results = {}
        with patch.object(app, 'app', SimpleNamespace(state=state)):
            for func in functions.values():
                if await func(path) != payload:
                    raise AssertionError('baseline/candidate payload mismatch')
            ready = loop.create_future()
            ready.set_result(payload)

            async def measure(func, mode):
                state.reader_bucket_cache.clear()
                state.reader_bucket_inflight.clear()
                if mode == 'hot_cache':
                    state.reader_bucket_cache[path] = (time.monotonic(), payload)
                else:
                    state.reader_bucket_inflight[path] = ready
                start = time.perf_counter_ns()
                checksum = 0
                for _ in range(repeats):
                    checksum += len(await func(path))
                return (time.perf_counter_ns() - start) / repeats, checksum

            for mode in ('hot_cache', 'completed_shared_future'):
                for func in functions.values():
                    await measure(func, mode)
                rows = []
                for index in range(rounds):
                    labels = ('baseline', 'candidate') if index % 2 == 0 else ('candidate', 'baseline')
                    row = {}
                    for label in labels:
                        row[label], row[label + '_checksum'] = await measure(functions[label], mode)
                    if row['baseline_checksum'] != row['candidate_checksum']:
                        raise AssertionError('checksum mismatch')
                    rows.append(row)
                ratios = [row['candidate'] / row['baseline'] for row in rows]
                results[mode] = {'baseline_median_ns': statistics.median(row['baseline'] for row in rows),
                                 'candidate_median_ns': statistics.median(row['candidate'] for row in rows),
                                 'median_paired_ratio': statistics.median(ratios),
                                 'candidate_slower_pairs': sum(ratio > 1 for ratio in ratios),
                                 'pairs': rounds, 'iterations_per_pair_side': repeats, 'rows': rows}
        return results

    results = asyncio.run(compare())
    report = {'metadata': {'architecture': platform.machine(), 'python': platform.python_version(),
                           'platform': platform.platform(), 'run_id': os.environ.get('BENCH_RUN_ID')},
              'source_sha256': EXPECTED,
              'baseline_method': 'Both functions compiled in whole source module; same app globals.',
              'scope': 'Synthetic in-memory async cache hit and already-completed shared future only. '
                       'No real resources, PDF, HTTP handlers, filesystem reads, or production traffic.',
              'results': results}
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'metadata': report['metadata'], 'results': {
        key: {name: value for name, value in item.items() if name != 'rows'} for key, item in results.items()}}))


if __name__ == '__main__':
    main()
