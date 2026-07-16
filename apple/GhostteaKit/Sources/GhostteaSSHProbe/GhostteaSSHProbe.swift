import LibSSH2Candidate

public enum GhostteaSSHProbeError: Error, Equatable, Sendable {
  case initializationFailed(code: Int32)
  case sessionAllocationFailed
  case versionUnavailable
}

public struct GhostteaSSHProbeCapabilities: Equatable, Sendable {
  public let runtimeVersion: String
  public let hasKeyboardInteractiveSymbol: Bool

  public init(runtimeVersion: String, hasKeyboardInteractiveSymbol: Bool) {
    self.runtimeVersion = runtimeVersion
    self.hasKeyboardInteractiveSymbol = hasKeyboardInteractiveSymbol
  }
}

/// A link and lifecycle probe for the Phase 0 libssh2 candidate.
///
/// This is deliberately not an SSH transport implementation. Advancing the
/// candidate still requires live-server coverage for host keys, algorithms,
/// authentication sequencing, and channel flow control.
public enum GhostteaSSHProbe {
  public static func inspect() throws -> GhostteaSSHProbeCapabilities {
    let initializationStatus = libssh2_init(0)
    guard initializationStatus == 0 else {
      throw GhostteaSSHProbeError.initializationFailed(code: initializationStatus)
    }
    defer { libssh2_exit() }

    guard let session = libssh2_session_init_ex(nil, nil, nil, nil) else {
      throw GhostteaSSHProbeError.sessionAllocationFailed
    }
    defer { libssh2_session_free(session) }

    guard let version = libssh2_version(0) else {
      throw GhostteaSSHProbeError.versionUnavailable
    }

    // Referencing the imported function is a compile-time check that libssh2's
    // callback-bearing keyboard-interactive API survives the Clang importer.
    // The XCFramework validator separately requires the archive symbol.
    _ = libssh2_userauth_keyboard_interactive_ex

    return GhostteaSSHProbeCapabilities(
      runtimeVersion: String(cString: version),
      hasKeyboardInteractiveSymbol: true
    )
  }
}
