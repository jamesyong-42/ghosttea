// swift-tools-version: 6.1

import PackageDescription

// Truffle is consumed from its published repository rather than the sibling
// development checkout. The pin is a Git revision, not a version range: it is
// the same exactness `truffle-swift.lock.json` already required
// (`requireExactRevision`), and it does not depend on Truffle having tagged a
// SemVer release, which its `truffle-vX.Y.Z` tag scheme does not provide.
//
// Keep this equal to `package.revision` in
// `Compatibility/truffle-swift.lock.json`; the App Store readiness check
// compares them and fails closed on drift.
let truffleRepository = "https://github.com/vibecook-dev/truffle.git"
let truffleRevision = "REPLACE_WITH_TRUFFLE_ROOT_MANIFEST_REVISION"

let package = Package(
  name: "GhostteaKit",
  platforms: [
    .iOS("18.1"),
    .macOS(.v14),
  ],
  products: [
    .library(name: "GhostteaCredentials", targets: ["GhostteaCredentials"]),
    .library(name: "GhostteaDiagnostics", targets: ["GhostteaDiagnostics"]),
    .library(name: "GhostteaConnectionProfiles", targets: ["GhostteaConnectionProfiles"]),
    .library(name: "GhostteaConnectionProfilesUI", targets: ["GhostteaConnectionProfilesUI"]),
    .library(name: "GhostteaCore", targets: ["GhostteaCore"]),
    .library(name: "GhostteaFontProof", targets: ["GhostteaFontProof"]),
    .library(name: "GhostteaPerformance", targets: ["GhostteaPerformance"]),
    .library(name: "GhostteaTerminal", targets: ["GhostteaTerminal"]),
    .library(name: "GhostteaSSH", targets: ["GhostteaSSH"]),
    .library(name: "GhostteaSSHWorkspace", targets: ["GhostteaSSHWorkspace"]),
    .library(name: "GhostteaSSHProbe", targets: ["GhostteaSSHProbe"]),
    .library(name: "GhostteaSession", targets: ["GhostteaSession"]),
    .library(name: "GhostteaTransport", targets: ["GhostteaTransport"]),
    .library(name: "GhostteaTruffle", targets: ["GhostteaTruffle"]),
    .library(name: "GhostteaWorkspace", targets: ["GhostteaWorkspace"]),
    .library(name: "GhostteaWorkspaceUI", targets: ["GhostteaWorkspaceUI"]),
    .library(name: "GhosttyVtProof", targets: ["GhosttyVtProof"]),
    .executable(name: "GhosttyVtMemoryProbe", targets: ["GhosttyVtMemoryProbe"]),
  ],
  dependencies: [
    .package(url: truffleRepository, revision: truffleRevision)
  ],
  targets: [
    .binaryTarget(
      name: "GhostteaAppleNative",
      path: "Artifacts/ghosttea-apple-native.xcframework"
    ),
    .target(
      name: "CGhostteaSSH",
      dependencies: ["GhostteaAppleNative"],
      publicHeadersPath: "include"
    ),
    .target(
      name: "GhostteaSSH",
      dependencies: [
        "CGhostteaSSH",
        "GhostteaCore",
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaTransport",
      ]
    ),
    .target(
      name: "GhostteaSSHWorkspace",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCore",
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaWorkspace",
      ]
    ),
    .target(
      name: "GhostteaCredentials",
      linkerSettings: [.linkedFramework("Security")]
    ),
    .target(name: "GhostteaDiagnostics"),
    .target(name: "GhostteaPerformance"),
    .target(
      name: "GhostteaConnectionProfiles",
      dependencies: ["GhostteaCredentials", "GhostteaSSH"]
    ),
    .target(
      name: "GhostteaConnectionProfilesUI",
      dependencies: ["GhostteaConnectionProfiles"]
    ),
    .target(
      name: "GhostteaFontProof",
      dependencies: ["GhostteaAppleNative", "GhostteaFonts"],
      exclude: ["Resources"],
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(
      name: "GhostteaFonts",
      path: "Sources/GhostteaFontProof/Resources",
      resources: [
        .process("Fonts"),
        .copy("FONT-NOTICES.md"),
        .copy("OFL-1.1.txt"),
        .copy("font-parity.json"),
      ]
    ),
    .target(
      name: "GhostteaCore",
      dependencies: ["GhostteaAppleNative", "GhostteaFonts", "GhostteaPerformance"],
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(name: "GhostteaFrame"),
    .target(
      name: "GhostteaSession",
      dependencies: ["GhostteaCore", "GhostteaPerformance", "GhostteaTransport"]
    ),
    .target(
      name: "GhostteaTerminal",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaPerformance", "GhostteaTransport"],
      exclude: ["GhostteaTerminal.metal"],
      resources: [.copy("Resources/terminal-visual-golden.json")],
      linkerSettings: [
        .linkedFramework("Metal"),
        .linkedFramework("MetalKit", .when(platforms: [.iOS])),
        .linkedFramework("UIKit", .when(platforms: [.iOS])),
      ],
      plugins: ["GhostteaMetalCompilerPlugin"]
    ),
    .target(name: "GhostteaTransport"),
    .target(
      name: "GhostteaTruffle",
      dependencies: [
        "GhostteaCore",
        "GhostteaPerformance",
        .product(name: "Truffle", package: "truffle"),
        .product(name: "TruffleTailscale", package: "truffle"),
      ]
    ),
    .target(name: "GhostteaWorkspace"),
    .target(
      name: "GhostteaWorkspaceUI",
      dependencies: ["GhostteaWorkspace"]
    ),
    .target(
      name: "GhostteaSSHProbe",
      dependencies: ["GhostteaTransport", "GhostteaAppleNative"]
    ),
    .target(
      name: "GhosttyVtProof",
      dependencies: ["GhostteaAppleNative", "GhostteaWorkspace"]
    ),
    .executableTarget(
      name: "GhostteaSSHLiveProbe",
      dependencies: ["GhostteaSSH", "GhostteaTransport"]
    ),
    .executableTarget(
      name: "GhosttyVtMemoryProbe",
      dependencies: ["GhosttyVtProof"]
    ),
    .executableTarget(
      name: "GhostteaVisualGoldenRecorder",
      dependencies: ["GhostteaCore", "GhostteaTerminal"]
    ),
    .testTarget(
      name: "GhostteaCredentialsTests",
      dependencies: ["GhostteaCredentials"]
    ),
    .testTarget(
      name: "GhostteaDiagnosticsTests",
      dependencies: ["GhostteaDiagnostics"]
    ),
    .testTarget(
      name: "GhostteaPerformanceTests",
      dependencies: ["GhostteaPerformance"]
    ),
    .testTarget(
      name: "GhostteaConnectionProfilesTests",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCredentials",
        "GhostteaSSH",
      ]
    ),
    .testTarget(
      name: "GhostteaConnectionProfilesUITests",
      dependencies: ["GhostteaConnectionProfiles", "GhostteaConnectionProfilesUI"]
    ),
    .testTarget(
      name: "GhostteaFontProofTests",
      dependencies: ["GhostteaFontProof"]
    ),
    .testTarget(
      name: "GhostteaCoreTests",
      dependencies: ["GhostteaCore"]
    ),
    .testTarget(
      name: "GhostteaFrameTests",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaTerminal", "GhostteaTransport"]
    ),
    .testTarget(
      name: "GhostteaSSHTests",
      dependencies: [
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaTransport",
      ]
    ),
    .testTarget(
      name: "GhostteaSSHWorkspaceTests",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCore",
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaSSHWorkspace",
        "GhostteaTransport",
        "GhostteaWorkspace",
      ]
    ),
    .testTarget(
      name: "GhostteaSSHProbeTests",
      dependencies: ["GhostteaSSHProbe"]
    ),
    .testTarget(
      name: "GhostteaSessionTests",
      dependencies: ["GhostteaSession", "GhostteaTransport"]
    ),
    .testTarget(
      name: "GhostteaTransportTests",
      dependencies: ["GhostteaTransport"]
    ),
    .testTarget(
      name: "GhostteaTruffleTests",
      dependencies: [
        "GhostteaCore",
        "GhostteaTruffle",
        .product(name: "Truffle", package: "truffle"),
      ],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "GhostteaWorkspaceTests",
      dependencies: ["GhostteaWorkspace"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "GhostteaWorkspaceUITests",
      dependencies: ["GhostteaWorkspace", "GhostteaWorkspaceUI"]
    ),
    .testTarget(
      name: "GhosttyVtProofTests",
      dependencies: ["GhosttyVtProof"],
      resources: [.copy("Fixtures")]
    ),
    .plugin(
      name: "GhostteaMetalCompilerPlugin",
      capability: .buildTool()
    ),
  ]
)
