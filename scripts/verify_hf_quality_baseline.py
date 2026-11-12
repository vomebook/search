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


def read_verified_baselines(directory: Path, lock: dict[str, object]) -> tuple[dict[str, bytes], list[str]]:
    """Hash each byte snapshot once; callers must use those same bytes."""
    errors: list[str] = []
    snapshots: dict[str, bytes] = {}
    if lock.get("repository") != "VoiceOfML/Search":
        errors.append("incorrect Hugging Face baseline repository")
    revision = lock.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        errors.append("baseline revision must be a full commit SHA")
    expected = lock.get("files")
    if not isinstance(expected, dict) or set(expected) != REQUIRED:
        return {}, errors + ["baseline must list exactly the coverage and strict inventories"]
    for name in sorted(REQUIRED):
        digest = expected[name]
        path = directory / name
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            errors.append(f"invalid baseline SHA-256: {name}")
        else:
            try:
                data = path.read_bytes()
            except OSError:
                errors.append(f"missing or altered baseline file: {name}")
                continue
            if hashlib.sha256(data).hexdigest() != digest:
                errors.append(f"missing or altered baseline file: {name}")
            else:
                snapshots[name] = data
    return snapshots, errors


def validate_baselines(directory: Path, lock: dict[str, object]) -> list[str]:
    return read_verified_baselines(directory, lock)[1]


def selected_lock(selected: str) -> dict[str, object]:
    if __package__:
        from .select_hf_history import HISTORIES
    else:
        from select_hf_history import HISTORIES
    lock = json.loads(LOCK.read_text())
    if lock.get("revision") != HISTORIES["66d92cb401f52e9dfe78ca6026e682c7097b730b"] or selected not in HISTORIES.values():
        raise ValueError("invalid selected baseline revision or lock")
    lock["revision"] = selected
    return lock


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python scripts/verify_hf_quality_baseline.py DIRECTORY SELECTED_REVISION", file=sys.stderr)
        return 2
    try:
        lock = selected_lock(sys.argv[2])
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    errors = validate_baselines(Path(sys.argv[1]), lock)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Verified two HF quality baselines from {lock['revision']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
