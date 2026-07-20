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

## Retained optimization: reusable contiguous protocol buffers

The next receive-side change preserves the JSON and framing contract but
removes two copies per message. Previously both production readers and the
benchmark accumulated bytes in a `VecDeque`, drained each payload into a new
allocation, copied the header and payload into another allocation, and only
then called the decoder. They now retain one contiguous buffer plus an unread
offset and decode directly from that slice. An incoming QUIC allocation is
adopted when the buffer is empty; otherwise only the small unread tail is
compacted before appending another chunk. The compact Apple stream uses the
same reusable-buffer policy without changing its channel framing.

In an adjacent 15-repetition comparison, truecolor decode fell from 205.30 ms
to 169.90 ms (-17.2%, bootstrap 95% interval -17.8% to -16.3%). Wall time fell
17.1%, enqueue-to-apply p99 improved 20.7%, process user CPU fell 16.5%, and
throughput increased 20.7%. The smaller-message controls improved even more:
sparse decode fell 25.2% and dense decode 25.9%, with wall time down 24.5% and
25.5% respectively. All source wire bytes, TRF1 bytes, message counts, and
revision checksums remained identical.

Across the full matrix versus the original clean baseline, the retained clone
and buffer changes reduce truecolor replica wall time from 308.67 ms to 269.14
ms (-12.8%), decode work 16.7%, apply work 5.0%, p99 7.8%, and process user CPU
13.2%. Dense and four-view replication remain shaping/apply-bound: their decode
work improves 29.1% and 24.0%, but wall time changes by only 2.0% and 1.7%, both
below the practical threshold. Sparse replica wall time is neutral; its short
p99 remains scheduler-sensitive and is not used to claim a latency change.

The truecolor wire still carries roughly 32 MB of owned per-cell JSON and now
spends about 171 ms in read/decode work. A compact state representation remains
the next transport target, but it must be explicitly versioned and negotiated
rather than silently changing the existing desktop and Apple protocol.

## Retained optimization: negotiated compact state encoding

Desktop peers now advertise state-codec capabilities in the existing Truffle
hello and select `compact-json-v1` only when both sides support it. Missing
capability and selection fields mean legacy JSON, so older desktop peers and
the Apple compact-stream client keep their existing contract without a
protocol-version bump. The selected codec changes only live state messages;
control messages and the four-byte length framing remain unchanged.

The compact representation preserves the logical model but serializes state
variants, snapshots, patches, rows, cells, styles, cursors, and scrollbars as
short tagged tuples. Cell booleans use a validated bit field. Encoding borrows
the production state directly instead of cloning it into an intermediate DTO;
decoding produces the same owned logical snapshot or patch. Unsupported style
or extension bits fail closed. Round-trip tests cover snapshots, patches, and
control changes, while the shared Apple fixture verifies that omitted
negotiation fields retain the old wire shape.

An adjacent 15-repetition same-binary comparison isolated the codec on sparse,
dense, and truecolor decode cases. Values below are medians; deltas have
bootstrap 95% intervals wholly on the improving side of zero.

| Case                 |        Wall JSON → compact |      Decode JSON → compact |    Encode JSON → compact | Source bytes |
| -------------------- | -------------------------: | -------------------------: | -----------------------: | -----------: |
| `sparse-decode-1`    |  58.70 → 22.67 ms (-61.4%) |  56.16 → 20.19 ms (-64.1%) | 15.54 → 7.21 ms (-53.6%) |       -52.5% |
| `dense-decode-1`     |  57.45 → 16.03 ms (-72.1%) |  56.14 → 14.65 ms (-73.9%) | 16.05 → 8.92 ms (-44.4%) |       -43.9% |
| `truecolor-decode-1` | 172.33 → 31.77 ms (-81.6%) | 170.89 → 30.34 ms (-82.2%) | 24.80 → 6.56 ms (-73.5%) |       -79.0% |

The 10-repetition full matrix confirms the user-visible target:
`truecolor-replica-1` wall time falls from 269.22 to 127.43 ms (-52.7%), p99
from 18.14 to 8.66 ms (-52.3%), user CPU from 266.85 to 126.67 ms (-52.5%),
and source bytes from 32.30 MB to 6.79 MB (-79.0%). Compared with the original
clean baseline before the clone and buffer work, truecolor replica wall time is
down from 308.67 to 127.43 ms (-58.7%).

The full matrix also exposes the next bottleneck rather than hiding it. Sparse,
dense, resync, and four-view replica bursts are dominated by shaping and TRF1
publication, so their total wall time changes by only -0.7% to -1.7%. Their
enqueue-to-apply p99 rises 56-61% because smaller frames no longer backpressure
the producer as early; more already-generated updates can queue ahead of the
apply stage. This is not a codec CPU regression—their decode work falls
64-68%—but it is a real saturated-queue behavior. The next experiment should
bound or coalesce pending state at the publish/receive boundary while
preserving patch ordering and resynchronization semantics.

The benchmark now treats source wire bytes as a performance metric rather than
a correctness invariant. TRF1 bytes, received message counts, and revision
checksums remain invariant across JSON and compact runs. Rust unit tests,
benchmark tests, Clippy, and all 137 Apple package tests passed.

## Retained optimization: reuse shaping for color-only rows

The replica benchmark now attributes apply time to shared text-engine lock
wait, text-engine hold/shaping, and remaining replica work. A 10-repetition
compact-codec run showed where apply time actually goes:

| Case                  |      Apply | Engine wait | Engine hold |    Other |
| --------------------- | ---------: | ----------: | ----------: | -------: |
| `sparse-replica-1`    |   74.51 ms |     0.01 ms |    74.00 ms |  0.50 ms |
| `dense-replica-1`     |  805.02 ms |    <0.01 ms |   802.14 ms |  2.85 ms |
| `truecolor-replica-1` |   96.13 ms |    <0.01 ms |    73.28 ms | 22.79 ms |
| `resync-replica-1`    |  405.82 ms |    <0.01 ms |   404.08 ms |  1.69 ms |
| `dense-replica-4`     | 6481.24 ms |  4836.50 ms |  1638.96 ms |  6.08 ms |

Color changes do not affect glyph shaping; only row text and bold/italic span
boundaries do. The replica cache now retains those shaping inputs separately
from the full cell style. A color-only patch still converts cells and emits a
new incremental TRF1 frame, but it reuses the existing `ShapedRow` and does not
acquire the shared text engine. Full snapshots reset the cache, and text or
font-style changes still shape normally. A regression test verifies that a
foreground-only patch performs zero text-engine acquisitions.

A clean 15-repetition comparison used separate worktrees at the attribution
baseline (`d0be47b`) and final candidate (`bd3977b`). In the DOOM-fire-like
`truecolor-replica-1` case, wall time fell from 127.81 to 59.41 ms (-53.5%),
replica apply from 96.51 to 28.44 ms (-70.5%), engine hold from 73.58 to 2.36 ms
(-96.8%), p99 from 8.72 to 5.55 ms (-36.4%), and user CPU from 126.97 to
58.56 ms (-53.9%). The remaining engine time is the initial full snapshot.

The decode-only control is neutral. Dense, resync, and four-view cases—whose
text changes every update—are also neutral in end-to-end wall and user CPU.
Cache checking raises measured non-engine work from 22.92 to 26.10 ms in the
truecolor case, but the net apply and CPU gains already include that cost.
Peak RSS rose by about 0.9 MB in the truecolor process; this is a lifetime
high-water measurement and includes allocator granularity, but the retained
shape-span cache is intentionally bounded by the visible cell grid and the
increase should remain a memory guardrail.

Across all retained Truffle changes, truecolor replica wall time is now 59.41
ms versus the original 308.67 ms baseline (-80.8%), with p99 down from 20.56 to
5.55 ms (-73.0%) and user CPU down from 307.70 to 58.56 ms (-81.0%). Workspace
tests, workspace Clippy, and the benchmark harness tests pass.
