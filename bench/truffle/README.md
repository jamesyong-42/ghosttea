# Truffle replicated-session benchmark

This suite measures the state path used by a replicated terminal session:

```text
logical snapshot/patch -> production protocol frame -> bounded stream
  -> production-like buffered decode -> RemoteReplica -> TRF1 frame
```

It is deliberately separate from the Electron render benchmark. `decode` cases
isolate protocol framing, stream copies, and decoding. `replica` cases continue
through logical-state application, text shaping, and TRF1 publication. Fanout
cases use concurrent publisher/receiver tasks per replicated view and the same
shared `TextEngine` contention as a daemon displaying several remote views.

The default `quic-protocol-loopback` transport uses the same length prefix and
negotiated `compact-json-v1` state encoding as desktop-to-desktop Truffle QUIC
sessions. Pass `--state-codec=json` for the legacy desktop encoding. The
optional `compact-loopback` transport uses the channel-byte framing and legacy
JSON state contract from the Apple raw-stream path; it therefore requires
`--state-codec=json`. Both run over an in-process bounded duplex stream. They
are stable microbenchmarks for code changes in the Truffle adapter, but they do
**not** include Tailscale discovery, encryption, congestion control, packet
loss, or an actual QUIC socket. Do not describe their latency or throughput as
tailnet performance. The optional live Truffle qualification is documented
below and must be reported separately.

## Baseline workflow

Use a release build on an otherwise idle, AC-powered machine:

```sh
npm run bench:truffle -- \
  --allow-untracked=pnpm-lock.yaml,pnpm-workspace.yaml \
  --output=bench/truffle/results-baseline.json

# Make and commit one optimization, then repeat with identical arguments.
npm run bench:truffle -- \
  --allow-untracked=pnpm-lock.yaml,pnpm-workspace.yaml \
  --output=bench/truffle/results-candidate.json

npm run bench:truffle:compare -- \
  bench/truffle/results-baseline.json \
  bench/truffle/results-candidate.json
```

The runner rejects tracked modifications and unacknowledged untracked files.
`--allow-dirty` exists only for harness smoke testing; comparison rejects such
reports. Raw `results*.json` files are ignored because they are machine- and
revision-specific. The default 250 ms unmeasured cooldown between repetitions
reduces heat and scheduler carry-over; keep it identical across comparisons.

To compare the negotiated desktop state codecs on one committed binary, run
the same cases once with each codec. Codec identity is recorded but
intentionally excluded from the comparison configuration gate:

```sh
npm run bench:truffle -- \
  --allow-untracked=pnpm-lock.yaml,pnpm-workspace.yaml \
  --state-codec=json \
  --output=bench/truffle/results-codec-json.json

npm run bench:truffle -- \
  --no-build \
  --allow-untracked=pnpm-lock.yaml,pnpm-workspace.yaml \
  --state-codec=compact-json-v1 \
  --output=bench/truffle/results-codec-compact.json
```

Run the compact Apple route as a separate baseline; never compare it directly
with the default QUIC-protocol report:

```sh
npm run bench:truffle -- \
  --transport=compact-loopback \
  --output=bench/truffle/results-compact.json
```

## Workloads

| Case                  | Pressure                                                           |
| --------------------- | ------------------------------------------------------------------ |
| `sparse-decode-1`     | Many one-row patches; codec/allocation overhead                    |
| `sparse-replica-1`    | Interactive one-row updates through `RemoteReplica`                |
| `dense-decode-1`      | Full-screen row patches without shaping                            |
| `dense-replica-1`     | Full-screen plain-text shaping and TRF1 publication                |
| `truecolor-decode-1`  | Per-cell truecolor serialization and decode                        |
| `truecolor-replica-1` | Per-cell styles and half-block glyphs, like the DOOM-fire workload |
| `resync-replica-1`    | Repeated full snapshots after lag/baseline loss                    |
| `dense-replica-4`     | Four receivers contending for the shared text engine               |

Every case begins with a full snapshot. The remaining messages are patches,
except `resync`, which intentionally sends only snapshots. Workloads are
deterministic and report source wire bytes, TRF1 bytes, message counts, and a
revision checksum. Source wire size is a lower-is-better performance metric so
representation experiments can change it. The comparison gate still rejects
changes to TRF1 bytes, received message counts, and revision checksums.

Useful development subsets:

```sh
npm run bench:truffle -- \
  --allow-dirty \
  --cases=sparse-decode-1,sparse-replica-1 \
  --iterations=2 --warmup=0 --scale=0.1
```

## Interpreting the report

- `wallMs` is end-to-end time to deliver and apply the complete burst.
- producer encode and write time separate serialization from backpressure.
- receiver decode and replica apply are accumulated task durations. With
  fanout, apply includes time waiting for the shared text-engine mutex and can
  exceed wall time; process user/system CPU are the actual CPU counters.
- text-engine wait and hold split shared-lock contention from shaping work;
  row preparation and TRF1 encode split the largest parts of the remaining
  work. Replica non-engine time is the full remainder of apply after engine
  wait and hold, so it includes both attributed values.
- enqueue-to-apply latency includes time waiting behind earlier messages in
  the burst; p95/p99 reveal queue buildup rather than interactive RTT.
- wire throughput is aggregate bytes per wall second across receivers;
  reducing frame size can lower this value in an apply-bound case even when
  the codec improves. `sourceWireBytes` is the lower-is-better size for one
  peer.
- user/system CPU come from `getrusage`; peak RSS is the process lifetime high
  water mark, so use it as a coarse regression signal.

An optimization is credible only when repeated medians improve, the bootstrap
95% interval excludes zero, the practical threshold is exceeded, and the
correctness invariants remain identical. Check wall time, latency, CPU, and
memory together; moving work from decode to apply is not a win.

## Live Truffle qualification

### Visible end-to-end rendering benchmark

The visible tier launches two real Electron applications side by side. The
`HOST` window owns a real PTY and renders its local session; the `VIEWER`
window discovers that session over Truffle, attaches a writable remote view,
and renders the replicated frames through the production WebGPU surface. The
labels at the top-left of each window show discovery, warmup, and measurement
progress. This is intentionally not a headless benchmark.

With a valid reusable/ephemeral Tailscale auth key:

```sh
TRUFFLE_TEST_AUTHKEY=... \
TRUFFLE_SIDECAR_PATH=/absolute/path/to/truffle-sidecar \
npm run bench:truffle:visible -- \
  --output=bench/truffle/results-visible-baseline.json
```

Alternatively, seed the two temporary nodes from distinct authenticated
Ghosttea profiles. The runner recursively copies both directories into its
temporary workspace and never launches a daemon against the source profiles:

```sh
npm run bench:truffle:visible -- \
  --host-state-dir="$HOME/Library/Application Support/Ghosttea/profiles/alpha/truffle" \
  --viewer-state-dir="$HOME/Library/Application Support/Ghosttea/profiles/beta/truffle" \
  --output=bench/truffle/results-visible-baseline.json
```

Do not use the same profile for both arguments: each side needs a distinct
tailnet device identity. The default suite runs sparse, dense, and deterministic
DOOM-fire streams with one warmup and three measured repetitions. A quick
development smoke run is:

```sh
npm run bench:truffle:visible -- \
  --allow-dirty \
  --cases=sparse-remote-1 \
  --iterations=1 --warmup=0 --scale=0.25 \
  --output=/tmp/ghosttea-visible-smoke.json
```

The report records host producer duration/backpressure, viewer end-to-idle
time, replicated frame counts, worker apply/render CPU, arrival-to-render
latency, WebGPU backend selection, and Electron process CPU/memory samples.
`--verify-pixels` additionally checks the partial result against a forced full
redraw. A sibling `.log` captures prefixed host/viewer diagnostics. Compare
clean reports with the rendering comparison gate:

```sh
npm run bench:render:compare -- \
  bench/truffle/results-visible-baseline.json \
  bench/truffle/results-visible-candidate.json
```

This tier exercises actual discovery, QUIC, remote replica application, and
WebGPU rendering. It is sensitive to tailnet path and machine conditions, so
record those conditions and compare repeated runs on the same setup.

### Connectivity-only qualification

The existing ignored integration test verifies that two ephemeral Truffle
nodes can discover one another and carry a QUIC stream over the configured
Tailscale control plane:

```sh
TRUFFLE_TEST_AUTHKEY=... \
TRUFFLE_SIDECAR_PATH=/absolute/path/to/truffle-sidecar \
cargo test -p ghosttea-truffle latest_truffle_quic_round_trip -- --ignored --nocapture
```

That test is currently a connectivity qualification, not a statistically
useful benchmark. Keep its result separate from all loopback numbers. A
live QUIC timing tier should reuse the exact workload/report schema but record
path type and network conditions before it is used for optimization claims.

## Harness checks

```sh
npm run test:bench:truffle
cargo clippy -p ghosttea-truffle --bin replication_bench -- -D warnings
```
