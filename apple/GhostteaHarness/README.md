# Ghosttea iOS Phase 0 harness

This is a deliberately small SwiftUI application for completing the physical-device Phase 0 gates. It references `../GhostteaKit` as a local Swift package and exercises the pinned native artifacts through their current proof boundaries.

The harness provides:

- an on-device Ghostty VT create/feed/resize/key-encoding smoke test;
- a real data-protection Keychain save/load/delete smoke test using random
  non-user data;
- deterministic one-, four-, and eight-session physical-footprint measurements before and after scrollback compression;
- a password-, in-memory private-key-, or keyboard-interactive-authenticated SSH
  command probe with bounded output;
- an asynchronous keyboard-interactive challenge sheet that preserves protocol
  name, instruction, prompt ordering, and per-prompt echo policy;
- explicit cancellation with measured unwind latency for physical-device
  adverse-network checks;
- negotiated host-key and cipher reporting;
- strict known-host verification with explicit reject, accept-once, and atomic accept-and-store decisions.

The harness is diagnostic scaffolding, not the production terminal UI. It does not render TRF1 frames, store credentials, or attempt to keep SSH alive indefinitely in the background.

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

1. Open `GhostteaHarness.xcodeproj` in Xcode.
2. Select the `GhostteaHarness` target and choose a development team.
3. If necessary, replace `com.vibecook.GhostteaHarness` with a bundle identifier owned by that team.
4. Select an iOS 17 or newer device and run.
5. Record the device model, OS, VT result, and full memory matrix.
6. Run the SSH command probe against the launch-server sample, verify the displayed fingerprint out of band, and exercise both Wi-Fi and cellular transitions.

For the adverse-network diagnostic, run a bounded long-lived command, interrupt
the active network path, and tap **Cancel**. Record the displayed cancellation
latency, restore the path, then run the bounded command again to prove an
explicit fresh connection. The harness does not claim that the original SSH
session survives the transition.

Password, pasted private-key, and passphrase fields are cleared before each
attempt. The probe stores their bytes only under random opaque IDs in the
device-only, non-synchronizing Keychain, resolves them during authentication,
and deletes every item before reading command output. Keyboard-interactive
answers live only in the challenge sheet and responder call. Use only
disposable fixture credentials in this diagnostic app.
