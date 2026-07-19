# Ghosttea iOS Phase 0 harness

This is a deliberately small SwiftUI application for completing the physical-device Phase 0 gates. It references `../GhostteaKit` as a local Swift package and exercises the pinned native artifacts through their current proof boundaries.

The production-session surface also hosts the Phase 7 workspace integration.
Its live SSH terminal is represented as an identity-only one-tab/one-pane
workspace and rendered through `GhostteaWorkspaceUI`. Hardware shortcuts are
resolved by `GhostteaWorkspace` before unmatched keys reach terminal encoding;
new-tab and split requests now allocate independent native terminals and SSH
session actors through `GhostteaSSHWorkspace` before the layout commits. The
tab-strip touch controls expose the same requests when no hardware keyboard is
attached, and closing a pane tears down only its corresponding connection.

The harness provides:

- an on-device Ghostty VT create/feed/resize/key-encoding smoke test;
- a real data-protection Keychain save/load/delete smoke test using random
  non-user data;
- deterministic one-, four-, and eight-session physical-footprint measurements before and after scrollback compression;
- an enforceable compact/standard whole-process memory gate that measures one
  active session plus compressed background sessions and starts automatically
  under the device runner;
- an automatic active-SSH gate that pauses application demand during a 32 MiB
  server flood, proves that both delivery and raw socket counters remain fixed,
  then drains the stream exactly under the whole-process memory budget;
- a password-, in-memory private-key-, or keyboard-interactive-authenticated SSH
  command probe with bounded output;
- separate bounded stdout and stderr capture plus deterministic exit-37 and
  remote-signal command presets;
- exact physical-device session probes for initial PTY allocation and resize,
  plus input half-close followed by lossless output drain and clean exit;
- an asynchronous keyboard-interactive challenge sheet that preserves protocol
  name, instruction, prompt ordering, and per-prompt echo policy, with challenge
  cancellation routed through the measured SSH task-cancellation path;
- explicit cancellation with measured unwind latency for physical-device
  adverse-network checks;
- strict TRF1 retained-state, packaged-Metal, GPU lifecycle, grid geometry, and
  visual-golden automation using the production styled Unicode/emoji fixture;
- a focusable TRF1 preview that exercises the production hardware-key and
  `UITextInput` software/IME paths, including the normalized terminal accessory
  row, and reports their exact encoded bytes or application action;
- production pointer routing and safe-area-aware mouse/cell geometry assertions
  in the automatic TRF1 simulator probe;
- interactive indirect-pointer mouse/hover, local wheel scrolling, touch
  selection, and native-model selection extraction on the TRF1 preview;
- secondary-click Copy/Select All/Paste plus cancellable edge autoscroll, with
  clipboard writes performed only after native selection extraction;
- native TRF1 accessibility rows exposed as per-line VoiceOver elements, with
  absolute row metadata, page scrolling, Copy, Select All, and Paste actions;
- automatic Network.framework path monitoring and generation-checked lifecycle
  policy. A selected-route change or background transition tears down the live
  SSH attempt, while path restoration offers (but never silently starts) a
  fresh connection;
- aggregate WindowGroup lifecycle coordination, so backgrounding or closing one
  scene cannot suspend the app-owned session while another scene remains
  active, plus per-scene Metal visibility;
- guided lifecycle probes that select commands and disposable credentials,
  capture teardown latency, enforce the one-second gate, validate exact fresh
  reconnect output, and report pass/fail on the device;
- negotiated host-key and cipher reporting;
- strict known-host verification with explicit reject, accept-once, and atomic accept-and-store decisions.
- a Release-mode physical-device performance gate with 1,000 ordered input
  writes, 1,000 received-byte-to-Metal samples, native text-engine contention
  attribution, and a zero-background-submission assertion. It emits only
  redacted numeric JSON evidence.

The harness is diagnostic scaffolding, not the production terminal UI. Its
offscreen and preview surfaces render TRF1 only for conformance; it does not
store user credentials or attempt to keep SSH alive indefinitely in the
background.
Its Debug UI starts with this development Mac's disposable LAN fixture values
and can reload them with one tap; replace the host when the trusted-network
address changes. These values are test-only and must never be reused elsewhere.

## Reproducible unsigned build

Build the pinned Apple artifacts first, then compile both SDK variants:

```sh
npm run build:ghostty-vt:apple
npm run build:ssh:apple
npm run test:ios:harness
```

The automated build uses unsigned arm64 simulator and device destinations. Outputs go under ignored `native/build/ios-harness/`.
It also composes the two pinned native inputs into the ignored
`GhostteaKit/Artifacts/ghosttea-apple-native.xcframework`; the Swift package
uses this single binary target so Xcode does not flatten two competing
`module.modulemap` files into the same output path.

## Run on a physical device

Run the automatic local-pipeline latency gate with an unlocked device:

```sh
npm run test:ios:performance
```

Passing evidence is written under ignored
`native/build/ios-performance-device/evidence.json`. Energy Log, Time Profiler,
and multi-session scoring remain separate release evidence.

The automated launcher discovers one connected physical iOS device, the sole
development team configured in Xcode, and the Mac's Bonjour hostname. It checks
device lock state, runs package and dual-SDK build gates, and signs the app
before opening a network service. It then waits for an unlocked device, starts
only the disposable password fixture, installs, and launches the harness with
the non-secret hostname and both automatic memory gates enabled. It always removes
the fixture on error, Return, Ctrl-C, or termination:

```sh
npm run test:ios:device
```

The Phase 7 multi-session gate is fully automatic: it creates a second tab,
splits that tab into a third SSH session, validates distinct native-terminal
markers, verifies a secret-free session-to-profile restoration manifest, and
then proves pane, tab, and whole-window teardown ordering. Every session is
constructed from the validated disposable connection profile while receiving
its own native terminal and SSH transport:

```sh
npm run test:ios:production-workspace
```

The same gate atomically writes and reloads the connection-profile and workspace
documents under iOS file protection, recreates all three stable session IDs as
demand-paused handles 706–708, initializes a coordinator only from that exact
registry, and tears the restored resources down before validating the original
connected handles 606–608.
The tab strip also exposes the same searchable commands-and-connections palette
opened by Command-Shift-O. The device automation requires its saved fixture
profile to win a tokenized search before the second tab may be allocated.
That palette includes a reusable saved-connections manager with add, edit, and
delete flows for password, private-key, and keyboard-interactive profiles. In
this diagnostic app its callback validates and immediately releases submitted
secret bytes without persisting them; the production repository and Keychain
mutation semantics are covered independently by package tests. Device
automation also requires the editor to clear every transient secret property
before allocation continues.

Set `GHOSTTEA_IOS_DEVICE_ID` when more than one physical iOS device is connected,
`GHOSTTEA_IOS_DEVELOPMENT_TEAM` when Xcode has zero or multiple teams, or
`GHOSTTEA_IOS_FIXTURE_HOST` to override Bonjour discovery. Keep the command
running while using the app, then press Return to clean up. The launcher never
passes credential bytes through the process environment.

System Wi-Fi changes and application backgrounding remain manual gestures;
ordinary iOS apps are not permitted to perform those actions themselves. The
harness automates setup, command selection, measurement, validation, and result
recording around those gestures.

Manual Xcode fallback:

1. Open `GhostteaHarness.xcodeproj` in Xcode.
2. Select the `GhostteaHarness` target and choose a development team.
3. If necessary, replace `com.vibecook.GhostteaHarness` with a bundle identifier owned by that team.
4. Select an iOS 17 or newer device and run.
5. Record the device model, OS, VT result, and full memory matrix.
6. Run the SSH command probe against the launch-server sample, verify the displayed fingerprint out of band, and exercise both Wi-Fi and cellular transitions.

For the adverse-network diagnostic, first confirm that **Network** reports
`Satisfied · Wi-Fi`. Run a bounded long-lived command, then disable Wi-Fi from
Control Center without tapping **Cancel**. The selected-route change must
automatically cancel the active generation, and **SSH lifecycle** must move to
`Reconnect available` (or `Waiting for network` when no alternate path exists).
Restore Wi-Fi, reload disposable fixture credentials if needed, and explicitly
run the bounded command again. Record both cancellation latency and the fresh
connection result. The harness does not claim that the original SSH session
survives the transition.

Also background the app during a bounded command. It must cancel the live
generation and show `Suspended`; returning to the foreground may offer a fresh
reconnect but must not start one or retain submitted credential bytes.

Password, pasted private-key, and passphrase fields are cleared before each
attempt. The probe stores their bytes only under random opaque IDs in the
device-only, non-synchronizing Keychain, resolves them during authentication,
and deletes every item before reading command output. Keyboard-interactive
answers live only in the challenge sheet and responder call. Use only
disposable fixture credentials in this diagnostic app.
