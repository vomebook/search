"""Pass hash-verified snapshots to HF gates using sealed Linux memfds.

This prevents changes to the baseline bytes after verification. It is not a
sandbox: the HF gate code, runner, Python environment and lock remain trusted.
"""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import subprocess
import sys

if __package__:
    from .select_hf_history import select
    from .verify_hf_quality_baseline import read_verified_baselines, selected_lock
else:
    from select_hf_history import select
    from verify_hf_quality_baseline import read_verified_baselines, selected_lock

STRICT = "strict-inventory-debt.json"
COVERAGE = "backend-coverage-debt.json"
SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL


def sealed_snapshot(name: str, data: bytes) -> int:
    fd = os.memfd_create(name, os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        remaining = memoryview(data)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("unable to write snapshot")
            remaining = remaining[written:]
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, SEALS)
        if fcntl.fcntl(fd, fcntl.F_GET_SEALS) & SEALS != SEALS:
            raise OSError("incomplete baseline seals")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def run(repo: Path, directory: Path, revision: str, report: Path) -> None:
    baseline = select(repo, revision)
    snapshots, errors = read_verified_baselines(directory, selected_lock(baseline))
    if errors:
        raise ValueError("\n".join(errors))
    strict_fd = sealed_snapshot(STRICT, snapshots[STRICT])
    try:
        coverage_fd = sealed_snapshot(COVERAGE, snapshots[COVERAGE])
        try:
            for script, arguments, fd in (
                ("scripts/check_strict_inventory.py", [], strict_fd),
                ("scripts/check_backend_coverage.py", [str(report)], coverage_fd),
            ):
                subprocess.run([sys.executable, "-B", script, *arguments, f"/proc/self/fd/{fd}"],
                               cwd=repo, pass_fds=(fd,), check=True)
        finally:
            os.close(coverage_fd)
    finally:
        os.close(strict_fd)


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: run_hf_quality_with_verified_baseline.py REPO DIRECTORY CAPTURED_REVISION COVERAGE_REPORT", file=sys.stderr)
        return 2
    try:
        run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]).resolve())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"verified HF quality gates failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
