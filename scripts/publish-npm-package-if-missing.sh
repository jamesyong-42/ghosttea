#!/usr/bin/env bash
set -euo pipefail

package="${1:?npm package name is required}"
version="$(node -p "require('./package.json').version")"

wait_until_resolvable() {
  for _ in {1..60}; do
    if npm view "${package}@${version}" version >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if npm view "${package}@${version}" version >/dev/null 2>&1; then
  echo "${package}@${version} is already published; skipping"
  exit 0
fi

publish_args=(publish --workspace "$package" --access public)
provenance="${NPM_CONFIG_PROVENANCE:-${npm_config_provenance:-}}"
if [[ "$provenance" == "false" || "$provenance" == "0" ]]; then
  publish_args+=(--provenance=false)
fi

npm "${publish_args[@]}"

if wait_until_resolvable; then
  echo "verified ${package}@${version} on npm"
  exit 0
fi

echo "timed out waiting for ${package}@${version} to become resolvable" >&2
exit 1
