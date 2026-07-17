import Foundation
import GhostteaCredentials
import GhostteaSSH
import GhostteaTransport
import UIKit

@MainActor
final class HarnessModel: ObservableObject {
  enum SSHCommandPreset {
    case defaultOutput
    case exitStreams
    case signalTermination
  }

  enum SSHProbeAuthentication: String, CaseIterable, Identifiable {
    case password = "Password"
    case privateKey = "Private key"
    case keyboardInteractive = "Keyboard"

    var id: Self { self }
  }

  enum SSHProbeSession: String, CaseIterable, Identifiable {
    case command = "Command"
    case ptyResize = "PTY resize"
    case halfClose = "Half-close"

    var id: Self { self }
  }

  struct PendingHostKey: Identifiable {
    let id = UUID()
    let challenge: SSHCandidateHostKeyChallenge
  }

  struct PendingKeyboardChallenge: Identifiable {
    let id = UUID()
    let challenge: SSHKeyboardInteractiveChallenge
  }

  @Published var vtResult = "Not run"
  @Published var keychainResult = "Not run"
  @Published var memoryResults: [HarnessMemoryResult] = []
  @Published var memoryStatus = "Not run"
  @Published var host = "10.0.0.103"
  @Published var port = "22022"
  @Published var username = "ghosttea"
  @Published var sshAuthentication = SSHProbeAuthentication.password
  @Published var sshSession = SSHProbeSession.command
  @Published var password = "ghosttea-password"
  @Published var privateKey = ""
  @Published var privateKeyPassphrase = ""
  @Published var command = "printf 'ghosttea-device-ok\\n'; uname -a"
  @Published var sshStatus = "Not connected"
  @Published var sshOutput = ""
  @Published var sshStandardError = ""
  @Published var pendingHostKey: PendingHostKey?
  @Published var pendingKeyboardChallenge: PendingKeyboardChallenge?
  @Published private var isBridgingSSHInteraction = false
  @Published var isRunningMemory = false
  @Published var isRunningKeychain = false
  @Published var isRunningSSH = false

  private var hostKeyContinuation: CheckedContinuation<SSHCandidateHostKeyDecision, Never>?
  private var keyboardChallengeContinuation: CheckedContinuation<[String], Error>?
  private var sshTask: Task<Void, Never>?
  private var sshCancellationRequestedAt: ContinuousClock.Instant?

  var isPresentingSSHInteraction: Bool {
    pendingHostKey != nil || pendingKeyboardChallenge != nil || isBridgingSSHInteraction
  }

  var deviceSummary: String {
    let device = UIDevice.current
    return
      "\(device.model) · iOS \(device.systemVersion) · \(ProcessInfo.processInfo.physicalMemory / 1_048_576) MiB RAM"
  }

  func runVTProof() {
    do {
      vtResult = try HarnessDiagnostics.runVTProof()
    } catch {
      vtResult = "Failed: \(error)"
    }
  }

  func runKeychainProof() {
    guard !isRunningKeychain else { return }
    isRunningKeychain = true
    keychainResult = "Running save/load/delete proof…"
    Task {
      let credential = SSHCredentialID(connectionID: UUID(), kind: .password)
      do {
        let store = try KeychainSSHCredentialStore()
        let expected = Data(UUID().uuidString.utf8)
        try await store.store(expected, for: credential)
        guard try await store.load(credential) == expected else {
          throw HarnessError.keychainRoundTripMismatch
        }
        try await store.remove(credential)
        guard try await store.load(credential) == nil else {
          throw HarnessError.keychainRemovalFailed
        }
        keychainResult = "Passed · device-only, non-synchronizing item removed"
      } catch {
        if let store = try? KeychainSSHCredentialStore() {
          try? await store.remove(credential)
        }
        keychainResult = "Failed: \(error)"
      }
      isRunningKeychain = false
    }
  }

  func runMemoryMatrix() {
    guard !isRunningMemory else { return }
    isRunningMemory = true
    memoryStatus = "Running deterministic 1/4/8-session matrix…"
    Task {
      do {
        let results = try await Task.detached(priority: .userInitiated) {
          try HarnessDiagnostics.runMemoryMatrix()
        }.value
        memoryResults = results
        memoryStatus = "Complete"
      } catch {
        memoryStatus = "Failed: \(error)"
      }
      isRunningMemory = false
    }
  }

  func runSSHCommand() {
    guard !isRunningSSH else { return }
    guard let numericPort = Int(port), (1...65_535).contains(numericPort) else {
      sshStatus = "Enter a valid port"
      return
    }
    guard !host.isEmpty, !username.isEmpty else {
      sshStatus = "Host and username are required"
      return
    }
    guard sshAuthentication != .privateKey || !privateKey.isEmpty else {
      sshStatus = "Paste a disposable OpenSSH private key"
      return
    }

    let requestedHost = host
    let requestedUsername = username
    let requestedAuthentication = sshAuthentication
    let requestedSession = sshSession
    let requestedPassword = Data(password.utf8)
    let requestedPrivateKey = Data(privateKey.utf8)
    let requestedPassphrase = Data(privateKeyPassphrase.utf8)
    let requestedCommand = command
    password = ""
    privateKey = ""
    privateKeyPassphrase = ""
    isRunningSSH = true
    sshStatus = "Connecting…"
    sshOutput = ""
    sshStandardError = ""
    isBridgingSSHInteraction = false

    sshCancellationRequestedAt = nil
    sshTask = Task {
      do {
        let credentialStore = try KeychainSSHCredentialStore()
        let connectionID = UUID()
        let credentials: [SSHCredentialID]
        let authentication: SSHCandidateAuthentication
        do {
          switch requestedAuthentication {
          case .password:
            let credential = SSHCredentialID(connectionID: connectionID, kind: .password)
            credentials = [credential]
            authentication = .passwordCredential(
              username: requestedUsername,
              credential: credential,
              resolver: { requestedCredential in
                try await credentialStore.require(requestedCredential)
              }
            )
            try await credentialStore.store(requestedPassword, for: credential)
          case .privateKey:
            let privateKeyCredential = SSHCredentialID(
              connectionID: connectionID,
              kind: .privateKey
            )
            let passphraseCredential =
              requestedPassphrase.isEmpty
              ? nil
              : SSHCredentialID(
                connectionID: connectionID,
                kind: .privateKeyPassphrase
              )
            credentials = [privateKeyCredential, passphraseCredential].compactMap { $0 }
            authentication = .publicKeyCredential(
              username: requestedUsername,
              privateKeyCredential: privateKeyCredential,
              passphraseCredential: passphraseCredential,
              resolver: { requestedCredential in
                try await credentialStore.require(requestedCredential)
              }
            )
            try await credentialStore.store(requestedPrivateKey, for: privateKeyCredential)
            if let passphraseCredential {
              try await credentialStore.store(requestedPassphrase, for: passphraseCredential)
            }
          case .keyboardInteractive:
            credentials = []
            authentication = .keyboardInteractive(
              username: requestedUsername,
              responder: { [weak self] challenge in
                guard let self else { throw CancellationError() }
                return try await self.requestKeyboardChallengeResponse(challenge)
              }
            )
          }
          let candidateSession: SSHCandidateSession
          let initialColumns: Int
          let initialRows: Int
          switch requestedSession {
          case .command:
            candidateSession = .command(requestedCommand, allocatePTY: false)
            initialColumns = 80
            initialRows = 24
          case .ptyResize:
            candidateSession = .shell
            initialColumns = 132
            initialRows = 41
          case .halfClose:
            candidateSession = .command("cat", allocatePTY: false)
            initialColumns = 80
            initialRows = 24
          }
          let knownHostsPath = try self.knownHostsPath()
          let configuration = try SSHCandidateConfiguration(
            host: requestedHost,
            port: numericPort,
            knownHostsPath: knownHostsPath,
            hostKeyPolicy: .ask { [weak self] challenge in
              guard let self else { return .reject }
              return await self.requestHostKeyDecision(challenge)
            },
            authentication: authentication,
            session: candidateSession,
            columns: initialColumns,
            rows: initialRows,
            connectTimeoutMilliseconds: 15_000,
            handshakeTimeoutMilliseconds: 15_000
          )
          let transport = SSHCandidateTransport(configuration: configuration)
          let connection = try await transport.connect()
          finishSSHInteraction()
          do {
            try await removeCredentials(credentials, from: credentialStore)
            var negotiatedSummary: String?
            let candidate = connection as? SSHCandidateConnection
            if let candidate {
              let summary =
                "\(candidate.negotiatedAlgorithms.hostKey) · \(candidate.negotiatedAlgorithms.serverToClientCipher)"
              negotiatedSummary = summary
              sshStatus = "Connected · \(summary)"
            } else {
              sshStatus = "Connected"
            }
            let halfClosePayload = Data("ghosttea-half-close-device-ok\n".utf8)
            switch requestedSession {
            case .command:
              break
            case .ptyResize:
              try await connection.write(
                Data(
                  "printf 'INITIAL '; stty size; while [ \"$(stty size)\" = '41 132' ]; do sleep 1; done; printf 'RESIZED '; stty size; exit 0\n"
                    .utf8
                )
              )
            case .halfClose:
              try await connection.write(halfClosePayload)
              try await connection.finishInput()
            }
            var standardOutput = Data()
            var standardError = Data()
            var sentResize = false
            if let candidate {
              while let chunk = try await candidate.readCommandOutput(maxBytes: 32_768) {
                switch chunk {
                case .standardOutput(let bytes):
                  try appendSSHOutput(
                    bytes,
                    to: &standardOutput,
                    otherStreamBytes: standardError.count
                  )
                case .standardError(let bytes):
                  try appendSSHOutput(
                    bytes,
                    to: &standardError,
                    otherStreamBytes: standardOutput.count
                  )
                }
                if requestedSession == .ptyResize,
                  !sentResize,
                  String(decoding: standardOutput, as: UTF8.self).contains("INITIAL 41 132")
                {
                  try await connection.resize(columns: 140, rows: 50)
                  sentResize = true
                }
              }
            } else {
              while let chunk = try await connection.read(maxBytes: 32_768) {
                try appendSSHOutput(chunk, to: &standardOutput, otherStreamBytes: 0)
              }
            }
            let termination = try await connection.waitForExit()
            try validateSSHSessionProbe(
              requestedSession,
              standardOutput: standardOutput,
              standardError: standardError,
              termination: termination,
              sentResize: sentResize,
              halfClosePayload: halfClosePayload
            )
            sshOutput = String(decoding: standardOutput, as: UTF8.self)
            sshStandardError = String(decoding: standardError, as: UTF8.self)
            sshStatus = ["Completed", termination.description, negotiatedSummary]
              .compactMap { $0 }
              .joined(separator: " · ")
            await connection.disconnect()
          } catch {
            await connection.disconnect()
            throw error
          }
        } catch {
          try? await removeCredentials(credentials, from: credentialStore)
          throw error
        }
      } catch {
        if let requestedAt = sshCancellationRequestedAt {
          let duration = requestedAt.duration(to: .now)
          sshStatus = "Cancelled in \(durationMilliseconds(duration)) ms"
        } else {
          sshStatus = "Failed: \(error)"
        }
      }
      finishSSHInteraction()
      isRunningSSH = false
      sshCancellationRequestedAt = nil
      sshTask = nil
    }
  }

  func loadSSHCommandPreset(_ preset: SSHCommandPreset) {
    switch preset {
    case .defaultOutput:
      command = "printf 'ghosttea-device-ok\\n'; uname -a"
    case .exitStreams:
      command = "printf 'fixture-stdout\\n'; printf 'fixture-stderr\\n' >&2; exit 37"
    case .signalTermination:
      command = "kill -TERM $$"
    }
  }

  func loadDisposableFixtureDefaults() {
    host = "10.0.0.103"
    port = "22022"
    username = "ghosttea"
    sshAuthentication = .password
    password = "ghosttea-password"
  }

  func cancelSSHCommand() {
    guard isRunningSSH, sshCancellationRequestedAt == nil else { return }
    sshCancellationRequestedAt = .now
    sshStatus = "Cancelling…"
    resolveHostKey(.reject)
    cancelKeyboardChallenge()
    sshTask?.cancel()
  }

  func resolveHostKey(_ decision: SSHCandidateHostKeyDecision) {
    let continuation = hostKeyContinuation
    hostKeyContinuation = nil
    pendingHostKey = nil
    isBridgingSSHInteraction = decision != .reject
    continuation?.resume(returning: decision)
  }

  func resolveKeyboardChallenge(_ responses: [String]) {
    let continuation = keyboardChallengeContinuation
    keyboardChallengeContinuation = nil
    pendingKeyboardChallenge = nil
    isBridgingSSHInteraction = true
    continuation?.resume(returning: responses)
  }

  func cancelKeyboardChallenge() {
    let continuation = keyboardChallengeContinuation
    keyboardChallengeContinuation = nil
    pendingKeyboardChallenge = nil
    isBridgingSSHInteraction = false
    continuation?.resume(throwing: CancellationError())
  }

  private func requestHostKeyDecision(
    _ challenge: SSHCandidateHostKeyChallenge
  ) async -> SSHCandidateHostKeyDecision {
    if let continuation = hostKeyContinuation {
      continuation.resume(returning: .reject)
    }
    return await withCheckedContinuation { continuation in
      hostKeyContinuation = continuation
      isBridgingSSHInteraction = false
      pendingHostKey = PendingHostKey(challenge: challenge)
    }
  }

  private func requestKeyboardChallengeResponse(
    _ challenge: SSHKeyboardInteractiveChallenge
  ) async throws -> [String] {
    if let continuation = keyboardChallengeContinuation {
      continuation.resume(throwing: CancellationError())
    }
    return try await withCheckedThrowingContinuation { continuation in
      keyboardChallengeContinuation = continuation
      isBridgingSSHInteraction = false
      pendingKeyboardChallenge = PendingKeyboardChallenge(challenge: challenge)
    }
  }

  private func finishSSHInteraction() {
    isBridgingSSHInteraction = false
  }

  private func knownHostsPath() throws -> String {
    let root = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = root.appending(path: "GhostteaHarness", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete]
    )
    return directory.appending(path: "known_hosts", directoryHint: .notDirectory).path
  }

  private func removeCredentials(
    _ credentials: [SSHCredentialID],
    from store: KeychainSSHCredentialStore
  ) async throws {
    for credential in credentials {
      try await store.remove(credential)
    }
  }

  private func appendSSHOutput(
    _ bytes: Data,
    to stream: inout Data,
    otherStreamBytes: Int
  ) throws {
    guard stream.count + otherStreamBytes + bytes.count <= 1_048_576 else {
      throw HarnessError.outputLimitExceeded
    }
    stream.append(bytes)
  }

  private func validateSSHSessionProbe(
    _ session: SSHProbeSession,
    standardOutput: Data,
    standardError: Data,
    termination: TerminalExitStatus,
    sentResize: Bool,
    halfClosePayload: Data
  ) throws {
    switch session {
    case .command:
      return
    case .ptyResize:
      let output = String(decoding: standardOutput, as: UTF8.self)
      guard
        sentResize,
        output.contains("INITIAL 41 132"),
        output.contains("RESIZED 50 140"),
        standardError.isEmpty,
        termination == .exited(code: 0)
      else {
        throw HarnessError.sessionProbeMismatch("PTY resize")
      }
    case .halfClose:
      guard
        standardOutput == halfClosePayload,
        standardError.isEmpty,
        termination == .exited(code: 0)
      else {
        throw HarnessError.sessionProbeMismatch("input half-close")
      }
    }
  }

  private func durationMilliseconds(_ duration: Duration) -> Int64 {
    let components = duration.components
    return components.seconds * 1_000 + components.attoseconds / 1_000_000_000_000_000
  }
}

private enum HarnessError: Error, CustomStringConvertible {
  case keychainRemovalFailed
  case keychainRoundTripMismatch
  case outputLimitExceeded
  case sessionProbeMismatch(String)

  var description: String {
    switch self {
    case .keychainRemovalFailed:
      return "credential remained after Keychain removal"
    case .keychainRoundTripMismatch:
      return "Keychain credential round trip changed the secret"
    case .outputLimitExceeded:
      return "command output exceeded the 1 MiB harness limit"
    case .sessionProbeMismatch(let probe):
      return "\(probe) session probe did not produce its exact expected result"
    }
  }
}

extension TerminalExitStatus {
  fileprivate var description: String {
    switch self {
    case .exited(let code):
      return "exit \(code)"
    case .signaled(let name):
      return "signal \(name)"
    }
  }
}
