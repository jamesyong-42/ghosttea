# Ghosttea iOS app

This is the production application composition target. Unlike
`GhostteaHarness`, it contains no fixture credentials, automated gates, or
diagnostic controls. Its shared-session flow owns the in-process Truffle node,
interactive Tailscale login, peer/session browsing, logical replica, Metal
terminal surface, keyboard/mouse/selection input, control state, and foreground
snapshot resynchronization.

The Truffle node is application-owned, but every `WindowGroup` scene owns its
own shared-session browser, logical replica, Metal surface, attachment task,
grid, control epoch, and stable view ID. On iPad, the New Window toolbar action
opens another Stage Manager window without starting a second embedded
Tailscale runtime. Closing a window cancels any in-flight attach and detaches
only that scene's remote view; other windows and the private mesh remain live.

The production app also composes saved direct-SSH connections. Non-secret
profiles are protected application-support documents; password, private-key,
and passphrase material is stored only behind device-only Keychain references.
The SSH tab handles host-key trust, keyboard-interactive challenges, route and
background lifecycle changes, PTY resize, and the same Metal/input/selection
surface as shared sessions. Tabs and splits own independent terminals and
transports. Their secret-free profile bindings are persisted atomically with
complete file protection; process restoration recreates them demand-paused and
requires an explicit reconnect. The adaptive command palette exposes saved
connections and workspace actions, while hardware-keyboard chords share the
same command-routing boundary as the desktop workspace.

The app requires iOS 18.1 or newer, matching the minimum deployment target of
the pinned TailscaleKit binary. Simulator builds are arm64-only because the
Ghosttea native core is intentionally distributed without an x86_64 slice.

The local Truffle package must have its pinned TailscaleKit artifact
materialized before resolving the project:

```bash
cd ../../../p008/truffle/apple
./scripts/materialize-tailscalekit.sh

cd ../../../electron-ghostty/apple/GhostteaApp
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project GhostteaApp.xcodeproj -scheme Ghosttea \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

With one paired iPhone or iPad connected, the repository runner selects the
configured Xcode team, signs, installs, and launches the app:

```bash
npm run run:ios:app
```

The DEBUG build contains deterministic, opt-in signed-device gates; neither is
reachable from the production UI or a Release build. With the desktop demo
running, the shared-session gate creates two simultaneous iOS attachments and
proves control handoff, exact resize, snapshot, selection, detach, and fresh
reconnect:

```bash
npm run test:ios:app:interop
```

The restart gate attaches, prints a ready marker, and waits while the desktop
demo process is restarted. It then proves the old session is rejected and a
fresh attachment and snapshot succeed. Tailnet peer generation may remain
stable across this restart; the desktop `hostInstanceID` must change.

```bash
npm run test:ios:app:restart
```

For ordinary signed-device debugging with streaming console output, use
`npm run run:ios:app:console`.

The first signed-device desktop/iPhone gate completed on 2026-07-18: the app
discovered the Electron demo, attached read-write to its desktop-authoritative
session, rendered its logical state locally, and sent input whose output was
observed in the concurrent desktop view. See
[`../GhostteaKit/Compatibility/ios-device-evidence.md`](../GhostteaKit/Compatibility/ios-device-evidence.md)
for the complete automated evidence and the remaining physical iPad/release
matrix.

Create and verify the signed Release archive with:

```bash
npm run archive:ios:app
```

The archive runner verifies the application, dSYM, bundle ID, application
path, arm64 executable, signing identity, and configured team signature at
`native/build/ios-app/archive/Ghosttea.xcarchive`. App Store distribution export
remains a release-account step.

Set `GHOSTTEA_IOS_DEVELOPMENT_TEAM` or `GHOSTTEA_IOS_DEVICE_ID` only when Xcode
has multiple teams or more than one physical iOS device is paired.
