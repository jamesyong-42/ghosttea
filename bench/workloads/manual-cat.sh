#!/usr/bin/env bash
# Manual workload for native Ghostty (or any terminal app).
#
# Usage:
#   time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh scrolling
#   time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh dense
#   time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh unicode
#   time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh scroll-region
#
# Run inside Ghostty, Terminal.app, Kitty, etc. Compare wall clock and whether
# typing / Ctrl+C stayed responsive during the dump.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIND="${1:-scrolling}"
SCALE="${BENCH_SCALE:-1}"
OUT_DIR="${TMPDIR:-/tmp}/electron-ghostty-manual-bench-$$"
mkdir -p "$OUT_DIR"
PAYLOAD="$OUT_DIR/payload.bin"

cd "$ROOT"
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
import { payloadCatalog } from './bench/lib/payloads.mjs';
const catalog = payloadCatalog(Number(process.env.BENCH_SCALE || '${SCALE}'));
const map = {
  dense: catalog.dense,
  scrolling: catalog.scrolling,
  unicode: catalog.unicode,
  'scroll-region': catalog.scrollRegion,
};
const payload = map['${KIND}'];
if (!payload) {
  console.error('unknown kind: ${KIND}');
  process.exit(2);
}
writeFileSync(process.argv[1], payload);
console.error('payload bytes:', payload.byteLength, 'kind:', '${KIND}');
" "$PAYLOAD"

echo "BENCH_START $(date +%s%3N)"
cat "$PAYLOAD"
echo "BENCH_END $(date +%s%3N)"
rm -rf "$OUT_DIR"
