#!/usr/bin/env bash
set -euo pipefail

package="${1:?npm package name is required}"
version="$(node -p "require('./package.json').version")"

if npm view "${package}@${version}" version >/dev/null 2>&1; then
  echo "${package}@${version} is already published; skipping"
  exit 0
fi

npm publish --workspace "$package" --access public
npm view "${package}@${version}" version
