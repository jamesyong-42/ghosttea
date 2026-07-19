# iOS beta qualification matrix

**Status:** contract implemented; physical matrix evidence open

[`ios-beta-matrix.json`](ios-beta-matrix.json) is the authoritative device and
real-application coverage contract for an external beta or App Store release
candidate. It prevents a collection of convenient simulator runs or one modern
iPhone from being described as the product's device matrix.

## Required physical coverage

One exact release artifact must pass on at least:

- a current compact iPhone;
- a current large iPhone;
- a current iPad using touch and the software keyboard;
- a current iPad with a hardware keyboard and pointing device; and
- physical 60 Hz and 120 Hz displays.

Direct SSH shell behavior, desktop/iOS Truffle continuity, lifecycle/network
recovery, and Unicode/IME behavior must pass on every device class. The local
Release performance gate must pass at both refresh rates. The Stage Manager and
hardware keyboard/pointer scenarios must pass on the corresponding physical
iPad class; the simulator multi-scene command remains required automatic
structural evidence but is not a substitute for the manual physical run.

Memory-pressure recovery and process restoration require both methods on every
device class. Their automatic commands prove deterministic over-soft LRU and
host-terminated restoration against the signed production Debug app. The
manual records must come from the exact release artifact under an OS-delivered
memory warning and actual system-pressure termination/foreground recovery;
the deterministic proxies cannot fill those manual rows.

The application matrix contains 24 scenarios spanning shells, Vim, Neovim,
tmux, Zellij, htop/btop, less/man, fzf, interactive Git, a language REPL,
Codex, Claude Code, Unicode/IME, accessibility, high-volume resize, workspace
persistence, lifecycle recovery, performance, memory-pressure recovery,
process restoration, and shared-session continuity.
The checked manifest identifies which scenarios require an automatic trace, a
manual trace, or both, and verifies that every referenced npm command exists.

## Ordinary and release gates

Validate the checked contract without claiming physical coverage:

```sh
npm run check:ios-beta-matrix
```

This ordinary gate validates the manifest and any evidence files present. It
reports missing release coverage but exits successfully when evidence has not
yet been collected, allowing normal development to continue.

The fail-closed form is included in `npm run check:ios-release-ready`:

```sh
node scripts/check-ios-beta-matrix.mjs --release \
  --evidence-dir /secure/release/ios-beta-evidence
```

`GHOSTTEA_IOS_BETA_EVIDENCE_DIR` can supply the same directory to the release
aggregator. Release mode requires every device, refresh, scenario, method, and
scenario-specific device constraint. It also requires every evidence file to
reference the current Git revision and one common release-artifact evidence
hash.

## Redacted evidence schema

Each `.json` file in the evidence directory describes one physical device run:

```json
{
  "schemaVersion": 1,
  "matrixSha256": "<sha256 of ios-beta-matrix.json>",
  "sourceRevision": "<full Git commit>",
  "sourceClean": true,
  "artifactEvidenceSha256": "<signed archive/IPA evidence sha256>",
  "recordedAt": "2026-07-18T00:00:00Z",
  "device": {
    "classId": "compactPhone",
    "modelIdentifier": "iPhone15,2",
    "systemVersion": "26.5.2",
    "maximumFramesPerSecond": 120,
    "hardwareKeyboard": false,
    "pointingDevice": false
  },
  "scenarios": [
    {
      "id": "direct-ssh-shell",
      "method": "automatic",
      "result": "pass",
      "evidenceSha256": "<retained console or Instruments trace sha256>"
    }
  ]
}
```

The validator rejects unknown keys, scenario IDs, or methods. Evidence may
contain the Apple model identifier, OS version, refresh rate, capability booleans,
timestamps, revisions, and hashes. It must not contain a device name or UDID,
host, username, path, command, terminal content, credential, diagnostic string,
or free-form test note. External reasons for a rejected run belong beside the
retained trace in the access-controlled release record, not in this JSON.

Every scenario entry hashes its retained automatic console, screenshot bundle,
manual test record, or Instruments trace. The release artifact hash binds all
device runs to the same signed candidate. Evidence collected from another
source revision or artifact cannot silently fill a matrix hole.

## Current state

The signed iPhone 14 Pro runs already prove many automatic cases during
development, including the 120 Hz performance gate. They were not collected
from one clean Apple Distribution release artifact under this schema and are
therefore not backfilled as release evidence. The beta matrix remains
deliberately blocked until the complete physical campaign is run against the
actual candidate.
