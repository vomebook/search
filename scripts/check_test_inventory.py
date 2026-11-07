#!/usr/bin/env python3
"""Fail closed when a test-shaped file is absent from the reviewed CI inventory.

This is an inventory check, not evidence that a referenced command executes the
intended test. Dynamic runners and test-level selections still need their own
contracts. The workflow and scripts listed below are checked as literal evidence
and are not parsed as a shell or workflow program.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
INVENTORY = ROOT / 'tests/gates/ci-test-inventory.json'
PROJECT = 'hf' if (ROOT / 'pyrightconfig.json').is_file() else 'github'
KINDS = {'direct', 'script', 'manifest', 'helper', 'excluded'}
SUFFIXES = {'.py', '.js', '.mjs'}


def clean_path(value, parent=None):
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError('path must be a nonempty POSIX string')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('.', '..') for part in value.split('/')) or str(path) != value:
        raise ValueError(f'unsafe path: {value}')
    if parent and path.parts[0] != parent:
        raise ValueError(f'expected {parent}/ path: {value}')
    return path


def test_files(root):
    directory = root / 'tests'
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('tests directory missing or symlinked')
    files = set()
    for path in directory.rglob('*'):
        if path.is_symlink() and (path.is_dir() or (path.name.startswith('test_') and path.suffix in SUFFIXES)):
            raise ValueError(f'symlinked test path: {path.relative_to(root)}')
        if path.is_file() and path.name.startswith('test_') and path.suffix in SUFFIXES:
            files.add(path.relative_to(root).as_posix())
    if not files:
        raise ValueError('no tests found')
    return files


def uncomment(text):
    return '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))


def referenced(path, text):
    dotted = path[:-3].replace('/', '.') if path.endswith('.py') else ''
    return any(re.search(r'(?<![A-Za-z0-9_./-])' + re.escape(name) + r'(?![A-Za-z0-9_/-])', text)
               for name in (path, dotted) if name)


def validate(root, inventory=INVENTORY, project=PROJECT, external_workflow=None):
    doc = json.loads(inventory.read_text(encoding='utf-8'))
    if not isinstance(doc, dict) or set(doc) != {'version', 'project', 'tests'}:
        raise ValueError('invalid inventory structure')
    if type(doc['version']) is not int or doc['version'] != 1 or doc['project'] != project:
        raise ValueError('invalid inventory version or project')
    if not (root / 'tests/__init__.py').is_file() or (root / 'tests/__init__.py').is_symlink():
        raise ValueError('tests package marker missing or symlinked')
    if not isinstance(doc['tests'], dict):
        raise ValueError('tests must be a mapping')
    actual = test_files(root)
    listed = set(doc['tests'])
    if actual != listed:
        raise ValueError(f'test inventory mismatch: missing={sorted(actual-listed)}, stale={sorted(listed-actual)}')
    external_sources = sum(entry.get('source') == '@reader-workflow' for entry in doc['tests'].values()
                           if isinstance(entry, dict))
    if project == 'hf' and external_workflow is not None and external_sources == 0:
        raise ValueError('HF inventory has no external workflow evidence')
    for path, entry in doc['tests'].items():
        clean_path(path, 'tests')
        if not isinstance(entry, dict) or entry.get('kind') not in KINDS:
            raise ValueError(f'invalid entry: {path}')
        kind = entry['kind']
        self_test = path in {'tests/gates/test_package_resolution.py', 'tests/gates/test_test_inventory.py'}
        if self_test and (kind != 'direct' or (project == 'hf' and entry.get('source') != '@reader-workflow')):
            raise ValueError(f'inventory self-test must be a CI requirement: {path}')
        if kind == 'excluded':
            if set(entry) != {'kind', 'reason'} or not isinstance(entry['reason'], str) or len(entry['reason'].strip()) < 15:
                raise ValueError(f'exclusion needs a reason: {path}')
            continue
        if kind == 'direct' and entry.get('source') == '@reader-workflow':
            if project != 'hf' or set(entry) != {'kind', 'source'}:
                raise ValueError(f'invalid external workflow evidence: {path}')
            if external_workflow is None:
                continue  # Local HF checkout has no GitHub workflow; CI supplies it.
            workflow = external_workflow.read_text(encoding='utf-8')
            if workflow.count('  huggingface-search:\n') != 1:
                raise ValueError('external workflow missing HF job')
            hf_job = workflow.split('  huggingface-search:\n', 1)[1]
            hf_job = re.split(r'\n  [A-Za-z0-9_-]+:\s*\n', hf_job, maxsplit=1)[0]
            if not referenced(path, uncomment(hf_job)):
                raise ValueError(f'external workflow HF job does not reference {path}')
            continue
        if set(entry) != {'kind', 'source'}:
            raise ValueError(f'invalid evidence: {path}')
        source = entry['source']
        clean_path(source)
        evidence = root / source
        if not evidence.is_file() or evidence.is_symlink():
            raise ValueError(f'missing evidence file for {path}: {source}')
        text = uncomment(evidence.read_text(encoding='utf-8'))
        if kind == 'manifest':
            data = json.loads(evidence.read_text(encoding='utf-8'))
            module = path[:-3].replace('/', '.') if path.endswith('.py') else None
            if not module or data.get('module') != module or not data.get('groups'):
                raise ValueError(f'invalid frozen-manifest evidence for {path}')
        elif kind == 'helper':
            if not source.startswith('tests/') or not referenced(source, refs_for_helper(root, path)):
                raise ValueError(f'helper importer missing: {path}')
        elif not referenced(path, text):
            raise ValueError(f'evidence does not reference {path}: {source}')
    evidence = ('external workflow references unchecked' if external_sources and external_workflow is None
                else 'references checked')
    print(f'{project} CI test inventory: {len(actual)} files accounted for; {evidence}; not proof of execution')


def refs_for_helper(root, path):
    """Return importer paths that literally require the candidate's basename."""
    stem = PurePosixPath(path).stem
    importers = []
    for file in (root / 'tests').rglob('*'):
        if not file.is_file() or file.suffix not in {'.js', '.mjs'}:
            continue
        text = uncomment(file.read_text(encoding='utf-8'))
        if re.search(r'(?:require\(\s*|from\s+)[\"\'][^\"\']*/' + re.escape(stem) + r'(?:\.(?:js|mjs))?[\"\']', text):
            importers.append(file.relative_to(root).as_posix())
    return '\n'.join(importers)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', choices=('github', 'hf'), required=True)
    parser.add_argument('--reader-workflow', type=Path)
    args = parser.parse_args()
    if args.project != PROJECT or Path.cwd().resolve() != ROOT:
        raise SystemExit('project or checkout root mismatch')
    if args.reader_workflow is not None and (PROJECT != 'hf' or not args.reader_workflow.is_file()):
        raise SystemExit('invalid external reader workflow')
    validate(ROOT, external_workflow=args.reader_workflow)


if __name__ == '__main__':
    try:
        main()
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f'CI test inventory failed: {exc}', file=sys.stderr)
        sys.exit(1)
