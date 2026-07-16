# Phase 0 iOS device evidence

This record captures reproducible physical-device observations from the
checked-in `apple/GhostteaHarness` diagnostic app. It does not contain device
serial numbers, UDIDs, credentials, or host-key material.

## 2026-07-16: Ghostty VT and scrollback memory

Environment:

- harness source: commit `8167f5f` (`feat: add iOS phase zero harness`);
- device: iPhone 14 Pro (`iPhone15,2`);
- operating system: iOS 26.5;
- reported physical memory: 5,662 MiB;
- toolchain: Xcode 26.1 with the iOS 26.1 SDK;
- connection: wired, paired, Developer Mode enabled;
- build: automatically signed Debug device build, installed and launched with
  Xcode's CoreDevice tooling.

The VT smoke test passed with the expected result:

```text
100x30, cursor 5,0, key [97]
```

The deterministic 80-column, 5,000-line memory matrix completed as follows.
Values are process physical-footprint deltas captured by the harness, not a
breakdown of every terminal-owned allocation.

| Sessions |  Empty |  Loaded | After full compression | Retained scrollback rows |
| -------: | -----: | ------: | ---------------------: | -----------------------: |
|        1 | 128 KB |  3.3 MB |               1,008 KB |                    4,977 |
|        4 | 512 KB | 13.5 MB |                 4.4 MB |        4,977 per session |
|        8 |   1 MB | 27.1 MB |                 6.6 MB |        4,977 per session |

All sessions reported full scrollback compression support. The loaded result
scaled approximately linearly to eight sessions, while compression reduced the
eight-session delta by about 76%. These measurements cover raw Ghostty VT state
only. They exclude the future Ghosttea model, TRF1 buffers, text shaping,
decoded images, Metal resources, transport state, and application UI budgets.

The physical-device VT build/run gate is satisfied. The same harness still
needs launch-server SSH, adverse-network transition, and complete terminal-stack
memory evidence before Phase 0 can close.
