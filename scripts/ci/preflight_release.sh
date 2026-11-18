#!/usr/bin/env bash
# Non-publishing release preflight: Pages source job + full Space image.
# Use pinned Node/Python/dependencies from the Pages workflow. Pass only clean,
# committed repositories to ensure the Space image sees exactly the candidate.
set -euo pipefail
if [[ $# != 1 ]]; then
  printf 'Usage: bash scripts/ci/preflight_release.sh /path/to/hf-search\n' >&2
  exit 2
fi
pages=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
space=$(cd -- "$1" && pwd)
for command in docker git git-lfs bash python3 tar; do
  command -v "$command" >/dev/null || { printf 'Required tool missing: %s\n' "$command" >&2; exit 2; }
done
for root in "$pages" "$space"; do
  if [[ $(git -C "$root" rev-parse --show-toplevel) != "$root" || -n $(git -C "$root" status --porcelain --untracked-files=all) ]]; then
    printf 'Expected a clean committed checkout: %s\n' "$root" >&2
    exit 2
  fi
done
pages_sha=$(git -C "$pages" rev-parse HEAD)
space_sha=$(git -C "$space" rev-parse HEAD)
if [[ ! -f "$space/Dockerfile" || ! -f "$space/backend/app.py" || "$space" == "$pages" ]]; then
  printf 'Invalid HF Space checkout: %s\n' "$space" >&2
  exit 2
fi
args=()
if [[ -n ${SEARCH_DATA_GENERATION:-} ]]; then
  [[ $SEARCH_DATA_GENERATION =~ ^[0-9a-f]{64}$ ]] || { printf 'Invalid SEARCH_DATA_GENERATION\n' >&2; exit 2; }
  args+=(--build-arg "SEARCH_DATA_GENERATION=$SEARCH_DATA_GENERATION")
fi
python3 -I -B "$pages/scripts/verify_hf_source_revision.py" "$space_sha"
docker info >/dev/null
printf 'Checking Pages source %s and full Space image %s (no publishing)\n' "$pages_sha" "$space_sha"
bash "$pages/scripts/ci/check_pages_source.sh"
# Materialize LFS content in an isolated checkout; a bare git archive would
# hand Docker the pointer files, not the production decoder binaries.
context=$(mktemp -d "${TMPDIR:-/tmp}/space-release-context.XXXXXXXX")
trap 'rm -rf -- "$context"' EXIT
GIT_LFS_SKIP_SMUDGE=1 git clone --no-local --no-checkout -- "$space" "$context/repo"
GIT_LFS_SKIP_SMUDGE=1 git -C "$context/repo" checkout --detach "$space_sha"
# Reuse checked-out LFS objects, never send Git metadata or ignored files to
# Docker. Missing LFS objects are a hard error, not a partial build.
lfs_storage=$(git -C "$space" config --path --get lfs.storage || git -C "$space" rev-parse --path-format=absolute --git-path lfs)
if [[ $lfs_storage != /* ]]; then
  lfs_storage="$(git -C "$space" rev-parse --absolute-git-dir)/$lfs_storage"
fi
git -C "$context/repo" -c "lfs.storage=$lfs_storage" lfs checkout
git -C "$context/repo" lfs fsck --pointers
git -C "$context/repo" lfs ls-files --json | python3 -I -B -c '
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
for item in json.load(sys.stdin)["files"]:
    path = root / item["name"]
    with path.open("rb") as stream:
        valid = path.stat().st_size == item["size"] and hashlib.file_digest(stream, "sha256").hexdigest() == item["oid"]
    if not valid:
        sys.exit(f"LFS content missing or invalid: {path.relative_to(root)}; materialize LFS in the input Space checkout")
' "$context/repo"
mkdir "$context/build"
git -C "$context/repo" ls-files -z | tar -C "$context/repo" --null -T - -cf - | tar -C "$context/build" -xf -
docker build --progress=plain "${args[@]}" "$context/build"
if [[ $(git -C "$pages" rev-parse HEAD) != "$pages_sha" || -n $(git -C "$pages" status --porcelain --untracked-files=all) ]]; then
  printf 'Pages candidate changed during check\n' >&2
  exit 1
fi
printf 'PASS Pages source gates: %s\nPASS full Space image build: %s\n' "$pages_sha" "$space_sha"
printf 'Not covered here: Pages artifact/data build, browser matrix and deployment readback.\n'
