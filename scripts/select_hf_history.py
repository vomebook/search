"""Select exactly one independently pinned baseline from the captured Git history."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys

HISTORIES = {
    "c7424ac3e549c9edf59f302e3809268c12bfe114": "626785f1e3d9e05d2e8f3d9aec3d6ec16dc25f0b",
    "66d92cb401f52e9dfe78ca6026e682c7097b730b": "d6c3bea07d0005143f0a411a036b360a584bf315",
}


def select(repo: Path, revision: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("captured revision must be a full commit SHA")
    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1")
    # Do not let ambient Git environment redirect repository/object lookup.
    for key in list(env):
        if key.startswith("GIT_") and key not in {"GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH"}:
            del env[key]

    def git(*args: str) -> str:
        result = subprocess.run(["git", "-C", str(repo), *args], env=env,
                                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return result.stdout.strip()

    if git("rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("shallow history cannot establish ancestry")
    grafts = Path(git("rev-parse", "--path-format=absolute", "--git-path", "info/grafts"))
    if grafts.exists() and grafts.stat().st_size:
        raise ValueError("grafted history is not accepted")
    if git("rev-parse", "--verify", "HEAD^{commit}") != revision:
        raise ValueError("HEAD differs from captured revision")
    # Traversing the entire captured commit graph distinguishes an absent anchor
    # from an incomplete graph: rev-list fails if a reachable parent is missing.
    reachable = set(git("rev-list", revision).splitlines())
    matches = [(anchor, baseline) for anchor, baseline in HISTORIES.items() if anchor in reachable]
    if len(matches) != 1:
        raise ValueError("captured revision does not identify exactly one history")
    baseline = matches[0][1]
    if baseline not in reachable:
        raise ValueError("selected baseline is not in captured history")
    anchor = matches[0][0]
    git("merge-base", "--is-ancestor", baseline, anchor)
    return baseline


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: select_hf_history.py REPOSITORY CAPTURED_REVISION", file=sys.stderr)
        return 2
    try:
        print(select(Path(sys.argv[1]), sys.argv[2]))
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"history selection failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
