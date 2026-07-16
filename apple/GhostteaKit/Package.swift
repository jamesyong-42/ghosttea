// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "GhostteaKit",
  platforms: [
    .iOS(.v17),
    .macOS(.v14),
  ],
  products: [
    .library(name: "GhostteaSSHProbe", targets: ["GhostteaSSHProbe"]),
    .library(name: "GhostteaTransport", targets: ["GhostteaTransport"]),
    .library(name: "GhosttyVtProof", targets: ["GhosttyVtProof"]),
    .executable(name: "GhosttyVtMemoryProbe", targets: ["GhosttyVtMemoryProbe"]),
  ],
  targets: [
    .binaryTarget(
      name: "LibSSH2Candidate",
      path: "Artifacts/ghosttea-libssh2-candidate.xcframework"
    ),
    .binaryTarget(
      name: "GhosttyVt",
      path: "Artifacts/ghostty-vt.xcframework"
    ),
    .target(name: "GhostteaTransport"),
    .target(
      name: "GhostteaSSHProbe",
      dependencies: ["GhostteaTransport", "LibSSH2Candidate"]
    ),
    .target(
      name: "GhosttyVtProof",
      dependencies: ["GhosttyVt"]
    ),
    .executableTarget(
      name: "GhosttyVtMemoryProbe",
      dependencies: ["GhosttyVtProof"]
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
