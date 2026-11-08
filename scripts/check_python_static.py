"""Check all repository-owned Python sources, not generated/vendor files."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys


root = Path(__file__).resolve().parent.parent
paths = [path.name for path in (root / "app.py", root / "backend", root / "scripts", root / "tests")
         if path.exists()]
if not paths or not (root / "scripts").is_dir() or not (root / "tests").is_dir():
    raise SystemExit("Static-check source inventory is incomplete")
print("Python static check:", ", ".join(paths), flush=True)
subprocess.run([sys.executable, "-m", "ruff", "check", *paths], cwd=root, check=True)
