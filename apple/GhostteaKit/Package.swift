// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "GhostteaKit",
  platforms: [
    .iOS(.v17),
    .macOS(.v14),
  ],
  products: [
    .library(name: "GhostteaCredentials", targets: ["GhostteaCredentials"]),
    .library(name: "GhostteaSSH", targets: ["GhostteaSSH"]),
    .library(name: "GhostteaSSHProbe", targets: ["GhostteaSSHProbe"]),
    .library(name: "GhostteaTransport", targets: ["GhostteaTransport"]),
    .library(name: "GhosttyVtProof", targets: ["GhosttyVtProof"]),
    .executable(name: "GhosttyVtMemoryProbe", targets: ["GhosttyVtMemoryProbe"]),
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
      dependencies: ["CGhostteaSSH", "GhostteaCredentials", "GhostteaTransport"]
    ),
    .target(
      name: "GhostteaCredentials",
      linkerSettings: [.linkedFramework("Security")]
    ),
    .target(name: "GhostteaTransport"),
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
    .testTarget(
      name: "GhostteaCredentialsTests",
      dependencies: ["GhostteaCredentials"]
    ),
    .testTarget(
      name: "GhostteaSSHTests",
      dependencies: ["GhostteaSSH"]
    ),
    .testTarget(
      name: "GhostteaSSHProbeTests",
      dependencies: ["GhostteaSSHProbe"]
    ),
    .testTarget(
      name: "GhostteaTransportTests",
      dependencies: ["GhostteaTransport"]
    ),
    .testTarget(
      name: "GhosttyVtProofTests",
      dependencies: ["GhosttyVtProof"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
