# Ghosttea iOS app

This is the production application composition target. Unlike
`GhostteaHarness`, it contains no fixture credentials, automated gates, or
diagnostic controls. Its shared-session flow owns the in-process Truffle node,
interactive Tailscale login, peer/session browsing, logical replica, Metal
terminal surface, keyboard/mouse/selection input, control state, and foreground
snapshot resynchronization.

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
