#!/usr/bin/env bash
set -euo pipefail

# Leave time for a second APT attempt within the 15-minute Actions step.
# Successful package downloads can be reused by APT on the same runner.
for attempt in 1 2; do
  if timeout --kill-after=15s 390s python -m playwright install-deps "$@"; then
    exit 0
  else
    status=$?
  fi
  if [[ $attempt == 1 ]]; then
    printf '::warning::Playwright system dependency installation exited %s; retrying once.\n' "$status"
    sleep 5
  fi
done
exit "$status"
