# Truffle replicated-session benchmark

This suite measures the state path used by a replicated terminal session:

```text
logical snapshot/patch -> production protocol frame -> bounded stream
  -> production-like buffered decode -> RemoteReplica -> TRF1 frame
```

It is deliberately separate from the Electron render benchmark. `decode` cases
isolate protocol framing, stream copies, and decoding. `replica` cases continue
through logical-state application, text shaping, and TRF1 publication. Fanout
cases use one receiver per peer and the same shared `TextEngine` contention as
the daemon.

The default `quic-protocol-loopback` transport uses the same length-prefixed
JSON encoding as desktop-to-desktop Truffle QUIC sessions. The optional
`compact-loopback` transport adds the channel-byte framing from the Apple
raw-stream path. Both run over an in-process bounded duplex stream. They are
stable microbenchmarks for code changes in the Truffle adapter, but they do **not**
include Tailscale discovery, encryption, congestion control, packet loss, or an
actual QUIC socket. Do not describe its latency or throughput as tailnet
performance. The optional live Truffle qualification is documented below and
must be reported separately.

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
revision-specific.

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
revision checksum. The comparison gate rejects candidates that change those
invariants.

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
- enqueue-to-apply latency includes time waiting behind earlier messages in
  the burst; p95/p99 reveal queue buildup rather than interactive RTT.
- wire throughput is aggregate across receivers. `sourceWireBytes` is one peer.
- user/system CPU come from `getrusage`; peak RSS is the process lifetime high
  water mark, so use it as a coarse regression signal.

An optimization is credible only when repeated medians improve, the bootstrap
95% interval excludes zero, the practical threshold is exceeded, and the
correctness invariants remain identical. Check wall time, latency, CPU, and
memory together; moving work from decode to apply is not a win.

## Live Truffle qualification

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
