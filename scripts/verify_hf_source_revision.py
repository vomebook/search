"""Admit only the locked full HF commit before checkout or source execution.

Run from the trusted Pages checkout, before installing HF dependencies. This
stdlib-only gate is separate from ancestry selection and quality baseline hashes.
Updating the lock requires review of the complete committed HF candidate; a dirty
working tree or a descendant of the baseline is not an approved source revision.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

LOCK = Path(__file__).resolve().parents[1] / ".github/hf-source-revision.json"


def verify(revision: str, lock: object) -> None:
    if not isinstance(lock, dict) or lock.get("repository") != "VoiceOfML/Search":
        raise ValueError("incorrect Hugging Face source repository")
    approved = lock.get("revision")
    if not isinstance(approved, str) or not re.fullmatch(r"[0-9a-f]{40}", approved):
        raise ValueError("source lock revision must be a full commit SHA")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("captured revision must be a full commit SHA")
    if revision != approved:
        raise ValueError(
            f"captured HF revision {revision} is not approved; locked revision is {approved}. "
            "Review the complete committed HF candidate and explicitly update the source lock before deployment."
        )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python3 -I -B scripts/verify_hf_source_revision.py CAPTURED_REVISION", file=sys.stderr)
        return 2
    try:
        verify(sys.argv[1], json.loads(LOCK.read_text(encoding="utf-8")))
    except (ValueError, OSError) as exc:
        print(f"HF source admission failed: {exc}", file=sys.stderr)
        return 1
    print(f"Approved exact HF source revision {sys.argv[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
