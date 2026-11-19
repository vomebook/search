#!/usr/bin/env bash
set -euo pipefail

# Bound idle acquisition inside APT, including the sudo child spawned by Playwright.
# Do not time out the unprivileged parent: the privileged apt-get can outlive it
# and retain the dpkg lock. The Actions step still has an overall deadline.
conf=/etc/apt/apt.conf.d/zzzz-reader-ci-acquire
sudo tee "$conf" >/dev/null <<'APT'
Acquire::http::Timeout "10";
Acquire::https::Timeout "10";
Acquire::Retries "1";
APT
trap 'sudo rm -f -- "$conf"' EXIT

# Retry only after Playwright returns the result of its APT commands.
for attempt in 1 2; do
  if python -m playwright install-deps "$@"; then
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
