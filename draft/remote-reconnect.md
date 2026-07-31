# Remote Session Resilience: Disconnect, Reconnect, and Resume

Extends `terminal-tunneling.md`. Implementation target: tunnel protocol
1.4 → 1.5, local control protocol minor bump, `ghosttea-truffle` mesh
runtime, `ghosttead` control protocol, `ghosttea-react` workspace, and the
GhostteaKit compact-stream client.

Revision 11: secondaries removed from the resume handshake (they attach
after Live and never gate it), the rejection table gains feed/secondary
and connection-disposition columns (compact follows per-code session
outcomes, not blanket redial; feed `view-limit` closes the fence-pinning
connection so watermark GC can free the cap), `reconnect-remote-session`
defined as a Phase-1 one-shot resume (never dormant), heartbeat cadence
made explicitly idle-triggered (ping at 3 s idle, fail at 6 s idle), and
`AttachRejectCode` typed with `#[serde(other)] Unknown` → ambiguous path,
table authoritative over `retryable`.
(Revision 10: local minor re-pinned to 11, per-scope rejection table,
contact contract fixed, QUIC-scoped re-election, response DTOs, purge
overclaim tied to the residual window.)
(Revision 9: `AttachRejected`, `control_revision` init at 1 with legacy
downgrade for old clients, commit-time currency, complete-schema rule,
scoped cancellation guarantee, `r:`/`h:` namespaces.)
(Revision 8: per-connection liveness, definitive-vs-ambiguous feed
failure, `maybeReclaim` funnel, controller state in reconciliation +
downgrade matrix, fence ordering invariants, cancellable setup writes,
local minor 10, bounded wire ids.)
(Revision 7: watermark GC fenced across overlapping connections, feed
re-election, atomic tombstone cause, epoch-checked stream registration,
reclaim ownership + nullable local `control-state`, exact compact
encodings, asymmetric reclaim outcomes, attach RPC inside the
`viewStateSeq` fence.)
(Revision 6: refresh as re-attach, per-view barrier half for
`wants_state: false`, `ControlState`, gate over all state dispatch,
`attach_generation`, compact-codec rule, range purge, per-client watermark
caps. Revision 5: control-revision CAS, serde defaults, snapshot exclusion,
no queueing outside Live, `viewStateSeq`. Revision 4: input-replay removal,
generation ordering, honest 1.4 fencing, ordered takeover, local-control
gating, promotion as re-attach, per-view schema.)

## 0. Problem

Today, when the remote host disappears while a viewer is attached:

- The viewer's state-reader task tears down the `RemoteView` and the cached
  QUIC connection (`ghosttea-truffle/src/lib.rs:452–477`) after the QUIC idle
  timeout (~30 s; quinn default, 5 s keep-alive from truffle-core).
- No event reaches any client. The daemon only forwards `control-changed` and
  `session-activity-changed`.
- The daemon's per-client `attached` map still holds the dead epoch
  (`service.rs:996–1009`; only cleared by explicit detach at `:1038`), so a
  repeated `attach-session` returns a stale epoch without re-dialing.
- The React runtime attaches once per mount; while a view has no epoch it
  **queues up to 256 input operations and replays them after attach**
  (`runtime.ts:903–912`, replay at `:861–866`) — acceptable for the
  milliseconds of a local mount, catastrophic across an outage (§4.3).
- Nothing ever re-attaches. Recovery requires closing and re-opening the
  remote session, and only works because host-side attach performs a full
  refresh (`session.rs:1225–1239`).

Host- and viewer-side facts that constrain any resume design:

- `ViewAuthority::attach` returns the **existing** epoch when the same
  `(view_id, client_id)` re-attaches, and rejects a different client
  (`ghosttea-core/src/authority.rs:81–104`). A resumed viewer keeps the same
  truffle `client_id` (`truffle:{peer_ref}`), so a naive re-attach does not
  mint a fresh epoch.
- When a host-side connection handler dies it detaches by
  `(view_id, client_id)` unconditionally (`lib.rs:1803`, compact `:1545`).
  A zombie handler for the *old* connection can destroy a *resumed*
  attachment minutes later.
- Host-side epoch checks are connection-local: each handler compares incoming
  messages against the epoch **it** captured at attach (`lib.rs:1827–1857`),
  and `claim_control` / `resize_view` take no attachment epoch at all
  (`session.rs:1249`, `:1270`). Only the input family validates the epoch in
  the authority.
- Every `RemoteView` state task publishes into the session's single shared
  replica (`lib.rs:383`), and patch sequences are per-stream (each host
  stream restarts at 0), so two live streams — or an old and a resumed one —
  corrupt each other's sequencing.
- The local (daemon ⇄ app) control protocol is strict: a client that receives
  an event type it does not recognize **destroys the socket**
  (`ghosttea-client/src/index.ts:369–371`). New unsolicited events must be
  minor-gated like existing ones (`client_accepts_event`,
  `service.rs:688–690`).

## 1. Goals and non-goals

Goals:

1. A host network blip is invisible beyond a short status banner: the session
   auto-resumes with an authoritative snapshot, same tab, same pane, no user
   action.
2. The user is never lied to. Frozen content is visibly frozen; typed input is
   visibly not delivered — and is **never** delivered later; a dead session is
   visibly dead, with an end reason claimed only on evidence (§6.4).
3. Host restart, session close, and remote process exit are distinct states
   with honest messaging. The last rendered viewport remains visible and its
   text copyable while frozen.
4. Detection in seconds, not the 30 s transport idle timeout, for peers on
   protocol ≥ 1.5.
5. Desktop and iOS present the same lifecycle with platform-native affordances.
6. Every phase is independently shippable and safe against 1.4 peers — with
   the 1.4 fencing limitation stated honestly (§4.2.1).

Non-goals:

- Predictive local echo (mosh-style). The replica renders authoritative host
  state only; prediction is a separate future project.
- Input buffering/replay across an outage (§4.3 — deliberately rejected, and
  the existing client queue is explicitly disabled for these states).
- Replicated scrollback. The logical snapshot carries only the rendered
  viewport plus scrollbar metadata (`ghosttea-core/src/logical.rs:5–16`);
  scroll is a host-side input. Offline, the frozen replica shows the last
  viewport only. Replicating scrollback is future work.
- Surviving a host *process* restart. Sessions live in the host `ghosttead`;
  a new `host_instance_id` is a new world (unchanged invariant).

## 2. Prior art informing this design

- **mosh**: state-sync protocol over roaming transport; when the link stalls it
  overlays "Last contact: N seconds ago" rather than freezing silently. We
  adopt the honest last-contact clock; we do not adopt prediction.
- **Eternal Terminal**: reconnect keyed by session identity, not address, with
  sequence-numbered replay of a byte stream. Our analog of replay is cheaper
  and simpler: host attach always emits a full logical snapshot, so resume is
  "re-attach + snapshot", with `session_epoch`/`terminal_revision` as the
  identity/staleness fence instead of byte sequences.
- **VS Code Remote**: two-phase UX — transparent bounded auto-reconnect
  ("Reconnecting…"), then an explicit suspended state with a manual action;
  reconnection token validates it is the *same* server incarnation. Our
  `host_instance_id` + `session_epoch` play the token's role.
- **tmux / RDP**: host-persistent sessions with client re-attach as the
  primary recovery primitive — already our model; this design makes the
  re-attach automatic.

## 3. Viewer session lifecycle (the core state machine)

One state machine per open remote session, owned by `MeshRuntime` in
`ghosttea-truffle` (single implementation serves every desktop client through
`ghosttead`; GhostteaKit mirrors it per attachment in Swift, §8.2).

```text
            attach ok                     stream lost / probe failure
   Opening ─────────► Live ◄──────────────────────────┐► Reconnecting
                       ▲                              │      │ feed view attach ok
                       │ feed snapshot ingested       │      ▼
                       └───────────────────────── Synchronizing
                                                      │ identity mismatch /
   Reconnecting ── host absent > suspend_after ──► Suspended
   Suspended ── advertisement reappears / manual retry ──► Reconnecting
   any state ── terminal condition ──► Ended { reason }
```

States and invariants:

- **Live** — the session's designated *feed view* (§4.5) is attached **and**
  its post-attach snapshot has been applied to the replica. `last_contact`
  updates on every state message and pong. Per-pane input readiness is
  additionally gated per view (§4.5) — Live alone never unblocks a pane whose
  own view is not attached.
- **Reconnecting** — replica retained and frozen; input rejected locally
  (§4.3); the engine dials on a backoff schedule (§4.1).
- **Synchronizing** — transport re-established and the feed view's
  `ViewAttached` received; the new state generation is already **active**
  (§4.2.2) but the recovery snapshot has not yet been ingested. Input stays
  blocked and the UI stays cooled. This state exists because the host sends
  `ViewAttached` *before* opening the state stream (`lib.rs:1763–1786`), so
  attach-complete must not be treated as recovered. Timeout back to
  Reconnecting if no snapshot arrives within `HANDSHAKE_TIMEOUT`.
- **Suspended** — the engine stops burning dials because the host has been
  absent longer than `suspend_after` (default 10 min). A watcher remains: any
  fresh advertisement from the device (or manual retry) re-enters
  Reconnecting immediately.
- **Ended { reason }** — terminal. Reasons are a closed enum, each requiring
  the evidence defined in §6.4: `session-closed`, `session-exited` (with exit
  metadata when known), `session-unavailable` (honest "don't know"),
  `host-restarted`, `host-shutdown`, `closed-locally`. The replica is
  retained frozen for viewing/copying until the tab closes.

Process exit vs lifecycle: a remote session whose process exited but which the
host still lists as `attachable` **resumes normally** and stays Live showing
the final screen; exited-ness is process metadata (`summary.exited` /
`running == false`), surfaced through the existing
`session-exited`/`session-metadata` vocabulary, not a lifecycle state. Ended
reasons apply only when re-attach is impossible.

Rules:

- Single-flight *locally*: one reconnect engine per (device, session).
  Network-delayed duplicates are still possible and are ordered by the resume
  generation (§4.2.1) — single-flight is a local optimization, not the
  correctness mechanism.
- Every transition emits a lifecycle event with a per-session monotonically
  increasing `lifecycle_seq`.
- Every open remote session records `device_id` **and** `device_name` at open
  time; lifecycle events carry both (§7).

## 4. Reconnect engine

### 4.1 Scheduling

- Backoff with **full jitter** (AWS definition, precisely):
  `delay(n) = uniform(0, min(10 s, 500 ms · 2ⁿ))`, `n` = 0-based attempt
  counter, with a 250 ms floor.
- Fast path: subscribe to the advertisement store
  (`SyncedStore::subscribe()`) and peer events (`Node::on_peer_change()`). A
  fresh `TerminalHostAdvertisement` from the target device short-circuits the
  backoff timer and dials immediately. Advertisements republish every 5 s, so
  resume typically lands within ~1–6 s of the host returning.
- Dial gating: skip a scheduled dial when discovery says the peer is offline
  and the advertisement is expired; the fast path covers the wake-up.
- Cancellation: local detach/close, or entering Ended, aborts the engine and
  closes any in-flight dial.

Discovery signals while Live are **probe triggers, not teardown triggers**:
advertisement expiry or a peer-offline event on a device with Live sessions
fires an immediate liveness probe — Ping on 1.5 (§5), or a `ListSessions`
round-trip for 1.4. The 1.4 probe must reach the **cached connection
directly**: a new `MeshRuntime::probe_connection(device_id)` runs the
round-trip on the cached connection's control stream *without* advertisement
validation — the existing `remote_connection` path bails on an expired
advertisement before touching the cache (`lib.rs:710–724`), which would make
the probe self-defeating exactly when it matters. Only a failed probe (or a
stream error) tears the transport down.

### 4.2 Resume handshake, takeover, and identity fencing

On each attempt, per device:

1. Re-validate the advertisement (existing `validated_advertisement`).
2. `host_instance_id` differs from the one recorded at first attach →
   **Ended { host-restarted }**. Do not dial.
3. Establish connection + `ClientHello`/`ServerHello`. **Record the
   negotiated minor on the connection** (`RemoteHostConnection` gains
   `protocol_minor`; both Rust and Swift currently validate and then discard
   it, `lib.rs:764–777`) — every 1.5-gated behavior reads it from there.
4. `ListSessions`; interpret for our `remote_session_id` per the evidence
   rules of §6.4: present and attachable → proceed (even if
   `running == false`, §3); otherwise resolve the end reason from listing
   flags, tombstone lookup (1.5), or fall back to
   **Ended { session-unavailable }**.
5. `AttachView` for the **feed view only**, with **takeover semantics**
   (§4.2.1) so a fresh `attachment_epoch` is guaranteed. Secondary views
   are *not* attached here — they attach independently **after** step 7's
   Live transition (§4.5), so a stalled secondary can never block
   recovery. (An earlier draft attached "the remaining views" inside this
   sequence, silently re-gating Live on every secondary.)
6. `ViewAttached.session_epoch` differs from the epoch recorded at first
   attach → **Ended { host-restarted }**.
7. **Activate the new generation, then synchronize** (ordering matters —
   §4.2.2): atomically swap the `RemoteView` entries and advance the
   session's state generation *before* reading state, enter
   **Synchronizing**, ingest the full snapshot through the now-current
   generation (host attach publishes a full refresh, `lib.rs:1760–1761`).
   Only after the snapshot applies: update replica metadata, emit per-view
   `view-state-changed`, transition → Live, and unblock input per view.
   Input never races ahead of the epoch swap or the snapshot.
8. On 1.4 hosts, **purge the zombie attachment** (§4.2.1) in the background
   once Live.

#### 4.2.1 Attach takeover — fencing *every* view-scoped operation

The current host contract cannot support resume with the same `view_id`:
same-client re-attach returns the **old** epoch (`authority.rs:85–88`), and
the old connection's cleanup path detaches by `(view_id, client_id)` with no
epoch check (`lib.rs:1803`, `:1545`). Fencing only input and cleanup is not
enough: the old handler's guards compare against its *own captured* epoch
(`lib.rs:1827–1857`), and `claim_control`/`resize_view` never consult the
authority's current epoch (`session.rs:1249`, `:1270`).

**Protocol 1.5 hosts — atomic, ordered takeover with uniform epoch
enforcement:**

- `ViewAuthority` gains
  `take_over(view_id, client_id, access, attach_generation) -> Result<u64>`:
  - Validates `resume.previous_session_epoch` against the live session
    **before any mutation**; mismatch → error (viewer maps to
    Ended { host-restarted }).
  - **Orders *every* attach attempt, not only resumes**: a delayed *initial*
    `AttachView` needs the same fencing — if an initial request times out
    after reaching the host, a retry on the same wire view id would hit the
    same-client legacy path and mint **the same epoch twice**, recreating
    the collision and cleanup race. Therefore `attach_generation` is a
    top-level field on every 1.5 `AttachView` (not buried in `ResumeHint`),
    monotonic per wire-view lineage from the very first attempt. The
    authority records the highest generation accepted per
    `(view_id, client_id)` and rejects ≤ with `stale-resume`. Local
    single-flight is an optimization; *this* is the correctness mechanism.
  - **Watermark storage: never evict while reachable, GC when provably
    dead**: a watermark only fences attempts that could still arrive, and a
    delayed `AttachView` cannot outlive the connection it was written to —
    QUIC delivers nothing from a closed connection. But "the connection that
    accepted the newest generation" is the wrong thing to stamp: with
    overlapping connections, an *older* connection A can still hold a
    delayed lower-generation attach after the watermark was raised on B —
    if B's close alone permitted GC, A's stale attach would sail through the
    no-current-attachment branch as a plain attach. The fence must
    therefore cover **every connection that could deliver an older
    generation**: the host numbers each client's connections monotonically,
    and a watermark records `fence_conn_id` = the highest connection id
    from that client at the moment the watermark was raised. GC requires
    the view detached **and** every connection with id ≤ `fence_conn_id`
    *fully terminated* — where terminated means the transport is closed and
    its spawned stream handlers have **completed**, not merely been
    orphaned: today's accept loops spawn handlers detached
    (`lib.rs:1561–1573`, compact `:1093–1105`), so 1.5 hosts must track
    them (a per-connection `JoinSet`) for termination to be observable.
    Two ordering invariants make the fence sound, and both must be stated
    because the proof silently depends on them: **(a)** the host assigns
    connection ids at **raw transport acceptance, before any handler
    runs** — an id assigned later (e.g., at hello) could order a
    slow-handshaking older connection *above* the fence recorded for a
    newer attempt; **(b)** the client re-checks that an attach attempt is
    still its lineage's current one **immediately before writing
    `AttachView`** — otherwise a stalled attempt task could write an old
    generation onto a newer connection, which is exactly the "correct
    client never emits an old generation on a newer connection" property
    the fence relies on. With both held, connections with id >
    `fence_conn_id` need no fencing — and a malicious client gains nothing,
    since `client_id` is authenticated and it could simply attach normally. This bounds growth structurally (no
    timer, no eviction of live fencing state). Admission control is **per
    client**: at most 256 outstanding watermark keys per
    `(session, client_id)`; excess attaches are rejected (`view-limit`),
    failing safe without touching other clients. The client-side counter
    lives in `MeshRuntime` memory, per wire-view lineage; it needs no
    persistence because a restarted viewer generates fresh wire view ids,
    so its generation space can never collide with a previous process's
    watermarks.
  - **No-current-attachment branch**: if the view is not currently attached,
    this is a plain attach — mint a fresh epoch — but the generation is
    still validated and recorded.
  - Otherwise (same `client_id`, newer generation): **increment**
    `next_attachment_epoch`, replace the `AttachedView` (resetting per-view
    input/resize sequences), return the new epoch.
- **Uniform epoch validation in the authority**: `claim_control` and
  `resize_view` gain an `attachment_epoch` parameter checked against the
  current `AttachedView` — the contract the input family already enforces.
- **Controller state binds to the attachment epoch**: `ControllerState`
  records the controlling view's `attachment_epoch`; `take_over` clears the
  controller if held by the taken-over view's previous incarnation.
- **Host state streams are epoch-bound — with atomic registration**: the
  host keys each view's state-stream cancel handle by attachment
  incarnation and fires the old handle inside `take_over`. Cancellation
  alone races registration: a delayed old handler can sit *between* its
  successful attach and registering its handle when the takeover fires —
  cancelling nothing — then register and start a stale stream anyway.
  Registration is therefore epoch-checked under the same lock takeover
  mutates: `register_state_stream(view_id, epoch)` fails unless `epoch` is
  the authority's *current* attachment epoch, and a handler whose
  registration fails aborts without spawning. Either the takeover finds the
  handle and cancels it, or the registration finds the epoch stale and
  self-cancels — no interleaving lets a superseded stream run.
  Registration succeeding is not the end of it: the current helper performs
  its **setup writes — preface, initial snapshot, control state, activity —
  before the spawned loop ever observes cancellation**
  (`lib.rs:1972` onward), so a takeover landing just after registration
  would still let those initial frames go out. All setup writes move
  inside the cancellable scope, each re-checking cancellation/current-epoch
  before it begins. The achievable guarantee is precisely: **no write
  *begins* after cancellation is observed** — cancellation landing while an
  asynchronous write is already in flight cannot recall that frame, and
  does not need to: the viewer's generation gate (§4.2.2) drops it. Host
  suppression bounds the leak; viewer gating provides the correctness.
- Cleanup becomes epoch-conditional:
  `detach_view_if_epoch(view_id, client_id, attachment_epoch)`; the explicit
  `Detach` message routes through the same conditional.

**Protocol 1.4 hosts — wire view-id rotation, with an honest, degraded
guarantee.** The viewer never reuses a wire `view_id` across attach attempts,
bumping the generation on **every attempt — resumes, Phase-1 manual retries,
and retries of the *initial* attach alike**, since a timed-out initial
attempt that reached the host leaves the same same-epoch collision a resume
would. The wire id must respect the host's 128-byte view-id cap
(`authority.rs:82`) — naively appending `#g{n}` to an already-long local id
would make **every** retry invalid. Encoding:
`wire_view_id = {base}#g{generation}` where `base` is
`r:{local_view_id}` if the local id fits alongside the prefix and a
worst-case suffix (local id ≤ 98 bytes), else `h:{32-hex truncated
SHA-256(local_view_id)}`. The `r:`/`h:` namespace prefixes are load-bearing:
without them, a short local id literally equal to another id's hash would
produce the same base — a deterministic cross-view collision at equal
generations. Prefixed, the raw and hashed namespaces are disjoint; the
encoding stays bounded under the host's cap, deterministic per lineage,
and collision-safe far beyond the number of views a session can hold. To
the host each attempt is brand-new:
fresh epoch, and the zombie's cleanup and identity can never collide with it.

What rotation does **not** fence: until the host notices the old connection
is dead, the old wire view remains a *valid* attachment — messages already in
flight from before the outage (`Input`, `FocusAndResize`, `Resize` targeting
the old id with its still-valid epoch) are accepted by the host and act on
the shared terminal. The viewer-side generation gate protects only inbound
replica publication. Two mitigations bound the window; neither closes it:

- The viewer closes the old QUIC connection on teardown, so nothing new can
  be sent and undelivered data is dropped; the residual window is the host
  draining already-received frames (typically sub-second, and empty in the
  common host-was-actually-down case).
- **Zombie purge — best-effort acceleration, not correctness**: zombies
  self-clean without our help — each stranded attachment lives on a
  connection the viewer has abandoned, and the host detaches the view when
  it observes that connection's death (`lib.rs:1803`), at worst one QUIC
  idle timeout (~30 s) later. The purge only *accelerates* slot and
  controller release. Because generations are consecutive integers, the
  viewer tracks a contiguous **generation range** `[oldest_unpurged, current)`
  per view lineage (two integers — a ten-minute outage of timed-out
  attempts cannot overflow it the way a fixed "last 8" set silently would),
  restricted to attempts whose `AttachView` was actually written to a
  stream. Once Live, purge iterates the range in the background: attach the
  old wire id (same client → host returns its existing epoch,
  `authority.rs:85–88`), immediately `Detach` with that epoch, drain the
  transient state stream; advance `oldest_unpurged` per id. Identities the
  purge has not reached yet remain until the host's own connection-death
  detach collects them — acknowledged, **and still subject to the residual
  window above**: until the host observes each zombie connection's death,
  already-delivered pre-outage operations targeting those still-valid
  attachments can act on the session; the purge accelerates cleanup but
  does not close that window. Beyond the caveat, the remaining cost is an
  occupied view slot and possibly a held controller, both released on the
  host's detach per `terminal-tunneling.md` §2.4.

The strict "no stale operation can act after recovery" guarantee therefore
**requires 1.5**; on 1.4 the guarantee is "no stale operation after the host
has observed the old connection's death, with proactive purge on resume."
§9 and the rollout notes state this explicitly.

#### 4.2.2 Viewer-side generation gate: activate before publication

Every state-reader task carries the session's **state generation**, and
`MeshRuntime` gates **every state-channel dispatch** on it — not only
`replica.publish*` for snapshots and patches, but the `ControlChanged`/
`ControlState` watch-and-broadcast, `ActivityChanged`
(`replica.set_activity` + broadcast), and `SessionEnded`/`HostShutdown`
handling, all of which the reader dispatches outside the replica path
(`lib.rs:420–449`). A zombie reader that only had its frames gated could
still overwrite controller or activity state — or terminate the lifecycle —
after recovery. Ordering is activate-then-publish-then-Live:

1. On reader swap (entering Synchronizing) the new generation becomes
   **current** — before any state is read. The zombie's generation is now
   stale; its late publishes drop.
2. The recovery snapshot flows through the now-current generation and
   applies.
3. Live is entered only after the apply succeeds.

(Advancing the generation only *after* the snapshot applied — as a naive
reading of "atomic swap at the end" would do — is circular: the new reader's
own snapshot would be gated as non-current, and tagging it with the old
generation would re-admit the zombie. Activation is early; *Live* is late.)

Old tasks are also cancelled explicitly; the gate is the backstop that makes
late wakeups harmless on both 1.4 and 1.5 paths.

#### 4.2.3 Controller reclaim without racing

`ViewAttached` today carries no controller information, and the initial
`ControlChanged` state message is only emitted **when a controller exists**
(`lib.rs:1331–1345`), so a resuming client cannot distinguish "no controller"
from "announcement not yet delivered" — an unconditional `FocusAndResize`
would race a claim another view made during the outage.

- **1.5**: the authority maintains an always-present **`control_revision`**,
  incremented on **every change to controller state — claims *and* clears**
  (`control_epoch` alone cannot serve: it advances only on claims, so
  "controller detached" is invisible to it). Revisioned authorities
  **initialize at 1**, so `0` is unreachable for a 1.5 authority and serves
  exclusively as the "legacy/unknown source" sentinel — without this,
  "no controller at revision 0" on a fresh session would be a legitimate,
  CAS-able observation that the downgrade matrix simultaneously declares
  un-CAS-able. `ViewAttached` returns
  `control_revision` unconditionally alongside
  `controller: Option<{ controller_view_id, control_epoch }>` (the shape the
  original `terminal-tunneling.md` §11.2 design already specified) — so
  "I observed no controller at revision 17" is a first-class, expressible
  observation, never ambiguous with a legacy unconditional claim. Reclaim is
  sent only when the local pane holds meaningful focus **and** the attach
  response shows no controller or our own previous incarnation, and carries
  `expected_control_revision: Some(observed)`; the host compares-and-swaps
  against the current revision and rejects the claim if any claim *or
  clear* intervened, announcing current state (the `ResizeRejected`
  pattern). The announcement — and every 1.5 control notification — uses a
  new **`StateMessage::ControlState`** shape, because the existing
  `ControlChanged` *requires* `controller_view_id: String`
  (`tunnel_protocol.rs:380`) and structurally cannot say "no controller at
  revision N": `ControlState { controller: Option<ControllerInfo>,
  control_revision, cols, rows, layout_epoch }`. Hosts send `ControlState`
  to ≥ 1.5 viewers (clears included, which today are silent on the wire)
  and legacy `ControlChanged` to 1.4 viewers; 1.5 viewers accept both.
- **1.4**: reclaim remains last-write-wins on meaningful focus
  (`expected_control_revision` absent = legacy unconditional, which is all a
  1.4 host understands) — the same benign race concurrent claims have today,
  resolved by `control_epoch` ordering. Documented, not hidden.

**Who reissues the claim** — the layer that owns focus truth: meaningful
focus and desired dimensions live in the React runtime, not the
daemon/mesh, and the runtime's focus setter suppresses duplicate `true`
updates (`runtime.ts:1030`), so nothing re-fires automatically after a
resume. The trigger must not be a single event either: recovery emits
`view-state-changed: attached` *before* the session transitions to Live
(§4.2 step 7), so "reclaim on the attached event if already Live" would
skip and never retry. The runtime instead funnels every input into one
idempotent **`maybeReclaim(view)`** — evaluated whenever *any* of its
conditions changes (session lifecycle, view attachment, meaningful focus,
pane dimensions) — which sends `claimResizeControl` when all conditions
hold, **single-flight per attachment epoch** (at most one claim per epoch,
plus the §4.2.3 cleared-controller retry). This bypasses the
duplicate-suppression, which guards focus *transitions*, not epoch-scoped
claims. The daemon and mesh store no focus state; they only enforce the
CAS above. Symmetrically, the
local event vocabulary must express "no controller": §7's gated
`control-state` event carries a nullable controller plus `controlRevision`,
and the runtime clears its per-view `controlEpoch` on `controller: null` —
the existing `control-changed` local event cannot say that, mirroring the
wire-level gap `ControlState` fixes.

**Reclaim outcomes are asymmetric** (the no-fighting rule made precise):
a CAS rejection whose announced state shows **another view holding
control** ends the reclaim — do not retry. A rejection or observation
showing **no controller** at a newer revision may be retried with the
updated `expected_control_revision`, provided the pane still holds
meaningful focus.

### 4.3 Input policy during an outage: reject, never replay — and disable the existing queue

Keystrokes typed while a pane is not input-ready (§4.5) are **discarded
locally with visible feedback** (§8). No queue, no replay on resume.

This is not just a new rule — it requires **removing current behavior**: the
React runtime today queues up to 256 operations while a view has no epoch and
replays them wholesale once attached (`runtime.ts:903–912`, `:861–866`).
Across a resume that replay is exactly the `rm -rf tmp<Enter>`-90-seconds-
later hazard §4.3 exists to prevent. Required changes:

- `#sendViewInput` never queues for a view of a **remote** session in *any*
  non-Live state — **including Opening**: a remote open can spend up to the
  20 s `CONNECT_TIMEOUT` dialing, and 20 seconds of blind-queued keystrokes
  fired at a session whose state the user has never seen is the same replay
  hazard. Drop + §8.1 feedback instead.
- `view.pendingInput` is cleared on every `remote-session-state-changed`
  that leaves Live, and again before the epoch is re-armed on resume.
- The queue survives only for **local** sessions' mount-to-attach gap, which
  is a local IPC round-trip measured in milliseconds.
- A regression test proves keystrokes typed during any non-Live remote state
  (Opening included) are never emitted after recovery (§10).

Rationale: terminal input is imperative and context-dependent. Eternal
Terminal replays bytes safely only because its buffer spans sub-second
transport blips inside one live session; mosh drops to prediction rather
than queueing. For a multi-second outage the only safe policies are "reject
visibly" or "predict"; we choose reject.

The sole exception: `TunnelInput::Focus(false)` may be dropped silently
(cosmetic). Scrolling is host-side input and is therefore inert while frozen.

### 4.4 Copy while frozen: local viewport extraction

`selection-text` is today a host RPC end-to-end (`runtime.ts:1057–1074` →
daemon → `MeshRuntime::selection_text` → host). Offline it would fail. Fix at
the daemon: when the session is a remote replica and its lifecycle is not
Live, answer `selection-text` **locally** from the replica's retained
`LogicalTerminalSnapshot` rows (text + cell spans support column-accurate
extraction; `select_all` means the visible viewport). Authorization for the
offline path checks the caller's retained **ownership record** (§7), not a
live attachment epoch. When Live, keep the host RPC (it can access
scrollback). The response notes `scope: "viewport"` so the UI can hint that
offline copy covers the visible screen only.

### 4.5 Multi-view sessions: per-view readiness and a single replica feed

A session may be shown in several panes (views), but there is **one replica
per session** and every view's state stream currently publishes into it
(`lib.rs:383`) with per-stream patch sequences — already a latent collision
today, and unacceptable during recovery. The design makes the feed explicit:

- **Feed view**: exactly one view per session is the replica's state feed;
  only its stream passes the generation gate. Election happens **only at
  generation activation** (initial open, resume, failover) and picks the
  lexicographically-smallest *eligible* local view id at that moment; it is
  **sticky** — mounting a new, smaller-sorting view later never re-elects.
  Other views' state streams are drained and discarded; on 1.5,
  `AttachView.wants_state: false` declines the redundant stream at the
  source (against 1.4 hosts we drain).
- **Feed attach failure re-elects within the same activation**: Live
  depends on the feed's snapshot, and promotion (below) only covers a feed
  stream dying *after* Live — without a fallback, one permanently failing
  view would strand the whole session in Synchronizing forever,
  contradicting the "one failed pane doesn't break the session" promise.
  How re-election proceeds depends on **why** the attach failed:
  - **Definitive pre-attach rejection — 1.5 only, and it needs a wire
    message**: `SessionControlMessage` today has no error variant
    (`tunnel_protocol.rs:274–351`) — a host-side attach failure `bail!`s
    the handler and the viewer sees only stream closure, which is by
    definition ambiguous. Protocol 1.5 therefore adds
    `AttachRejected { request_id, code, retryable }`. A rejection is
    definitive, but **what it decides depends on the code's scope** — the
    closed code/action table in §6.2 governs; there is no blanket
    "rejected → re-elect" rule, because most codes are *not* view-scoped:
    `view-limit` is a session×client admission failure any replacement
    view would hit identically, `unknown-session` and
    `session-epoch-mismatch` are session verdicts (SessionStatus lookup
    and Ended { host-restarted } respectively), and `stale-resume` marks
    the *response itself* obsolete — discarded outright, no `failed` mark,
    no re-election; the superseding attempt's outcome governs. Only the
    genuinely view-scoped `view-invalid` re-elects the next eligible view
    in place — and **in-place re-election exists only on QUIC**: a compact
    connection carries exactly one view, so on compact the per-code
    *session-level* outcome applies unchanged (terminal codes end the
    session, `stale-resume` is discarded) and only non-terminal attach
    failures resolve as "fail that attachment, redial under an advanced
    generation" — the full role- and transport-aware disposition is the
    §6.2 table.
  - **Ambiguous failure** (attach timeout, stream error — and on 1.4
    hosts, **every** failure, since without `AttachRejected` closure is
    all they can express): the host may have accepted the attach and may
    still open the first candidate's state stream later — which would
    collide with the next candidate on the connection-wide accept queue
    that the attach handshake serializes (`lib.rs:311–316`,
    misrouted-preface bail at `:366–371`). Re-electing in place is unsafe;
    instead **close the connection and advance the generation** — a fresh
    dial, where the abandoned attempt is fenced as usual by
    `attach_generation` (1.5) or rotation (1.4).

  Only when no view can attach does the resume attempt itself fail,
  returning the session to Reconnecting (backoff and Suspended semantics as
  normal — never a silent hang).
- **Per-view readiness**: each view is `pending → attached(epoch) | failed`,
  and this state is part of the daemon schema (§7). A pane accepts input
  only when the session is Live **and** its own view is `attached`. Panes
  whose view attach failed show a per-pane retry affordance (§8.1) while the
  rest of the session works.
- **Live barrier**: the session is Live when the *feed* view has attached and
  its snapshot is ingested (§3). Secondary views do not gate Live and need
  no snapshot; each becomes input-ready as its own attach completes.
- **Feed promotion is a generation-advanced re-attach**, not an in-place
  stream switch: if the feed view's stream dies while others live on, the
  engine advances the generation and re-attaches the promoted view —
  takeover with `wants_state: true` on 1.5, wire-id rotation on 1.4 —
  transitioning the session through Synchronizing. Attach semantics
  guarantee a fresh stream, a full snapshot, and reset sequencing, and the
  generation bump retires the dead feed; no new promotion RPC is needed.
  (In-place promotion is not well-defined on either transport: a 1.5
  secondary declined its stream at attach, and on QUIC `RequestSnapshot`
  does not re-snapshot an existing stream — it spawns a whole new persistent
  one, `lib.rs:1905–1915`. Compact connections carry a single view, so
  promotion does not arise there.)

## 5. Fast failure detection

Transport reality: truffle-core pins keep-alive at 5 s and quinn's default
idle timeout is 30 s; we do not fork truffle-core. Protocol 1.5 adds
application-level liveness, framed per transport:

- **QUIC**: the connection-control stream is lockstep request/response under
  a mutex (`lib.rs:186–211`); unsolicited messages would desynchronize it.
  The viewer opens one dedicated **heartbeat stream** per connection
  (`StreamKind::Heartbeat`, new preface kind, 1.5-gated) carrying
  `Ping { nonce }`/`Pong { nonce }`, on which the host may push
  `HostShutdown` (§6.3).
- **Compact**: heartbeats are new `SessionControlMessage::Ping/Pong`
  variants on the existing control channel (`lib.rs:1357–1363` parses only
  `SessionControlMessage` there), per attachment. Host shutdown for compact
  is `StateMessage::HostShutdown` on the state channel (§6.3).

Cadence (both transports) — **idle-triggered, not fixed-interval**, which
is what "state traffic counts as contact" implies and the normative rule
now states outright: while ≥ 1 view is attached, **after 3 s without any
contact on the current incarnation, send a `Ping`; after 6 s without
contact, declare probe failure** → tear down that connection's views →
Reconnecting. A busy session whose state stream never goes 3 s quiet sends
no pings at all; an idle session probes at most every 3 s.

**Liveness is scoped per connection incarnation — and the currency check
is atomic with the mutation, not a pre-check.** "Any traffic counts as
contact" must not let the wrong connection vouch for the current one: a
zombie reader that touched a shared `last_contact` before its generation
check — or a late `Pong` from a superseded connection's heartbeat — could
indefinitely mask a black-holed *current* connection, and a late
`HostShutdown` from an old connection could terminate a healthy session.
Each connection incarnation owns its own `last_contact` and ping nonces.
A check-then-dispatch pattern is not enough: an old heartbeat task can
verify "A is current," get descheduled while B replaces A, then resume and
dispatch A's `HostShutdown` anyway. Every liveness-driven effect therefore
flows through the session's **serialized lifecycle owner**, carrying the
connection incarnation it acted for; the owner compares that incarnation
against the current one **at commit, under its own lock**, and drops
mismatches. The same commit-time rule applies to probe-failure teardown
(tear down only if the failed incarnation is still current) and to contact
refresh. To be precise about what refreshes contact — the two paths differ:
**any state-channel traffic on the current incarnation refreshes
`last_contact`** (that is §5's "state traffic counts as contact", scoped);
the **Pong path additionally requires the nonce to match an outstanding
ping on that same incarnation** — an unsolicited or replayed Pong refreshes
nothing even on the current connection.

1.4 peers: no heartbeat; detection falls back to the 30 s idle timeout plus
the discovery-triggered cached-connection probe (§4.1).

## 6. Tunnel protocol changes (1.4 → 1.5, all minor-gated)

Following the `SESSION_ACTIVITY_PROTOCOL_MINOR` gating pattern
(`tunnel_protocol.rs:14–16`), bump `PROTOCOL_MINOR` to 5. The negotiated
minor is **persisted per connection** on both sides (§4.2 step 3).

> **Implementation-time renumbering (Phase 3 start, 2026-07-31):** minor 5
> was spent by terminal-presentation sync (commit 612af6d) between design
> freeze and Phase 3 start. Everything this document calls "1.5" ships as
> **minor 6**, gated by a new `REMOTE_RECONNECT_PROTOCOL_MINOR: u16 = 6`;
> read "1.4 peers/hosts" as "negotiated minor < 6". Prose below is left
> unrenumbered — this note governs.

### 6.1 Liveness

```rust
// QUIC: new stream kind, one per connection, viewer-opened.
StreamKind::Heartbeat,

// Messages on the heartbeat stream (QUIC) — new enum, not ConnectionMessage:
enum HeartbeatMessage {
    Ping { nonce: u64 },
    Pong { nonce: u64 },
    HostShutdown {},
}

// Compact: SessionControlMessage additions on the control channel:
Ping { nonce: u64 },
Pong { nonce: u64 },
```

### 6.2 Resume takeover (correctness-bearing on 1.5)

```rust
// SessionControlMessage::AttachView gains:
#[serde(default)]
attach_generation: u64,               // §4.2.1: monotonic per wire-view
                                      // lineage over EVERY attempt (initial
                                      // retries included); host rejects ≤
                                      // last accepted. 0 = 1.4 client.
#[serde(default, skip_serializing_if = "Option::is_none")]
resume: Option<ResumeHint>,
#[serde(default = "default_true")]
wants_state: bool,                    // §4.5: secondary views decline the stream

struct ResumeHint {                   // resume evidence only; ordering
    previous_session_epoch: u64,      // lives in attach_generation above
    previous_attachment_epoch: u64,
    previous_terminal_revision: u64,
}

// SessionControlMessage::ViewAttached gains — every new field carries a
// serde default: a 1.5 viewer must decode a 1.4 host's ViewAttached, which
// omits all of them (same pattern as ClientHello.state_codecs):
#[serde(default)]
resumed: bool,
#[serde(default, skip_serializing_if = "Option::is_none")]
controller: Option<ControllerInfo>,   // §4.2.3
#[serde(default)]
control_revision: u64,                // §4.2.3; 0 = "1.4 host, unknown"
struct ControllerInfo { controller_view_id: String, control_epoch: u64 }

// SessionControlMessage::FocusAndResize gains:
#[serde(default, skip_serializing_if = "Option::is_none")]
expected_control_revision: Option<u64>,  // §4.2.3: CAS; None = legacy LWW

// New SessionControlMessage variant — the definitive-rejection wire message
// (§4.5): today attach failures can only close the stream, which reads as
// ambiguous. Sent by 1.5 hosts instead of bailing:
AttachRejected {
    request_id: String,
    code: AttachRejectCode, // typed enum with #[serde(other)] Unknown —
                            // see the code/action table below
    retryable: bool,
},
```

**Rejection code/action table** (closed set). The action depends on the
code's scope **and on the role of the attach that was rejected** — a feed
attach is load-bearing for the session, a secondary attach is not, and the
two must never share a recovery rule. "Connection" is the disposition of
the QUIC connection the rejection arrived on; on compact, a connection
carries exactly one view, so there is no in-place anything — the per-code
*session-level* outcome still applies (terminal codes end the session,
`stale-resume` is discarded), and only the non-terminal attach failures
resolve as "fail that attachment, redial under an advanced generation":

| Code | Scope | Feed attach | Secondary attach | Connection | Retryable |
| --- | --- | --- | --- | --- | --- |
| `stale-resume` | attempt | Discard the response; superseding attempt governs | Same | Keep | n/a (response is obsolete) |
| `view-invalid` | view | Mark view `failed`; re-elect next eligible in place (QUIC) | Mark view `failed`; **session stays Live**, per-pane retry offered | Keep | Yes, with a corrected id |
| `view-limit` | session × client | **Do not re-elect** (any replacement hits the same cap). Resume fails → Reconnecting — and **invalidate this connection first**: watermark GC needs fence-pinning connections terminated (§4.2.1), so retrying on the same connection would preserve the very cap that rejected us | Pane fails; **an already-Live session is untouched** | Feed: close before retry. Secondary: keep | Yes, after GC frees slots |
| `unknown-session` | session | `SessionStatus` (§6.4) → evidence-backed Ended | Same (session outcome, regardless of which attach surfaced it) | Close | No |
| `session-epoch-mismatch` | session, terminal | **Ended { host-restarted }** — the takeover pre-mutation check (§4.2.1) given definitive wire form | Same | Close | No |
| `access-denied` | session | Resume fails, session-level error surfaced; never re-elect. (Reserved: current hosts silently **downgrade to read-only**, `lib.rs:879–896`) | Same | Close | No |

The wire type is a **typed enum, not a free string** — "closed set" must be
enforced by the decoder: `code: AttachRejectCode` with
`#[serde(other)] Unknown`. An `Unknown` code takes the **ambiguous-failure
path** (close the connection, advance the generation) — the safe default
for a future code this viewer predates. The table is **authoritative over
the `retryable` boolean**: `retryable` is advisory telemetry, and a host
that sends a contradictory value does not change the action taken.

```rust

// New StateMessage variant — ControlChanged is NOT extended (§4.2.3):
ControlState {
    controller: Option<ControllerInfo>,   // None = "no controller", finally expressible
    control_revision: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
},
```

**Compact-codec evolution rule**: serde defaults protect only the JSON
struct paths. The compact codec encodes `ControlChanged` as a **fixed
5-element tuple** under tag `"c"` (`tunnel_protocol.rs:582–612`), where an
appended field is a decode error, not a default. Existing compact tuples
are therefore **never widened**; new semantics get a **new compact tag**.
The three new state frames are specified exactly, so Rust and Swift cannot
diverge — all emitted only on connections whose negotiated minor is ≥ 5;
1.4 decoders never see the tags, and 1.5 decoders keep accepting `"c"`
from 1.4 hosts unchanged:

| Tag | Message | Compact shape |
| --- | --- | --- |
| `"cs"` | `ControlState` | 5-tuple `[controller, control_revision, cols, rows, layout_epoch]`, where `controller` is `null` or the 2-tuple `[controller_view_id, control_epoch]` |
| `"se"` | `SessionEnded` | 2-tuple `[reason, exit_code]`, `reason` ∈ `"exited" \| "closed"`, `exit_code` an integer or `null` (always `null` for `"closed"`) |
| `"hs"` | `HostShutdown` | empty 0-tuple `[]` |

On a 1.5 host, `resume` triggers the ordered atomic takeover of §4.2.1 —
session-epoch validation before mutation, resume-generation ordering, epoch
increment (or plain attach when no current attachment exists), controller
invalidation, old-state-stream cancellation, uniform epoch checks on
control/resize, and epoch-conditional cleanup. The mandatory full snapshot
applies **only when `wants_state == true`** (and to every 1.4 attach, where
the flag does not exist): a `wants_state: false` attach creates **no
live-state stream and no snapshot** — that is its entire purpose (§4.5).
Its `ViewAttached` satisfies **only the per-view half of the §4.5 input
barrier**; the session-Live half (feed snapshot ingested) still gates such
a pane, so a secondary attaching while the feed is Synchronizing cannot
race input ahead of recovery. Against 1.4 hosts
the viewer omits `resume` and rotates the wire view id (§4.2.1); the
generation gate (§4.2.2) protects ingestion on both paths.

### 6.3 Clean goodbyes

- QUIC: `HeartbeatMessage::HostShutdown` (host → viewer, then close).
- Compact: `StateMessage::HostShutdown {}` on the state channel.
- Both: `StateMessage::SessionEnded { reason }` with
  `reason: exited { code: Option<i32> } | closed` on a session's state
  stream/channel.

`ghosttead` sends the shutdown frame on SIGTERM/SIGINT before dropping
listeners; viewers map it to Ended { host-shutdown } (configurable to
Suspended for hosts expected back).

### 6.4 End-reason evidence: tombstones and honest fallbacks

An exit that happens *during* an outage would otherwise be indistinguishable
from an explicit close. Reasons therefore require evidence:

- **1.5 hosts keep bounded session tombstones**: an LRU
  (`session_id → { reason: exited { code } | closed, ended_at_ms }`, cap 128,
  TTL 24 h). The write must be **atomic with a single removal choke point**:
  sessions leave the registry today through several racing paths — natural
  process exit, explicit close commands, and owner closure
  (`service.rs:762`, `:1437`) — and letting each path write its own cause
  would record `exited` vs `closed` nondeterministically, violating the
  truthfulness goal. All removal paths route through one
  `registry.remove_with_cause(session_id)` that, holding the session lock,
  computes the cause at the moment of removal with a fixed precedence:
  **observed process exit wins** (`exited { code }` whenever the session's
  process has already exited, regardless of which path triggered removal;
  `closed` only for sessions removed while still running). First writer
  commits; late writers find the tombstone present and do not overwrite.
  Consulted via:

  ```rust
  // ConnectionMessage additions:
  SessionStatus { request_id: String, session_id: String },
  SessionStatusResult {
      request_id: String,
      status: SessionStatusKind,   // live | ended { reason } | unknown
  },
  ```

  Resume step 4 maps `ended { exited }` → **Ended { session-exited }**,
  `ended { closed }` → **Ended { session-closed }**, `unknown` →
  **Ended { session-unavailable }**.
- **Live-observed evidence** still applies: `SessionEnded` frames observed
  before the drop, or listings with `attachable: false` paired with
  `running` flags.
- **No evidence** (1.4 hosts, expired tombstone) → honest
  **Ended { session-unavailable }**. Never claim `closed` or `exited`
  without evidence.

`SharedSessionSummary` already carries `running`; the advertisement loop
currently hardcodes `attachable: true` (`lib.rs:1027`). 1.5 hosts set
`attachable` from actual registry policy.

## 7. Daemon surface (`ghosttead` ⇄ local clients)

**The local control protocol is versioned too.** New unsolicited events would
destroy older clients' sockets (`index.ts:369–371`), so this work bumps
`CONTROL_PROTOCOL_MINOR` from 11 to **12** and gates every new event behind
`REMOTE_LIFECYCLE_PROTOCOL_MINOR = 12` — named explicitly because the lower
minors are **already spent and keep being consumed by parallel work**:
`SESSION_CREATED_PROTOCOL_MINOR = 9`, `CONFIG_EVENT_PROTOCOL_MINOR = 10`
(Ghostty-configuration feature), and `CONFIG_DOCUMENT_PROTOCOL_MINOR = 11`
(lossless document editing, commit `7035792` — allocated *after* this
document first pinned 11, proving the re-verify rule below is not
theoretical), with daemon and clients both advertising 11
(`service.rs:45–50`, `ghosttea-protocol/src/index.ts:2`).
Reusing an allocated minor recreates the exact failure this section
prevents — a released minor-11 client would pass a ≥ 11 lifecycle gate yet
be unable to decode the event. Implementers must re-verify the current
minor at implementation time; this document pins **12** as of the
config-document allocation. The
gate follows the existing `client_accepts_event` mechanism
(`service.rs:688–690`) and the compile-time
`assert!(GATE <= CONTROL_PROTOCOL_MINOR)` pattern already in place. The
negotiated value persists on both ends; clients likewise gate new commands
on the daemon's negotiated minor and fall back to Phase-0 behavior (frozen
tab, no lifecycle UI) against an older daemon. §11's "no protocol change"
phases mean "no **tunnel**-protocol change".

**Minor 12 is advertised only with its complete schema.** A version number
is a promise about *surface*, not behavior: if Phase 1 advertised 12 with
only the Phase-1 commands implemented, a Phase-2 client and a Phase-1
daemon would both negotiate 12 and the client's newer command would hit
the unknown-command path, which closes the socket (`service.rs:1016`).
Phase 1 therefore ships **every** minor-12 message — all events, all
commands, `control-state` included — with dormant handlers where behavior
arrives later, each with an **explicitly named response DTO** (inert means
"real response shape, no side effect", never an ad-hoc placeholder):

| Command | Response DTO (always, dormant or live) |
| --- | --- |
| `get-remote-session-state` | `remote-session-state` — the full §7 reconciliation object |
| `reconnect-remote-session` | `remote-session-state` — **never dormant**: Phase 1 implements it as a **one-shot resume attempt** (invalidate the cached connection, one fresh dial + re-attach under an advanced generation/rotation, no backoff loop, no discovery fast path), returning the resulting state; Phase 2 upgrades it to arming the full engine. Phase 1's manual-retry UX depends on this command actually doing something — a dormant handler here would contradict the rollout. |
| `retry-remote-view` | `view-state` — `{ sessionId, viewId, viewStateSeq, viewState, attachmentEpoch: number \| null, readWrite: boolean \| null, error, retryable }` (dormant = current record unchanged) |

Events simply do not fire until the phase that produces them. Later phases
change behavior only, never the negotiated surface; any future surface
change allocates minor 13. Mixed-version tests must cover the **released
minor-11 pairings** specifically: a config-document-era v11 client against
the new daemon (receives config events, none of the lifecycle events,
socket survives) and the new client against a released v11 daemon (sends
none of the minor-12 commands, falls back to Phase-0 behavior).

**Downgrade matrix** (the two mixed-version rows implementers will hit):

| Pairing | Behavior |
| --- | --- |
| 1.5-capable daemon ⇄ **1.4 host** | No revisions or clears exist on the wire; reconciliation reports last-known controller from legacy `ControlChanged` with `controlRevision: 0` = "legacy, unknown" (unambiguous because 1.5 authorities start at 1) — clients treat control state as advisory (LWW reclaim, §4.2.3's 1.4 row) and never CAS against revision 0. |
| **minor ≤ 11 local client** ⇄ minor-12 daemon | Client receives none of the new events (gated), sends none of the new commands, and keeps Phase-0 behavior; remote sessions freeze on outage exactly as today — degraded but never socket-fatal. **Controller updates are not lost**: when the daemon's internal state carries `ControlState(Some(...))`, it downgrades the event to legacy `control-changed` for ≤ 11 clients; only clears (`None`) remain invisible to them, exactly as today. |

New server events (same JSON envelope as `control-changed`):

```jsonc
{ "type": "remote-session-state-changed",
  "sessionId": "…", "lifecycleSeq": 7,
  "deviceId": "…", "deviceName": "studio-mac",
  "state": "reconnecting",            // opening | live | synchronizing | reconnecting | suspended | ended
                                       // "opening" is the §3 initial state and IS on the wire —
                                       // clients render no banner for it; implementations split
                                       // once because this list omitted it
  "reason": null,                      // ended: session-closed | session-exited | session-unavailable | host-restarted | host-shutdown | closed-locally
  "exit": null,                        // for session-exited: { "code": 1 } when known
  "attempt": 3, "nextRetryMs": 4000, "lastContactMs": 12000 }
  // attempt, nextRetryMs, lastContactMs are number|null and exit is
  // {code: number|null}|null — a Phase-1 daemon with no engine sends null
  // rather than inventing zeros; clients accept null for exactly these
  // fields and are strict everywhere else.

{ "type": "view-state-changed",
  "sessionId": "…", "viewId": "…",
  "viewStateSeq": 12,                  // monotonic per view — see below
  "viewState": "attached",             // pending | attached | failed
  "attachmentEpoch": 9,                // null unless attached
  "readWrite": true,                   // null unless attached — there is no
                                       // authoritative access level without
                                       // a live attachment; UIs may keep
                                       // showing their last-known value
  "error": null, "retryable": null }   // populated when failed

{ "type": "control-state",             // gated; supersedes control-changed
  "sessionId": "…",                    // for ≥-minor clients (§4.2.3)
  "controller": null,                  // null = no controller — finally
                                       // expressible locally; or
                                       // { "viewId": "…", "controlEpoch": 5 }
  "controlRevision": 17,
  "cols": 120, "rows": 40, "layoutEpoch": 3 }
```

Per-view transitions race — a delayed `failed` from an abandoned attempt
must not overwrite a newer `attached` (and, being distinct events rather
than lag, this would not trigger `events-lost`). Every `view-state-changed`
and every reconciliation `views[]` entry therefore carries a monotonic
per-view **`viewStateSeq`**, assigned by the daemon's per-view state owner;
consumers drop anything ≤ the last sequence they applied, exactly as
`lifecycleSeq` protects session-level events. **The `attach-session` RPC
response is inside this fence too**: the React runtime today applies
`view-attached` directly (`runtime.ts:841–848`), outside any ordering — a
response racing a newer sequenced event could regress view state. The
response therefore carries the same `viewStateSeq`, and the runtime applies
it through the identical ≤-comparison; there is exactly one mutation path
for per-view state, whether the update arrived as an event, a
reconciliation, or an RPC response.

`view-state-changed` replaces the earlier `view-attachment-changed` sketch:
the per-view model has three states (§4.5) and the schema must represent all
of them — `attachmentEpoch: null` alone cannot distinguish pending from
failed, and a failed view needs error/retryability for the per-pane UI.

**Attachment epochs are never broadcast-dependent**: the daemon event channel
is a lossy broadcast that already emits `events-lost` on lag
(`service.rs:693–706`). Therefore:

- The daemon's per-client `attached` map records only *ownership*. Epoch,
  view state, and `read_write` are fetched from the authoritative source at
  use time: the local `ViewAuthority` for local sessions, and a new
  `MeshRuntime::current_attachment(session_id, view_id)` for remote ones.
  `attach-session` on a dead view therefore re-dials instead of returning a
  stale cached epoch — fixing the `service.rs:996–1009` bug as a side
  effect. The ownership record also authorizes offline `selection-text`.
- Reconciliation rebuilds client state completely — **including controller
  state**, because a lost nullable `control-state` clear would otherwise
  leave a stale `controlEpoch` with no repair path (the whole point of
  reconciliation):
  `get-remote-session-state { sessionId }` →
  `{ state, reason, exit, lifecycleSeq, deviceId, deviceName, attempt,
     nextRetryMs, lastContactMs,
     controller: { viewId, controlEpoch } | null,
     controlRevision, cols, rows, layoutEpoch,
     views: [{ viewId, viewStateSeq, viewState,
               attachmentEpoch: number | null,
               readWrite: boolean | null, error, retryable }] }`
  for all caller-owned views. **`attachmentEpoch` and `readWrite` are null
  whenever the view is not `attached`** — inventing either would recreate
  the staleness bug. The
  React runtime clears its cached per-view epoch on null **and clears
  `pendingInput`** (§4.3), re-arming from `view-state-changed` or the next
  reconcile. The runtime calls reconcile for every open remote session on
  `events-lost` (mirroring `runtime.ts:314–319`).
- `view-state-changed` remains the low-latency push; it is an optimization,
  not the source of truth.
- **Advisory fields are open, never strict**: the validator tolerates
  unknown *extra* fields (pinned by test), so optional advisory additions
  (e.g. `scope` on `selection-text`) ship without a minor bump — but their
  *values* must be open enums on the client (`known | (string & {})`),
  never strict unions: a strict enum on an advisory field turns a future
  value into socket destruction for every released client. Same principle
  as `AttachRejectCode`'s `#[serde(other)] Unknown` (§6.2).
- **Hello snapshot**: when a ≥ 12 client completes `hello`, the daemon
  emits one `remote-session-state-changed` per currently open remote
  session on that connection. Without this, a workspace restored from
  persistence after an app restart has no way to learn that an
  already-open session is remote (it never called `open-remote-session`
  and no lifecycle transition may occur for hours) — it would fall back to
  local-session input queueing and show no banner for an already-offline
  session.

Commands (gated on the local control minor):

- `reconnect-remote-session { sessionId }` — manual retry from Suspended.
- `retry-remote-view { sessionId, viewId }` — per-pane retry for a failed
  view (§4.5/§8.1).
- `get-remote-session-state { sessionId }` — as above.

Also folded in: `refresh-session` on a Live remote session performs a true
remote refresh — but **not** via `RequestSnapshot` on QUIC, which does not
reset the existing stream: it spawns a *second* persistent state stream
(`lib.rs:1905–1915`), leaving two feeds with independent patch sequences —
the §4.5 collision reintroduced through the back door. On QUIC, refresh is a
**generation-advanced re-attach of the feed view** (the §4.5 promotion
machinery: fresh stream, full snapshot, reset sequencing, old feed retired
by the generation bump), passing through Synchronizing. On compact,
`RequestSnapshot` is already correct — it emits an in-band snapshot on the
single existing stream and resets the server-side patch sequence
(`lib.rs:1432–1441`) — so compact keeps it.

## 8. UX specification

### 8.1 Desktop (ghosttea-react workspace)

The pane hosting the remote session owns the presentation; the tab strip gets
a status dot reusing the activity-indicator vocabulary. All status text goes
through the existing `role="status"` live-region pattern
(`Workspace.tsx:813`). Banner device names come from the lifecycle events
(§7).

- **Grace window (0–2 s of Reconnecting)**: no visible change.
- **Reconnecting (> 2 s)**: slim non-modal banner docked to the pane top:
  `⟳ Connection to ⟨device⟩ lost — reconnecting… · last contact 12 s ago`
  (mosh-style honest clock). Terminal content stays visible but visually
  "cooled" (reduced saturation/contrast, `prefers-reduced-motion`-safe
  spinner). The cursor stops blinking. First swallowed keypress triggers a
  transient inline hint: `Keystrokes are not delivered while reconnecting`
  (and they are dropped, not queued — §4.3). Copying the visible screen
  keeps working via §4.4.
- **Synchronizing**: banner shows `⟳ Restoring session…`; still cooled,
  input still blocked.
- **Resumed**: input unblocks per view on Live + that view's
  `view-state-changed: attached`. The visual un-cool is tied to the frame
  actually being applied: the render worker posts a new
  **`frame-committed { sessionHandle, sessionEpoch, frameSequence }`**
  acknowledgement after it has applied a frame and scheduled invalidation —
  the existing `frame-resync-complete` cannot serve here because it carries
  no sequence and fires before invalidation
  (`terminal-render.worker.ts:823–825`). The runtime removes the cooling
  class on the **first `frame-committed` after the session reaches live** —
  not a raw "frameSequence ≥ recovery sequence" comparison, because
  per-stream patch sequences restart at 0 on re-attach (§0) and a
  pre-outage baseline is not comparable. The specialization is sound
  because live is only committed after the recovery snapshot is ingested
  (§3's Live invariant), making the first post-live commit the recovery
  frame or later by construction. The guarantee is commit-level ("after
  the worker commits the full frame"), not GPU-paint-level. Banner swaps
  to `✓ Reconnected` for 2 s. Control reclaim per §4.2.3 requires no user
  action.
- **Suspended**: persistent, actionable banner:
  `⟨device⟩ is offline · waiting for it to return  [Retry now] [Close]`.
  Auto-resume stays armed; "Retry now" maps to `reconnect-remote-session`.
- **Ended**: banner states the truth per reason and evidence —
  `Session ended — the host restarted. This is a frozen snapshot of the last
  screen.` / `Process exited (code 1) on ⟨device⟩.` / for
  `session-unavailable`: `This session is no longer available on ⟨device⟩.`
  Buttons: `[Browse sessions on ⟨device⟩] [Close]`. The frozen viewport
  remains visible and copyable (§4.4). "Browse sessions" opens the existing
  RemoteSessionPalette **pre-filtered to that device** (a new palette prop;
  today it lists all hosts, `RemoteSessionPalette.tsx:79–93`; there is no
  "create session on host" operation in the protocol, so the affordance is
  browsing, not creating).
- **Read-only viewers**: identical states minus the keystroke messaging.
- **Per-pane view failure** (§4.5): a pane whose own view is `failed` while
  the session is otherwise Live shows a compact inline
  `View not attached · [Retry]` state (backed by `retry-remote-view` and the
  `error`/`retryable` fields) instead of the session banner.

### 8.2 iOS (GhostteaKit / GhostteaApp)

- **Per-attachment lifecycle, not global runtime state**:
  `GhostteaTruffleRuntimePhase` maps the shared mesh/auth runtime
  (`GhostteaTruffleRuntime.swift:6–18`) and stays untouched. A per-attachment
  actor (`GhostteaAttachmentLifecycle`) owns the §3 state machine, publishing
  `live | synchronizing | reconnecting | suspended | ended(reason)` to its
  scene.
- Drive the same banner vocabulary as the SSH app model's existing
  "Reconnect available" language (`GhostteaSSHAppModel.swift:262+`).
- Backgrounding is an **explicit, orderly suspend**: on
  `scenePhase → background`, stop the heartbeat, close the compact
  connection, record `suspended-by-app`. On foreground, dial immediately and
  show the retained last frame with the standard Reconnecting treatment
  until Live — a pre-first-frame reconnect cannot be guaranteed and is not
  promised.
- The compact client implements §5's compact heartbeat, §4.2 fencing
  (takeover + resume generation against 1.5; rotation against 1.4; the
  §4.2.2 generation gate), and persists the negotiated minor; constants
  shared via a small generated header to keep timings in lockstep with Rust.

## 9. Robustness inventory

- **Epoch fencing, uniformly (1.5)**: input, resize, control claim, cleanup,
  and host state streams are all bound to the current attachment epoch;
  controller records carry the epoch and are invalidated on takeover; resume
  attempts — initial and resume alike — are totally ordered by
  `attach_generation`, so delayed duplicates lose deterministically.
- **1.4 fencing is honestly weaker**: rotation isolates identity, cleanup,
  and inbound state; it cannot stop already-delivered pre-outage messages
  from acting until the host observes the old connection's death. Bounded by
  QUIC close semantics plus the post-resume zombie purge (§4.2.1). Strict
  fencing ⇒ 1.5.
- **State ingestion**: generation-gated with activate-before-publish
  ordering (§4.2.2) and single-feed per session with sticky election and
  re-attach promotion (§4.5).
- **No replay, precisely scoped**: no keystroke *accepted by the client
  while a pane is not input-ready* is ever delivered — the queue is disabled
  and cleared in every non-Live remote state including Opening (§4.3). This
  guarantee is about client-held input; it deliberately excludes data
  already submitted to the transport before the outage, which on 1.4 can
  still reach the host within the residual window of §4.2.1 (1.5 takeover
  fences that too, by epoch).
- **Misrouted streams**: existing preface validation (`lib.rs:366–371`) and
  the accept-queue mutex stay as-is; the heartbeat stream has its own
  preface kind and reader (§5).
- **Event ordering**: `lifecycleSeq` + authoritative reconcile; epochs and
  view states are lookup-authoritative and nullable, never
  broadcast-authoritative (§7); the local control protocol is minor-gated so
  old clients never see unknown events (§7).
- **Clocks**: engine and UI timing use monotonic instants with elapsed ms in
  events. The deliberate exception is advertisement expiry — wall-clock by
  protocol design across machines (`expires_at_ms`), used only as a
  discovery hint, never for lifecycle timing.
- **Resource bounds**: one engine per session; dials gated by discovery;
  connect timeout unchanged (20 s); backoff capped; Suspended costs zero
  network; tombstone and resume-generation maps bounded.
- **Concurrent multi-pane**: shared connection-level reconnect; per-view
  re-attach serialized; views added during Reconnecting park until Live;
  per-view readiness per §4.5.

### 9.1 QUIC connection identity (Phase 2 measured finding and decision)

Real-tailnet testing exposed that the host's QUIC identity binding — match
the connection's source IP against the peer registry — silently rots:
durable profiles receive fresh ephemeral tailnet IPs per incarnation, so a
registry-stale address rejects every connection from a legitimate peer
("QUIC source is not a current Truffle peer"), which surfaces on the
viewer as dead-on-arrival dials. Phase 2 therefore binds identity from
`ClientHello.local_device_id`, validated against the live registry
(current, online, same-app), with the source IP demoted to corroboration.
**Documented caveat**: within the authenticated tailnet + app set, one
peer may now assert another's device id and inherit its `client_id` —
affecting view bookkeeping generally, and input only under
`allow_tailnet_write`/shared-capability configs, which already declare
every peer trusted. The compact path is unaffected (it has transport
WhoIs). Proper closure is a Phase 3 item: a WhoIs-equivalent identity on
QUIC connections from truffle-core, restoring cryptographic binding.

> **Closed at Phase 3 (2026-07-31):** the host resolves
> `Node::whois(remote_address())` at QUIC accept. Where the provider
> supports WhoIs, the tailnet-authenticated identity is authoritative and
> the asserted `ClientHello.local_device_id` must correspond to it;
> mismatch or an anonymous answer rejects the connection. The Phase-2
> hello+registry validation remains only as the fallback for providers
> without WhoIs support (in-process tests). The impersonation caveat
> above no longer applies to tailnet-backed hosts.

## 10. Testing strategy

- **Rust (deterministic, loopback mesh — extend the existing in-crate
  tests)**:
  - kill listener mid-stream → Reconnecting; restart same
    `host_instance_id`/registry → auto-resume through Synchronizing → Live,
    fresh epoch, snapshot applied, input accepted with new epoch only.
  - **zombie-cleanup race**: old server-side handler outlives a resume, then
    dies — resumed attachment survives (1.5 takeover and 1.4 rotation).
  - **delayed stale operations**: after takeover, deliver old-epoch
    `FocusAndResize`, `Resize`, `Input`, and a stale host snapshot/patch —
    all rejected/dropped; the new incarnation still claims control cleanly.
  - **delayed duplicate resume**: an `AttachView` with an older
    `attach_generation` arriving after a newer takeover is rejected
    (`stale-resume`) and does not disturb the current attachment — including
    the detached case: detach the view first, then deliver the delayed old
    attempt over its still-open connection; the surviving watermark must
    still reject it.
  - **mixed-version decode**: a 1.5 viewer decodes a 1.4 `ViewAttached`
    (no `resumed`/`controller`/`control_revision`) and a 1.4 `ControlChanged`
    without error; defaults apply.
  - **`wants_state: false`**: attach completes with no state stream and no
    snapshot; `ViewAttached` satisfies the per-view barrier half only — a
    secondary attached while the feed is Synchronizing stays input-blocked
    until the session reaches Live.
  - **delayed initial attach**: an initial `AttachView` that reached the
    host but timed out client-side, retried with a bumped
    `attach_generation` (1.5) or rotated wire id (1.4), never yields two
    handlers holding the same epoch; the delayed original is rejected
    (`stale-resume`) or lands on a dead identity.
  - **refresh without stream collision**: `refresh-session` on Live QUIC
    re-attaches the feed under a new generation — exactly one state stream
    feeds the replica afterward; compact refresh resets sequence in-band.
  - **zombie side-channel gating**: after recovery, a zombie reader
    delivering `ControlChanged`/`ControlState`, `ActivityChanged`, or
    `SessionEnded` is dropped by the generation gate — controller, activity,
    and lifecycle state are untouched.
  - **compact codec mixes**: a 1.4 Swift decoder never receives a `"cs"`
    frame; a 1.5 decoder accepts both `"c"` and `"cs"`; existing tuple
    shapes are byte-identical to 1.4.
  - **watermark GC**: watermarks stamped by a closed connection with the
    view detached are collected; a live-fencing watermark never is; the
    257th outstanding key from one client is rejected (`view-limit`)
    without affecting another client's attaches.
  - **generation activation ordering**: the recovery snapshot published
    immediately after reader swap is admitted; a zombie publish delivered in
    the same window is dropped.
  - **multi-view**: feed election at activation; sticky under later smaller
    ids; secondary drain; per-view input gating; **feed promotion as
    re-attach** with sequencing reset on both 1.5 (`wants_state` flip) and
    1.4 (rotation) paths.
  - **1.4 residual window**: pre-outage in-flight input delivered post-resume
    is accepted (documents the degraded guarantee); the zombie purge evicts
    **every** superseded generation — including several stranded by
    consecutive timed-out attach attempts — and frees a zombie-held
    controller.
  - restart with new `host_instance_id` → Ended { host-restarted } without a
    dial storm.
  - end-reason evidence: exited-then-dropped during outage → tombstone
    yields Ended { session-exited } with code (1.5) vs
    Ended { session-unavailable } (1.4); explicit close →
    Ended { session-closed }; exited-but-attachable resumes with metadata.
  - heartbeat: black-holed connection detected ≤ 6 s; state traffic
    suppresses pings; 1.4 probe reaches the cached connection with an
    expired advertisement.
  - controller reclaim honors the asymmetric outcomes (§4.2.3): a CAS
    rejection announcing **another controller** ends the reclaim — no
    retry is sent; a rejection announcing **no controller** at a newer
    revision is retried with the updated revision and succeeds while focus
    remains meaningful.
  - **overlapping-connection watermark GC**: attach gen N on connection A
    (delayed), take over with gen N+1 on connection B, detach and close B —
    the watermark must survive (A is ≤ `fence_conn_id` and still live);
    A's delayed gen-N attach is rejected; only after A fully terminates
    (handlers joined) is the watermark collected.
  - **feed re-election on attach failure**: elected feed's attach fails →
    next eligible view is elected within the same activation and the
    session reaches Live; all views failing → resume attempt fails to
    Reconnecting, never a silent hang.
  - **tombstone cause race**: concurrent explicit close and process exit →
    exactly one tombstone, `exited { code }` whenever exit was observed
    first, never two writes; repeated for owner-closure vs exit.
  - **cancel-vs-registration race**: fire a takeover while the old
    handler is between attach and stream registration — the stale
    registration must fail its epoch check and abort; no superseded stream
    ever runs. Also fire it immediately *after* registration: no setup
    write (preface/snapshot/control/activity) **begins** after cancellation
    is observed, and a frame already in flight at cancellation is dropped
    by the viewer's generation gate — the precise guarantee of §4.2.1, not
    the unachievable "nothing is ever emitted".
  - **liveness scoping, atomic at commit**: a zombie reader delivering
    traffic — or a late `Pong` on a superseded connection — must not
    refresh the current connection's `last_contact`; a black-holed current
    connection is still detected in ≤ 6 s. A late `HostShutdown` on a
    superseded connection does not end the session — **including the
    descheduled case**: check currency, park the task, swap connections,
    resume — the commit-time comparison in the lifecycle owner must drop
    it.
  - **rejection code/action table, by role and transport**: on a feed
    attach — `view-invalid` re-elects in place on the same QUIC
    connection; `view-limit` fails the resume attempt **and closes the
    fence-pinning connection first** (a retry on a fresh connection then
    finds slots GC-ed; retrying on the kept connection must be shown to
    preserve the cap); `unknown-session` triggers `SessionStatus` and
    lands on the evidence-backed Ended state; `session-epoch-mismatch`
    lands on Ended { host-restarted }; `stale-resume` is discarded — no
    `failed` mark, no re-election, the superseding attempt's outcome
    stands. On a **secondary** attach — `view-invalid` and `view-limit`
    fail only that pane and an already-Live session stays Live; the
    session-scoped codes produce their session outcome regardless of
    role. On compact, terminal codes end the session, `stale-resume` is
    discarded, and non-terminal failures redial under an advanced
    generation. An unknown code takes the ambiguous path (close +
    advance); a contradictory `retryable` boolean does not alter any of
    the above. An attach timeout closes the connection and advances the
    generation — and a late state stream from the first candidate never
    collides with the next. Against a 1.4 host every failure takes the
    ambiguous path.
  - **Phase-1 one-shot reconnect**: `reconnect-remote-session` on a
    Phase-1 daemon performs exactly one dial + re-attach (advanced
    generation) and returns the resulting `remote-session-state`; no
    backoff loop is started, and a failed one-shot leaves the session in
    its prior lifecycle state.
  - **fence ordering invariants**: connection ids are assigned at raw
    acceptance (a slow-handshaking old connection never orders above the
    fence); a stalled client attempt re-checks currency before writing
    `AttachView` and aborts rather than emitting an old generation on a
    new connection.
  - **wire-id bounds**: a 128-byte local view id rotates into a valid
    hashed wire id on every generation; distinct long ids never collide.
  - offline `selection-text` answered locally, authorized by ownership.
  - fuzz: lifecycle event sequence monotonicity under random kill/restart.
- **TypeScript**:
  - **outage input is never replayed**: type during Opening, Reconnecting,
    and Suspended on a remote session; resume; assert zero emissions and
    cleared `pendingInput`. Local-session initial-mount queueing still
    works.
  - **`viewStateSeq` ordering**: a delayed `failed` event with a lower
    sequence arriving after `attached` is dropped; reconcile with a higher
    sequence wins.
  - per-view input gating incl. epoch cleared to null on reconcile; epoch
    swap ordering; cooling-removal on `frame-committed` sequence.
  - local-protocol compatibility: a client with an older negotiated minor
    receives none of the new events (socket survives); new commands are not
    sent to older daemons.
  - Workspace: each banner state, per-pane failed-view state with retry, the
    events-lost reconcile.
- **Fixture**: `scripts/truffle-fixture.mjs` in the mold of
  `ssh-fixture.mjs`: two local ghosttead profiles;
  `partition`/`heal`/`restart-host` subcommands.
- **iOS**: per-attachment phase transitions; background suspend / foreground
  redial ordering.

## 11. Rollout

1. **Phase 1 — Truth (no tunnel-protocol change; local control minor bump)**:
   lifecycle state machine + gated events (with device identity),
   authoritative-epoch daemon refactor with nullable, per-view-state
   reconciliation (§7), **input-queue disable/clear** (§4.3), viewer-side
   generation gate (§4.2.2), **wire view-id rotation** (§4.2.1 — Phase 1
   ships manual retry, which is unsafe without it), Ended/Suspended UX with
   evidence-honest reasons, frozen viewport copy (§4.4), discovery probe
   triggers with the cached-connection probe.
2. **Phase 2 — Auto-resume (no tunnel-protocol change)**: reconnect engine,
   advertisement fast path, identity fencing, feed-view designation,
   per-view readiness and re-attach promotion (§4.5), zombie purge, 1.4 LWW
   controller reclaim, Reconnecting/Synchronizing/Resumed UX with
   `frame-committed` un-cool, input rejection feedback. Ships with the
   documented 1.4 residual-window caveat (§4.2.1).
3. **Phase 3 — Tunnel protocol 1.5**: ordered attach takeover with uniform
   epoch enforcement and controller/state-stream invalidation,
   epoch-conditional cleanup, attach generations with connection-scoped
   watermark GC, `ControlState`, heartbeat, HostShutdown
   (both framings), SessionEnded, tombstones + SessionStatus, honest
   `attachable`, `wants_state`, attach-response controller info +
   `control_revision` + `expected_control_revision` CAS, persisted
   negotiated minor. Closes the 1.4
   caveat for 1.5 pairs.
4. **Phase 4 — iOS parity**: per-attachment lifecycle actor + compact
   heartbeat + explicit background suspend + UX.

Each phase is independently shippable and reversible; 1.4 ⇄ 1.5 mixes degrade
to Phase-2 behavior by construction of the minor gating.

## 12. Defaults

Knobs live in a new `MeshReconnectConfig` embedded in `TruffleTerminalConfig`
(`ghosttea-truffle`), mirrored in the Swift client configuration — **not** in
`TerminalServiceConfig`, which is strictly local-IPC endpoints and auth
(`service.rs:376–380`).

Measured reality (Phase 2, real tailnet): on a 1.4 pair — i.e. until the
Phase 3 heartbeat ships — outage detection costs **~24 s** (advertisement
TTL 15 s + expiry sweep + probe), not the seconds the heartbeat row
implies; the heartbeat row applies from Phase 3. Also measured: the first
`reconnecting` event carries `attempt 0` / `nextRetryMs null` — backoff
fields appear from attempt 1 — so countdown UIs must tolerate their
absence on the first event.

Measured reality (Phase 3, real tailnet, minor-6 pair, same path/day as
the 24.0 s baseline): outage detection **3.5 s** via the heartbeat,
auto-resume still same-tick on thaw, `ended { session-exited }` delivered
through the tombstone for a session killed mid-outage, and
`ended { host-shutdown }` on SIGTERM. One semantic the goodbye exposed:
a "restart" performed with SIGTERM now correctly concludes
**host-shutdown** (a polite restart is a shutdown followed by a start);
**host-restarted** is reserved for a host that vanished without a word —
the fixture's `restart-host` SIGKILLs to mean exactly that.

| Knob | Default | Rationale |
| --- | --- | --- |
| Grace window before banner | 2 s | hide sub-perceptual blips |
| Heartbeat (idle-triggered) | Ping after 3 s idle / fail after 6 s idle | contact = state traffic or matched Pong on the current incarnation; busy streams never ping — **Phase 3+; see measured note above** |
| Backoff | full jitter: `uniform(0, min(10 s, 0.5 s · 2ⁿ))`, floor 250 ms | fast first retry, kind to hosts |
| `suspend_after` | 10 min | laptop-lid realism before going quiet |
| Advertisement fast path | always on | primary resume trigger |
| Tombstone LRU / TTL | 128 entries / 24 h | bounded, covers realistic outages |
| Input during outage | reject + visible feedback; queue disabled | §4.3, safety over convenience |

## 13. Phase 1 implementation checklist (design frozen at revision 11)

Review ended at revision 11; findings below are **implementation-sequencing
traps**, verified against the code, not design changes.

1. **Separate local and wire view ids before anything else.** `RemoteView`
   stores no wire id (`lib.rs:91–97`), and input, resize, selection,
   detach, state-preface validation, and controller comparisons all use the
   local id directly (e.g. `lib.rs:522`, `:556`). Rotation (§4.2.1)
   requires `{ local_view_id, wire_view_id, generation }` on every view
   record, the wire id on **every** tunnel operation, and controller ids
   translated back to local ids at the daemon boundary.
2. **Replace the attachment retry/cache path before building one-shot
   reconnect.** `attach_view` silently retries and `attach_view_once`
   early-returns any cached `RemoteView` (`lib.rs:282–302`) — so
   "invalidate connection, then attach" can return the stale epoch before
   the dying reader removes its entry, and attach reports success before
   the snapshot applies (`lib.rs:480`). Centralize attempts in the
   lifecycle owner: retire old views synchronously, advance the generation
   for every actual `AttachView` write, dial exactly once for the Phase-1
   command, and await snapshot application before reporting Live.
3. **Run one-shot reconnect off the connection loop, with a real
   timeout.** Network commands are explicitly offloaded via
   `runs_off_connection_loop` (`service.rs:1002–1010`); `reconnect-remote-
   session` must join that list (and stay clear of the loop's
   view-attachment bookkeeping), be single-flight per session, and the
   renderer client's default 10 s request timeout
   (`packages/ghosttea/src/index.ts:28`) must be overridden to cover dial
   + handshake — 60 s.
