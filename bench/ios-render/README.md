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
four/eight visible surfaces, and fractional UIKit resize jitter.
