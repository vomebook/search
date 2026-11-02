"""Validate independently pinned HF debt baselines before passing them to gates."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / ".github/quality-baselines/hf-source.json"
REQUIRED = {"backend-coverage-debt.json", "strict-inventory-debt.json"}


def validate_baselines(directory: Path, lock: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if lock.get("repository") != "VoiceOfML/Search":
        errors.append("incorrect Hugging Face baseline repository")
    revision = lock.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        errors.append("baseline revision must be a full commit SHA")
    expected = lock.get("files")
    if not isinstance(expected, dict) or set(expected) != REQUIRED:
        return errors + ["baseline must list exactly the coverage and strict inventories"]
    for name in sorted(REQUIRED):
        digest = expected[name]
        path = directory / name
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            errors.append(f"invalid baseline SHA-256: {name}")
        elif not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            errors.append(f"missing or altered baseline file: {name}")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python scripts/verify_hf_quality_baseline.py DIRECTORY", file=sys.stderr)
        return 2
    lock = json.loads(LOCK.read_text())
    errors = validate_baselines(Path(sys.argv[1]), lock)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Verified two HF quality baselines from {lock['revision']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
