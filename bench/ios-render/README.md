# iOS physical-device rendering benchmark

This suite measures the production Swift retained-TRF1 and Metal path on a
connected physical iOS device. It is the required baseline and A/B gate for
Swift rendering optimization; it does not replace the strict latency gate or
release Instruments campaign.

Each case runs one untimed warmup and five fresh measured repetitions by
default. Operations are paced just beyond the device refresh interval so
drawable backpressure is consistent. The report retains numeric stage totals
and percentiles, renderer upload/allocation counters, process footprint,
thermal state, operation and TRF1 byte invariants, and a final offscreen pixel
hash. Terminal content and device identifiers are never exported.

Run the full suite with one connected, paired, unlocked device:

```sh
npm run bench:ios-render -- --output=bench/ios-render/results-baseline.json
```

Useful development options:

```sh
# Quick pipeline smoke test.
npm run bench:ios-render -- --iterations=1 --warmup=0 --scale=0.05 \
  --cases=typing-1,truecolor-1,scroll-4

# Reuse an already built signed Release app.
npm run bench:ios-render -- --no-build
```

The renderer also exposes a forced-reference control for causal, same-binary
A/B checks. Build and run the reference first, then launch a fresh process from
the same installed binary with reuse enabled:

```sh
npm run bench:ios-render -- \
  --output=bench/ios-render/results-geometry-off.json \
  --geometry-reuse=off

npm run bench:ios-render -- \
  --output=bench/ios-render/results-geometry-on.json \
  --geometry-reuse=on --no-build

npm run bench:ios-render:compare -- \
  bench/ios-render/results-geometry-off.json \
  bench/ios-render/results-geometry-on.json \
  --allow-geometry-reuse-difference
```

The comparator still enforces device, toolchain, workload, thermal, frame,
TRF1, renderer, and pixel invariants. The flag permits only the encoded-geometry
reuse setting to differ.

Retained-state commit also has a same-binary copy-on-write control. Both modes
perform identical complete decode and validation; only the ownership of the
final nonthrowing commit differs:

```sh
npm run bench:ios-render -- \
  --cases=typing-1,sparse-1,scroll-1,dense-1 \
  --retained-state-commit=copy \
  --output=bench/ios-render/results-retained-copy.json

npm run bench:ios-render -- \
  --no-build \
  --cases=typing-1,sparse-1,scroll-1,dense-1 \
  --retained-state-commit=in-place \
  --output=bench/ios-render/results-retained-in-place.json

npm run bench:ios-render:compare -- \
  bench/ios-render/results-retained-copy.json \
  bench/ios-render/results-retained-in-place.json \
  --allow-retained-state-commit-difference
```

The comparator permits only `inPlaceRetainedStateCommitEnabled` to differ;
source/TRF1 bytes and every renderer/pixel invariant remain mandatory. Reports
separately attribute TRF1 envelope decode, retained-state preparation, and
retained-state commit.

The dedicated `doom-fire-truffle-1` case measures the production shared-session
receive path from negotiated state bytes through the Swift decoder, native
logical replica, TRF1 retained apply, and Metal submission. It generates the
same deterministic 100-column fire state for both codecs. Before timing each
sample, the device decodes both representations, asserts identical logical
messages, and publishes both through independent replicas. Every incremental
TRF1 frame and the final full-refresh TRF1 frame must be byte-identical. The
normal final pixel proof remains mandatory.

Capture the JSON control and compact candidate in fresh processes from the
same signed binary:

```sh
npm run bench:ios-render -- \
  --cases=doom-fire-truffle-1 \
  --state-codec=json \
  --output=bench/ios-render/results-doom-fire-truffle-json.json

npm run bench:ios-render -- \
  --no-build \
  --cases=doom-fire-truffle-1 \
  --state-codec=compact-json-v1 \
  --output=bench/ios-render/results-doom-fire-truffle-compact.json

npm run bench:ios-render:compare -- \
  bench/ios-render/results-doom-fire-truffle-json.json \
  bench/ios-render/results-doom-fire-truffle-compact.json \
  --allow-state-codec-difference
```

The comparator permits only `truffleStateCodec` and source payload bytes to
differ. Operation count, TRF1 bytes, final pixels, accepted/rendered frames,
device, toolchain, pacing, and every other workload setting remain hard gates.
The case is intentionally opt-in rather than part of the default VT renderer
matrix.

Capture the baseline from a clean tracked worktree with Low Power Mode off and
nominal thermal state. Keep the same device, iOS/Xcode version, refresh-rate
setting, cases, scale, warmups, repetitions, and cooldown for the candidate.
Then compare:

```sh
npm run bench:ios-render:compare -- \
  bench/ios-render/results-baseline.json \
  bench/ios-render/results-candidate.json
```

The comparator rejects dirty tracked captures, unaccepted untracked files,
environment/configuration drift, failed or non-nominal samples, incomplete
repetitions, and changes to operation counts, source/TRF1 bytes, accepted and
rendered frame counts, or pixel hashes. It uses deterministic bootstrap 95%
intervals and a 3% practical threshold, matching the desktop benchmark policy.

Default cases cover unchanged repaint, cursor movement, typing, sparse updates,
scrolling, dense screen replacement, truecolor style churn, complex Unicode,
the shared seeded DOOM Fire simulation, four/eight visible surfaces, and
fractional UIKit resize jitter. `doom-fire-1` uses the desktop seed
`0x0d00f1ee` and exact simulation/encoding algorithm, adapted to the iOS
benchmark's 100x30 grid.
