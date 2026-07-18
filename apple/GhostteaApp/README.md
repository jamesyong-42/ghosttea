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

The browser's About button opens the human-readable third-party notices bundled
with the application. `npm run check:ios-release-resources` verifies those
notices and the bundled CycloneDX BOM against the reviewed release-resource
lock. `npm run archive:ios:app` repeats the check against the built `.app`.

The app bundle also contains its reviewed privacy manifest, while the embedded
TailscaleKit framework contains a separate manifest installed by the pinned
Truffle materializer. `npm run check:ios-app-store` verifies their hashes,
required-reason API contract, project resources, and the explicit
`ITSAppUsesNonExemptEncryption=YES` declaration. The `--app-bundle` gate audits
the exact linked symbols and semantically compares Xcode's packaged plists.
`npm run check:ios-app-store-ready` additionally fails until the privacy label
and in-app policy URL, encryption determination, and reviewer fixture access
are approved. See
[`../GhostteaKit/Compatibility/app-store-review-notes.md`](../GhostteaKit/Compatibility/app-store-review-notes.md).

The production app also shares one `GhostteaDiagnosticRecorder` across every
scene and both connection modes. It persists only audited codes, severities,
sequences, and timestamps in a bounded, atomic, file-protected record. Raw
errors, connection metadata, commands, credentials, and terminal content have
no place in the schema. Users can copy the redacted JSON from the About sheet;
`npm run check:ios-diagnostics` prevents raw error interpolation from returning
to production app and terminal-renderer surfaces.

Every production terminal surface also closes the renderer memory-pressure
recovery loop. A UIKit memory warning releases the fixed 20 MiB glyph atlases
and CPU glyph/style render payloads while preserving readable row text. Shared
sessions request a full snapshot from their desktop Truffle attachment; direct
SSH sessions request a full frame from their local core. Drawing resumes and
GPU state rebuilds only after that full snapshot is applied. The exact contract
and remaining whole-app budget work are documented in
[`../GhostteaKit/Compatibility/memory-pressure.md`](../GhostteaKit/Compatibility/memory-pressure.md).
The application also compresses Ghostty scrollback for hidden SSH tabs in
stable workspace order while protecting every pane in the selected tab. If the
live registry still exceeds the compact/standard four/eight-session target, it
disconnects and evicts the least-recently-used hidden terminals while retaining
their secret-free pane and profile identities. Selecting or reconnecting a cold
pane creates a fresh terminal and transport under the same workspace session ID
but leaves SSH demand-paused until the user explicitly reconnects.

The deterministic iPad gate selects an available iPad Simulator, boots it when
needed, builds and installs the production app target, opens a real second
`WindowGroup` scene, verifies shared runtime and distinct terminal identities,
closes that exact scene, and verifies one survivor:

```bash
npm run test:ios:app:multiscene
```

Set `GHOSTTEA_IOS_SIMULATOR_ID` only when a specific installed iPad simulator
must be used. The probe and its environment trigger are compiled only in DEBUG.

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
path, arm64 executable, signing identity, configured team signature, packaged
BOM, and notices at
`native/build/ios-app/archive/Ghosttea.xcarchive`. It also writes a deterministic
`Ghosttea.release-evidence.json` with source/lock hashes, content-tree hashes,
signature metadata, executable and dSYM UUIDs, and explicit policy blockers.

An existing App Store export can be checked with:

```bash
npm run validate:ios:release-artifact -- \
  --archive native/build/ios-app/archive/Ghosttea.xcarchive \
  --ipa /path/to/Ghosttea.ipa \
  --release
```

For one coherent build/export/validation chain, provide account-owned export
options without checking them into the repository:

```bash
GHOSTTEA_IOS_EXPORT_OPTIONS_PLIST=/secure/path/ExportOptions.plist \
GHOSTTEA_IOS_RELEASE=1 \
npm run archive:ios:app
```

The IPA must contain one safe payload app, match the archive identity and
executable, carry the reviewed resources, have a valid trusted signature, and
use Apple Distribution signing before the evidence can become eligible.
Producing that distribution export remains a release-account step.
`GHOSTTEA_IOS_RELEASE=1` makes the command exit nonzero after writing evidence
when any eligibility blocker remains. `GHOSTTEA_IOS_IPA` is also accepted for
an IPA already exported from the exact archive being validated.

Set `GHOSTTEA_IOS_DEVELOPMENT_TEAM` or `GHOSTTEA_IOS_DEVICE_ID` only when Xcode
has multiple teams or more than one physical iOS device is paired.
