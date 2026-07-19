# iOS performance and energy qualification

**Status:** automated 120 Hz device gate passed; full Instruments matrix open

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
| `textEngineLockWait`           | native shaping requests the shared engine   | its mutex is acquired                     |
| `textEngineLockHold`           | the shared engine mutex is acquired         | coarse row shaping releases it            |
| `frameDecode`                  | a TRF1 frame enters retained-state apply    | retained CPU presentation state is ready  |
| `metalSubmission`              | the view begins mesh/atlas/command encoding | the Metal command buffer is committed     |

`inputToTransportWrite` is deliberately conservative: it includes ordered
writer completion, not merely function entry. `receivedBytesToFrameDelivery`
ends at the awaited view callback. The release output-latency measurement uses
the Instruments timeline from that interval's start through the corresponding
`metalSubmission` end, so frame coalescing remains visible rather than being
hidden by a synthetic in-process timer.

## Qualification protocol

The deterministic physical-device latency subset is automated with:

```sh
npm run test:ios:performance
```

The runner builds the harness in Release configuration, signs and installs it
on the selected unlocked iPhone, and runs 1,000 ordered in-memory transport
writes plus 1,000 production core/TRF1/attached-Metal updates. It also attempts
120 draws after suspending the surface. The same run creates four and then eight
terminals over one shared native runtime and concurrently feeds 256 updates per
terminal. The app returns a redacted base64 JSON marker over `devicectl`; the
host validates it and writes
`native/build/ios-performance-device/evidence.json`. A missing marker, dropped
sample, percentile failure, missing native boundary, transport mismatch, or
background Metal submission fails the command. No SSH fixture or credential is
used by this gate.

The shared-engine scenarios require every terminal to complete every feed and
every feed to produce one native-feed and text-engine wait/hold sample. They
reject a text-engine lock-wait p99 at or above 8 ms, any per-terminal feed p99
at or above 16 ms, or a slowest-to-fastest p99 ratio above 4x. Per-terminal
completion ratios remain evidence but are not scored because Swift's cooperative
executor can schedule more terminal tasks than available device cores in waves.
These are deterministic starvation and lock-convoy guards. The per-terminal
summaries and native aggregate samples remain in the evidence so the first
device run can still drive the architectural sharding/pooling review.

The local Metal loop disables `MTKView`'s event-driven callback and performs
exactly one explicit draw per update. Each iteration is paced just beyond one
device refresh interval before the scored interval begins, preventing drawable
backpressure from turning a command-submission measurement into an accidental
present/vblank benchmark. The evidence records that numeric pacing interval.

This automated workload establishes repeatable local-pipeline latency,
background-submission, and shared-engine fairness evidence. It does not replace
the longer interactive output, rendered multi-session, Time Profiler, or Energy
Log trace below.

The first corrected Release run passed on an iPhone 14 Pro (`iPhone15,2`) with
iOS 26.5.2, 120 Hz, nominal thermal state, and Low Power Mode disabled. Input to
ordered write measured 0.0018/0.0048 ms p50/p99; received bytes through Metal
submission measured 1.91/2.28 ms. All scored metrics retained their exact sample
counts with zero drops, the 120 suspended draws produced zero submissions, and
both shared-engine scenarios passed. The redacted JSON evidence SHA-256 is
`163b312644886f0a4678d06969a409252256eb270fe87dbeff96edfaac5eab9b`.

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

The passing automated 120 Hz run establishes the local-pipeline baseline. Full
performance/energy release qualification remains open until the 60 Hz run and
the longer Instruments CPU, Energy, and rendered multi-session evidence pass.
Simulator and macOS results are regression aids, not substitutes for device
energy or display-timing evidence.

## Evidence retention

Retain the `.trace` files and a redacted JSON summary beside archive provenance.
The summary must include the qualification metadata above, the
`GhostteaPerformanceSnapshot`, end-to-end latency percentiles derived from the
trace, background submission count, main-thread violations, CPU time, Energy
Impact, and a pass/fail reason for every gate. Hash every evidence file. Never
attach terminal output or network payloads.

Each serialized terminal and logical replica now exposes its latest completed
native text-engine acquisition through a dedicated C ABI snapshot. Swift reads
that snapshot only while profiling is enabled and records one wait/hold sample
per new sequence; normal production execution makes no additional FFI call.
The automated four/eight-session feed gate now establishes a fail-closed first
fairness bound. The rendered four/eight-session Instruments trace must still
confirm that finding under real display work and decide whether the shared
engine requires sharding or pooling.
