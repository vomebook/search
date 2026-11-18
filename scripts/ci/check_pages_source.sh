#!/usr/bin/env bash
# The same non-publishing source gates for local preflight and Pages CI.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd -- "$root"
npm run check:static
python -B scripts/check_python_static.py
npx --no-install pyright --project pyrightconfig.strict.json
python -B -m unittest -v tests.gates.test_static_shards_runner tests.gates.test_package_resolution tests.gates.test_test_inventory
python -B scripts/check_test_inventory.py --project github
python -B scripts/ci/run_static_gate_shards.py --project github
python -B -m unittest -v tests.gates.test_ci_ubuntu_mirror
python -B scripts/ci/reader_matrix_contract.py
python -B -m unittest -v tests.gates.test_reader_matrix_contract tests.gates.test_unittest_suite_runner
node tests/reader/pdf-v3/test_dataset_primary_policy.mjs
