// swift-tools-version: 6.1

import PackageDescription

let package = Package(
  name: "GhostteaKit",
  platforms: [
    .iOS(.v17),
    .macOS(.v14),
  ],
  products: [
    .library(name: "GhostteaCredentials", targets: ["GhostteaCredentials"]),
    .library(name: "GhostteaConnectionProfiles", targets: ["GhostteaConnectionProfiles"]),
    .library(name: "GhostteaConnectionProfilesUI", targets: ["GhostteaConnectionProfilesUI"]),
    .library(name: "GhostteaCore", targets: ["GhostteaCore"]),
    .library(name: "GhostteaFontProof", targets: ["GhostteaFontProof"]),
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
    // Development intentionally mirrors the Rust workspace's sibling Truffle
    // checkout. Release automation records and verifies its exact Git revision.
    .package(path: "../../../p008/truffle/apple"),
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
      dependencies: ["GhostteaAppleNative", "GhostteaFonts"],
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(name: "GhostteaFrame"),
    .target(
      name: "GhostteaSession",
      dependencies: ["GhostteaCore", "GhostteaTransport"]
    ),
    .target(
      name: "GhostteaTerminal",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaTransport"],
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
        .product(name: "Truffle", package: "apple"),
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
      dependencies: ["GhostteaAppleNative"]
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
        "GhostteaTruffle",
        .product(name: "Truffle", package: "apple"),
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
