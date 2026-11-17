"""Audit the Reader matrix against a reviewed, frozen workflow contract.

Requires PyYAML 6.0.3 (install via the project's pinned CI dependencies).
No Git history or network is needed at validation time. The pinned historical
workflow and policy require review; protect this checker and its constants with
an independently trusted CI revision or an external protected pin.
"""
import argparse
import ast
import hashlib
import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError as exc:
    raise SystemExit('Reader matrix gate requires PyYAML==6.0.3') from exc

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = Path(__file__).with_name('reader_matrix_baseline.json')
WORKFLOW = ROOT / '.github/workflows/reader-refactor.yml'
ORIGINAL = Path(__file__).with_name('reader_matrix_original_2a7436bf.yml')
ORIGINAL_COMMIT = '2a7436bfd0f3f97f26edc18326558cdaee13bacb'
ORIGINAL_SHA256 = '03bc625cb66d6c19010602be7c3c9504d1cb5647d15928405db20f82c24735ba'
POLICY_SHA256 = '3ac946ec52191313d531d4327f746b1096d95b488c68f70a772b9606c13874c4'
JOBS = ('github-search', 'huggingface-search')
SHARDS = ['static', 'core', 'loading', 'navigation', 'search']
_SHARD = re.compile(r"\$\{\{\s*!cancelled\(\)\s*&&\s*steps\.setup-complete\.outputs\.ready\s*==\s*'true'\s*&&\s*matrix\.shard\s*==\s*'([a-z0-9-]+)'\s*\}\}")


class ContractError(ValueError):
    """Invalid YAML or a violation of the reviewed contract."""


class ActionsLoader(yaml.SafeLoader):
    # GitHub uses YAML 1.2 booleans, not YAML 1.1's on/off/yes/no.
    yaml_implicit_resolvers = {key: [(tag, regexp) for tag, regexp in entries
                                     if tag != 'tag:yaml.org,2002:bool']
                               for key, entries in yaml.SafeLoader.yaml_implicit_resolvers.items()}

    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise ContractError('YAML aliases are forbidden')
        event = self.peek_event()
        if getattr(event, 'anchor', None) is not None:
            raise ContractError('YAML anchors are forbidden')
        if getattr(event, 'tag', None) is not None:
            raise ContractError('explicit YAML tags are forbidden')
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            if key_node.tag == 'tag:yaml.org,2002:merge' or key_node.value == '<<':
                raise ContractError('YAML merge keys are forbidden')
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str):
                raise ContractError('mapping keys must be strings')
            if key in result:
                raise ContractError(f'duplicate YAML key: {key}')
            result[key] = self.construct_object(value_node, deep=deep)
        return result


ActionsLoader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|false|True|False|TRUE|FALSE)$'), list('tTfF'))


def parse(text):
    try:
        result = yaml.load(text, Loader=ActionsLoader)
    except (yaml.YAMLError, ValueError) as exc:
        raise ContractError(f'invalid YAML: {exc}') from exc
    if not isinstance(result, dict):
        raise ContractError('workflow must be a mapping')
    return result


def digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def require(condition, message):
    if not condition:
        raise ContractError(message)


def business_record(step, shard):
    """Preserve all original fields; hash run bytes independently for review."""
    require(isinstance(step, dict) and isinstance(step.get('name'), str) and isinstance(step.get('run'), str), 'invalid business step')
    require(set(step) <= {'name', 'run', 'env', 'working-directory', 'timeout-minutes'}, 'unexpected business step field')
    return {'fields': {k: v for k, v in step.items() if k != 'run'},
            'run_sha256': hashlib.sha256(step['run'].encode()).hexdigest(), 'shard': shard}


def verify_policy(contract, original_bytes):
    """Authenticate policy and derive every classified business step from history."""
    require(digest(contract) == POLICY_SHA256, 'reviewed policy fingerprint mismatch')
    require(contract.get('baseline_commit') == ORIGINAL_COMMIT[:8], 'invalid baseline commit')
    require(contract.get('baseline_workflow_sha256') == ORIGINAL_SHA256, 'invalid baseline fingerprint')
    require(hashlib.sha256(original_bytes).hexdigest() == ORIGINAL_SHA256, 'historical workflow fingerprint mismatch')
    original = parse(original_bytes.decode('utf-8'))
    for job in JOBS:
        original_steps = original['jobs'][job]['steps']
        named = [s for s in original_steps if isinstance(s, dict) and 'name' in s]
        names = [s['name'] for s in named]
        require(len(names) == len(set(names)), f'{job}: duplicate original names')
        by_name = {s['name']: s for s in named}
        seen = set()
        for record in contract['matrix_jobs'][job]['steps']:
            if 'fields' not in record:
                continue
            name = record['fields']['name']
            require(name in by_name and name not in seen, f'{job}: unknown or duplicate historical step {name}')
            require(record == business_record(by_name[name], record['shard']), f'{job}: historical step mismatch {name}')
            seen.add(name)
        # Setup is a separate pinned allowlist. No historical step may vanish:
        # each is either a business step or explicitly identified as setup.
        setup_labels = [r['label'] for r in contract['matrix_jobs'][job]['steps'] if 'setup' in r]
        for name in names:
            require(name in seen or name in setup_labels, f'{job}: historical step missing: {name}')


def summary_manifest(summary):
    """Read only literal manifest assignments; never execute untrusted workflow code."""
    run = summary['steps'][0]['run']
    require(run.startswith("python3 - <<'PY'\n") and run.endswith('\nPY\n'), 'unexpected summary program')
    tree = ast.parse(run[len("python3 - <<'PY'\n"):-len('\nPY\n')])
    values = {}

    def literal(node):
        if isinstance(node, ast.Name) and node.id == 'common_core' and node.id in values:
            return values[node.id]
        if isinstance(node, ast.Dict):
            keys = [literal(k) for k in node.keys]
            require(len(keys) == len(set(keys)), 'duplicate manifest key')
            return dict(zip(keys, (literal(v) for v in node.values)))
        if isinstance(node, (ast.Tuple, ast.List)):
            return [literal(e) for e in node.elts]
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        raise ContractError('nonliteral manifest')

    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ('common_core', 'business'):
            name = node.targets[0].id
            require(name not in values, f'duplicate manifest assignment: {name}')
            values[name] = literal(node.value)
    require('business' in values, 'missing manifest')
    return values['business']


def validate(workflow, contract, original_bytes=None):
    if original_bytes is None:
        original_bytes = ORIGINAL.read_bytes()
    verify_policy(contract, original_bytes)
    require({k: v for k, v in workflow.items() if k != 'jobs'} == contract['workflow_settings'], 'workflow settings changed')
    jobs = workflow.get('jobs')
    require(isinstance(jobs, dict) and set(jobs) == set(contract['job_ids']), 'unexpected workflow jobs')
    # Fixed jobs include the summary and capture jobs in full. In particular,
    # summary's exact reviewed command enforces all four success results.
    for name, expected in contract['fixed_jobs'].items():
        require(name in jobs and jobs[name] == expected, f'{name}: job changed')
    require(set(contract['fixed_jobs']) == set(jobs) - set(JOBS), 'incomplete fixed jobs contract')
    manifest = summary_manifest(jobs['summary'])
    require(isinstance(manifest, dict) and set(manifest) == set(JOBS), 'invalid summary manifest jobs')
    for name in JOBS:
        job = jobs.get(name)
        policy = contract['matrix_jobs'][name]
        require(isinstance(job, dict), f'{name}: missing job')
        require(digest({k: v for k, v in job.items() if k != 'steps'}) == policy['job_sha256'], f'{name}: job configuration changed')
        strategy = job.get('strategy')
        require(isinstance(strategy, dict) and strategy.get('fail-fast') is False and strategy.get('matrix') == {'shard': SHARDS}, f'{name}: invalid matrix')
        steps = job.get('steps')
        require(isinstance(steps, list) and len(steps) == len(policy['steps']), f'{name}: missing or extra steps')
        seen = set()
        by_shard = {shard: [] for shard in SHARDS}
        for step, expected in zip(steps, policy['steps']):
            require(isinstance(step, dict), f'{name}: invalid step')
            if 'setup' in expected:
                require(step == expected['setup'], f"{name}: setup changed: {expected['label']}")
                continue
            condition = step.get('if')
            match = _SHARD.fullmatch(condition.strip()) if isinstance(condition, str) else None
            # The trusted HF history pre-check necessarily precedes setup.
            if name == 'huggingface-search' and expected['fields']['name'] == 'Test Hugging Face history bridge':
                require(condition == "${{ matrix.shard == 'static' }}", 'HF history pre-check condition changed')
                shard = 'static'
            else:
                require(match is not None, f"{name}: invalid condition for {expected['fields']['name']}")
                shard = match.group(1)
            require(shard == expected['shard'], f"{name}: invalid shard for {expected['fields']['name']}")
            original = {k: v for k, v in step.items() if k != 'if'}
            actual = business_record(original, shard)
            require(actual == expected, f"{name}: business step changed: {expected['fields']['name']}")
            require(actual['fields']['name'] not in seen, f'{name}: duplicate step')
            seen.add(actual['fields']['name'])
            by_shard[shard].append(actual['fields']['name'])
        require(seen, f'{name}: no business steps')
        declared = manifest[name]
        require(isinstance(declared, dict) and set(declared) == set(SHARDS), f'{name}: invalid manifest shards')
        for shard in SHARDS:
            names = declared[shard]
            require(isinstance(names, list) and len(names) == len(set(names)) and set(names) == set(by_shard[shard]), f'{name}/{shard}: manifest differs from business steps')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workflow', type=Path, default=WORKFLOW)
    args = parser.parse_args()
    try:
        contract = json.loads(CONTRACT.read_text(encoding='utf-8'))
        validate(parse(args.workflow.read_text(encoding='utf-8')), contract)
    except (ContractError, OSError, KeyError, TypeError, ValueError, UnicodeError) as exc:
        print(f'Reader matrix contract FAILED: {exc}', file=sys.stderr)
        return 1
    print('Reader matrix contract passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
