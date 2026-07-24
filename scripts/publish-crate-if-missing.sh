#!/usr/bin/env bash
set -euo pipefail

crate="${1:?crate name is required}"
version="$(node -p "require('./package.json').version")"
registry_url="https://crates.io/api/v1/crates/${crate}/${version}"
registry_user_agent="ghosttea-release/${version} (https://github.com/jamesyong-42/ghosttea)"

wait_until_resolvable() {
  for _ in {1..60}; do
    if curl --fail --silent --show-error --user-agent "$registry_user_agent" "$registry_url" >/dev/null 2>&1 &&
      cargo info --registry crates-io "${crate}@${version}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if curl --fail --silent --show-error --user-agent "$registry_user_agent" "$registry_url" >/dev/null 2>&1; then
  if wait_until_resolvable; then
    echo "${crate}@${version} is already published and resolvable; skipping"
    exit 0
  fi
  echo "timed out waiting for ${crate}@${version} to become resolvable" >&2
  exit 1
fi

cargo publish --locked --package "$crate"

if wait_until_resolvable; then
  echo "verified ${crate}@${version} on crates.io and through Cargo"
  exit 0
fi

echo "timed out waiting for ${crate}@${version} to become resolvable" >&2
exit 1
