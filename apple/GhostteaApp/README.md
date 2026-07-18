# Ghosttea iOS app

This is the production application composition target. Unlike
`GhostteaHarness`, it contains no fixture credentials, automated gates, or
diagnostic controls. Its shared-session flow owns the in-process Truffle node,
interactive Tailscale login, peer/session browsing, logical replica, Metal
terminal surface, keyboard/mouse/selection input, control state, and foreground
snapshot resynchronization.

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

For a signed-device interoperability run, keep the app's debug console attached
until the app exits:

```bash
npm run run:ios:app:console
```

Set `GHOSTTEA_IOS_DEVELOPMENT_TEAM` or `GHOSTTEA_IOS_DEVICE_ID` only when Xcode
has multiple teams or more than one physical iOS device is paired.
