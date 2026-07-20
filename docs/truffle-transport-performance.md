# Truffle transport performance baseline

This is the starting point for Ghosttea's Truffle replicated-session
optimization work. The raw machine-specific report is
`bench/truffle/results-baseline.json` (intentionally ignored); the reproducible
workflow and metric definitions live in
[`bench/truffle/README.md`](../bench/truffle/README.md).

## Scope

The deterministic suite measures:

```text
logical snapshot/patch -> production JSON protocol frame
  -> bounded stream -> buffered decode -> RemoteReplica -> TRF1
```

The default `quic-protocol-loopback` mode uses the exact message encoding from
the desktop Truffle QUIC path, but replaces the nondeterministic network with a
64 KiB in-process stream. `compact-loopback` separately covers the
channel-framed Apple raw-stream protocol. Both use concurrent tasks for
multiple replicated views and a shared `TextEngine` on the receiving side.

The suite intentionally excludes session parsing and logical diff generation
before serialization, actual Tailscale/QUIC networking, and Electron/WebGPU
rendering after TRF1 publication. Its latency is burst queueing time, not
tailnet RTT. The existing ignored two-node Truffle test remains the live
connectivity qualification; it is not yet a performance benchmark.

## Initial clean baseline

Captured 2026-07-20 on an Apple M1 Max, macOS arm64 25.5.0, Rust 1.95.0, at
commit `3dd4e0193d535404eafbf6c6bacbd30d75599bd0`. Each case used one warmup,
five measured repetitions, and a 250 ms unmeasured cooldown. Values below are
medians; time is milliseconds.

| Case                  |    Wall | Encode | Decode | Replica apply | Queue p99 |
| --------------------- | ------: | -----: | -----: | ------------: | --------: |
| `sparse-decode-1`     |   77.33 |  15.99 |  74.66 |          0.96 |      0.41 |
| `sparse-replica-1`    |   76.04 |   0.16 |   1.03 |         74.92 |     35.69 |
| `dense-decode-1`      |   78.38 |  16.11 |  77.08 |          1.18 |      0.55 |
| `dense-replica-1`     |  818.07 |   1.14 |   5.96 |        811.70 |    106.63 |
| `truecolor-decode-1`  |  207.59 |  25.39 | 206.16 |          1.38 |     13.91 |
| `truecolor-replica-1` |  308.67 |  25.51 | 206.41 |        102.34 |     20.56 |
| `resync-replica-1`    |  423.61 |   0.56 |   2.75 |        420.79 |    110.33 |
| `dense-replica-4`     | 1647.06 |   2.34 |  12.64 |       6492.38 |    427.71 |

Encode, decode, and apply are accumulated task durations and can overlap. The
four-view apply value includes time waiting on the shared text-engine mutex,
so it can exceed wall time. Process user CPU for that case was 1646.25 ms,
confirming that wall time—not the accumulated apply value—is the right
throughput headline.

The clean report passed the comparison validator against itself: configuration
matched, Git was clean apart from the explicitly accepted pnpm files, and all
wire bytes, TRF1 bytes, message counts, and revision checksums were stable.

## What the baseline says

1. Plain sparse transport is not the dominant cost. Applying 180 sparse
   updates takes about 75 ms total, while protocol decode is about 1 ms.
2. Dense plain-text replication is apply-bound. Sixty dense updates spend
   roughly 812 ms in `RemoteReplica`, versus 6 ms decoding.
3. Truecolor is transport-representation-bound. Thirty updates produce 32.3 MB
   of source wire data and spend about 206 ms decoding; replica application
   adds about 102 ms. The owned per-cell JSON representation is the first
   transport target to profile.
4. Full resynchronization is also apply-bound. Thirty snapshots spend about
   421 ms in replica application, so snapshot application and full-row shaping
   need attribution before changing transport framing.
5. Four simultaneous replicated views consume about 1.65 seconds of process
   user CPU and build a 428 ms queue tail. Shared text-engine lock wait and
   repeated shaping should be measured explicitly before attempting
   concurrency changes.

## Optimization order

1. Add allocation/byte attribution around truecolor JSON encode/decode and
   test a representation change behind the existing correctness invariants.
2. Attribute `RemoteReplica` time between state mutation, shaping/text-engine
   lock wait, and TRF1 encoding for dense patches and resync snapshots.
3. Use the four-view case to distinguish useful shared caches from mutex
   serialization; keep single-view latency as a guardrail.
4. Add a live two-node QUIC timing tier only after it records path type and
   network conditions. Never compare it numerically with loopback reports.

Every candidate should be one committed change followed by the same full
matrix and `npm run bench:truffle:compare`. A result remains inconclusive when
the bootstrap interval crosses zero or the change is below the practical 3%
threshold.

## Retained optimization: clone-free replica patch state

The first retained replica change removes two full logical-grid clones from
the receive path. `LogicalReplicaModel::latest` now lends its snapshot when the
desktop wrapper refreshes dimensions and metadata. Patch application validates
every replacement before mutation, swaps owned replacement rows directly into
the current snapshot, and keeps the displaced rows until rendering succeeds.
If rendering fails, the swaps and scalar state are reversed before returning
the error. Wire encoding, TRF1 output, message counts, and revision checksums
are unchanged.

A seven-repetition targeted comparison reduced median truecolor replica apply
time from 105.64 ms to 98.74 ms (-6.5%, bootstrap 95% interval -7.9% to
-2.5%). Enqueue-to-apply p50 improved 3.8%. Dense replica apply moved from
816.64 ms to 806.82 ms (-1.2%, below the practical threshold), while its p99
improved from 109.31 ms to 104.88 ms (-4.1%, supported).

Because separate historical runs showed broad machine drift in decode-only
controls, the truecolor target was also tested with pre-change and candidate
release binaries back-to-back in both orders. Two 15-sample pairs measured
100.99 ms versus 95.81 ms (-5.1%) and 100.51 ms versus 95.92 ms (-4.6%); all
30 candidate apply samples were below all 30 baseline samples. End-to-end wall
time improved only 1.4-2.2%, below the 3% practical threshold because JSON
decode remains the larger cost.

The historical resync baseline and one fresh baseline disagreed materially, so
no resync improvement is claimed. Peak RSS also varied between fresh benchmark
processes and moved adversely in one targeted comparison despite eliminating
allocations; it remains a coarse lifetime high-water mark, not evidence of a
memory regression or win. Workspace tests, Truffle harness tests, and Clippy
passed after the change, including a regression test that proves an invalid
late row replacement cannot partially mutate replica state.
