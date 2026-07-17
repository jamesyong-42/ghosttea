# Ghosttea iOS Phase 0 harness

This is a deliberately small SwiftUI application for completing the physical-device Phase 0 gates. It references `../GhostteaKit` as a local Swift package and exercises the pinned native artifacts through their current proof boundaries.

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
- automatic Network.framework path monitoring and generation-checked lifecycle
  policy. A selected-route change or background transition tears down the live
  SSH attempt, while path restoration offers (but never silently starts) a
  fresh connection;
- guided lifecycle probes that select commands and disposable credentials,
  capture teardown latency, enforce the one-second gate, validate exact fresh
  reconnect output, and report pass/fail on the device;
- negotiated host-key and cipher reporting;
- strict known-host verification with explicit reject, accept-once, and atomic accept-and-store decisions.

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
