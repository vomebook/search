"""Alternate isolated DjVu baseline/candidate runs; never mix stall with normal."""
import argparse
import hashlib
import json
import re
import statistics
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name('benchmark_djvu.py')


def summary(pairs):
    values = {'first_canvas_ms': lambda row: row['first']['marks']['firstCanvas'],
              'jump_canvas_ms': lambda row: row['jump']['ms']}
    result = {}
    for name, extract in values.items():
        base = [extract(pair['baseline']) for pair in pairs]
        candidate = [extract(pair['candidate']) for pair in pairs]
        delta = [after - before for before, after in zip(base, candidate)]
        result[name] = {'baseline_median': statistics.median(base),
                        'candidate_median': statistics.median(candidate),
                        'paired_delta_ms': delta, 'paired_delta_median': statistics.median(delta)}
    return result


def assert_same_output(pair):
    before, after = pair['baseline'], pair['candidate']
    for key in ('target_canvas_sha256', 'target_text_sha256', 'target_text_characters'):
        if before[key] != after[key]:
            raise ValueError(f'baseline/candidate {key} differs')
    if (before['jump']['width'], before['jump']['height']) != (after['jump']['width'], after['jump']['height']):
        raise ValueError('baseline/candidate canvas geometry differs')
    if before['live_source_validator_sha256'] != after['live_source_validator_sha256']:
        raise ValueError('baseline/candidate source validators differ')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-root', type=Path, required=True)
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--mode', choices=['normal', 'stall'], default='normal')
    parser.add_argument('--fixture', choices=['long', 'separated', 'small', 'ocr'], default='long')
    parser.add_argument('--live-id', help='local Reader with real network; requires pinned revision and strong ETag')
    parser.add_argument('--source-revision')
    parser.add_argument('--expected-etag')
    parser.add_argument('--browser', choices=['chromium', 'firefox', 'webkit'], default='chromium')
    parser.add_argument('--target', type=int, default=20)
    parser.add_argument('--pairs', type=int, default=3)
    parser.add_argument('--stall-ms', type=int, default=1200)
    parser.add_argument('--timeout-ms', type=int, default=90000)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.pairs < 1 or args.target < 2 or args.stall_ms < 0 or args.timeout_ms < 1000:
        parser.error('invalid pairs, target, stall or timeout')
    if args.source_revision and not re.fullmatch(r'[0-9a-f]{40}', args.source_revision):
        parser.error('source revision must be 40 lowercase hex digits')
    if args.live_id and (args.mode != 'normal' or not args.source_revision or
                         not re.fullmatch(r'"[^"\r\n]{1,250}"', args.expected_etag or '')):
        parser.error('live comparison requires normal mode, pinned revision and strong --expected-etag')
    if args.expected_etag and not args.live_id:
        parser.error('--expected-etag requires --live-id')
    for root in (args.baseline_root, args.candidate_root):
        if not (root / 'static/reader.html').is_file():
            parser.error(f'invalid Reader root: {root}')
    report = {'started_at': datetime.now(timezone.utc).isoformat(), 'mode': args.mode,
              'browser': args.browser, 'pairs_requested': args.pairs, 'pairs': [],
              'benchmark_sha256': hashlib.sha256(SCRIPT.read_bytes()).hexdigest(),
              'scope': 'local Reader with live original relay' if args.live_id else 'synthetic local original',
              'fixture': None if args.live_id else args.fixture,
              'pinned_revision': bool(args.source_revision), 'stall_ms': args.stall_ms if args.mode == 'stall' else None,
              'target': args.target, 'complete': False}
    roots = {'baseline': args.baseline_root.resolve(), 'candidate': args.candidate_root.resolve()}

    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    try:
        with tempfile.TemporaryDirectory(prefix='djvu-comparison-') as directory:
            for index in range(args.pairs):
                pair = {'pair': index + 1, 'order': ['baseline', 'candidate'] if index % 2 == 0 else ['candidate', 'baseline']}
                for name in pair['order']:
                    result = Path(directory) / f'{index}-{name}.json'
                    command = [sys.executable, '-B', str(SCRIPT), '--root', str(roots[name]),
                               '--mode', args.mode, '--browser', args.browser, '--fixture', args.fixture,
                               '--target', str(args.target), '--iterations', '1', '--stall-ms', str(args.stall_ms),
                               '--timeout-ms', str(args.timeout_ms), '--output', str(result)]
                    if args.source_revision:
                        command += ['--source-revision', args.source_revision]
                    if args.live_id:
                        command += ['--live-id', args.live_id, '--expected-etag', args.expected_etag]
                    completed = subprocess.run(command, text=True, capture_output=True,
                                               timeout=args.timeout_ms / 1000 + 45)
                    if completed.returncode:
                        raise RuntimeError(f'{name} pair {index + 1} failed: {completed.stderr}')
                    measurement = json.loads(result.read_text())
                    pair[name] = measurement['runs'][0]
                    pair[name]['reader_head'] = measurement['reader_head']
                    pair[name]['reader_dirty'] = measurement['reader_dirty']
                    pair[name]['fixture_source_sha256'] = measurement.get('fixture_source_sha256')
                    print(f"pair {index+1} {name}: first={pair[name]['first']['marks']['firstCanvas']:.1f}ms", file=sys.stderr)
                assert_same_output(pair)
                report['pairs'].append(pair)
                save()
        report['summary'] = summary(report['pairs'])
        report['complete'] = True
        save()
        print(json.dumps(report['summary'], ensure_ascii=False, indent=2))
    except Exception as error:
        report['error'] = str(error)
        save()
        raise


if __name__ == '__main__':
    main()
