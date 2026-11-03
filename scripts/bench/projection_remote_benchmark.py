"""Compare pinned local checkouts on one remote x86_64 runner, never production."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time


BASELINE = "bc9d36d02ed278002d161f01c5512b33ed8b4ea8"
CANDIDATE = BASELINE
EXPECTED = {
    "baseline": "b73c5db076ae1dce7c8988fc30049d2c0120ffdf9b6d6b2fd02a4b97e726b3cb",
    "candidate": "bd3de63841020bfc3c16f5015894ae39ff08c38e6a6d3bc03129e1b86ed91a84",
}
EXPECTED_MODULE = "81dbe74b8142aed5447478e2a05c36150a5a2abf67f4aa0b55bc3d43b297cec4"
ORDER = ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate", "candidate", "baseline"]
CHILD = r'''
import contextlib, gc, hashlib, io, json, os, platform, socket, statistics, time
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from backend import app
def no_network(self, address):
    raise RuntimeError('external sockets forbidden in benchmark')
socket.socket.connect = no_network

records=[{'Repo':('Bench/Example' if i%2==0 else 'Bench/Other'),
          'File':('alpha guide' if i%11==0 else ('alpa guide' if i%13==0 else f'file_{i:07}')),
          'Extension':('pdf' if i%3 else 'txt'),
          'Folder':(['books',f'group{i%20}'] if i%4 else ['manuals',f'group{i%10}']),
          'Size':i,'HasTxt':False} for i in range(1500)]
app.records=records
app.build_indexes()
grams={2:{},3:{}}
for idx,record in enumerate(records):
    text=(record['File']+' '+record['Repo']+' '+' '.join(record['Folder'])).lower()
    for width in (2,3):
        for gram in {text[i:i+width] for i in range(len(text)-width+1)}:
            grams[width].setdefault(gram,set()).add(idx)
app.ngram_postings=grams
app.ngram_posting_buffers={}
known=[{**r,'Link':'https://example.invalid/resolve','Path':'https://example.invalid/blob'} for r in records[:500]]
missing=records[:500]

def direct(records):
    return app.trim_results(records)

micro={}
for mode, query, scope in (('literal_common','alpha',None),('literal_scoped','alpha',['Bench/Example']),
                           ('literal_miss','zzzz',None),('literal_short','a',None)):
    reference=app.literal_candidates(query,scope)
    for _ in range(300):assert app.literal_candidates(query,scope)==reference
    times=[]
    gc.disable()
    try:
        for _ in range(25):
            start=time.perf_counter_ns()
            for _ in range(500):value=app.literal_candidates(query,scope)
            times.append((time.perf_counter_ns()-start)/500/1e6)
            assert value==reference
    finally:gc.enable()
    micro[mode]={'ms_per_500':times,'median_ms':statistics.median(times),
                 'result_sha256':hashlib.sha256(repr(sorted(reference) if reference is not None else None).encode()).hexdigest(),
                 'result_count':len(reference) if reference is not None else None}

with patch.object(app,'get_reader_assets',AsyncMock(return_value={})):
    client=TestClient(app.app)
    try:
        api={}
        scenarios=[
            ('empty_page_1_100',{'q':'','page_size':100}),
            ('empty_page_1_500',{'q':'','page_size':500}),
            ('empty_page_3_100',{'q':'','page':3,'page_size':100}),
            ('exact_literal',{'q':'alpha','exact':True,'page_size':100}),
            ('exact_wildcard',{'q':'alpha*','exact':True,'page_size':100}),
            ('fuzzy_multi',{'q':'alphaa guide','page_size':100}),
            ('repo_extension',{'q':'','repos':['Bench/Example'],'extensions':['pdf'],'page_size':100}),
            ('folder_mixed',{'q':'','folder_match_mode':'mixed','folder_subtrees':['books/group2'],'page_size':100}),
            ('sorted_name',{'q':'','sort':'name','page_size':100}),
            ('sorted_size',{'q':'','sort':'size','page_size':100}),
        ]
        for scenario,payload in scenarios:
            for mode in ('cold_order','cold_projection','warm_caches'):
                def call():
                    if mode in ('cold_order','cold_projection'):
                        app._search_cache.clear()
                        app.api_response_cache.clear()
                    if mode=='cold_order':app._search_order_cache.clear()
                    start=time.perf_counter_ns()
                    with contextlib.redirect_stdout(io.StringIO()):
                        response=client.post('/api/search',json=payload)
                    elapsed=(time.perf_counter_ns()-start)/1e6
                    assert response.status_code==200
                    body=response.json()
                    assert body['total']>=len(body['results']) and len(body['results'])<=payload['page_size']
                    assert all(not str(k).startswith('_') for item in body['results'] for k in item)
                    body.pop('generation')
                    digest=hashlib.sha256(json.dumps(body,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
                    return elapsed,digest,len(app._search_cache),len(app.api_response_cache),body['total'],len(body['results'])
                _,reference,_,_,body_total,result_count=call()
                assert body_total>0 and result_count>0, (scenario,mode,body_total,result_count)
                for _ in range(5):assert call()[1]==reference
                samples=[]
                for _ in range(20):
                    elapsed,digest,search_entries,response_entries,current_total,current_count=call()
                    assert digest==reference
                    assert (current_total,current_count)==(body_total,result_count)
                    assert search_entries>0 and response_entries>0, (mode,search_entries,response_entries)
                    samples.append(elapsed)
                print('SCENARIO_CHECK='+json.dumps({'scenario':scenario,'mode':mode,'total':body_total,
                    'result_count':result_count,'search_entries':search_entries,'response_entries':response_entries}),flush=True)
                api[f'{mode}_{scenario}']={'ms':samples,'median_ms':statistics.median(samples),
                                      'body_sha256':reference,'total':body_total,'result_count':result_count,'search_entries':search_entries,
                                      'response_entries':response_entries}
    finally:client.close()
print(json.dumps({'micro':micro,'api':api,'python':platform.python_version()}))
'''


def run(command: list[str], **kwargs: object) -> str:
    return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, **kwargs).stdout.strip()  # noqa: S603


def main() -> None:
    repositories = {name: Path(os.environ[f"BENCH_{name.upper()}"]) for name in EXPECTED}
    output = Path(os.environ["BENCH_OUTPUT"])
    if output.exists():
        raise SystemExit("refusing to overwrite benchmark evidence")
    expected_commits = {"baseline": BASELINE, "candidate": CANDIDATE}
    for name, root in repositories.items():
        commit = run(["git", "-C", str(root), "rev-parse", "HEAD"])
        digest = hashlib.sha256((root / "backend/app.py").read_bytes()).hexdigest()
        if commit != expected_commits[name] or digest != EXPECTED[name]:
            raise RuntimeError(f"unexpected {name} source")
        if name == "candidate" and hashlib.sha256((root / "backend/search_candidates.py").read_bytes()).hexdigest() != EXPECTED_MODULE:
            raise RuntimeError("unexpected extracted module")
    env = os.environ.copy()
    env["PYTHONPATH"] = os.environ["BENCH_NATIVE"]
    env["PYTHONHASHSEED"] = "1"
    runs: dict[str, list[dict[str, object]]] = {"baseline": [], "candidate": []}
    started = time.monotonic()
    for index, name in enumerate(ORDER):
        print(f"Benchmark process {index + 1}/{len(ORDER)}: {name}", flush=True)
        text = run([sys.executable, "-B", "-c", CHILD], cwd=repositories[name], env=env, timeout=150)
        runs[name].append(json.loads(text.splitlines()[-1]))
    summary = {}
    for group in ("micro", "api"):
        for name in runs["baseline"][0][group]:
            units = "ms_per_500" if group == "micro" else "ms"
            old = [number for run_row in runs["baseline"] for number in run_row[group][name][units]]
            new = [number for run_row in runs["candidate"] for number in run_row[group][name][units]]
            if group == "api":
                digests = {run_row[group][name]["body_sha256"] for rows in runs.values() for run_row in rows}
                if len(digests) != 1:
                    raise RuntimeError(f"response mismatch: {name}")
            else:
                digests = {run_row[group][name]["result_sha256"] for rows in runs.values() for run_row in rows}
                if len(digests) != 1:
                    raise RuntimeError(f"candidate mismatch: {name}")
            paired = [new_row[group][name]["median_ms"] / old_row[group][name]["median_ms"]
                      for old_row, new_row in zip(runs["baseline"], runs["candidate"])]
            summary[f"{group}_{name}"] = {
                "baseline_median_ms": statistics.median(old), "candidate_median_ms": statistics.median(new),
                "baseline_range_ms": [min(old), max(old)], "candidate_range_ms": [min(new), max(new)],
                "baseline_process_medians_ms": [row[group][name]["median_ms"] for row in runs["baseline"]],
                "candidate_process_medians_ms": [row[group][name]["median_ms"] for row in runs["candidate"]],
                "median_process_pair_ratio": statistics.median(paired), "samples_per_revision": len(old),
            }
    cpu = Path('/proc/cpuinfo').read_text() if Path('/proc/cpuinfo').exists() else ''
    metadata = {"run_id": os.environ.get("BENCH_RUN_ID"), "python": platform.python_version(),
                "platform": platform.platform(), "architecture": platform.machine(), "cpu_count": os.cpu_count(),
                "cpu_model": next((line for line in cpu.splitlines() if line.startswith('model name')), 'unknown'),
                "elapsed_seconds": round(time.monotonic() - started, 2)}
    result = {"baseline": BASELINE, "candidate_base": CANDIDATE, "source_sha256": EXPECTED,
              "candidate_module_sha256": EXPECTED_MODULE,
              "metadata": metadata, "order": ORDER, "summary": summary, "runs": runs,
              "scope": "GitHub-hosted x86_64 runner; exact source hashes, synthetic 1500 records and generated in-memory n-gram index; no network or production traffic. Cold order clears order, page and response caches; cold projection retains warmed order; warm preserves all. Micro values are per literal_candidates call, not 500 calls. FastAPI timings include TestClient overhead; not production HF hardware or public network latency."}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print("REMOTE_BENCHMARK_SUMMARY=" + json.dumps({"metadata": metadata, "summary": summary}, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
