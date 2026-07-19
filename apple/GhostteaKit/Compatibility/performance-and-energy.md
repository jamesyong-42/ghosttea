# iOS performance and energy qualification

**Status:** instrumentation implemented; physical-device release evidence open

The production pipeline exposes opt-in, coarse-grained Instruments intervals
through `GhostteaPerformance`. Recording is disabled by default and can be
enabled for a qualification launch with:

```text
GHOSTTEA_PERFORMANCE_RECORDING=1
```

The recorder retains at most 2,048 samples per metric in a constant-time ring.
Its public snapshot contains only metric enums, durations, byte counts, sample
counts, and drop counts. It cannot accept terminal text, commands, hostnames,
usernames, profile identifiers, or error strings. No performance evidence is
persisted automatically.

## Instrumented boundaries

| Metric                         | Begins                                      | Ends                                      |
| ------------------------------ | ------------------------------------------- | ----------------------------------------- |
| `inputToTransportWrite`        | public session input operation              | ordered transport write completes         |
| `receivedBytesToFrameDelivery` | demanded transport bytes enter the session  | all ordered core effects are delivered    |
| `nativeFeed`                   | Swift enters the coarse C ABI feed call     | owned effects and frame bytes are decoded |
| `frameDecode`                  | a TRF1 frame enters retained-state apply    | retained CPU presentation state is ready  |
| `metalSubmission`              | the view begins mesh/atlas/command encoding | the Metal command buffer is committed     |

`inputToTransportWrite` is deliberately conservative: it includes ordered
writer completion, not merely function entry. `receivedBytesToFrameDelivery`
ends at the awaited view callback. The release output-latency measurement uses
the Instruments timeline from that interval's start through the corresponding
`metalSubmission` end, so frame coalescing remains visible rather than being
hidden by a synthetic in-process timer.

## Qualification protocol

Run the same release build, fixture, duration, power state, thermal state, and
display refresh mode on each comparison. Record the source revision, archive
evidence hash, iOS/Xcode versions, device model, available refresh rates,
battery/charger state, Low Power Mode, thermal state before and after, fixture
hash, and sample duration.

Capture one Instruments trace containing Points of Interest, Time Profiler,
Metal System Trace, and Energy Log while exercising:

1. idle foreground for 60 seconds;
2. unchanged background for 60 seconds;
3. 1,000 hardware/software input events against the deterministic fixture;
4. sustained received output for 120 seconds on one visible terminal;
5. the same flood with four, then eight resident sessions; and
6. foreground, resize, shared-session resync, and direct-SSH reconnect.

Use a physical 60 Hz iPhone and a physical 120 Hz iPhone or iPad. Repeat the
active-output samples three times after one untimed warm-up. Discard a run only
for a recorded external reason such as thermal-state change, fixture failure,
or connection loss; retain the rejected trace beside the reason.

## Gates

The Phase 3 initial latency targets remain:

| Gate                                             |      p50 |       p99 |
| ------------------------------------------------ | -------: | --------: |
| input event through ordered transport write      | `< 2 ms` |  `< 8 ms` |
| demanded received bytes through Metal submission | `< 8 ms` | `< 16 ms` |

Each percentile requires at least 1,000 samples and zero recorder drops. Also
require:

- zero Metal submissions during the unchanged background interval;
- no native feed, VT parsing, shaping, or glyph rasterization on the main
  thread;
- active rendering at the useful device refresh rate without a continuously
  running display link while unchanged;
- no unexplained sample gap, lock convoy, frame storm, or input starvation in
  the four/eight-session trace;
- no thermal escalation during the scored interval; and
- no more than 10% CPU-time or Energy Impact regression from the accepted
  same-device baseline unless the review records and accepts the cause.

The first fully passing physical-device run establishes the checked release
baseline; until that evidence exists, performance/energy release qualification
is open. Simulator and macOS results are regression aids, not substitutes for
device energy or display-timing evidence.

## Evidence retention

Retain the `.trace` files and a redacted JSON summary beside archive provenance.
The summary must include the qualification metadata above, the
`GhostteaPerformanceSnapshot`, end-to-end latency percentiles derived from the
trace, background submission count, main-thread violations, CPU time, Energy
Impact, and a pass/fail reason for every gate. Hash every evidence file. Never
attach terminal output or network payloads.

Text-engine lock wait/hold/fairness is still a native instrumentation gap. It
must be added before the four/eight-session contention gate can close; the
current Swift intervals make the resulting stalls visible but cannot attribute
them to the shared native mutex.
